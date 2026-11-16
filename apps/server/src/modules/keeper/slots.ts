import type { Sql } from './lease-store.js';
import { reasonOf } from './machine-keys.js';

export const SLOTS_EVERY_MS = 60_000;
export const KEEP_SIZE_EVERY_MS = 3_600_000;
/* A slot of a table's first copy that nobody has read for this long is left over from an attempt that was given up, or
   belongs to a copy that sleeps and will make itself again. One whose rows still go over is read, however long that takes. */
export const SYNC_SLOT_IDLE_MS = 600_000;
const MAX_KEEP_MB = 20_480;
const COPY_SLOT = /^copy_([0-9a-f]{16})_([1-9][0-9]{0,8})$/;
/* A slot Postgres makes on the leader for a table's first copy: pg_<subscription>_sync_<table>_<the copy's system id>. */
export const TABLE_SYNC_SLOT = /^pg_[0-9]+_sync_[0-9]+_[0-9]+$/;

/* How much of the log the leader keeps for a copy that fell behind, in whole megabytes: a quarter of the free disk, and
   20 GB at most. Past it a slot is lost, and its copy makes itself again. */
export function keepSize(diskFree: number): number {
  return Math.min(MAX_KEEP_MB, Math.floor(diskFree / 4 / 2 ** 20));
}

/* copying: a connection named after the slot sends from the leader now. While a table's rows go over to a copy, the
   connection that sends them holds no slot, so Postgres lists the slot as read by nobody; only its name tells. */
type Slot = { name: string; active: boolean; pid: number | null; copying: boolean };
type Copy = { networkId: string; copyName: string | null };

/* Whether somebody reads the slot now: the connection that holds it, or the one that sends a table's rows for it. */
const read = (slot: Slot): boolean => slot.active || slot.copying;

/* Whether a copy's slot is nobody's any more: no live machine that holds the data has that id, or the machine has
   named a later attempt since. A slot of a later attempt than the machine named waits for its next report. */
function stale(name: string, copies: Copy[]): boolean {
  const [, id, attempt] = COPY_SLOT.exec(name)!;
  const owner = copies.find(copy => copy.networkId.toLowerCase().startsWith(id!));
  if (!owner) return true;
  const named = owner.copyName ? COPY_SLOT.exec(owner.copyName) : null;
  return named !== null && named[1] === id && Number(named[2]) > Number(attempt);
}

/* Whether a slot of a table's first copy goes: its copy named it as one of a table whose first copy broke off, which
   Postgres makes anew when that table starts again, so it goes at once; else once nobody read it for ten minutes. One
   that is read stays, named or not: its table started again since the copy said so. */
function syncSlotGoes(slot: Slot, named: readonly string[], inactiveSince: Map<string, number>, now: number): boolean {
  if (read(slot)) return false;
  const since = inactiveSince.get(slot.name) ?? now;
  inactiveSince.set(slot.name, since);
  return named.includes(slot.name) || now - since >= SYNC_SLOT_IDLE_MS;
}

/* Drops the slots nobody will read again, each after the connection that reads it was ended, and answers their names.
   inactiveSince: when each slot of a table's first copy was first seen with no reader, kept by the caller from sweep
   to sweep. named: the slots of tables whose first copy broke off, as the copies said in their last reports. Slots of
   any other name are left alone. A slot that will not go is one line, and the next sweep tries. */
export async function sweepSlots(sql: Sql, log: (line: string) => void, inactiveSince: Map<string, number>, now: number, named: readonly string[] = []): Promise<string[]> {
  const slots = (
    await sql.query<Slot>(
      'SELECT s.slot_name::text AS name, s.active, s.active_pid AS pid, EXISTS (SELECT FROM pg_stat_replication r WHERE r.application_name = s.slot_name::text) AS copying FROM pg_replication_slots s',
    )
  ).rows;
  const copies = (await sql.query<Copy>(`SELECT network_id AS "networkId", copy_name AS "copyName" FROM public.machines WHERE role = 'data' AND revoked_at IS NULL AND network_id IS NOT NULL`)).rows;
  for (const name of inactiveSince.keys()) if (!slots.some(slot => slot.name === name && !read(slot))) inactiveSince.delete(name);
  const dropped: string[] = [];
  for (const slot of slots) {
    let goes = false;
    if (COPY_SLOT.test(slot.name)) goes = stale(slot.name, copies);
    else if (TABLE_SYNC_SLOT.test(slot.name)) goes = syncSlotGoes(slot, named, inactiveSince, now);
    if (!goes) continue;
    try {
      if (slot.pid !== null) await sql.query('SELECT pg_terminate_backend($1::int)', [slot.pid]);
      await sql.query('SELECT pg_drop_replication_slot($1::text)', [slot.name]);
      inactiveSince.delete(slot.name);
      dropped.push(slot.name);
    } catch (err) {
      log(`Could not drop the slot ${slot.name} that no copy reads any more: ${reasonOf(err)}`);
    }
  }
  return dropped;
}
