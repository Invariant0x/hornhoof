import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { agentEvents, agents, jobs, taskEvents, tasks, TASK_STATUSES } from '../../db/schema.js';
import { requestedPromptOf } from '../conversation/requested-prompt.js';
import { CLOSED, type Task, type Tx, type Wake } from './engine.js';

/* Kept in the wake's existing message JSON, so its purpose and phase survive a server restart. */
const State = z.object({ why: z.string(), status: z.enum(TASK_STATUSES), stage: z.number().int().nonnegative(), merging: z.boolean(), version: z.number().int().nonnegative().optional(), to: z.string().optional() });
export type TaskWake = z.infer<typeof State>;
type TaskTurn = { id: string; agentId: string | null; taskId: string | null };
type Store = Db | Tx;

const NOTICES = new Set(['done', 'reported', 'cancelled', 'turn', 'reviewed', 'review_passed']);
const GIVER_NEWS = new Set(['blocked', 'stuck_at_gate', 'tests', 'work']);
const REVIEW = new Set(['review', 'turn_review']);

export const taskWakeOf = (task: Task, wake: Pick<Wake, 'why' | 'version'>): TaskWake => ({ why: wake.why, status: task.status, stage: task.stage, merging: task.merging, version: wake.version });

/* Legacy turns have no snapshot. Only their known server-written notice prefixes identify a notice to the giver. */
const isNotice = (state: TaskWake | null): boolean => state !== null && NOTICES.has(state.why);

/* A message addressed to someone other than the task's assignee stays deliverable unless the task was cancelled. */
const directMessage = (task: Task, agentId: string, state: TaskWake | null): boolean =>
  state?.why === 'message' && state.to === agentId && task.status !== 'cancelled';

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
  state === null || (sameStatus(task, state) && state.stage === task.stage && state.merging === task.merging && sameVersion(task, state));

/* Messages follow their recipient through status changes within the same workflow stage. */
const sameStatus = (task: Task, state: TaskWake): boolean => state.why === 'message' || state.status === task.status;

const sameVersion = (task: Task, state: TaskWake): boolean => state.version === undefined || state.version === task.version;

export const onTask = (task: Task, agentId: string): boolean => task.assigneeAgentId === agentId || (task.stage > 0 && task.panel.includes(agentId));
const assignment = (task: Task, agentId: string): boolean => ['open', 'working'].includes(task.status) && !task.merging && task.assigneeAgentId === agentId;
const review = (task: Task, agentId: string): boolean => task.status === 'review' && task.panel.includes(agentId);

function recipient(task: Task, agentId: string, why = ''): boolean {
  if (why === 'assigned') return assignment(task, agentId);
  if (why === 'merge') return task.merging && task.assigneeAgentId === agentId;
  if (REVIEW.has(why)) return review(task, agentId);
  if (GIVER_NEWS.has(why)) return task.createdByAgentId === agentId || onTask(task, agentId);
  return onTask(task, agentId);
}

/* A cancelled prerequisite is news for the dependent task's creator, not its executor or reviewers. */
async function wakeRecipient(db: Store, task: Task, agentId: string, why = ''): Promise<boolean> {
  if (why !== 'after_cancelled') return recipient(task, agentId, why);
  if (task.createdByAgentId) return task.createdByAgentId === agentId;
  const [orchestrator] = await db.select({ id: agents.id }).from(agents)
    .where(and(eq(agents.companyId, task.companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt)));
  return orchestrator?.id === agentId;
}

async function applies(db: Store, task: Task, agentId: string, state: TaskWake | null): Promise<boolean> {
  if (isNotice(state) || directMessage(task, agentId, state)) return true;
  return !task.externalWait && !CLOSED.includes(task.status) && samePhase(task, state) && (await wakeRecipient(db, task, agentId, state?.why));
}

/* Validate again when a delayed outbox wake is queued, before it can reach a live terminal. */
export async function taskForWake(db: Db, wake: Wake): Promise<Task | null> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, wake.taskId));
  return task ? checkedTask(db, task, wake.agentId, taskWakeOf(task, wake), wake.why) : null;
}

/* Every task action, including a repeat, goes through the same policy before it can wake anybody. */
async function checkedTask(db: Store, task: Task, agentId: string, state: TaskWake | null, run: string, job: string | null = null): Promise<Task | null> {
  if (await applies(db, task, agentId, state)) return task;
  await logSkipped(db, task, agentId, run, job);
  return null;
}

type Ended = { job: typeof jobs.$inferSelect; task: Task; agent: typeof agents.$inferSelect };
type Repeat = 'restart' | 'continue';
const REPEAT_ERRORS: Record<Repeat, string> = { restart: 'machine_restarted', continue: 'agent_failed' };
const mayRepeat = (job: Ended['job'], run: Repeat): boolean => job.status === 'failed' && job.error === REPEAT_ERRORS[run] && (run !== 'continue' || !job.continueOf);

/* Load the current task once for either kind of repeat; no caller makes its own wake decision. */
export async function repeatedTurn(db: Db, jobId: string, run: Repeat): Promise<(Ended & { taskWake: TaskWake }) | null> {
  const [found] = await db.select({ job: jobs, task: tasks, agent: agents }).from(jobs).innerJoin(tasks, eq(tasks.id, jobs.taskId)).innerJoin(agents, eq(agents.id, jobs.agentId)).where(eq(jobs.id, jobId));
  if (!found || !mayRepeat(found.job, run)) return null;
  const taskWake = await repeatWake(db, found, run);
  return taskWake ? { ...found, taskWake } : null;
}

/* A running turn may have started work or received messages since it was queued. Keep its purpose and workflow stage,
   but refresh the status and version for the next turn. Legacy notices retain their exception for the task's giver. */
export async function repeatWake(db: Db, { job, task, agent }: Ended, run: string): Promise<TaskWake | null> {
  const before = await stateOf(db, job.id);
  const why = before ? before.why : (legacyNotice(task, agent.id, agent.kind, requestedPromptOf(job)) ? 'done' : 'go_on');
  const state = { ...before, why, status: task.status, stage: before?.stage ?? task.stage, merging: before?.merging ?? task.merging, version: task.version };
  return (await checkedTask(db, task, agent.id, state, run, job.id)) ? state : null;
}

/* The log is English for agents; the web uses wake and its author's name to translate it for people. */
async function logSkipped(db: Store, task: Task, agentId: string, wake: string, job: string | null): Promise<void> {
  if (!CLOSED.includes(task.status)) return;
  const [agent] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId));
  await db.insert(taskEvents).values({ companyId: task.companyId, taskId: task.id, agentId, kind: 'wake_skipped', text: `Run skipped: task is already closed. ${agent!.name}: ${wake}.`, data: { wake, job } });
}

async function stateOf(db: Store, jobId: string): Promise<TaskWake | null> {
  const [message] = await db.select({ data: agentEvents.data }).from(agentEvents)
    .where(and(eq(agentEvents.jobId, jobId), inArray(agentEvents.kind, ['message', 'typed']))).orderBy(asc(agentEvents.seq)).limit(1);
  const parsed = z.object({ taskWake: State }).safeParse(message?.data);
  return parsed.success ? parsed.data.taskWake : null;
}

/* Retain an unsent job and its explanation; it neither starts work nor triggers afterJob's continuation logic. */
export async function discardStaleTurn(db: Store, job: TaskTurn): Promise<boolean> {
  if (!job.taskId || !job.agentId) return false;
  const [row] = await db.select({ task: tasks, kind: agents.kind, job: jobs }).from(tasks)
    .innerJoin(agents, eq(agents.id, job.agentId)).innerJoin(jobs, eq(jobs.id, job.id)).where(eq(tasks.id, job.taskId));
  if (!row) throw new Error('A queued task turn lost its task or agent.');
  const state = await stateOf(db, job.id);
  if (state === null && legacyNotice(row.task, job.agentId, row.kind, row.job.prompt)) return false;
  if (await applies(db, row.task, job.agentId, state)) return false;
  await recordStale(db, job.id, job.agentId, row.task, runOf(row.job, state), 'queued');
  return true;
}

const runOf = (job: typeof jobs.$inferSelect, state: TaskWake | null): string => job.retryOf ? 'restart' : job.continueOf ? 'continue' : state ? state.why : 'task';

export async function recordStale(db: Store, jobId: string, agentId: string, task: Task, run: string, status: 'queued' | 'running'): Promise<boolean> {
  const text = `Stale turn: #${task.number} no longer waits for this action from the agent.`;
  const [ended] = await db.update(jobs).set({ status: 'failed', error: 'stale', result: text, finishedAt: new Date() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, status))).returning({ id: jobs.id });
  if (!ended) return false;
  await db.insert(agentEvents).values({ companyId: task.companyId, agentId, jobId, kind: 'stopped', data: { reason: 'stale', text, task: { id: task.id, number: task.number } } });
  /* A running turn was already logged by repeatWake; queued work reaches this path directly. */
  if (status === 'queued') await logSkipped(db, task, agentId, run, jobId);
  return true;
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
