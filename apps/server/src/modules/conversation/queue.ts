import { and, asc, count, desc, eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { hashToken, newToken } from '../../crypto/tokens.js';
import { agents, jobs, subscriptions } from '../../db/schema.js';
import { dispatchJob } from '../jobs/dispatch.js';
import { identityOf } from '../nodes/hub.js';
import { appendEvent, earlierTalk, publishWorking } from '../events/store.js';
import { ORCHESTRATOR_INSTRUCTIONS, preface } from './prompt.js';

export const CONVERSATION_TIMEOUT_MS = 15 * 60_000;

export type OrchestratorState = {
  ready: boolean;
  reason: 'no_subscription' | 'waiting_machine' | 'needs_login' | 'node_outdated' | 'machine_offline' | null;
  busy: boolean;
  runningJobId: string | null;
  queued: number;
};

type Turn = { companyId: string; agentId: string; prompt: string; createdBy: string | null; message?: { personId: string; text: string } };

/* One thing at a time per agent, so two pumps never send two turns. */
const chains = new WeakMap<Ctx, Map<string, Promise<unknown>>>();

export function onAgent<T>(ctx: Ctx, agentId: string, fn: () => Promise<T>): Promise<T> {
  const mine = chains.get(ctx) ?? new Map<string, Promise<unknown>>();
  chains.set(ctx, mine);
  const run = (mine.get(agentId) ?? Promise.resolve()).then(fn);
  const settled = run.catch(() => undefined);
  mine.set(agentId, settled);
  void settled.then(() => {
    if (mine.get(agentId) === settled) mine.delete(agentId);
  });
  return run;
}

const conversationOf = (agentId: string) => and(eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation'));

async function liveSubscription(ctx: Ctx, agentId: string) {
  const [row] = await ctx.db.select({ sub: subscriptions }).from(agents).innerJoin(subscriptions, eq(subscriptions.id, agents.subscriptionId)).where(eq(agents.id, agentId));
  return row && !row.sub.removedAt ? row.sub : null;
}

/* Stores the turn and, when it carries a person's message, the message under the same job. */
export async function insertTurn(ctx: Ctx, t: Turn): Promise<string> {
  const sub = await liveSubscription(ctx, t.agentId);
  if (!sub) throw new Error('The agent has no subscription.');
  const [job] = await ctx.db
    .insert(jobs)
    .values({ companyId: t.companyId, subscriptionId: sub.id, agentId: t.agentId, kind: 'conversation', prompt: t.prompt, timeoutMs: CONVERSATION_TIMEOUT_MS, createdBy: t.createdBy })
    .returning({ id: jobs.id });
  if (t.message) {
    await appendEvent(ctx, { companyId: t.companyId, agentId: t.agentId, jobId: job!.id, kind: 'message', data: { text: t.message.text }, personId: t.message.personId });
  }
  return job!.id;
}

/* Stores the turn, then sends it if he is free. */
export async function enqueueTurn(ctx: Ctx, t: Turn): Promise<string> {
  const jobId = await insertTurn(ctx, t);
  await pump(ctx, t.agentId);
  return jobId;
}

/* A new session catches up from the conversation; the same subscription resumes the last finished turn's session. */
async function sessionFor(ctx: Ctx, agentId: string, subscriptionId: string, prompt: string): Promise<{ sessionId: string | null; prompt: string }> {
  const [last] = await ctx.db
    .select({ subscriptionId: jobs.subscriptionId, sessionId: jobs.sessionId })
    .from(jobs)
    .where(and(conversationOf(agentId), eq(jobs.status, 'done')))
    .orderBy(desc(jobs.finishedAt))
    .limit(1);
  if (last?.sessionId && last.subscriptionId === subscriptionId) return { sessionId: last.sessionId, prompt };
  const talk = await earlierTalk(ctx.db, agentId);
  return { sessionId: null, prompt: talk.length ? `${preface(talk)}\n\n${prompt}` : prompt };
}

/* Turns need a node from 0.3.0 on: older ones drop his instructions and tool token, cannot stop a turn and send nothing live. */
const CONVERSATION_NODE = [0, 3, 0];
function outdated(sub: { kind: string; nodeVersion: string | null }): boolean {
  if (sub.kind !== 'personal') return false;
  const have = (sub.nodeVersion ?? '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < CONVERSATION_NODE.length; i++) if ((have[i] ?? 0) !== CONVERSATION_NODE[i]) return (have[i] ?? 0) < CONVERSATION_NODE[i]!;
  return false;
}

async function sendNext(ctx: Ctx, agentId: string): Promise<void> {
  const { db, hub } = ctx;
  const [running] = await db.select({ id: jobs.id }).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'running'))).limit(1);
  if (running) return;
  const sub = await liveSubscription(ctx, agentId);
  if (!sub || sub.status !== 'ready' || outdated(sub) || !hub.isReady(identityOf(sub))) return;
  const [job] = await db.select().from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'queued'))).orderBy(asc(jobs.createdAt)).limit(1);
  if (!job) return;

  const { sessionId, prompt } = await sessionFor(ctx, agentId, sub.id, job.prompt);
  const token = newToken();
  /* Running from the moment it is sent: the token works for its tools at once, and the next turn waits. */
  const [taken] = await db
    .update(jobs)
    .set({ status: 'running', startedAt: new Date(), subscriptionId: sub.id, prompt, toolTokenHash: hashToken(token) })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, 'queued')))
    .returning({ id: jobs.id });
  if (!taken) return;
  await publishWorking(ctx, job.companyId);
  const sent = await dispatchJob(ctx, { id: job.id, subscriptionId: sub.id, prompt, sessionId, timeoutMs: job.timeoutMs, instructions: ORCHESTRATOR_INSTRUCTIONS, toolToken: token });
  if (sent) return;
  await db.update(jobs).set({ status: 'queued', startedAt: null, prompt: job.prompt, toolTokenHash: null }).where(eq(jobs.id, job.id));
  await publishWorking(ctx, job.companyId);
}

/* Sends the agent's oldest waiting turn when none runs and his subscription is online and signed in. */
export function pump(ctx: Ctx, agentId: string): Promise<void> {
  return onAgent(ctx, agentId, () => sendNext(ctx, agentId));
}

/* Every agent with turns waiting, after a machine came back or a subscription changed. */
export async function pumpWaiting(ctx: Ctx): Promise<void> {
  const waiting = await ctx.db.selectDistinct({ agentId: jobs.agentId }).from(jobs).where(and(eq(jobs.kind, 'conversation'), eq(jobs.status, 'queued')));
  for (const { agentId } of waiting) if (agentId) await pump(ctx, agentId);
}

/* A finished turn: a failure or a stop goes into the conversation, then the next turn goes out. */
export async function afterJob(ctx: Ctx, jobId: string): Promise<void> {
  const [job] = await ctx.db.select({ companyId: jobs.companyId, agentId: jobs.agentId, kind: jobs.kind, status: jobs.status, error: jobs.error }).from(jobs).where(eq(jobs.id, jobId));
  if (!job?.agentId || job.kind !== 'conversation') return;
  if (job.status === 'failed') {
    const stopped = job.error === 'cancelled';
    await appendEvent(ctx, { companyId: job.companyId, agentId: job.agentId, jobId, kind: stopped ? 'stopped' : 'failed', data: stopped ? {} : { error: job.error } });
  }
  await pump(ctx, job.agentId);
}

export async function orchestratorOf(ctx: Ctx, companyId: string) {
  const [agent] = await ctx.db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.kind, 'orchestrator')));
  return agent ?? null;
}

export async function orchestratorState(ctx: Ctx, companyId: string): Promise<OrchestratorState> {
  const agent = await orchestratorOf(ctx, companyId);
  if (!agent) return { ready: false, reason: 'no_subscription', busy: false, runningJobId: null, queued: 0 };
  const [running] = await ctx.db.select({ id: jobs.id }).from(jobs).where(and(conversationOf(agent.id), eq(jobs.status, 'running'))).limit(1);
  const [waiting] = await ctx.db.select({ n: count() }).from(jobs).where(and(conversationOf(agent.id), eq(jobs.status, 'queued')));
  const sub = await liveSubscription(ctx, agent.id);
  const reason: OrchestratorState['reason'] = !sub
    ? 'no_subscription'
    : sub.status === 'waiting_machine'
      ? 'waiting_machine'
      : sub.status === 'needs_login'
        ? 'needs_login'
        : outdated(sub)
          ? 'node_outdated'
          : !ctx.hub.isReady(identityOf(sub))
            ? 'machine_offline'
            : null;
  return { ready: reason === null, reason, busy: Boolean(running), runningJobId: running?.id ?? null, queued: Number(waiting?.n ?? 0) };
}
