import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import type { UploadState } from '../../db/schema.js';
import type { CopyOrder } from '../keeper/copy.js';
import { queryOf } from '../merge/leader.js';
import { machineSource } from '../merge/source.js';
import { findThisMachine } from '../network/store.js';
import { weakPath } from './path.js';
import { copyRetryAsked } from './retry.js';

/* A replication slot of the server's Postgres. pid: the connection that reads it now, none while nobody does.
   confirmed: how far its reader said it holds the changes. */
export type CopySlot = { name: string; pid: number | null; walStatus: string | null; confirmed: string | null };

/* What the app asks of its Postgres about the copies that follow it. */
export type Replication = {
  within?(db: Db): Replication;
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
    within: replicationOf,
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
   attempt the row's copy is named by, which a machine that was wiped starts above. leader: this machine, whose view
   it is. join: the slot this machine made for the copy when it took the server in the newest planned switch, while the
   copy's row still names an attempt below it: a copy that held everything the leader before had written joins that
   slot, and takes no row again. */
export async function copyOrder(
  ctx: Ctx,
  row: { id: string; networkId: string | null; copyName: string | null; copyOld?: number | null; copyOldLed?: number | null; uploadState?: UploadState | null; copyState?: string | null; linkMbps?: number | null; linkRttMs?: number | null },
): Promise<CopyOrder> {
  const q = queryOf(ctx.db);
  const found = row.copyName ? (await ctx.replication.slots()).find(slot => slot.name === row.copyName) : null;
  const slot = !row.copyName ? null : !found ? 'missing' : found.walStatus === 'lost' ? 'lost' : 'ok';
  const [sized] = await q<{ size: number }>('SELECT pg_database_size(current_database())::float8 AS size');
  const [counted] = await q<{ n: number }>('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
  /* How far the leader is with the old database a copy that was made again still holds: until it is merged, or left
     out, the copy keeps it. A merge that has no row yet gets one within the minute. */
  const [merge] = row.copyOld ? await q<{ status: string }>('SELECT status FROM net.merges WHERE source = $1', [machineSource({ id: row.id, copyOld: row.copyOld, copyOldLed: row.copyOldLed })]) : [];
  const old = !row.copyOld ? null : merge?.status === 'merged' ? 'merged' : merge?.status === 'done' ? 'done' : 'waiting';
  const upload = !row.uploadState ? null : row.uploadState === 'kept' ? 'wipe' : row.uploadState;
  const attempt = /_(\d+)$/.exec(row.copyName ?? '')?.[1];
  const leader = ctx.config.machineId ?? undefined;
  /* A copy that is not whole yet is not kept over a path measured too weak for it. */
  const weak = row.copyState === 'ready' ? null : weakPath(row, sized ? Number(sized.size) : null);
  return {
    slot, leaderSize: sized ? Number(sized.size) : null, migrations: counted?.n ?? null, old, upload, lastAttempt: attempt ? Number(attempt) : null,
    applied: await appliedOf(ctx, row.id),
    ...(copyRetryAsked(ctx, row.id) ? { retry: true as const } : {}),
    ...(weak ? { weak } : {}),
    ...(leader === undefined ? {} : { leader, join: await slotToJoin(ctx, row.networkId ?? null, attempt ? Number(attempt) : 0) }),
  };
}

/* How far a handover from that machine to this server applied its log, while no restore replaced it. */
async function appliedOf(ctx: Ctx, machineId: string): Promise<{ term: number; lsn: string } | null> {
  const mine = (await findThisMachine(ctx.db, ctx.config))?.id;
  if (!mine) return null;
  const [row] = await queryOf(ctx.db)<{ term: number; lsn: string }>(
    `SELECT h.term_number::int AS term, h.applied AS lsn FROM net.handovers h
      WHERE h.from_machine_id = $1::uuid AND h.to_machine_id = $2::uuid
        AND h.applied ~ '^[0-9A-Fa-f]{1,8}/[0-9A-Fa-f]{1,8}$'
        AND NOT EXISTS (SELECT 1 FROM net.restores r WHERE r.dumped_at < h.at OR r.at >= h.at)
      ORDER BY h.term_number DESC, h.at DESC, h.id DESC LIMIT 1`,
    [machineId, mine],
  );
  return row ? { term: Number(row.term), lsn: row.lsn } : null;
}

/* The slot the newest planned switch made for that machine, when this machine took the server in it and the slot's
   attempt is above the one the machine's copy goes by; none else. */
async function slotToJoin(ctx: Ctx, networkId: string | null, attempt: number): Promise<string | null> {
  if (!networkId) return null;
  const [newest] = await queryOf(ctx.db)<{ to: string; slots: Record<string, string> }>('SELECT to_machine_id::text AS "to", slots FROM net.handovers ORDER BY at DESC, id LIMIT 1');
  const slot = newest?.slots[networkId];
  if (!newest || !slot || Number(/_(\d+)$/.exec(slot)?.[1] ?? 0) <= attempt) return null;
  return newest.to === (await findThisMachine(ctx.db, ctx.config))?.id ? slot : null;
}
