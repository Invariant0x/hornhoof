import type { Ctx } from '../../app.js';
import type { Person } from '../../auth/session.js';
import { companies } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { queryOf } from '../merge/leader.js';

/* The company's database as Postgres keeps it where the app runs: its whole size, the line past which it is a card for
   the CEO, and its largest tables with their indexes, the largest first. */
export type DatabaseSize = { bytes: number; line: number; tables: { name: string; bytes: number }[] };

export const LARGEST_TABLES = 5;
/* Read at most once a minute: the machines tab and the CEO's cards ask again on every change. */
const FRESH_MS = 60_000;

const SIZES = `SELECT pg_database_size(current_database())::float8 AS bytes, COALESCE((SELECT jsonb_agg(t ORDER BY t.bytes DESC, t.name) FROM (
    SELECT n.nspname || '.' || c.relname AS name, pg_total_relation_size(c.oid)::float8 AS bytes FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname IN ('public', 'net') ORDER BY 2 DESC, 1 LIMIT ${LARGEST_TABLES}
  ) t), '[]'::jsonb) AS tables`;

const read = new WeakMap<object, { at: number; size: Promise<DatabaseSize> }>();

export function databaseSize(ctx: Pick<Ctx, 'db' | 'config'>): Promise<DatabaseSize> {
  const kept = read.get(ctx);
  if (kept && Date.now() - kept.at < FRESH_MS) return kept.size;
  const size = queryOf(ctx.db)<{ bytes: number; tables: { name: string; bytes: number }[] }>(SIZES).then(([row]) => ({
    bytes: Number(row!.bytes),
    line: ctx.config.databaseWarnBytes,
    tables: row!.tables.map(table => ({ name: table.name, bytes: Number(table.bytes) })),
  }));
  read.set(ctx, { at: Date.now(), size });
  size.catch(() => read.delete(ctx));
  return size;
}

/* The database past its line, for the CEO alone, and for nobody acting for him: what grows there is his to have looked at. */
export async function databaseLarge(ctx: Pick<Ctx, 'db' | 'config'>, me: Person, person?: string): Promise<DatabaseSize | null> {
  if (!me.isOwner || me.via || (person && person !== me.id)) return null;
  const size = await databaseSize(ctx);
  return size.bytes > size.line ? size : null;
}

const told = new WeakMap<object, boolean>();

/* Screens ask again when the database crosses its line, either way. The word holds nothing, so it goes to everyone. */
export async function tellOfDatabaseSize(ctx: Pick<Ctx, 'db' | 'config' | 'bus'>): Promise<void> {
  const size = await databaseSize(ctx);
  const over = size.bytes > size.line;
  if ((told.get(ctx) ?? false) === over) return;
  told.set(ctx, over);
  for (const { id } of await ctx.db.select(idOnly(companies)).from(companies)) ctx.bus.publish(id, { type: 'requests', machines: true });
}
