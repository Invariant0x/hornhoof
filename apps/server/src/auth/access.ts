import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { departments, people, personAccess, teams } from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { Person } from './session.js';

/* What a person reaches: the whole company, or the departments and teams listed for them. */
export type Access = { whole: boolean; departments: ReadonlySet<string>; teams: ReadonlySet<string> };

/* Where something sits: its department, the department that holds it when it is a product, and its team. */
export type Spot = { departmentId: string | null; teamId?: string | null; parentId?: string | null };

const ids = z.array(z.uuid()).max(100).default([]);

/* The whole company, or at least one department or team. */
export const AccessInput = z.union([
  z.object({ whole: z.literal(true) }).strict(),
  z
    .object({ departments: ids, teams: ids })
    .strict()
    .refine(a => a.departments.length + a.teams.length > 0, { message: 'Pick the whole company or at least one department or team.' }),
]);
export type AccessInput = z.infer<typeof AccessInput>;

export const WHOLE: Access = { whole: true, departments: new Set(), teams: new Set() };

/* Where an employee works: its product inside its department when it has one. */
export async function agentSpot(db: Db, agent: { departmentId: string | null; productId: string | null; teamId: string | null }): Promise<Spot> {
  if (agent.productId) return { departmentId: agent.productId, parentId: agent.departmentId, teamId: agent.teamId };
  if (!agent.departmentId) return { departmentId: null };
  const [dept] = await db.select({ parentId: departments.parentId }).from(departments).where(eq(departments.id, agent.departmentId));
  return { departmentId: agent.departmentId, parentId: dept?.parentId ?? null, teamId: agent.teamId };
}

export async function accessOf(db: Db, person: Pick<Person, 'id' | 'scopeKind'>): Promise<Access> {
  if (person.scopeKind === 'company') return WHOLE;
  const rows = await db.select().from(personAccess).where(eq(personAccess.personId, person.id));
  return {
    whole: false,
    departments: new Set(rows.flatMap(r => (r.departmentId ? [r.departmentId] : []))),
    teams: new Set(rows.flatMap(r => (r.teamId ? [r.teamId] : []))),
  };
}

export function canReach(access: Access, spot: Spot): boolean {
  if (access.whole) return true;
  if (spot.departmentId && access.departments.has(spot.departmentId)) return true;
  if (spot.parentId && access.departments.has(spot.parentId)) return true;
  return Boolean(spot.teamId && access.teams.has(spot.teamId));
}

/* Checks that every listed place exists in the company. */
export async function checkAccess(db: Db, companyId: string, input: AccessInput): Promise<void> {
  if ('whole' in input) return;
  const unknown = () => new ApiError(400, 'validation', 'access: No department or team with this id.', 'unknown_place');
  const depts = [...new Set(input.departments)];
  const tms = [...new Set(input.teams)];
  if (depts.length) {
    const found = await db.select({ id: departments.id }).from(departments).where(and(eq(departments.companyId, companyId), inArray(departments.id, depts)));
    if (found.length !== depts.length) throw unknown();
  }
  if (tms.length) {
    const found = await db.select({ id: teams.id }).from(teams).where(and(eq(teams.companyId, companyId), inArray(teams.id, tms)));
    if (found.length !== tms.length) throw unknown();
  }
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/* Replaces what a person reaches. Call checkAccess first. */
export async function saveAccess(tx: Tx, person: Pick<Person, 'id' | 'companyId'>, input: AccessInput): Promise<void> {
  const whole = 'whole' in input;
  await tx.update(people).set({ scopeKind: whole ? 'company' : 'listed' }).where(eq(people.id, person.id));
  await tx.delete(personAccess).where(eq(personAccess.personId, person.id));
  if (whole) return;
  const rows = [
    ...[...new Set(input.departments)].map(departmentId => ({ companyId: person.companyId, personId: person.id, departmentId })),
    ...[...new Set(input.teams)].map(teamId => ({ companyId: person.companyId, personId: person.id, teamId })),
  ];
  await tx.insert(personAccess).values(rows);
}
