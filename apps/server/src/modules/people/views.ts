import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { departments, teams, type ScopeKind } from '../../db/schema.js';
import { ApiError } from '../../errors.js';

export const WHOLE_COMPANY = 'Whole company';

export type PersonView = {
  id: string;
  name: string;
  email: string;
  title: string;
  status: Person['status'];
  scope: { kind: ScopeKind; id: string | null; name: string };
};

export const ScopeInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('company') }),
  z.object({ kind: z.literal('department'), id: z.string().uuid() }),
  z.object({ kind: z.literal('team'), id: z.string().uuid() }),
]);

/* Checks that the department or team exists and returns the columns to store. */
export async function resolveScope(db: Db, scope: z.infer<typeof ScopeInput>): Promise<{ scopeKind: ScopeKind; scopeId: string | null }> {
  if (scope.kind === 'company') return { scopeKind: 'company', scopeId: null };
  const table = scope.kind === 'department' ? departments : teams;
  const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, scope.id));
  if (!row) throw new ApiError(400, 'validation', `scope.id: No ${scope.kind} with this id.`);
  return { scopeKind: scope.kind, scopeId: row.id };
}

export async function personViews(db: Db, rows: Person[]): Promise<PersonView[]> {
  const names = new Map<string, string>();
  for (const d of await db.select({ id: departments.id, name: departments.name }).from(departments)) names.set(d.id, d.name);
  for (const t of await db.select({ id: teams.id, name: teams.name }).from(teams)) names.set(t.id, t.name);
  return rows.map(p => ({
    id: p.id,
    name: p.name,
    email: p.email,
    title: p.title,
    status: p.status,
    scope: { kind: p.scopeKind, id: p.scopeId, name: p.scopeId ? names.get(p.scopeId) ?? '' : WHOLE_COMPANY },
  }));
}

export async function personView(db: Db, row: Person): Promise<PersonView> {
  return (await personViews(db, [row]))[0]!;
}
