import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, notInArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, departments, jobs, requests, tasks, testRuns, turns } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { CLOSED, openAfter, type Task } from './state.js';
import { waitingCycles } from './wait-graph.js';
import { workOfOpenTurn } from './turn-department.js';

const QUIET_DEPARTMENT_MS = 15 * 60_000;
export const waitKey = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const taskVersions = (rows: Task[]) => rows.map(t => ({ id: t.id, version: t.version })).sort((a, b) => a.id.localeCompare(b.id));

export async function waitCycles(ctx: Ctx, now: Date) {
  const rows = await ctx.db.select({ task: tasks, employee: agents }).from(tasks).innerJoin(agents, eq(agents.id, tasks.assigneeAgentId)).where(and(
    notInArray(tasks.status, [...CLOSED]), isNull(agents.removedAt), isNull(agents.switchedOffAt),
  ));
  const edges = rows.flatMap(({ task, employee }) => !task.externalWait?.work && task.externalWait?.on?.kind === 'employee' && new Date(task.externalWait.until) > now
    ? [{ from: employee.id, to: task.externalWait.on.employee, task, name: employee.name }] : []);
  return waitingCycles(edges);
}

export async function departmentScope(ctx: Pick<Ctx, 'db'>, companyId: string, root: string): Promise<string[]> {
  const rows = await ctx.db.select().from(departments).where(eq(departments.companyId, companyId));
  const scope = new Set([root]);
  let previous = 0;
  while (previous !== scope.size) {
    previous = scope.size;
    for (const row of rows) if (row.parentId && scope.has(row.parentId)) scope.add(row.id);
  }
  return [...scope];
}

/* Work nothing explains: no one is on it and it waits for nothing known. */
async function unexplained(ctx: Ctx, rows: Task[], now: Date): Promise<Task[]> {
  const silent: Task[] = [];
  for (const task of rows) if (!(await taskWaitReason(ctx, task, now))) silent.push(task);
  return silent;
}

async function taskWaitReason(ctx: Ctx, task: Task, now: Date): Promise<string | null> {
  if (task.externalWait && new Date(task.externalWait.until) > now) return `${task.externalWait.reason}, until ${task.externalWait.until}`;
  if (task.status === 'blocked' || task.status === 'waiting') return task.status;
  /* A pause holds work so that nothing wakes its holder, whatever its status: its reason explains the quiet. */
  if (task.paused) return `paused: ${task.paused.reason}`;
  return await waitingForTasks(ctx, task) ?? await waitingForService(ctx, task);
}

async function waitingForTasks(ctx: Ctx, task: Task): Promise<string | null> {
  if ((await openAfter(ctx.db, task)).length) return 'waiting for prerequisite tasks';
  const [child] = await ctx.db.select(idOnly(tasks)).from(tasks).where(and(eq(tasks.parentId, task.id), notInArray(tasks.status, [...CLOSED]))).limit(1);
  return child ? 'waiting for subtasks' : null;
}

async function waitingForService(ctx: Ctx, task: Task): Promise<string | null> {
  const [request] = await ctx.db.select(idOnly(requests)).from(requests).where(and(eq(requests.taskId, task.id), eq(requests.status, 'open'))).limit(1);
  if (request) return 'waiting for a person';
  const [test] = await ctx.db.select(idOnly(testRuns)).from(testRuns).where(and(eq(testRuns.taskId, task.id), eq(testRuns.status, 'running'))).limit(1);
  return test ? 'waiting for a test run' : null;
}

/* The last thing that says the department was at work: lastEnded is when the last conversation that began ended. */
const silentSince = (turn: typeof turns.$inferSelect, work: (typeof tasks.$inferSelect)[], lastEnded: Date | null): Date => new Date(Math.max(
  (turn.openedAt ?? turn.createdAt).getTime(), ...work.map(t => t.updatedAt.getTime()),
  ...(lastEnded ? [lastEnded.getTime()] : []),
  /* A wait that ran out explained the work until then: the silence starts there. */
  ...work.flatMap(t => t.externalWait ? [new Date(t.externalWait.until).getTime()] : []),
));

/* What the quiet check asks of the conversations of a department: whether one runs, and when the last one that began ended.
   The check runs every minute for every department, and a conversation holds its whole prompt, tail and result, so it asks for
   two figures and no conversation. Two index reads, one for the employees' conversations and one for the work's, each a single
   aggregate (the index jobs_conversation_activity answers them alone). */
export type ConversationActivity = { running: boolean; lastEnded: Date | null };

const figures = () => ({
  running: sql<boolean | null>`bool_or(${jobs.status} = 'running')`,
  lastEnded: sql<Date | null>`max(${jobs.finishedAt}) filter (where ${jobs.startedAt} is not null)`.mapWith(jobs.finishedAt),
});

const conversationsOf = (ctx: Pick<Ctx, 'db'>, companyId: string, belonging: SQL) =>
  ctx.db.select(figures()).from(jobs).where(and(eq(jobs.companyId, companyId), eq(jobs.kind, 'conversation'), belonging));

const lastOf = (...ends: (Date | null)[]): Date | null => ends.reduce<Date | null>((last, end) => (end && (!last || end > last) ? end : last), null);

export async function conversationActivity(ctx: Pick<Ctx, 'db'>, companyId: string, employees: SQLWrapper, taskIds: string[]): Promise<ConversationActivity> {
  const [ofEmployees] = await conversationsOf(ctx, companyId, inArray(jobs.agentId, employees));
  const [ofWork] = await conversationsOf(ctx, companyId, inArray(jobs.taskId, taskIds));
  return { running: Boolean(ofEmployees?.running || ofWork?.running), lastEnded: lastOf(ofEmployees?.lastEnded ?? null, ofWork?.lastEnded ?? null) };
}

export async function quietDepartment(ctx: Ctx, turnId: string, departmentId: string, now: Date) {
  const [turn] = await ctx.db.select().from(turns).where(and(eq(turns.id, turnId), eq(turns.status, 'open')));
  if (!turn) return null;
  const scope = await departmentScope(ctx, turn.companyId, departmentId);
  const work = await ctx.db.select().from(tasks).where(and(workOfOpenTurn(turn.id), inArray(tasks.departmentId, scope), notInArray(tasks.status, [...CLOSED])));
  if (!work.length) return null;
  const employees = ctx.db.select(idOnly(agents)).from(agents).where(and(eq(agents.companyId, turn.companyId), inArray(agents.departmentId, scope)));
  const activity = await conversationActivity(ctx, turn.companyId, employees, work.map(task => task.id));
  if (activity.running) return null;
  /* A department where all of it waits for something known, in time, has nothing to say. */
  const silent = await unexplained(ctx, work, now);
  if (!silent.length) return null;
  const since = silentSince(turn, work, activity.lastEnded);
  if (now.getTime() - since.getTime() < QUIET_DEPARTMENT_MS) return null;
  const versions = taskVersions(work);
  return { companyId: turn.companyId, work, silent, since, key: waitKey([turn.id, departmentId, versions, since.toISOString()]) };
}
