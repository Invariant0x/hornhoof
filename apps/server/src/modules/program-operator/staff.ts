import { PROGRAM_OPERATOR_ROLE } from '@hornhoof/protocol/program-operator';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { agents, departments } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
/* Operations, by the role each holds in it: the head of Operations and the program operator. */
export const OPERATIONS_ROLES: Record<string, 'head' | 'worker'> = { 'OPS-HEAD': 'head', [PROGRAM_OPERATOR_ROLE]: 'worker' };

export type Agent = typeof agents.$inferSelect;

export async function inOperations(db: Db, department: typeof departments.$inferSelect | null): Promise<boolean> {
  if (!department) return false;
  if (department.templateKey === 'operations') return true;
  const [parent] = department.parentId ? await db.select().from(departments).where(eq(departments.id, department.parentId)) : [];
  return parent?.templateKey === 'operations';
}

/* Whether this employee holds a role of Operations in it, whatever it runs now. */
export async function ofOperations(db: Db, agent: Agent, department: typeof departments.$inferSelect | null): Promise<boolean> {
  return Boolean(agent.roleKey) && OPERATIONS_ROLES[agent.roleKey!] === agent.kind && await inOperations(db, department);
}

/* Operations on duty, the program operator before the head of Operations. */
export async function operationsStaff(ctx: Ctx, companyId: string): Promise<Agent[]> {
  const ops = ctx.db.select(idOnly(departments)).from(departments).where(and(eq(departments.companyId, companyId), eq(departments.templateKey, 'operations')));
  const below = ctx.db.select(idOnly(departments)).from(departments).where(and(eq(departments.companyId, companyId), inArray(departments.parentId, ops)));
  const staff = await ctx.db.select().from(agents).where(and(eq(agents.companyId, companyId), or(inArray(agents.departmentId, ops), inArray(agents.departmentId, below)), isNull(agents.removedAt), isNull(agents.switchedOffAt))).orderBy(asc(agents.createdAt));
  return [PROGRAM_OPERATOR_ROLE, 'OPS-HEAD'].flatMap(role => staff.filter(agent => agent.roleKey === role && OPERATIONS_ROLES[role] === agent.kind));
}
