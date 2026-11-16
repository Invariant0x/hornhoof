import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { accessOf, canReach, type Spot } from '../../auth/access.js';
import { actsAsCeo } from '../../auth/decisions.js';
import type { Person } from '../../auth/session.js';
import type { DecisionSubject } from '../../auth/decision-owner.js';
import { departments, people } from '../../db/schema.js';
import { candidates, decisionPerson } from '../tasks/decisions.js';
import { refuse, type Tx } from '../tasks/engine.js';

/* Who answers for work in a place nobody named one for: the person who takes the place's own decisions, by the rule its
   questions follow: its named owner, else the one person whose access lists it, else the CEO. */
export const placeSubject = (spot: Spot): DecisionSubject => ({ source: 'request', kind: 'question', topic: 'task', spot });
export const placeOwner = (ctx: Pick<Ctx, 'db'>, companyId: string, spot: Spot): Promise<string> => decisionPerson(ctx, companyId, placeSubject(spot));

/* Where a department sits, for whom reaches it: a sub-unit inside the department that holds it. None: the whole company. */
export async function spotOf(db: Pick<Ctx['db'], 'select'> | Tx, companyId: string, departmentId: string | null): Promise<Spot> {
  if (!departmentId) return { departmentId: null, parentId: null };
  const [dept] = await db.select({ id: departments.id, parentId: departments.parentId }).from(departments).where(and(eq(departments.id, departmentId), eq(departments.companyId, companyId)));
  if (!dept) throw refuse(404, 'department_unknown', 'This department does not exist.');
  return { departmentId: dept.id, parentId: dept.parentId };
}

/* Whether a person may answer for work in a place: an active person of the company, no assistant, who reaches it. What is
   in no department is for someone who sees the whole company. */
async function answersFor(ctx: Pick<Ctx, 'db'>, companyId: string, personId: string, spot: Spot): Promise<boolean> {
  const [person] = await ctx.db.select({ isAgent: people.isAgent }).from(people).where(and(eq(people.id, personId), eq(people.companyId, companyId)));
  if (!person || person.isAgent) return false;
  const found = (await candidates(ctx, companyId)).find(p => p.id === personId);
  return Boolean(found && found.status === 'active' && canReach(found.access, spot));
}

export async function requireAnswersFor(ctx: Pick<Ctx, 'db'>, companyId: string, personId: string, spot: Spot): Promise<void> {
  if (!(await answersFor(ctx, companyId, personId, spot))) throw refuse(400, 'responsible_invalid', 'The responsible person must be an active person of the company who reaches this place.');
}

/* Whether this person may give work and set the goals and pipelines of a place, by the rule the routes keep, so a screen
   offers only what they take. */
export async function mayPlan(ctx: Pick<Ctx, 'db'>, me: Person): Promise<(departmentId: string | null) => Promise<boolean>> {
  if (actsAsCeo(me)) return async () => true;
  const access = await accessOf(ctx.db, me);
  const known = new Map<string, Promise<boolean>>();
  return departmentId => {
    if (!departmentId) return Promise.resolve(false);
    if (!known.has(departmentId)) known.set(departmentId, spotOf(ctx.db, me.companyId, departmentId).then(spot => canReach(access, spot)));
    return known.get(departmentId)!;
  };
}
