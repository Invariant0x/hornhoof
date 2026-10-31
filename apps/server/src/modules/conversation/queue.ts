import { effortFor, effortsOf, modelsFor } from '@hornhoof/protocol';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { hashToken, newToken } from '../../crypto/tokens.js';
import { agents, jobs, subscriptions } from '../../db/schema.js';
import { dispatchJob } from '../jobs/dispatch.js';
import { identityOf, sameNode, type NodeIdentity } from '../nodes/hub.js';
import { appendEvent, earlierTalk, publishWorking } from '../events/store.js';
import { instructionsOf } from '../agents/instructions.js';
import { repoFor, repoLine } from '../departments/repository.js';
import { textHash } from '../templates/load.js';
import { answerDirectly } from '../tasks/engine.js';
import { checkLiveness, leaveIfOff, startWork, wakeAll } from '../tasks/wake.js';
import { preface } from './prompt.js';

/* Workers compact their conversation at half a million tokens, which keeps their turns quick; heads and the orchestrator
   keep the whole window, since they hold the department's and the company's picture. */
export const WORKER_COMPACT_WINDOW = 500_000;

export const CONVERSATION_TIMEOUT_MS = 15 * 60_000;
/* A turn on a task may run long: the work, its tests and a review fit in one. */
export const TASK_TURN_TIMEOUT_MS = 45 * 60_000;

export type AgentState = {
  ready: boolean;
  reason: 'no_subscription' | 'waiting_machine' | 'needs_login' | 'node_outdated' | 'machine_offline' | null;
  busy: boolean;
  runningJobId: string | null;
  queued: number;
  /* Its node shows the agent's live terminal. */
  terminal: boolean;
};

/* What a turn ends with when a person or Hornhoof stopped it on purpose; none of these is a failure. */
export const STOPPED_ON_PURPOSE = ['cancelled', 'removed', 'switched_off'];

type Turn = { companyId: string; agentId: string; prompt: string; createdBy: string | null; message?: { personId: string | null; text: string; from?: 'orchestrator' | 'agent'; name?: string; by?: string }; taskId?: string };

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

export async function liveSubscription(ctx: Ctx, agentId: string) {
  const [row] = await ctx.db.select({ sub: subscriptions }).from(agents).innerJoin(subscriptions, eq(subscriptions.id, agents.subscriptionId)).where(eq(agents.id, agentId));
  return row && !row.sub.removedAt ? row.sub : null;
}

/* Stores the turn and, when it carries a person's message, the message under the same job. */
export async function insertTurn(ctx: Ctx, t: Turn): Promise<string> {
  const sub = await liveSubscription(ctx, t.agentId);
  if (!sub) throw new Error('The agent has no subscription.');
  const [job] = await ctx.db
    .insert(jobs)
    .values({
      companyId: t.companyId,
      subscriptionId: sub.id,
      agentId: t.agentId,
      kind: 'conversation',
      prompt: t.prompt,
      timeoutMs: t.taskId ? TASK_TURN_TIMEOUT_MS : CONVERSATION_TIMEOUT_MS,
      createdBy: t.createdBy,
      taskId: t.taskId ?? null,
    })
    .returning({ id: jobs.id });
  if (t.message) {
    /* An employee's message carries its name for the window and its id in by. */
    const { personId, ...data } = t.message;
    await appendEvent(ctx, { companyId: t.companyId, agentId: t.agentId, jobId: job!.id, kind: 'message', data, personId });
  }
  return job!.id;
}

/* Stores the turn, then sends it if he is free. */
export async function enqueueTurn(ctx: Ctx, t: Turn): Promise<string> {
  const jobId = await insertTurn(ctx, t);
  await pump(ctx, t.agentId);
  return jobId;
}

/* A person typed into the agent's terminal while no turn ran, or while the program started. The turn is theirs and runs
   from now on the node that shows the session, which goes on with the instructions it was started with: their hash stays,
   so the next turn resumes it. */
export async function openTypedTurn(ctx: Ctx, node: NodeIdentity, agentId: string, text: string, personId: string | null): Promise<{ jobId: string; token: string } | null> {
  if (!z.uuid().safeParse(agentId).success) return null;
  const opened = await onAgent(ctx, agentId, async () => {
    const { db } = ctx;
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, agentId), isNull(agents.removedAt)));
    const sub = agent ? await liveSubscription(ctx, agent.id) : null;
    if (!agent || !sub || !sameNode(identityOf(sub), node)) return null;
    /* A turn that only started the program is over once the person types: their turn takes its place. */
    await db
      .update(jobs)
      .set({ status: 'done', result: '', finishedAt: new Date() })
      .where(and(conversationOf(agentId), eq(jobs.status, 'running'), eq(jobs.prompt, ''), isNull(jobs.taskId)));
    const [running] = await db.select({ id: jobs.id }).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'running'))).limit(1);
    if (running) return null;
    const [last] = await db
      .select({ hash: jobs.instructionsHash })
      .from(jobs)
      .where(and(conversationOf(agentId), eq(jobs.subscriptionId, sub.id), isNotNull(jobs.instructionsHash)))
      .orderBy(desc(jobs.startedAt))
      .limit(1);
    const token = newToken();
    const [job] = await db
      .insert(jobs)
      .values({
        companyId: agent.companyId,
        subscriptionId: sub.id,
        agentId,
        kind: 'conversation',
        status: 'running',
        startedAt: new Date(),
        prompt: text,
        timeoutMs: CONVERSATION_TIMEOUT_MS,
        createdBy: personId,
        toolTokenHash: hashToken(token),
        instructionsHash: last?.hash ?? null,
      })
      .returning({ id: jobs.id });
    if (text.trim()) await appendEvent(ctx, { companyId: agent.companyId, agentId, jobId: job!.id, kind: 'message', data: { text }, personId });
    await publishWorking(ctx, agent.companyId);
    return { jobId: job!.id, token };
  });
  /* Out of the agent's line, which the pump of its task's turn waits on. */
  if (opened && personId) await wakeAll(ctx, await answerDirectly(ctx, personId, agentId, text));
  return opened;
}

/* Someone who may type opened the window of an agent whose program does not run: a turn that types nothing starts it on
   the node, so they talk to it at once. A turn that waits or runs starts it anyway. */
export async function startProgram(ctx: Ctx, node: NodeIdentity, agentId: string): Promise<void> {
  if (!z.uuid().safeParse(agentId).success) return;
  const started = await onAgent(ctx, agentId, async () => {
    const { db } = ctx;
    const [agent] = await db.select().from(agents).where(and(eq(agents.id, agentId), isNull(agents.removedAt)));
    const sub = agent ? await liveSubscription(ctx, agent.id) : null;
    if (!agent || !sub || !sameNode(identityOf(sub), node)) return false;
    /* Task turns of an agent that is switched off wait for it to be on and start nothing. */
    const waiting = and(eq(jobs.status, 'queued'), agent.switchedOffAt ? isNull(jobs.taskId) : undefined);
    const [open] = await db.select({ id: jobs.id }).from(jobs).where(and(conversationOf(agentId), or(eq(jobs.status, 'running'), waiting))).limit(1);
    if (open) return false;
    await insertTurn(ctx, { companyId: agent.companyId, agentId, prompt: '', createdBy: null });
    return true;
  });
  /* Outside the agent's line, which the pump waits on. */
  if (started) await pump(ctx, agentId);
}

/* A new session catches up from the conversation. The last finished turn's session goes on only on the same subscription
   with the same instructions: changed instructions would not reach a session that already has the old ones. A turn that
   ran out of time or was stopped in its session finished too, the session whole; one that broke, or was called off
   before it ran, leaves the session before it. */
async function sessionFor(ctx: Ctx, agent: { id: string; kind: string; name: string }, subscriptionId: string, instructionsHash: string): Promise<{ sessionId: string | null; catchUp: string | null }> {
  const [last] = await ctx.db
    .select({ subscriptionId: jobs.subscriptionId, sessionId: jobs.sessionId, instructionsHash: jobs.instructionsHash })
    .from(jobs)
    .where(and(conversationOf(agent.id), or(eq(jobs.status, 'done'), and(eq(jobs.status, 'failed'), inArray(jobs.error, ['timeout', 'cancelled']), isNotNull(jobs.sessionId)))))
    .orderBy(desc(jobs.finishedAt))
    .limit(1);
  if (last?.sessionId && last.subscriptionId === subscriptionId && last.instructionsHash === instructionsHash) return { sessionId: last.sessionId, catchUp: null };
  const talk = await earlierTalk(ctx.db, agent.id);
  return { sessionId: null, catchUp: talk.length ? preface(talk, agent.kind === 'orchestrator' ? 'Orchestrator' : agent.name) : null };
}

/* Turns need a node from 0.3.0 on: older ones drop his instructions and tool token, cannot stop a turn and send nothing live.
   Turns with a repository need 0.5.0, which clones it. The built-in node always matches the server. */
const CONVERSATION_NODE = [0, 3, 0];
const REPOSITORY_NODE = [0, 5, 0];
function outdated(sub: { kind: string; nodeVersion: string | null }, need = CONVERSATION_NODE): boolean {
  if (sub.kind !== 'personal') return false;
  const have = (sub.nodeVersion ?? '0').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < need.length; i++) if ((have[i] ?? 0) !== need[i]) return (have[i] ?? 0) < need[i]!;
  return false;
}

async function sendNext(ctx: Ctx, agentId: string): Promise<void> {
  const { db, hub } = ctx;
  const [running] = await db.select({ id: jobs.id }).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'running'))).limit(1);
  if (running) return;
  const sub = await liveSubscription(ctx, agentId);
  if (!sub || sub.status !== 'ready' || outdated(sub) || !hub.isReady(identityOf(sub))) return;
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent) return;
  /* Switched off, it still answers people who write to it; its task turns wait until it is on. */
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(conversationOf(agentId), eq(jobs.status, 'queued'), agent.switchedOffAt ? isNull(jobs.taskId) : undefined))
    .orderBy(asc(jobs.createdAt))
    .limit(1);
  if (!job) return;
  const repo = await repoFor(ctx, agent);
  if (repo && outdated(sub, REPOSITORY_NODE)) return;

  const instructions = await instructionsOf(ctx, agent);
  /* The program's flag only for a model this subscription can run; anything else runs on its Default. */
  const models = modelsFor(sub.provider, sub.models);
  const model = agent.model && models.some(m => m.id === agent.model) ? agent.model : null;
  /* How hard it thinks goes on in the same session; the program starts again at the new level. */
  const effort = effortFor(sub.provider, agent.effort, effortsOf(models, model));
  /* The hash covers the model too, so a new model starts a fresh session like new instructions do. */
  const runHash = model ? textHash(`${instructions.hash}:${model}`) : instructions.hash;
  const { sessionId, catchUp } = await sessionFor(ctx, agent, sub.id, runHash);
  const said = repo ? `${job.prompt}\n\n${repoLine(repo)}` : job.prompt;
  /* A turn that types nothing only starts the program, for a person to talk to it: what was said before and where the
     repository is go with its instructions instead. */
  const prompt = !job.prompt ? '' : catchUp ? `${catchUp}\n\n${said}` : said;
  const token = newToken();
  /* Running from the moment it is sent: the token works for its tools at once, and the next turn waits. */
  const [taken] = await db
    .update(jobs)
    .set({ status: 'running', startedAt: new Date(), subscriptionId: sub.id, prompt, toolTokenHash: hashToken(token), instructionsHash: runHash })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, 'queued')))
    .returning({ id: jobs.id });
  if (!taken) return;
  await publishWorking(ctx, job.companyId);
  const sent = await dispatchJob(ctx, {
    id: job.id,
    subscriptionId: sub.id,
    prompt,
    sessionId,
    model,
    effort,
    compactWindow: agent.kind === 'worker' ? WORKER_COMPACT_WINDOW : null,
    timeoutMs: job.timeoutMs,
    instructions: instructions.text,
    toolToken: token,
    context: job.prompt ? null : catchUp,
    guidance: job.prompt || !repo ? null : repoLine(repo),
    /* Each agent keeps one folder on the node, with its repository's clone inside. */
    workspace: { key: agent.id, repo },
  });
  if (sent) {
    if (job.taskId) await startWork(ctx, job.id);
    return;
  }
  await db.update(jobs).set({ status: 'queued', startedAt: null, prompt: job.prompt, toolTokenHash: null, instructionsHash: null }).where(eq(jobs.id, job.id));
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

/* A finished turn: a failure or a stop goes into the conversation, a turn on a task that left it where it was is caught,
   then the next turn goes out. */
export async function afterJob(ctx: Ctx, jobId: string): Promise<void> {
  const [job] = await ctx.db.select({ companyId: jobs.companyId, agentId: jobs.agentId, kind: jobs.kind, status: jobs.status, error: jobs.error, taskId: jobs.taskId }).from(jobs).where(eq(jobs.id, jobId));
  if (!job?.agentId || job.kind !== 'conversation') return;
  if (job.status === 'failed') {
    const stopped = job.error === 'cancelled';
    await appendEvent(ctx, { companyId: job.companyId, agentId: job.agentId, jobId, kind: stopped ? 'stopped' : 'failed', data: stopped ? {} : { error: job.error } });
  }
  if (job.taskId) await checkLiveness(ctx, jobId);
  await leaveIfOff(ctx, job.agentId);
  await pump(ctx, job.agentId);
}

/* The node stops the program and reports the job as cancelled. A node that is away cannot, so the job ends here. */
export async function cancelJob(ctx: Ctx, jobId: string): Promise<void> {
  const [job] = await ctx.db.select({ job: jobs, sub: subscriptions }).from(jobs).innerJoin(subscriptions, eq(subscriptions.id, jobs.subscriptionId)).where(eq(jobs.id, jobId));
  if (!job || job.job.status !== 'running') return;
  if (ctx.hub.send(identityOf(job.sub), { type: 'job.cancel', jobId })) return;
  const [ended] = await ctx.db
    .update(jobs)
    .set({ status: 'failed', error: 'cancelled', result: 'Stopped.', finishedAt: new Date() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running')))
    .returning({ id: jobs.id });
  if (!ended) return;
  await publishWorking(ctx, job.job.companyId);
  await afterJob(ctx, jobId);
}

export async function orchestratorOf(ctx: Ctx, companyId: string) {
  const [agent] = await ctx.db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.kind, 'orchestrator')));
  return agent ?? null;
}

export async function orchestratorState(ctx: Ctx, companyId: string): Promise<AgentState> {
  const agent = await orchestratorOf(ctx, companyId);
  if (!agent) return { ready: false, reason: 'no_subscription', busy: false, runningJobId: null, queued: 0, terminal: false };
  return agentState(ctx, agent.id);
}

/* Whether the agent can answer now and, if not, why; what it is doing and how many turns wait. */
export async function agentState(ctx: Ctx, agentId: string): Promise<AgentState> {
  const [running] = await ctx.db.select({ id: jobs.id }).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'running'))).limit(1);
  const [waiting] = await ctx.db.select({ n: count() }).from(jobs).where(and(conversationOf(agentId), eq(jobs.status, 'queued')));
  const sub = await liveSubscription(ctx, agentId);
  const [agent] = sub ? await ctx.db.select({ productId: agents.productId, departmentId: agents.departmentId }).from(agents).where(eq(agents.id, agentId)) : [];
  const reason: AgentState['reason'] = !sub
    ? 'no_subscription'
    : sub.status === 'waiting_machine'
      ? 'waiting_machine'
      : sub.status === 'needs_login'
        ? 'needs_login'
        : outdated(sub) || (outdated(sub, REPOSITORY_NODE) && agent && (await repoFor(ctx, agent)))
          ? 'node_outdated'
          : !ctx.hub.isReady(identityOf(sub))
            ? 'machine_offline'
            : null;
  const terminal = Boolean(sub && ctx.hub.hasTerminals(identityOf(sub)));
  return { ready: reason === null, reason, busy: Boolean(running), runningJobId: running?.id ?? null, queued: Number(waiting?.n ?? 0), terminal };
}
