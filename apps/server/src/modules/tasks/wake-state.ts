import { lastBytes, type Failure } from '@hornhoof/protocol';
import { ECHELON_STAGES, type EchelonsSnapshot } from '@hornhoof/protocol/echelons';
import type { TurnProgram } from '@hornhoof/protocol/map';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { agentEvents, agents, jobs, taskEvents, tasks, TASK_STATUSES } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { routeOf, routeSnapshot } from './echelons-store.js';
import { CLOSED, type Task, type Tx, type Wake } from './engine.js';

/* Kept in the wake's existing message JSON, so its purpose and phase survive a server restart. */
const State = z.object({ why: z.string(), status: z.enum(TASK_STATUSES), stage: z.enum(ECHELON_STAGES).nullable(), candidateId: z.uuid().nullable(), version: z.number().int().nonnegative().optional(), to: z.string().optional() });
export type TaskWake = z.infer<typeof State>;
type TaskTurn = { id: string; agentId: string | null; taskId: string | null };
type Store = Db | Tx;

const NOTICES = new Set(['done', 'reported', 'cancelled', 'turn', 'reviewed']);
const GIVER_NEWS = new Set(['blocked', 'switched', 'tests', 'work']);
const REVIEW = new Set(['review']);
const RUN_ENDS = new Set(['tests', 'work']);

export const taskWakeOf = (task: Task, wake: Pick<Wake, 'why' | 'version'>, route: Pick<EchelonsSnapshot, 'stage' | 'candidateId'>): TaskWake => ({ why: wake.why, status: task.status, stage: route.stage, candidateId: route.candidateId, version: wake.version });

const isNotice = (state: TaskWake | null): boolean => state !== null && NOTICES.has(state.why);

/* A message addressed to someone other than the task's assignee stays deliverable unless the task was cancelled. */
const directMessage = (task: Task, agentId: string, state: TaskWake | null): boolean =>
  state?.why === 'message' && state.to === agentId && task.status !== 'cancelled';

async function samePhase(db: Store, task: Task, state: TaskWake | null): Promise<boolean> {
  if (!state) return false;
  const route = await routeOf(db, task);
  return sameStatus(task, state) && state.stage === route.state.stage && state.candidateId === route.state.candidateId && sameVersion(task, state);
}

/* Messages follow their recipient through status changes within the same workflow stage. */
const sameStatus = (task: Task, state: TaskWake): boolean => state.why === 'message' || state.status === task.status;

/* Only a wake that names a version expires when the task moves on; other wakes follow their status, stage and candidate. */
const sameVersion = (task: Task, state: TaskWake): boolean => state.why === 'message' || state.version === undefined || state.version === task.version;

export const onTask = (task: Task, agentId: string): boolean => task.assigneeAgentId === agentId;
const assignment = (task: Task, agentId: string): boolean => ['open', 'working'].includes(task.status) && task.assigneeAgentId === agentId;
const review = (task: Task, agentId: string): boolean => task.status === 'review' && task.assigneeAgentId === agentId;

function recipient(task: Task, agentId: string, why = ''): boolean {
  if (why === 'assigned') return assignment(task, agentId);
  if (REVIEW.has(why)) return review(task, agentId);
  if (GIVER_NEWS.has(why)) return task.createdByAgentId === agentId || onTask(task, agentId);
  return onTask(task, agentId);
}

/* Escalations reach the live department head even when a worker created the task. */
async function wakeRecipient(db: Store, task: Task, agentId: string, why = ''): Promise<boolean> {
  if (why === 'blocked' && !recipient(task, agentId, why)) {
    const [head] = await db.select(idOnly(agents)).from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, task.companyId), eq(agents.departmentId, task.departmentId!), eq(agents.kind, 'head'), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
    return head !== undefined;
  }
  if (why !== 'after_cancelled') return recipient(task, agentId, why);
  if (task.createdByAgentId) return task.createdByAgentId === agentId;
  const [orchestrator] = await db.select(idOnly(agents)).from(agents)
    .where(and(eq(agents.companyId, task.companyId), eq(agents.kind, 'orchestrator'), isNull(agents.removedAt)));
  return orchestrator?.id === agentId;
}

/* A wait holds back what would set its task's holder to work. The end of a run is the result someone asked for, told once
   and nowhere else, so no wait hides it. */
const heldByWait = (task: Task, state: TaskWake | null): boolean => Boolean(task.externalWait) && !RUN_ENDS.has(state?.why ?? '');

async function applies(db: Store, task: Task, agentId: string, state: TaskWake | null): Promise<boolean> {
  /* Paused work wakes nobody, not even with a message about it, until it is resumed. */
  if (task.paused && !CLOSED.includes(task.status)) return false;
  if (isNotice(state) || directMessage(task, agentId, state)) return true;
  return !heldByWait(task, state) && !CLOSED.includes(task.status) && (await samePhase(db, task, state)) && (await wakeRecipient(db, task, agentId, state?.why));
}

/* Validate again when a delayed outbox wake is queued, before it can reach a live terminal. */
export async function taskForWake(db: Db, wake: Wake): Promise<Task | null> {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, wake.taskId));
  return task ? checkedTask(db, task, wake.agentId, taskWakeOf(task, wake, routeSnapshot(await routeOf(db, task), task.assigneeAgentId)), wake.why) : null;
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

/* A repeat keeps its original candidate and stage, while refreshing progress within that assignment. */
export async function repeatWake(db: Db, { job, task, agent }: Ended, run: string): Promise<TaskWake | null> {
  const before = await stateOf(db, job.id);
  const route = routeSnapshot(await routeOf(db, task), task.assigneeAgentId);
  const state = { ...(before ?? taskWakeOf(task, { why: 'go_on' }, route)), status: task.status, version: task.version };
  return (await checkedTask(db, task, agent.id, state, run, job.id)) ? state : null;
}

/* The log is English for agents; the web uses wake and its author's name to translate it for people. */
async function logSkipped(db: Store, task: Task, agentId: string, wake: string, job: string | null): Promise<void> {
  if (!CLOSED.includes(task.status)) return;
  const [agent] = await db.select(only(agents, 'name')).from(agents).where(eq(agents.id, agentId));
  await db.insert(taskEvents).values({ companyId: task.companyId, taskId: task.id, agentId, kind: 'wake_skipped', text: `Run skipped: task is already closed. ${agent!.name}: ${wake}.`, data: { wake, job } });
}

const wakeIn = (data: unknown): TaskWake | null => {
  const parsed = z.object({ taskWake: State }).safeParse(data);
  return parsed.success ? parsed.data.taskWake : null;
};

async function stateOf(db: Store, jobId: string): Promise<TaskWake | null> {
  const [message] = await db.select(only(agentEvents, 'data')).from(agentEvents)
    .where(and(eq(agentEvents.jobId, jobId), inArray(agentEvents.kind, ['message', 'typed']))).orderBy(asc(agentEvents.seq)).limit(1);
  return wakeIn(message?.data);
}

/* Retain an unsent job and its explanation; it neither starts work nor triggers afterJob's continuation logic. */
export async function discardStaleTurn(db: Store, job: TaskTurn): Promise<boolean> {
  if (!job.taskId || !job.agentId) return false;
  const [row] = await db.select({ task: tasks, kind: agents.kind, job: jobs }).from(tasks)
    .innerJoin(agents, eq(agents.id, job.agentId)).innerJoin(jobs, eq(jobs.id, job.id)).where(eq(tasks.id, job.taskId));
  if (!row) throw new Error('A queued task turn lost its task or agent.');
  const state = await stateOf(db, job.id);
  if (await applies(db, row.task, job.agentId, state)) return false;
  await recordStale(db, job.id, job.agentId, row.task, runOf(row.job, state), 'queued');
  return true;
}

const runOf = (job: typeof jobs.$inferSelect, state: TaskWake | null): string => job.retryOf ? 'restart' : job.continueOf ? 'continue' : state ? state.why : 'task';

export type StaleProgram = Pick<TurnProgram, 'state' | 'since' | 'tool' | 'signAt'>;

export function staleOutput(text: string): string {
  const tail = lastBytes(text).trimEnd();
  return tail ? tail.split('\n').slice(-200).join('\n') : 'No output.';
}

function staleFailure(task: Task, run: string, status: 'queued' | 'running', program: StaleProgram | null): Failure {
  const state = status === 'queued' ? 'not started' : program ? `${program.state}${program.tool ? ` (${program.tool})` : ''}, since ${new Date(program.since).toISOString()}` : 'no data';
  const signAt = status === 'running' && program?.signAt != null ? new Date(program.signAt).toISOString() : 'no data';
  const text = `Stale turn: #${task.number} no longer waits for this action from the agent. Technical reason: task status=${task.status}, taskVersion=${task.version}, action=${run}, turn status=${status}. Program state: ${state}. Last sign of life: ${signAt}.`;
  return { kind: 'unknown', text, retryable: false };
}

async function logObsolete(db: Store, task: Task, agentId: string, wake: string, jobId: string): Promise<void> {
  const [agent] = await db.select(only(agents, 'name')).from(agents).where(eq(agents.id, agentId));
  const text = `Wake-up became obsolete: the task moved on. ${agent!.name}: ${wake}.`;
  await db.insert(taskEvents).values({ companyId: task.companyId, taskId: task.id, agentId, kind: 'wake_obsolete', text, data: { wake, job: jobId } });
}

export async function recordStale(db: Store, jobId: string, agentId: string, task: Task, run: string, status: 'queued' | 'running', program: StaleProgram | null = null): Promise<boolean> {
  const failure = staleFailure(task, run, status, program);
  const text = status === 'queued' ? `Wake-up became obsolete: task #${task.number} moved on. ${failure.text}` : failure.text;
  const tail = staleOutput('');
  const [ended] = await db.update(jobs).set({ status: status === 'queued' ? 'obsolete' : 'failed', error: 'stale', result: text, failure: status === 'queued' ? null : failure, tail, finishedAt: new Date() })
    .where(and(eq(jobs.id, jobId), eq(jobs.status, status))).returning({ id: jobs.id });
  if (!ended) return false;
  const reason = status === 'queued' ? 'obsolete' : 'stale';
  await db.insert(agentEvents).values({ companyId: task.companyId, agentId, jobId, kind: 'stopped', data: { reason, text, ...(status === 'running' ? { failure } : {}), tail, program, task: { id: task.id, number: task.number } } });
  /* A running turn was already logged by repeatWake; queued work reaches this path directly. */
  if (status === 'queued') await logObsolete(db, task, agentId, run, jobId);
  return true;
}

/* take holds these task rows until it claims the jobs. A concurrent task move cannot slip between the check and claim. */
export async function discardStaleTurns(db: Store, waiting: readonly TaskTurn[]): Promise<boolean> {
  const ids = [...new Set(waiting.map(j => j.taskId).filter((id): id is string => id !== null))];
  if (ids.length) await db.select(idOnly(tasks)).from(tasks).where(inArray(tasks.id, ids)).orderBy(asc(tasks.id)).for('share');
  let stale = false;
  for (const job of waiting) stale = (await discardStaleTurn(db, job)) || stale;
  return stale;
}

/* An old step must not swallow a new wake merely because both name the same agent and task. */
export async function waitingTaskTurn(db: Db, agentId: string, taskId: string): Promise<{ id: string } | undefined> {
  const waiting = await db.select({ id: jobs.id, agentId: jobs.agentId, taskId: jobs.taskId }).from(jobs)
    .where(and(eq(jobs.agentId, agentId), eq(jobs.taskId, taskId), eq(jobs.status, 'queued'), sql`not exists (select 1 from agent_events e where e.job_id = ${jobs.id} and e.data->>'report' is not null)`)).orderBy(asc(jobs.createdAt));
  await discardStaleTurns(db, waiting);
  const [current] = await db.select(idOnly(jobs)).from(jobs)
    .where(and(eq(jobs.agentId, agentId), eq(jobs.taskId, taskId), eq(jobs.status, 'queued'), sql`not exists (select 1 from agent_events e where e.job_id = ${jobs.id} and e.data->>'report' is not null)`)).limit(1);
  return current;
}
