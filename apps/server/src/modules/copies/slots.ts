import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import type { UploadState } from '../../db/schema.js';
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
  /* The copy commits wait for now, as the setting names it: its text, empty with none. */
  standby(): Promise<string>;
};

export function replicationOf(db: Db): Replication {
  const q = queryOf(db);
  return {
    slots: () => q<CopySlot>('SELECT slot_name::text AS name, active_pid AS pid, wal_status AS "walStatus", confirmed_flush_lsn::text AS confirmed FROM pg_replication_slots ORDER BY slot_name'),
    end: async pid => void (await q('SELECT pg_terminate_backend($1::int)', [pid])),
    drop: async name => void (await q('SELECT pg_drop_replication_slot($1::text)', [name])),
    standby: async () => (await q<{ synchronous_standby_names: string }>('SHOW synchronous_standby_names'))[0]?.synchronous_standby_names ?? '',
  };
}

/* What every slot of a machine's copy starts with, whatever the attempt: the first 16 hex characters of its network id. */
export const slotPrefix = (networkId: string): string => `copy_${networkId.slice(0, 16).toLowerCase()}_`;

/* What the leader tells a machine that keeps a copy: whether its slot is there and whole, how big the leader's database
   is, to count the copy's progress against, and how many migrations the leader's schema has, so a copy made with
   another schema makes itself again. slot: null while the copy named none. A machine that stopped holding the data is
   told what it still owes: what it holds, and its wipe once the leader has that merged and saved. lastAttempt: the
   attempt the row's copy is named by, which a machine that was wiped starts above. */
export async function copyOrder(ctx: Ctx, row: { id: string; copyName: string | null; copyOld?: number | null; uploadState?: UploadState | null }): Promise<CopyOrder> {
  const q = queryOf(ctx.db);
  const found = row.copyName ? (await ctx.replication.slots()).find(slot => slot.name === row.copyName) : null;
  const slot = !row.copyName ? null : !found ? 'missing' : found.walStatus === 'lost' ? 'lost' : 'ok';
  const [sized] = await q<{ size: number }>('SELECT pg_database_size(current_database())::float8 AS size');
  const [counted] = await q<{ n: number }>('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
  /* How far the leader is with the old database a copy that was made again still holds: until it is merged, or left
     out, the copy keeps it. A merge that has no row yet gets one within the minute. */
  const [merge] = row.copyOld ? await q<{ status: string }>('SELECT status FROM net.merges WHERE source = $1', [`machine:${row.id}:${row.copyOld}`]) : [];
  const old = !row.copyOld ? null : merge?.status === 'merged' ? 'merged' : merge?.status === 'done' ? 'done' : 'waiting';
  const upload = !row.uploadState ? null : row.uploadState === 'kept' ? 'wipe' : row.uploadState;
  const attempt = /_(\d+)$/.exec(row.copyName ?? '')?.[1];
  return { slot, leaderSize: sized ? Number(sized.size) : null, migrations: counted?.n ?? null, old, upload, lastAttempt: attempt ? Number(attempt) : null };
}
