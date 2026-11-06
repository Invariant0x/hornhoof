import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, notInArray, or } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, departments, jobs, requests, tasks, testRuns, turns } from '../../db/schema.js';
import { CLOSED, openAfter, type Task } from './engine.js';
import { waitingCycles } from './wait-graph.js';

export const QUIET_DEPARTMENT_MS = 15 * 60_000;
export const waitKey = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const taskVersions = (rows: Task[]) => rows.map(t => ({ id: t.id, version: t.version })).sort((a, b) => a.id.localeCompare(b.id));

export async function waitCycles(ctx: Ctx, now: Date) {
  const rows = await ctx.db.select({ task: tasks, employee: agents }).from(tasks).innerJoin(agents, eq(agents.id, tasks.assigneeAgentId)).where(and(
    notInArray(tasks.status, ['planned', ...CLOSED]), isNull(agents.removedAt), isNull(agents.switchedOffAt),
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

async function waitReasons(ctx: Ctx, rows: Task[], now: Date): Promise<string[] | null> {
  const reasons: string[] = [];
  for (const task of rows) {
    const reason = await taskWaitReason(ctx, task, now);
    if (!reason) return null;
    reasons.push(`#${task.number}: ${reason}`);
  }
  return reasons;
}

async function taskWaitReason(ctx: Ctx, task: Task, now: Date): Promise<string | null> {
  if (task.externalWait && new Date(task.externalWait.until) > now) return `${task.externalWait.reason}, until ${task.externalWait.until}`;
  if (task.status === 'blocked' || task.status === 'waiting') return task.status;
  return await waitingForTasks(ctx, task) ?? await waitingForService(ctx, task);
}

async function waitingForTasks(ctx: Ctx, task: Task): Promise<string | null> {
  if ((await openAfter(ctx.db, task)).length) return 'waiting for prerequisite tasks';
  const [child] = await ctx.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.parentId, task.id), notInArray(tasks.status, [...CLOSED]))).limit(1);
  return child ? 'waiting for subtasks' : null;
}

async function waitingForService(ctx: Ctx, task: Task): Promise<string | null> {
  const [request] = await ctx.db.select({ id: requests.id }).from(requests).where(and(eq(requests.taskId, task.id), eq(requests.status, 'open'))).limit(1);
  if (request) return 'waiting for a person';
  const [test] = await ctx.db.select({ id: testRuns.id }).from(testRuns).where(and(eq(testRuns.taskId, task.id), eq(testRuns.status, 'running'))).limit(1);
  return test ? 'waiting for a test run' : null;
}

export async function quietDepartment(ctx: Ctx, turnId: string, departmentId: string, now: Date) {
  const [turn] = await ctx.db.select().from(turns).where(and(eq(turns.id, turnId), eq(turns.status, 'open')));
  if (!turn) return null;
  const scope = await departmentScope(ctx, turn.companyId, departmentId);
  const work = await ctx.db.select().from(tasks).where(and(eq(tasks.turnId, turn.id), inArray(tasks.departmentId, scope), notInArray(tasks.status, ['planned', ...CLOSED])));
  if (!work.length) return null;
  const employees = ctx.db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, turn.companyId), inArray(agents.departmentId, scope)));
  const conversations = await ctx.db.select().from(jobs).where(and(eq(jobs.companyId, turn.companyId), eq(jobs.kind, 'conversation'), or(inArray(jobs.agentId, employees), inArray(jobs.taskId, work.map(task => task.id)))));
  if (conversations.some(job => job.status === 'running')) return null;
  const reasons = await waitReasons(ctx, work, now);
  if (!reasons) return null;
  const since = new Date(Math.max((turn.openedAt ?? turn.createdAt).getTime(), ...work.map(t => t.updatedAt.getTime()), ...conversations.flatMap(job => job.startedAt && job.finishedAt ? [job.finishedAt.getTime()] : [])));
  if (now.getTime() - since.getTime() < QUIET_DEPARTMENT_MS) return null;
  const versions = taskVersions(work);
  return { companyId: turn.companyId, work, reasons, since, key: waitKey([turn.id, departmentId, versions, since.toISOString()]) };
}
