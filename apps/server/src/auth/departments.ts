import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { departments, teams } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { accessOf, type Access } from './access.js';
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
  const [there] = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.id, id), eq(departments.companyId, me.companyId), isNull(departments.parentId)));
  if (!there) throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
  const had = (await departmentsHad(db, me)).find(d => d.id === id);
  if (!had) throw new ApiError(403, 'forbidden', 'This department is not one you have.', 'not_your_department');
  return had;
}
