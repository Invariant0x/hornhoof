import { type Along } from './turn-types.js';
import { conversationOf } from './placement.js';
import { and, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agentEvents, jobs } from '../../db/schema.js';
import { earlierTalk } from '../events/store.js';
import { openTurnOf } from '../tasks/turn-department.js';
import { preface } from './prompt.js';
import { originalPromptOf } from './requested-prompt.js';
export function keepsSessionAcrossTurns(kind: string): boolean {
  return kind === 'orchestrator' || kind === 'head' || kind === 'assistant';
}

export type Agent = { id: string; companyId: string; departmentId: string | null; kind: string; name: string };
/* Where a turn runs: the plan and its node, or for an API key the machine of the built-in node. own: the machine this
   server runs on, which a turn of an API key from before machines' built-in nodes were told apart ran on. */
export type On = { subscriptionId: string; nodeId: string | null; builtinMachine: string | null; own: string };
export type Session = { sessionId: string | null; catchUp: string | null };
/* The original prompt goes along when the continuation cannot resume the session that holds it. */
export type Continuation = { sessionId: string | null; originalPrompt: string | null };

/* Whether a session of that turn goes on here: on the same plan and node, an API key's on the same machine's built-in
   node, with the same instructions. */
export const sameRun = (turn: { subscriptionId: string | null; nodeId: string | null; builtinMachine: string | null; instructionsHash: string | null }, on: On, instructionsHash: string): boolean =>
  turn.subscriptionId === on.subscriptionId && turn.nodeId === on.nodeId && (on.builtinMachine === null || (turn.builtinMachine ?? on.own) === on.builtinMachine) && turn.instructionsHash === instructionsHash;

/* The turn this one goes on from: its session, when it can go on there, on the same plan and node with the same
   instructions; otherwise what that turn was asked. */
export async function continuedFrom(ctx: Ctx, jobId: string, on: On, instructionsHash: string): Promise<Continuation> {
  const [from] = await ctx.db.select({ subscriptionId: jobs.subscriptionId, nodeId: jobs.nodeId, builtinMachine: jobs.builtinMachine, sessionId: jobs.sessionId, instructionsHash: jobs.instructionsHash, prompt: jobs.prompt, requestedPrompt: jobs.requestedPrompt, continueOf: jobs.continueOf, retryOf: jobs.retryOf }).from(jobs).where(eq(jobs.id, jobId));
  if (!from) return { sessionId: null, originalPrompt: null };
  return { sessionId: sameRun(from, on, instructionsHash) ? from.sessionId : null, originalPrompt: await originalPromptOf(ctx, from) };
}

/* continueOf: a turn that goes on from one that ended without its work recorded goes on in that turn's session, or, when
   it cannot, takes what that turn was asked along into the session it gets. */
export type SessionJob = Pick<typeof jobs.$inferSelect, 'id' | 'continueOf' | 'retryOf' | 'createdAt' | 'taskId'>;

export async function sessionFor(ctx: Ctx, agent: Agent, on: On, instructionsHash: string, job: SessionJob): Promise<Session & Continuation> {
  /* A turn run once more after its node restarted carries its words itself, and goes on in the session the cut turn had. */
  const going = job.continueOf ?? job.retryOf;
  const from = going ? await continuedFrom(ctx, going, on, instructionsHash) : { sessionId: null, originalPrompt: null };
  if (from.sessionId) return { sessionId: from.sessionId, catchUp: null, originalPrompt: null };
  return { ...(await lastSession(ctx, agent, on, instructionsHash, job)), originalPrompt: job.continueOf ? from.originalPrompt : null };
}

export async function queuedSession(ctx: Ctx, agent: Agent, on: On, instructionsHash: string, job: SessionJob, along: readonly Along[]) {
  const session = await sessionFor(ctx, agent, on, instructionsHash, job);
  const prompts = await Promise.all(along.map(j => promptAlong(ctx, j, on, instructionsHash)));
  return { ...session, prompts };
}

/* What a turn asks: a continuation that lost its session says again what the turn that ended was asked. */
export const withOriginal = (asked: string, original: string | null) => (original && !asked.includes(original) ? `${asked}\n\nThe turn that ended was asked:\n\n${original}` : asked);

export type SavedSession = Pick<typeof jobs.$inferSelect, 'subscriptionId' | 'nodeId' | 'builtinMachine' | 'sessionId' | 'instructionsHash' | 'startedAt' | 'finishedAt'>;

export function companySessionStarts(agent: Agent, last: SavedSession | undefined, turn: { openedAt: Date } | undefined, job: SessionJob, startedAt: Date | null): boolean {
  if (!last || !turn || !startedAt) return false;
  if (followsRunningJob(last, job)) return false;
  return new Date(startedAt) < new Date(turn.openedAt) && !keepsSessionAcrossTurns(agent.kind);
}

export function followsRunningJob(last: SavedSession, job: SessionJob): boolean {
  return job.taskId === null && last.finishedAt !== null && job.createdAt < last.finishedAt;
}

export async function sessionStarted(ctx: Ctx, agentId: string, last: SavedSession | undefined): Promise<Date | null> {
  if (!last?.sessionId) return last?.startedAt ?? null;
  const [first] = await ctx.db.select({ at: sql<Date | null>`min(${jobs.startedAt})` }).from(jobs)
    .where(and(conversationOf(agentId), eq(jobs.sessionId, last.sessionId)));
  return first?.at ?? last.startedAt;
}

export function matchingSession(last: SavedSession | undefined, on: On, instructionsHash: string): string | null {
  return last && sameRun(last, on, instructionsHash) ? last.sessionId : null;
}

/* A new session catches up from the conversation. The last finished turn's session goes on only on the same subscription
   and node with the same instructions: another machine does not have it, and changed instructions would not reach a
   session that already has the old ones. A turn that ran out of time or was stopped in its session finished too, the
   session whole; one that broke, or was called off before it ran, leaves the session before it. Members start each turn of
   their department in a clean session with no catch-up, after the words already waiting during their work. The orchestrator and
   department heads keep their session across turns and compact it when it fills. */
export async function lastSession(ctx: Ctx, agent: Agent, on: On, instructionsHash: string, job: SessionJob): Promise<Session> {
  const repeated = await unheardSession(ctx, agent.id, job.id, on, instructionsHash);
  if (repeated) return { sessionId: repeated, catchUp: null };
  const [last] = await ctx.db
    .select({ subscriptionId: jobs.subscriptionId, nodeId: jobs.nodeId, builtinMachine: jobs.builtinMachine, sessionId: jobs.sessionId, instructionsHash: jobs.instructionsHash, startedAt: jobs.startedAt, finishedAt: jobs.finishedAt })
    .from(jobs)
    .where(and(conversationOf(agent.id), or(eq(jobs.status, 'done'), and(eq(jobs.status, 'failed'), inArray(jobs.error, ['timeout', 'cancelled']), isNotNull(jobs.sessionId)))))
    .orderBy(desc(jobs.finishedAt))
    .limit(1);
  if (await startsClean(ctx, agent, last, job)) return { sessionId: null, catchUp: null };
  const sessionId = matchingSession(last, on, instructionsHash);
  if (sessionId) return { sessionId, catchUp: null };
  return { sessionId: null, catchUp: await catchUpFor(ctx, agent) };
}

/* Whether the agent is a member whose last session started before the turn its department runs now. */
export async function startsClean(ctx: Ctx, agent: Agent, last: SavedSession | undefined, job: SessionJob): Promise<boolean> {
  const turn = await openTurnOf(ctx.db, agent.companyId, agent.departmentId);
  return companySessionStarts(agent, last, turn ? { openedAt: turn.openedAt ?? turn.createdAt } : undefined, job, await sessionStarted(ctx, agent.id, last));
}

export async function catchUpFor(ctx: Ctx, agent: Agent): Promise<string | null> {
  const talk = await earlierTalk(ctx.db, agent.id);
  return talk.length ? preface(talk, agent.kind === 'orchestrator' ? 'Orchestrator' : agent.name) : null;
}

/* The whole conversation an assistant's program sent with the message of this turn, for a new session. */
export async function freshConversation(ctx: Ctx, jobId: string): Promise<string | null> {
  const [row] = await ctx.db.select({ fresh: sql<string | null>`${agentEvents.data}->>'_fresh'` }).from(agentEvents)
    .where(and(eq(agentEvents.jobId, jobId), eq(agentEvents.kind, 'message'), sql`${agentEvents.data} ? '_fresh'`)).orderBy(desc(agentEvents.seq)).limit(1);
  return row?.fresh ?? null;
}

/* Once the turn is out, its session holds what it read: the conversation is not kept with the message. */
export async function forgetFresh(ctx: Ctx, jobId: string): Promise<void> {
  await ctx.db.update(agentEvents).set({ data: sql`${agentEvents.data} - '_fresh'` })
    .where(and(eq(agentEvents.jobId, jobId), eq(agentEvents.kind, 'message'), sql`${agentEvents.data} ? '_fresh'`));
}

/* Unheard words follow the original conversation without using its crash continuation. */
export async function unheardSession(ctx: Ctx, agentId: string, jobId: string, on: On, instructionsHash: string): Promise<string | null> {
  const [event] = await ctx.db.select({ from: sql<string | null>`${agentEvents.data}->>'unheardFrom'` }).from(agentEvents)
    .where(and(eq(agentEvents.jobId, jobId), eq(agentEvents.kind, 'typed'))).limit(1);
  const from = z.uuid().safeParse(event?.from);
  if (!from.success) return null;
  const [original] = await ctx.db.select().from(jobs).where(and(eq(jobs.id, from.data), eq(jobs.agentId, agentId)));
  return matchingSession(original, on, instructionsHash);
}

/* A continuation carried inside another task's turn takes its original work along too. */
export async function promptAlong(ctx: Ctx, job: Along, on: On, instructionsHash: string): Promise<string> {
  const from = job.continueOf ? await continuedFrom(ctx, job.continueOf, on, instructionsHash) : null;
  return withOriginal(job.prompt, from?.originalPrompt ?? null);
}
