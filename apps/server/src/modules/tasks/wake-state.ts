import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { agentEvents, agents, jobs, tasks, TASK_STATUSES } from '../../db/schema.js';
import { CLOSED, type Task, type Tx, type Wake } from './engine.js';

/* Kept in the wake's existing message JSON, so its purpose and phase survive a server restart. */
const State = z.object({ why: z.string(), status: z.enum(TASK_STATUSES), stage: z.number().int().nonnegative(), merging: z.boolean() });
export type TaskWake = z.infer<typeof State>;
type TaskTurn = { id: string; agentId: string | null; taskId: string | null };
type Store = Db | Tx;

const NOTICES = new Set(['done', 'reported', 'cancelled', 'turn', 'reviewed', 'review_passed']);
const GIVER_NEWS = new Set(['blocked', 'stuck_at_gate', 'tests', 'work']);
const REVIEW = new Set(['review', 'turn_review']);

export const taskWakeOf = (task: Task, wake: Pick<Wake, 'why'>): TaskWake => ({ why: wake.why, status: task.status, stage: task.stage, merging: task.merging });

/* Legacy turns have no snapshot. Only their known server-written notice prefixes identify a notice to the giver. */
const isNotice = (state: TaskWake | null): boolean => state !== null && NOTICES.has(state.why);

const legacyNotice = (task: Task, agentId: string, kind: string, prompt: string): boolean =>
  kind !== 'worker' && task.createdByAgentId === agentId && legacyReport(task, prompt);

function legacyReport(task: Task, prompt: string): boolean {
  const ref = `#${task.number} "${task.title}"`;
  const notices = [
    `${ref}, which you gave out, passed its gates and is done.`,
    `${ref}, which you gave out, was reported done`,
    `${ref}, which you gave out, was cancelled`,
    `${ref} is closed.`,
    `The reviewers of ${ref} gave their verdicts,`,
    `Nobody found anything that blocks in the ${task.title.toLowerCase()}:`,
  ];
  return notices.some(prefix => prompt.startsWith(prefix)) || (!CLOSED.includes(task.status) && prompt.startsWith(`${ref}, which you gave out,`));
}

const samePhase = (task: Task, state: TaskWake | null): boolean =>
  state === null || (state.status === task.status && state.stage === task.stage && state.merging === task.merging);

const onTask = (task: Task, agentId: string): boolean => task.assigneeAgentId === agentId || task.panel.includes(agentId);
const assignment = (task: Task, agentId: string): boolean => ['open', 'working'].includes(task.status) && !task.merging && task.assigneeAgentId === agentId;
const review = (task: Task, agentId: string): boolean => task.status === 'review' && task.panel.includes(agentId);

function recipient(task: Task, agentId: string, why = ''): boolean {
  if (why === 'assigned') return assignment(task, agentId);
  if (why === 'merge') return task.merging && task.assigneeAgentId === agentId;
  if (REVIEW.has(why)) return review(task, agentId);
  if (GIVER_NEWS.has(why)) return task.createdByAgentId === agentId || onTask(task, agentId);
  return onTask(task, agentId);
}

function applies(task: Task, agentId: string, state: TaskWake | null): boolean {
  if (isNotice(state)) return true;
  return !CLOSED.includes(task.status) && samePhase(task, state) && recipient(task, agentId, state?.why);
}

/* Validate again when a delayed outbox wake is queued, before it can reach a live terminal. */
export async function taskForWake(db: Db, wake: Wake): Promise<Task | null> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, wake.taskId));
  return task && applies(task, wake.agentId, taskWakeOf(task, wake)) ? task : null;
}

async function stateOf(db: Store, jobId: string): Promise<TaskWake | null> {
  const [message] = await db.select({ data: agentEvents.data }).from(agentEvents)
    .where(and(eq(agentEvents.jobId, jobId), eq(agentEvents.kind, 'message'))).orderBy(asc(agentEvents.seq)).limit(1);
  const parsed = z.object({ taskWake: State }).safeParse(message?.data);
  return parsed.success ? parsed.data.taskWake : null;
}

/* Retain an unsent job and its explanation; it neither starts work nor triggers afterJob's continuation logic. */
export async function discardStaleTurn(db: Store, job: TaskTurn): Promise<boolean> {
  if (!job.taskId || !job.agentId) return false;
  const [row] = await db.select({ task: tasks, kind: agents.kind, prompt: jobs.prompt }).from(tasks)
    .innerJoin(agents, eq(agents.id, job.agentId)).innerJoin(jobs, eq(jobs.id, job.id)).where(eq(tasks.id, job.taskId));
  if (!row) throw new Error('A queued task turn lost its task or agent.');
  const state = await stateOf(db, job.id);
  if (state === null && legacyNotice(row.task, job.agentId, row.kind, row.prompt)) return false;
  if (applies(row.task, job.agentId, state)) return false;
  await recordStale(db, job.id, job.agentId, row.task);
  return true;
}

async function recordStale(db: Store, jobId: string, agentId: string, task: Task): Promise<void> {
  const text = `Stale turn: #${task.number} no longer waits for this action from the agent.`;
  const [ended] = await db.update(jobs).set({ status: 'failed', error: 'stale', result: text, finishedAt: new Date() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, 'queued'))).returning({ id: jobs.id });
  if (!ended) return;
  await db.insert(agentEvents).values({ companyId: task.companyId, agentId, jobId, kind: 'stopped', data: { reason: 'stale', text, task: { id: task.id, number: task.number } } });
}

/* take holds these task rows until it claims the jobs. A concurrent task move cannot slip between the check and claim. */
export async function discardStaleTurns(db: Store, waiting: readonly TaskTurn[]): Promise<boolean> {
  const ids = [...new Set(waiting.map(j => j.taskId).filter((id): id is string => id !== null))];
  if (ids.length) await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, ids)).orderBy(asc(tasks.id)).for('share');
  let stale = false;
  for (const job of waiting) stale = (await discardStaleTurn(db, job)) || stale;
  return stale;
}

/* An old step must not swallow a new wake merely because both name the same agent and task. */
export async function waitingTaskTurn(db: Db, agentId: string, taskId: string): Promise<{ id: string } | undefined> {
  const waiting = await db.select({ id: jobs.id, agentId: jobs.agentId, taskId: jobs.taskId }).from(jobs)
    .where(and(eq(jobs.agentId, agentId), eq(jobs.taskId, taskId), eq(jobs.status, 'queued'))).orderBy(asc(jobs.createdAt));
  await discardStaleTurns(db, waiting);
  const [current] = await db.select({ id: jobs.id }).from(jobs)
    .where(and(eq(jobs.agentId, agentId), eq(jobs.taskId, taskId), eq(jobs.status, 'queued'))).limit(1);
  return current;
}
