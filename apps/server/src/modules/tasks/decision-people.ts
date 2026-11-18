import { eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { WHOLE, withOwned } from '../../auth/access.js';
import { decisionOwner, type Candidate, type DecisionSubject } from '../../auth/decision-owner.js';
import { departments, people, personAccess } from '../../db/schema.js';
/* The company's active and invited people with what each reaches and owns, for owners. */
export async function candidates(ctx: Pick<Ctx, 'db'>, companyId: string): Promise<Candidate[]> {
  const rows = await ctx.db.select({ id: people.id, status: people.status, isOwner: people.isOwner, scopeKind: people.scopeKind }).from(people).where(eq(people.companyId, companyId));
  const listed = rows.filter(p => p.scopeKind !== 'company').map(p => p.id);
  const access = listed.length ? await ctx.db.select().from(personAccess).where(inArray(personAccess.personId, listed)) : [];
  const owned = await ctx.db.select({ id: departments.id, ownerPersonId: departments.ownerPersonId }).from(departments).where(eq(departments.companyId, companyId));
  const namedFor = (id: string) => owned.filter(d => d.ownerPersonId === id).map(d => d.id);
  return rows.map(p => {
    if (p.scopeKind === 'company') return { id: p.id, status: p.status, isOwner: p.isOwner, access: withOwned(WHOLE, namedFor(p.id)) };
    const mine = access.filter(a => a.personId === p.id);
    return {
      id: p.id,
      status: p.status,
      isOwner: p.isOwner,
      access: withOwned({ whole: false, departments: new Set(mine.flatMap(a => (a.departmentId ? [a.departmentId] : []))), teams: new Set(mine.flatMap(a => (a.teamId ? [a.teamId] : []))) }, namedFor(p.id)),
    };
  });
}

/* Each department's owner who counts now: named by the CEO, active and with access still. */
export async function departmentOwners(ctx: Pick<Ctx, 'db'>, companyId: string): Promise<Map<string, string>> {
  const everyone = await candidates(ctx, companyId);
  return new Map(everyone.filter(p => p.status === 'active').flatMap(p => [...(p.access.owns ?? [])].map((department): [string, string] => [department, p.id])));
}

/* The addressee of a question uses the same ownership policy as its decision card. */
export async function decisionPerson(ctx: Pick<Ctx, 'db'>, companyId: string, subject: DecisionSubject): Promise<string> {
  return decisionOwner(subject, await candidates(ctx, companyId));
}
