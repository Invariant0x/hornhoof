import { rowsOf } from '../../db/result-rows.js';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { sameHome } from '../backups/holders.js';
import { DEFAULT_AREA_BYTES, floorOf, headroomOf } from './area.js';
import { storeBackupMachines } from './backup-settings.js';

/* Where the files of the store are kept. Each file is picked machines to keep it: as many as the copies setting asks, as
   far as the company has machines that keep files, each copy on another machine. The leading machine first, where it
   has room, as it reads the file at once; then one off site, so a home lost takes no file with it; then the one with
   the most of its area free. A machine fetches the files it is picked for. One that is not picked for a file any more
   lets it go only once the copies asked for stand on machines that are, so no change of setting, area or machine ever
   leaves a file with fewer copies than before.

   A machine keeps its files while it is away for up to a day, as a laptop asleep or a home without power is; one away
   longer has its files placed on another, and lets them go when it is back. One whose area went down, or to nothing,
   has the files over it placed on others before it lets them go; with no room elsewhere it keeps them. */

export const DEFAULT_COPIES = 2;
export const MAX_COPIES = 5;
/* A machine is picked for a new file only when its keeper was heard from this lately. */
export const FRESH_MS = 2 * 60_000;
/* A machine not heard from this long has its files placed on another. */
export const LOST_MS = 24 * 3_600_000;
/* At most this many files are placed, and as many looked at again, in one round. */
export const PLACE_BATCH = 200;

type Tx = Pick<Db, 'execute'>;
const listOf = (values: (string | number)[]): string => `{${values.join(',')}}`;
const arrayOf = (value: string[] | string | null): string[] =>
  Array.isArray(value) ? value : value ? value.replace(/^\{|\}$/g, '').split(',').filter(Boolean) : [];

/* A machine of the company as the store sees it. fit: it keeps files, its area being more than none. online: heard from
   just now, or the leading one. lost: not heard from for a day. room: what more it can be picked for (headroomOf):
   its area past what its files take and what it is still to fetch, and no more than its disk keeps above the floor. backup: it keeps the store's backup (backup.ts). */
export type Seat = {
  id: string;
  leader: boolean;
  fit: boolean;
  online: boolean;
  lost: boolean;
  addresses: string[];
  relayed: boolean;
  area: number;
  assigned: number;
  room: number;
  capacity: number;
  backup: boolean;
};

/* The machines that could keep files: every one with a keeper, of the data or a worker, whose owner is active; the one
   that keeps the store's backup apart from the live copies where there are machines enough. */
export async function seats(db: Tx, leader: string | null, now = new Date()): Promise<Seat[]> {
  const all = await machineSeats(db, leader, now);
  const backups = await storeBackupMachines(db);
  return backups.length ? apartFromBackup(all, backups, await copiesSet(db)) : all;
}

/* Those machines as they are, the one that keeps the store's backup among them like any other. What its files take
   counts the backup's too, and what it is still to take the backup's it is to fetch. */
export async function machineSeats(db: Tx, leader: string | null, now = new Date()): Promise<Seat[]> {
  type Row = { id: string; report_at: Date | string | null; addresses: string[] | string; path: string | null; free: string | number | null; total: string | number | null; area: string | number;
    assigned: string | number; used: string | number; pending: string | number };
  /* What a machine's files take there: what its keeper said, and no less than the copies on record of it, which counts
     the leading machine's own and those of a keeper from before it said. What it is still to take: the files it is
     picked for that it keeps no copy of yet. The disk is the one FILES_DIR lies on, or its keeper's where it said none. */
  const rows = rowsOf<Row>(
    await db.execute(sql`SELECT m.id, m.report_at, m.addresses, m.path, coalesce(m.files_disk_free, m.disk_free) AS free, m.files_disk_total AS total,
      coalesce(m.file_store_limit_bytes, ${DEFAULT_AREA_BYTES}) AS area,
      coalesce((SELECT sum(f.sealed_size) FROM net.file_targets t JOIN net.files f ON f.sha256 = t.sha256 WHERE t.machine_id = m.id), 0) AS assigned,
      greatest(m.file_store_used_bytes, coalesce((SELECT sum(f.sealed_size) FROM net.file_copies c JOIN net.files f ON f.sha256 = c.sha256 WHERE c.machine_id = m.id), 0)
        + coalesce((SELECT sum(b.sealed_size) FROM net.file_backups b WHERE b.machine_id = m.id AND b.kept_at IS NOT NULL), 0)) AS used,
      coalesce((SELECT sum(f.sealed_size) FROM net.file_targets t JOIN net.files f ON f.sha256 = t.sha256 WHERE t.machine_id = m.id
        AND NOT EXISTS (SELECT 1 FROM net.file_copies c WHERE c.sha256 = t.sha256 AND c.machine_id = m.id)), 0)
        + coalesce((SELECT sum(b.sealed_size) FROM net.file_backups b WHERE m.id = (SELECT s.machine_id FROM net.file_backup_settings s) AND b.drop_at IS NULL
          AND (b.kept_at IS NULL OR b.machine_id IS DISTINCT FROM m.id)), 0) AS pending
      FROM machines m JOIN people p ON p.id = m.person_id
      WHERE m.revoked_at IS NULL AND m.network_id IS NOT NULL AND m.role IN ('data', 'worker') AND p.status = 'active' ORDER BY m.id`),
  );
  return rows.map(row => {
    const isLeader = row.id === leader;
    const silent = row.report_at ? now.getTime() - new Date(row.report_at).getTime() : Infinity;
    const area = Number(row.area);
    const assigned = Number(row.assigned);
    const [used, free, total] = [Number(row.used), row.free === null ? null : Number(row.free), row.total === null ? null : Number(row.total)];
    const room = headroomOf({ area, used, pending: Number(row.pending), free, total });
    /* What it could hold in all: its area, and no more than what its files take and its disk keeps above the floor. */
    const capacity = free === null ? area : Math.min(area, used + Math.max(0, free - floorOf(total)));
    return {
      id: row.id,
      leader: isLeader,
      fit: area > 0,
      online: isLeader || silent < FRESH_MS,
      lost: !isLeader && silent >= LOST_MS,
      addresses: arrayOf(row.addresses),
      relayed: row.path === 'relay',
      area,
      assigned,
      room,
      capacity,
      backup: false,
    };
  });
}

/* A machine that keeps the store's backup keeps no live copy while the other machines that keep files are as many as the
   copies asked for: its live copies are placed on them, and it lets them go once they keep them, as one whose area was
   set to none does. With fewer, it keeps live copies too, the last one picked for them. */
export function apartFromBackup(all: Seat[], backups: string[], copies: number): Seat[] {
  const marked = all.map(seat => (backups.includes(seat.id) ? { ...seat, backup: true } : seat));
  const others = marked.filter(seat => seat.fit && !seat.backup && !seat.lost).length;
  return others >= copies ? marked.map(seat => (seat.backup ? { ...seat, fit: false, room: 0, capacity: 0 } : seat)) : marked;
}

/* The machines whose copies count: they keep files and were heard from within a day. */
export const counted = (all: Seat[]): Seat[] => all.filter(seat => seat.fit && !seat.lost);

/* The copies the CEO asked for. */
export async function copiesSet(db: Tx): Promise<number> {
  return rowsOf<{ copies: number }>(await db.execute(sql`SELECT copies FROM net.file_settings`))[0]?.copies ?? DEFAULT_COPIES;
}

/* How many machines keep each file now: the copies asked for, as far as there are machines to keep them. */
export const copiesWanted = (copies: number, all: Seat[]): number => Math.min(copies, counted(all).length);

/* The targets that count, as (sha256, machine_id): on a machine whose copies count, and within its area, the files
   picked for it first being the first within it. */
export function countedTargets(all: Seat[]): SQL {
  const seen = counted(all);
  const ids = listOf(seen.map(seat => seat.id));
  const areas = listOf(seen.map(seat => seat.area));
  return sql`(SELECT t.sha256, t.machine_id FROM (
      SELECT t.sha256, t.machine_id, sum(f.sealed_size) OVER (PARTITION BY t.machine_id ORDER BY t.at, t.sha256) AS upto
      FROM net.file_targets t JOIN net.files f ON f.sha256 = t.sha256 WHERE t.machine_id = ANY(${ids}::uuid[])) t
    JOIN unnest(${ids}::uuid[], ${areas}::bigint[]) AS s (id, area) ON s.id = t.machine_id WHERE t.upto <= s.area)`;
}

/* The order machines are picked for a file in: any but one that keeps the store's backup; the leading one, then one away
   from where its copies are, then the one with the most of its area free. */
export function better(here: string[]): (a: Seat, b: Seat) => number {
  const away = (seat: Seat) => seat.relayed || (here.length > 0 && seat.addresses.length > 0 && !sameHome(here, seat.addresses));
  return (a, b) =>
    Number(a.backup) - Number(b.backup) || Number(b.leader) - Number(a.leader) || Number(away(b)) - Number(away(a)) || b.room / b.area - a.room / a.area || a.id.localeCompare(b.id);
}

/* Picks up to need machines for a file, besides those it has: online, with room for it. The room picked is taken. */
export function pick(file: { sealedSize: number; targets: string[] }, all: Seat[], need: number): string[] {
  const chosen: string[] = [];
  const homes = () => all.filter(seat => file.targets.includes(seat.id) || chosen.includes(seat.id)).flatMap(seat => seat.addresses);
  for (let left = need; left > 0; left--) {
    const open = all.filter(seat => seat.fit && seat.online && !file.targets.includes(seat.id) && !chosen.includes(seat.id) && seat.room >= file.sealedSize);
    const best = open.sort(better(homes()))[0];
    if (!best) break;
    chosen.push(best.id);
    best.room -= file.sealedSize;
    best.assigned += file.sealedSize;
  }
  return chosen;
}

/* Places the files that have fewer counted targets than wanted, a page a round from after through the names, or only
   those named. Says how many machines were picked, and the last name looked at; '' once it went through them all. */
export async function placeFiles(db: Tx, leader: string | null, opts: { now?: Date; only?: string[]; after?: string } = {}): Promise<{ placed: number; through: string }> {
  const all = await seats(db, leader, opts.now);
  const wanted = copiesWanted(await copiesSet(db), all);
  if (wanted === 0) return { placed: 0, through: '' };
  const which = opts.only ? sql`f.sha256 = ANY(${listOf(opts.only)}::text[])` : sql`f.sha256 COLLATE "C" > ${opts.after ?? ''}`;
  const page = rowsOf<{ sha256: string; sealed_size: string | number; targets: string[] | string; good: string | number }>(
    await db.execute(sql`SELECT f.sha256, f.sealed_size, coalesce(array_agg(t.machine_id) FILTER (WHERE t.machine_id IS NOT NULL), '{}') AS targets,
      count(g.machine_id) AS good FROM net.files f LEFT JOIN net.file_targets t ON t.sha256 = f.sha256
      LEFT JOIN ${countedTargets(all)} g ON g.sha256 = t.sha256 AND g.machine_id = t.machine_id
      WHERE f.drop_at IS NULL AND ${which} GROUP BY f.sha256 ORDER BY f.sha256 COLLATE "C" LIMIT ${PLACE_BATCH}`),
  );
  let placed = 0;
  for (const row of page) {
    const need = wanted - Number(row.good);
    if (need <= 0) continue;
    const chosen = pick({ sealedSize: Number(row.sealed_size), targets: arrayOf(row.targets) }, all, need);
    if (!chosen.length) continue;
    await db.execute(sql`INSERT INTO net.file_targets (sha256, machine_id) SELECT ${row.sha256}, unnest(${listOf(chosen)}::uuid[]) ON CONFLICT DO NOTHING`);
    placed += chosen.length;
  }
  return { placed, through: opts.only || page.length < PLACE_BATCH ? '' : page.at(-1)!.sha256 };
}

/* Lets go of the targets a file needs no more, once the copies wanted stand on counted targets that keep it: those on a
   machine away for a day, without an area or over it, and those past the copies wanted, the leading machine's last.
   Until then a file keeps every target it has. A page a round from after through the names; says how many went, and
   the last name looked at, '' once it went through them all. */
export async function trimTargets(db: Tx, leader: string | null, opts: { now?: Date; after?: string } = {}): Promise<{ gone: number; through: string }> {
  const all = await seats(db, leader, opts.now);
  const wanted = copiesWanted(await copiesSet(db), all);
  if (wanted === 0) return { gone: 0, through: '' };
  const rows = rowsOf<{ sha256: string; machine_id: string; good: boolean; held: boolean }>(
    await db.execute(sql`WITH g AS ${countedTargets(all)},
      t AS (SELECT t.sha256, t.machine_id, t.at, EXISTS (SELECT 1 FROM g WHERE g.sha256 = t.sha256 AND g.machine_id = t.machine_id) AS good,
        EXISTS (SELECT 1 FROM net.file_copies c WHERE c.sha256 = t.sha256 AND c.machine_id = t.machine_id AND c.verified) AS held FROM net.file_targets t),
      over AS (SELECT sha256 FROM t WHERE sha256 COLLATE "C" > ${opts.after ?? ''} GROUP BY sha256 HAVING count(*) > ${wanted} OR bool_or(NOT good)
        ORDER BY sha256 COLLATE "C" LIMIT ${PLACE_BATCH})
      SELECT t.sha256, t.machine_id, t.good, t.held FROM t JOIN over USING (sha256) ORDER BY t.sha256, (t.machine_id = ${leader}) DESC, t.at, t.machine_id`),
  );
  const bySha = new Map<string, typeof rows>();
  for (const row of rows) bySha.set(row.sha256, [...(bySha.get(row.sha256) ?? []), row]);
  let gone = 0;
  for (const [sha256, targets] of bySha) {
    const keep = targets.filter(row => row.good && row.held).slice(0, wanted);
    if (keep.length < wanted) continue;
    const go = targets.filter(row => !keep.includes(row)).map(row => row.machine_id);
    if (!go.length) continue;
    await db.execute(sql`DELETE FROM net.file_targets WHERE sha256 = ${sha256} AND machine_id = ANY(${listOf(go)}::uuid[])`);
    gone += go.length;
  }
  return { gone, through: bySha.size < PLACE_BATCH ? '' : [...bySha.keys()].at(-1)! };
}

/* The ids of the machines whose copies count, and how many copies each file wants: for a machine's view, which is asked
   for often, so the area each machine is over is not looked at. */
export async function countedNow(db: Tx, leader: string | null, now = new Date()): Promise<{ ids: string[]; wanted: number }> {
  const all = await seats(db, leader, now);
  return { ids: counted(all).map(seat => seat.id), wanted: copiesWanted(await copiesSet(db), all) };
}

/* The verified copies of a file that stand on counted targets other than one machine's, in SQL: what lets that machine's
   go. */
export const keptElsewhere = (sha256: SQL, machine: string, ids: string[]): SQL =>
  sql`(SELECT count(*) FROM net.file_targets t JOIN net.file_copies o ON o.sha256 = t.sha256 AND o.machine_id = t.machine_id AND o.verified
    WHERE t.sha256 = ${sha256} AND t.machine_id <> ${machine} AND t.machine_id = ANY(${listOf(ids)}::uuid[]))`;

/* Whether a file stands on as many machines as the copies asked for, as far as the company has machines that keep files,
   each a machine picked for it that keeps it: what lets the mover name a row by the file, whether those machines are
   online this minute or away for days, as a copy a machine away keeps is a copy still. A company with no machine that
   keeps files has the one copy of the machine that took it. */
export async function copiesStand(db: Tx, leader: string | null, sha256: string, now = new Date()): Promise<boolean> {
  const fit = (await seats(db, leader, now)).filter(seat => seat.fit);
  const wanted = Math.min(await copiesSet(db), fit.length);
  if (wanted === 0) return true;
  const [row] = rowsOf<{ n: string | number }>(
    await db.execute(sql`SELECT count(*) AS n FROM net.file_targets t JOIN net.file_copies c ON c.sha256 = t.sha256 AND c.machine_id = t.machine_id AND c.verified
      WHERE t.sha256 = ${sha256} AND t.machine_id = ANY(${listOf(fit.map(seat => seat.id))}::uuid[])`),
  );
  return Number(row?.n ?? 0) >= wanted;
}
