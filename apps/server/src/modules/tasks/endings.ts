import { and, eq, gte, inArray, lte } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs, taskEvents, tasks } from '../../db/schema.js';
import { onAgent } from '../conversation/queue.js';
import { turnAgain } from './again.js';
import { published } from './engine.js';

/* What an agent records on a task for what it was woken for: its work handed in, a verdict, a report, why it is blocked,
   or a question to people. */
const RECORDED = ['submitted', 'verdict', 'report', 'blocked', 'asked'] as const;
/* Ends of a turn's program that can come after the turn recorded its work all the same. */
const UNFINISHED = ['agent_failed', 'timeout', 'lost_ending'];
/* A task the agent may still be at, as the continuation needs. */
const AT_WORK = ['open', 'working', 'review'];

type Ended = Pick<typeof jobs.$inferSelect, 'agentId' | 'status' | 'error' | 'taskId' | 'startedAt' | 'finishedAt'>;

/* A turn whose program failed, or ran out of time, after the turn recorded what it was woken for did its work, whatever
   the code its program exited with: it is done, keeps how its program ended, and the task goes on by what it recorded.
   An agent runs one turn at a time, so what it recorded on any task while this turn ran is this turn's. */
export async function doneIfRecorded(ctx: Ctx, jobId: string, job: Ended): Promise<boolean> {
  if (job.status !== 'failed' || !job.agentId || !job.taskId || !job.startedAt || !UNFINISHED.includes(job.error ?? '')) return false;
  const [recorded] = await ctx.db
    .select({ id: taskEvents.id })
    .from(taskEvents)
    .where(and(eq(taskEvents.agentId, job.agentId), inArray(taskEvents.kind, [...RECORDED]), gte(taskEvents.createdAt, job.startedAt), lte(taskEvents.createdAt, job.finishedAt ?? new Date())))
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

/* A turn on a task whose program failed before the turn recorded what it was woken for goes on once: in its session, with
   a short reminder to finish with its tool, or, when its program never named a session, anew with the same work. One that
   was such a continuation already does not; its end goes on as any failed turn's. Says whether it went on. */
export async function continueOnce(ctx: Ctx, jobId: string): Promise<'continued' | null> {
  const [found] = await ctx.db.select({ job: jobs, task: tasks, agent: agents }).from(jobs).innerJoin(tasks, eq(tasks.id, jobs.taskId)).innerJoin(agents, eq(agents.id, jobs.agentId)).where(eq(jobs.id, jobId));
  if (!found || found.job.status !== 'failed' || found.job.error !== 'agent_failed' || found.job.continueOf || !AT_WORK.includes(found.task.status)) return null;
  const { job, task, agent } = found;
  const how = howEnded(job);
  const note =
    `Your last turn on #${task.number} "${task.title}" ended without recording what it was woken for: ${how}. ` +
    'Finish that work now and record it with your Hornhoof tool: hand it in, give your verdict, report, say why you are blocked or ask people, whichever the turn was for.';
  const prompt = job.sessionId ? note : `${note}\n\nThat turn was asked:\n\n${job.prompt}`;
  const next = await onAgent(ctx, agent.id, () => turnAgain(ctx, found, note, { continueOf: job.id }, prompt));
  const then = next ? `Hornhoof goes on with it once: turn ${next}.` : `Hornhoof could not go on with it: ${agent.name} has no subscription.`;
  await ctx.db.insert(taskEvents).values({
    companyId: task.companyId,
    taskId: task.id,
    kind: 'continued',
    agentId: agent.id,
    text: `${agent.name}'s turn ${job.id} ended without recording its work: ${how}. ${then}`,
    data: { job: job.id, exit: { code: job.exitCode, signal: job.exitSignal }, continuation: next },
  });
  published(ctx, task);
  return next ? 'continued' : null;
}
