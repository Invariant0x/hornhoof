import { and, asc, eq, isNotNull, isNull, lt } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Person } from '../../auth/session.js';
import { companies, machines } from '../../db/schema.js';

const SCHEMA_WAIT_MS = 60 * 60_000;

const cutoff = (now: number): Date => new Date(now - SCHEMA_WAIT_MS);
const overdue = (since: Date | null, now: number): boolean => Boolean(since && since < cutoff(now));

function failures(ctx: Pick<Ctx, 'db'>, companyId: string, now: number) {
  return ctx.db.select({ id: machines.id, hostname: machines.hostname, personId: machines.personId, since: machines.copySchemaSince, attempt: machines.copySchemaAttempt })
    .from(machines)
    .where(and(eq(machines.companyId, companyId), eq(machines.role, 'data'), isNull(machines.revokedAt), isNotNull(machines.copySchemaAttempt), lt(machines.copySchemaSince, cutoff(now))))
    .orderBy(asc(machines.copySchemaSince), asc(machines.id));
}

/* A copy's machine owner and the CEO see the card directly. An agent acting for either sees none. */
export async function copySchemaFailures(ctx: Pick<Ctx, 'db' | 'clock'>, me: Person, person?: string) {
  if (me.via) return [];
  const rows = await failures(ctx, me.companyId, ctx.clock());
  return rows.filter(row => (me.isOwner || row.personId === me.id) && (!person || person === me.id || person === row.personId))
    .map(({ id, hostname, since, attempt }) => ({ id, hostname, since: since!.toISOString(), attempt: attempt! }));
}

const shown = new WeakMap<object, Map<string, string>>();

/* The screen asks again as soon as the minute round sees a card appear or go away. */
export async function tellOfCopySchemaFailures(ctx: Pick<Ctx, 'db' | 'bus'>, now: Date): Promise<void> {
  const last = shown.get(ctx) ?? new Map<string, string>();
  shown.set(ctx, last);
  for (const { id } of await ctx.db.select({ id: companies.id }).from(companies)) {
    const state = (await failures(ctx, id, +now)).map(row => `${row.id} ${row.since!.toISOString()} ${row.attempt}`).join();
    if (state === (last.get(id) ?? '')) continue;
    last.set(id, state);
    ctx.bus.publish(id, { type: 'requests', machines: true });
  }
}

/* A keeper can report recovery between rounds. Refresh right away if the changed attempt was or is old enough. */
export function schemaNoticeChanged(before: typeof machines.$inferSelect, after: typeof machines.$inferSelect, now: number): boolean {
  return (before.copySchemaSince?.getTime() !== after.copySchemaSince?.getTime() || before.copySchemaAttempt !== after.copySchemaAttempt)
    && (overdue(before.copySchemaSince, now) || overdue(after.copySchemaSince, now));
}
