import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { canReach, type Spot } from '../../auth/access.js';
import { departments, people } from '../../db/schema.js';
import { candidates, decisionPerson } from '../tasks/decisions.js';
import { refuse, type Tx } from '../tasks/engine.js';

/* Who answers for work in a place nobody named one for: the person who takes the place's own decisions, by the rule its
   questions follow: its named owner, else the one person whose access lists it, else the CEO. */
export const placeOwner = (ctx: Pick<Ctx, 'db'>, companyId: string, spot: Spot): Promise<string> =>
  decisionPerson(ctx, companyId, { source: 'request', kind: 'question', topic: 'task', spot });

/* Where a department sits, for whom reaches it: a sub-unit inside the department that holds it. None: the whole company. */
export async function spotOf(db: Pick<Ctx['db'], 'select'> | Tx, companyId: string, departmentId: string | null): Promise<Spot> {
  if (!departmentId) return { departmentId: null, parentId: null };
  const [dept] = await db.select({ id: departments.id, parentId: departments.parentId }).from(departments).where(and(eq(departments.id, departmentId), eq(departments.companyId, companyId)));
  if (!dept) throw refuse(404, 'department_unknown', 'This department does not exist.');
  return { departmentId: dept.id, parentId: dept.parentId };
}

/* Whether a person may answer for work in a place: an active person of the company, no assistant, who reaches it. What is
   in no department is for someone who sees the whole company. */
export async function answersFor(ctx: Pick<Ctx, 'db'>, companyId: string, personId: string, spot: Spot): Promise<boolean> {
  const [person] = await ctx.db.select({ isAgent: people.isAgent }).from(people).where(and(eq(people.id, personId), eq(people.companyId, companyId)));
  if (!person || person.isAgent) return false;
  const found = (await candidates(ctx, companyId)).find(p => p.id === personId);
  return Boolean(found && found.status === 'active' && canReach(found.access, spot));
}

export async function requireAnswersFor(ctx: Pick<Ctx, 'db'>, companyId: string, personId: string, spot: Spot): Promise<void> {
  if (!(await answersFor(ctx, companyId, personId, spot))) throw refuse(400, 'responsible_invalid', 'The responsible person must be an active person of the company who reaches this place.');
}
