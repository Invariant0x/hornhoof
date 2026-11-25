import { and, inArray, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Person } from '../../auth/session.js';
import { machines } from '../../db/schema.js';
import { gaveUpAll } from './measured.js';

/* A copy its keeper gave up, one card for the machine: since when, after how many attempts, and why. */
export type CopyGaveUpCard = { id: string; hostname: string; since: string; attempts: number; why: 'failed' | 'slow' | 'late' };

/* The copies given up that a person sees: the CEO sees every machine's, an owner their own machines'. An agent acting
   for either sees none, as for a copy that cannot load its schema. */
export async function copyGaveUpCards(ctx: Ctx, me: Person, person?: string): Promise<CopyGaveUpCard[]> {
  if (me.via) return [];
  const said = new Map(gaveUpAll(ctx));
  if (said.size === 0) return [];
  const rows = await ctx.db.select({ id: machines.id, hostname: machines.hostname, personId: machines.personId })
    .from(machines)
    .where(and(inArray(machines.id, [...said.keys()]), isNull(machines.revokedAt)));
  return rows
    .filter(row => (me.isOwner || row.personId === me.id) && (!person || person === me.id || person === row.personId))
    .map(({ id, hostname }) => ({ id, hostname, ...said.get(id)! }))
    .sort((a, b) => a.since.localeCompare(b.since) || a.id.localeCompare(b.id));
}
