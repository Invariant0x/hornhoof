import { and, eq, gte, inArray, lte, ne } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { jobs, taskEvents } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { conversationOf, GONE_ALONG, onAgent } from '../conversation/queue.js';
import { waitedForReturn } from '../nodes/connections.js';
import { turnAgain } from './again.js';
import { published, uncountedSinceMove } from './engine.js';
import { repeatedTurn } from './wake-state.js';

/* What an agent records on a task for what it was woken for: its work handed in, a verdict, a report, why it is blocked,
   or a question to people. */
const RECORDED = ['submitted', 'verdict', 'report', 'blocked', 'asked'] as const;
/* Ends of a turn's program that can come after the turn recorded its work all the same. */
const UNFINISHED = ['agent_failed', 'timeout'];

type Ended = Pick<typeof jobs.$inferSelect, 'agentId' | 'status' | 'error' | 'taskId' | 'startedAt' | 'finishedAt'>;

/* The other tasks whose turns went out inside this one: marked gone while it ran, as an agent runs one turn at a time. */
export async function carriedTasks(ctx: Ctx, job: { agentId: string; taskId: string; startedAt: Date | null; finishedAt: Date | null }): Promise<string[]> {
  if (!job.startedAt) return [];
  const rows = await ctx.db
    .selectDistinct({ taskId: jobs.taskId })
    .from(jobs)
    .where(and(conversationOf(job.agentId), eq(jobs.status, 'done'), eq(jobs.result, GONE_ALONG), ne(jobs.taskId, job.taskId), gte(jobs.startedAt, job.startedAt), lte(jobs.startedAt, job.finishedAt ?? new Date())));
  return rows.flatMap(r => (r.taskId ? [r.taskId] : []));
}

/* A turn whose program failed, or ran out of time, after the turn recorded what it was woken for did its work, whatever
   the code its program exited with: it is done, keeps how its program ended, and the task goes on by what it recorded.
   Only its own task and the tasks whose turns went out inside it count. */
export async function doneIfRecorded(ctx: Ctx, jobId: string, job: Ended): Promise<boolean> {
  if (job.status !== 'failed' || !job.agentId || !job.taskId || !job.startedAt || !UNFINISHED.includes(job.error ?? '')) return false;
  const taskIds = [job.taskId, ...(await carriedTasks(ctx, { agentId: job.agentId, taskId: job.taskId, startedAt: job.startedAt, finishedAt: job.finishedAt }))];
  const [recorded] = await ctx.db
    .select(idOnly(taskEvents))
    .from(taskEvents)
    .where(and(eq(taskEvents.agentId, job.agentId), inArray(taskEvents.taskId, taskIds), inArray(taskEvents.kind, [...RECORDED]), gte(taskEvents.createdAt, job.startedAt), lte(taskEvents.createdAt, job.finishedAt ?? new Date())))
    .limit(1);
  if (!recorded) return false;
  const [done] = await ctx.db.update(jobs).set({ status: 'done', error: null }).where(and(eq(jobs.id, jobId), eq(jobs.status, 'failed'))).returning({ id: jobs.id });
  return Boolean(done);
}

/* How the turn's program ended, in words for the agent and the task's log. */
function howEnded(job: Pick<typeof jobs.$inferSelect, 'exitCode' | 'exitSignal'>): string {
  if (job.exitSignal) return `its program was ended by ${job.exitSignal}`;
  if (job.exitCode !== null) return `its program exited with code ${job.exitCode}`;
  return 'its program ended';
}

/* A turn on a task whose program failed before the turn recorded what it was woken for goes on once, with a short reminder
   to finish with its tool: in its session, or, when that session cannot go on, anew with the same work, which the turn
   takes along as it goes out. One that was such a continuation already does not; its end goes on as any failed turn's.
   The first turn since the task last moved that waited in line until its node came back does not count for the stuck
   counter here either. Says whether it went on. */
export async function continueOnce(ctx: Ctx, jobId: string): Promise<'continued' | null> {
  const found = await repeatedTurn(ctx.db, jobId, 'continue');
  if (!found) return null;
  const { job, task, agent } = found;
  const how = howEnded(job);
  const note = continuationNote(job, task);
  const next = await onAgent(ctx, agent.id, () => turnAgain(ctx, found, note, { continueOf: job.id }, note));
  const then = next ? `Hornhoof goes on with it once: turn ${next}.` : `Hornhoof could not go on with it: ${agent.name} has no subscription.`;
  const afterReturn = (await waitedForReturn(ctx.db, job)) && !(await uncountedSinceMove(ctx.db, agent.id, task));
  await ctx.db.insert(taskEvents).values({
    companyId: task.companyId,
    taskId: task.id,
    kind: 'continued',
    agentId: agent.id,
    text: `${agent.name}'s turn ${job.id} ended without recording its work: ${how}. ${then}`,
    data: { job: job.id, exit: { code: job.exitCode, signal: job.exitSignal }, continuation: next, ...(afterReturn ? { afterReturn } : {}) },
  });
  published(ctx, task);
  return next ? 'continued' : null;
}

export function continuationNote(job: Pick<typeof jobs.$inferSelect, 'exitCode' | 'exitSignal'>, task: { number: number; title: string }): string {
  const how = howEnded(job);
  return `Your last turn on #${task.number} "${task.title}" ended without recording what it was woken for: ${how}. ` +
    'Finish that work now and record it with your Hornhoof tool: hand it in, give your verdict, report, say why you are blocked or ask people, whichever the turn was for.';
}
