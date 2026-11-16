import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, notInArray, or } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, departments, jobs, requests, tasks, testRuns, turns } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { CLOSED, openAfter, type Task } from './engine.js';
import { waitingCycles } from './wait-graph.js';
import { workOfOpenTurn } from './turn-department.js';

export const QUIET_DEPARTMENT_MS = 15 * 60_000;
export const waitKey = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const taskVersions = (rows: Task[]) => rows.map(t => ({ id: t.id, version: t.version })).sort((a, b) => a.id.localeCompare(b.id));

export async function waitCycles(ctx: Ctx, now: Date) {
  const rows = await ctx.db.select({ task: tasks, employee: agents }).from(tasks).innerJoin(agents, eq(agents.id, tasks.assigneeAgentId)).where(and(
    notInArray(tasks.status, [...CLOSED]), isNull(agents.removedAt), isNull(agents.switchedOffAt),
  ));
  const edges = rows.flatMap(({ task, employee }) => task.externalWait?.on?.kind === 'employee' && new Date(task.externalWait.until) > now
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

/* The last thing that says the department was at work. */
const silentSince = (turn: typeof turns.$inferSelect, work: (typeof tasks.$inferSelect)[], conversations: (typeof jobs.$inferSelect)[]): Date => new Date(Math.max(
  (turn.openedAt ?? turn.createdAt).getTime(), ...work.map(t => t.updatedAt.getTime()),
  ...conversations.flatMap(job => job.startedAt && job.finishedAt ? [job.finishedAt.getTime()] : []),
  /* A wait that ran out explained the work until then: the silence starts there. */
  ...work.flatMap(t => t.externalWait ? [new Date(t.externalWait.until).getTime()] : []),
));

export async function quietDepartment(ctx: Ctx, turnId: string, departmentId: string, now: Date) {
  const [turn] = await ctx.db.select().from(turns).where(and(eq(turns.id, turnId), eq(turns.status, 'open')));
  if (!turn) return null;
  const scope = await departmentScope(ctx, turn.companyId, departmentId);
  const work = await ctx.db.select().from(tasks).where(and(workOfOpenTurn(turn.id), inArray(tasks.departmentId, scope), notInArray(tasks.status, [...CLOSED])));
  if (!work.length) return null;
  const employees = ctx.db.select(idOnly(agents)).from(agents).where(and(eq(agents.companyId, turn.companyId), inArray(agents.departmentId, scope)));
  const conversations = await ctx.db.select().from(jobs).where(and(eq(jobs.companyId, turn.companyId), eq(jobs.kind, 'conversation'), or(inArray(jobs.agentId, employees), inArray(jobs.taskId, work.map(task => task.id)))));
  if (conversations.some(job => job.status === 'running')) return null;
  /* A department where all of it waits for something known, in time, has nothing to say. */
  const silent = await unexplained(ctx, work, now);
  if (!silent.length) return null;
  const since = silentSince(turn, work, conversations);
  if (now.getTime() - since.getTime() < QUIET_DEPARTMENT_MS) return null;
  const versions = taskVersions(work);
  return { companyId: turn.companyId, work, silent, since, key: waitKey([turn.id, departmentId, versions, since.toISOString()]) };
}
