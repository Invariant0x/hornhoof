import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { departments, teams } from '../db/schema.js';
import { idOnly } from '../db/selections.js';
import { ApiError } from '../errors.js';
import { accessOf, type Access } from './access.js';
import { actsAsCeo } from './decisions.js';
import type { Person } from './session.js';

type DepartmentRow = typeof departments.$inferSelect;
type Inside = { products: readonly string[]; teams: readonly string[] };

/* Whether a department is one of the person's own places: they have the whole company, the department itself, a product of
   it or a team in it. Only these departments show on the Tasks screen, and only these answer for their tasks and for their
   list of work kept for later turns. */
export function hasDepartment(access: Access, departmentId: string, inside: Inside): boolean {
  if (access.whole || access.departments.has(departmentId)) return true;
  return inside.products.some(id => access.departments.has(id)) || inside.teams.some(id => access.teams.has(id));
}

/* The top-level departments of the person's company that are theirs, in the order of the map. */
export async function departmentsHad(db: Pick<Db, 'select'>, me: Pick<Person, 'id' | 'companyId' | 'scopeKind'>): Promise<DepartmentRow[]> {
  const access = await accessOf(db, me);
  const all = await db.select().from(departments).where(eq(departments.companyId, me.companyId)).orderBy(asc(departments.position), asc(departments.createdAt));
  const groups = access.whole ? [] : await db.select({ id: teams.id, departmentId: teams.departmentId }).from(teams).where(eq(teams.companyId, me.companyId));
  return all.filter(d => !d.parentId && hasDepartment(access, d.id, {
    products: all.filter(p => p.parentId === d.id).map(p => p.id),
    teams: groups.filter(t => t.departmentId === d.id).map(t => t.id),
  }));
}

/* A top-level department of the person's company that is theirs: 404 for one that is not there, 403 for another one's. */
export async function requireDepartmentHad(db: Pick<Db, 'select'>, me: Pick<Person, 'id' | 'companyId' | 'scopeKind'>, id: string): Promise<DepartmentRow> {
  const [there] = await db.select(idOnly(departments)).from(departments).where(and(eq(departments.id, id), eq(departments.companyId, me.companyId), isNull(departments.parentId)));
  if (!there) throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
  const had = (await departmentsHad(db, me)).find(d => d.id === id);
  if (!had) throw new ApiError(403, 'forbidden', 'This department is not one you have.', 'not_your_department');
  return had;
}

/* Whether the person runs this department as the CEO does: the CEO, the CEO delegate, or the owner the CEO named for it. Its
   employees, sub-units, products, repository and tasks are theirs to change without the CEO; a product goes with the
   department that holds it. Nothing outside it comes with this. */
export async function runsDepartment(db: Pick<Db, 'select'>, me: Pick<Person, 'id' | 'companyId' | 'scopeKind' | 'status' | 'isOwner' | 'isCeoDelegate'>, departmentId: string | null): Promise<boolean> {
  if (actsAsCeo(me)) return true;
  if (!departmentId) return false;
  const [dept] = await db.select({ parentId: departments.parentId }).from(departments).where(and(eq(departments.id, departmentId), eq(departments.companyId, me.companyId)));
  if (!dept) return false;
  return (await accessOf(db, me)).owns?.has(dept.parentId ?? departmentId) === true;
}

/* People who see the whole company change any department, as before; a department's owner changes their own. What is in no
   department stays the whole company's. */
export async function requireDepartmentChanger(db: Pick<Db, 'select'>, me: Person, departmentId: string | null): Promise<void> {
  if (me.scopeKind === 'company' || (await runsDepartment(db, me, departmentId))) return;
  if (!departmentId) throw new ApiError(403, 'forbidden', 'Only people with access to the whole company can do this.', 'company_scope_only');
  throw new ApiError(403, 'forbidden', 'Only this department\'s owner or people with access to the whole company can do this.', 'department_owner_only');
}
