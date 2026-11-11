import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import type { CopyOrder } from '../keeper/copy.js';
import { queryOf } from '../merge/leader.js';

/* A replication slot of the server's Postgres. pid: the connection that reads it now, none while nobody does.
   confirmed: how far its reader said it holds the changes. */
export type CopySlot = { name: string; pid: number | null; walStatus: string | null; confirmed: string | null };

/* What the app asks of its Postgres about the copies that follow it. */
export type Replication = {
  slots(): Promise<CopySlot[]>;
  /* Ends the connection that reads a slot. */
  end(pid: number): Promise<void>;
  /* Throws while a connection still reads it. */
  drop(name: string): Promise<void>;
};

export function replicationOf(db: Db): Replication {
  const q = queryOf(db);
  return {
    slots: () => q<CopySlot>('SELECT slot_name::text AS name, active_pid AS pid, wal_status AS "walStatus", confirmed_flush_lsn::text AS confirmed FROM pg_replication_slots ORDER BY slot_name'),
    end: async pid => void (await q('SELECT pg_terminate_backend($1::int)', [pid])),
    drop: async name => void (await q('SELECT pg_drop_replication_slot($1::text)', [name])),
  };
}

/* What every slot of a machine's copy starts with, whatever the attempt: the first 16 hex characters of its network id. */
export const slotPrefix = (networkId: string): string => `copy_${networkId.slice(0, 16).toLowerCase()}_`;

/* What the leader tells a machine that keeps a copy: whether its slot is there and whole, how big the leader's database
   is, to count the copy's progress against, and how many migrations the leader's schema has, so a copy made with
   another schema makes itself again. slot: null while the copy named none. */
export async function copyOrder(ctx: Ctx, row: { copyName: string | null }): Promise<CopyOrder> {
  const q = queryOf(ctx.db);
  const found = row.copyName ? (await ctx.replication.slots()).find(slot => slot.name === row.copyName) : null;
  const slot = !row.copyName ? null : !found ? 'missing' : found.walStatus === 'lost' ? 'lost' : 'ok';
  const [sized] = await q<{ size: number }>('SELECT pg_database_size(current_database())::float8 AS size');
  const [counted] = await q<{ n: number }>('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
  return { slot, leaderSize: sized ? Number(sized.size) : null, migrations: counted?.n ?? null, old: null, upload: null };
}
