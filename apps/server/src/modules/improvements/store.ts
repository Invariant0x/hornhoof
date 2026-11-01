import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { agents, departments, improvements, IMPROVEMENT_STATUSES, people, taskEvents, tasks } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { deptName } from '../departments/templates.js';
import type { Tx } from '../tasks/engine.js';

export type ImprovementStatus = (typeof IMPROVEMENT_STATUSES)[number];
/* How many closed ones are listed; every one that waits or is in work is. */
const CLOSED_LISTED = 200;
const ACTIVE: readonly ImprovementStatus[] = ['open', 'taken'];

/* Improvements as people and the orchestrator read them, the latest changed first, each with who found it and where. */
export async function listImprovements(ctx: Pick<Ctx, 'db'>, companyId: string, statuses: readonly ImprovementStatus[] = IMPROVEMENT_STATUSES) {
  const active = statuses.filter(s => ACTIVE.includes(s));
  const closed = statuses.filter(s => !ACTIVE.includes(s));
  const ofCompany = eq(improvements.companyId, companyId);
  const latestClosed = ctx.db.select({ id: improvements.id }).from(improvements).where(and(ofCompany, inArray(improvements.status, closed))).orderBy(desc(improvements.updatedAt)).limit(CLOSED_LISTED);
  /* One read, so one that changes meanwhile is listed once. */
  const rows = await ctx.db
    .select({ i: improvements, agent: { id: agents.id, name: agents.name }, department: departments, decidedBy: people.name })
    .from(improvements)
    .innerJoin(agents, eq(agents.id, improvements.agentId))
    .leftJoin(departments, eq(departments.id, agents.departmentId))
    .leftJoin(people, eq(people.id, improvements.decidedBy))
    .where(and(ofCompany, or(active.length ? inArray(improvements.status, active) : undefined, closed.length ? inArray(improvements.id, latestClosed) : undefined) ?? sql`false`))
    .orderBy(desc(improvements.updatedAt));
  const linked = rows.length
    ? await ctx.db
        .select({ improvement: sql<string>`${taskEvents.data}->>'improvement'`, task: { id: tasks.id, number: tasks.number, title: tasks.title } })
        .from(taskEvents)
        .innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
        .where(and(eq(taskEvents.kind, 'created'), eq(taskEvents.companyId, companyId), eq(tasks.companyId, companyId), inArray(sql`${taskEvents.data}->>'improvement'`, rows.map(r => r.i.id))))
        .orderBy(asc(tasks.number))
    : [];
  const byImprovement = new Map<string, Map<string, { id: string; number: number; title: string }>>();
  for (const { improvement, task } of linked) {
    const found = byImprovement.get(improvement) ?? new Map<string, { id: string; number: number; title: string }>();
    found.set(task.id, task);
    byImprovement.set(improvement, found);
  }
  return rows.map(({ i, agent, department, decidedBy }) => ({
    id: i.id,
    title: i.title,
    text: i.text,
    seen: i.seen,
    status: i.status,
    result: i.result,
    at: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
    agent,
    department: department ? { id: department.id, name: deptName(department) } : null,
    decidedBy,
    tasks: [...(byImprovement.get(i.id)?.values() ?? [])],
  }));
}

/* People who see the whole company hear that the list changed. */
export const improvementsChanged = (ctx: Pick<Ctx, 'bus'>, companyId: string) => ctx.bus.publish(companyId, { type: 'improvements', spot: { departmentId: null } });

/* Moves an improvement inside a caller's transaction, with the same company and source-status guards everywhere. */
export async function moveImprovementTx(db: Db | Tx, companyId: string, id: string, from: ImprovementStatus, to: PgUpdateSetSource<typeof improvements>) {
  const [moved] = await db
    .update(improvements)
    .set({ ...to, updatedAt: new Date() })
    .where(and(eq(improvements.id, id), eq(improvements.companyId, companyId), eq(improvements.status, from)))
    .returning();
  if (!moved) {
    const [there] = await db.select({ status: improvements.status }).from(improvements).where(and(eq(improvements.id, id), eq(improvements.companyId, companyId)));
    if (!there) throw new ApiError(404, 'not_found', 'There is no such improvement.', 'improvement_unknown');
    throw new ApiError(409, 'conflict', `This improvement is ${there.status} already.`, 'improvement_decided');
  }
  return moved;
}

/* Moves an improvement on from one of the statuses it may leave, as one statement, so two people cannot both take it. */
export async function moveImprovement(ctx: Pick<Ctx, 'db' | 'bus'>, companyId: string, id: string, from: ImprovementStatus, to: PgUpdateSetSource<typeof improvements>) {
  const moved = await moveImprovementTx(ctx.db, companyId, id, from, to);
  improvementsChanged(ctx, companyId);
  return moved;
}

/* Planning may take an open improvement only in the run answering a person. A taken one keeps its original decision. */
export async function takeForPlanning(db: Db | Tx, companyId: string, id: string, personId: string | null): Promise<void> {
  const [current] = await db.select({ status: improvements.status }).from(improvements).where(and(eq(improvements.id, id), eq(improvements.companyId, companyId)));
  if (!current) throw new ApiError(404, 'not_found', 'There is no such improvement.', 'improvement_unknown');
  if (current.status === 'taken') return;
  if (current.status !== 'open') throw new ApiError(409, 'conflict', `This improvement is ${current.status} already.`, 'improvement_decided');
  if (!personId) throw new ApiError(403, 'forbidden', "This run has no person's instruction to take an improvement.", 'improvement_not_requested');
  await moveImprovementTx(db, companyId, id, 'open', { status: 'taken', decidedBy: personId, result: null });
}
