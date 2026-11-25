import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { hasCode } from '../../db/errors.js';
import { hasOldBytes, oldBytesGone, oldPieces } from './legacy.js';
import { approvedRows, listMoved, noteCleared, noteRoomBack, reconcile, unlist, type Listed, type Reconciliation } from './move.js';
import { SealRefused } from './seal.js';
import { StoreRefused } from './store.js';

/* Moves the bytes an older Hornhoof kept in Postgres, and the big files it kept on the disk of the machine that took
   them, into the store on this server's disk, while the server goes on serving. The state is in the rows: a row that
   names no content yet is not moved yet. A row is named by its content only once the store's copy opened to bytes of its
   sha256, and only in an update that proves its bytes are the bytes the store keeps; it keeps its bytes. They are cleared
   only once the CEO said yes to the reconciliation that lists the row (move.ts), only while the store of the machine that
   clears them opens its copy to them again, and only in an update that proves they are the bytes stored. A crash or a
   restart goes on from the next row: what was stored already is found there again. Once no row holds a byte, the column
   goes and the table gives its room back. */

/* Rows looked at a time. */
const MOVE_BATCH = 5;
/* Rows cleared a time. */
const CLEAR_BATCH = 20;
/* How long one round moves files at most, so the minute round goes on. */
export const MOVE_BUDGET_MS = 20_000;

const rowsOf = <T>(answer: unknown): T[] => (Array.isArray(answer) ? answer : (answer as { rows: T[] }).rows);

/* moved: rows named by their stored files; cleared: rows that gave up their bytes; ready: the reconciliation made now, for
   the CEO's yes; roomBack: the size of the database before and after the column went. stays says, once for an app, that the
   files stay in Postgres because the server has no FILES_DIR to keep them in. */
export type MoveRound = {
  moved: number;
  finished: boolean;
  cleared?: number;
  ready?: Reconciliation;
  roomBack?: { before: number; after: number };
  stays?: 'no_files_dir';
};
type Mover = Pick<Ctx, 'db' | 'config' | 'files'>;
type Row = { id: string; size: number; held: number | null };

/* Where the mover stands on this app: the last row it looked at, and whether it said the files stay where they are. */
type Moved = { sha256: string; size: number; disk: boolean };
type Place = { after: string; told?: boolean };
const places = new WeakMap<object, Place>();
const placeOf = (files: object): Place => {
  let place = places.get(files);
  if (!place) places.set(files, (place = { after: '' }));
  return place;
};

/* The next rows with bytes to move: those of the old column while it is there, or, with it gone, a row that names no
   content of the store yet and whose file may lie on this machine's disk. An empty file, which has no byte to see, is moved
   too. */
async function nextRows(ctx: Mover, after: string, column: boolean): Promise<Row[]> {
  const found = column
    ? await ctx.db.execute(sql`SELECT id, size, octet_length(bytes) AS held FROM attachments WHERE bytes IS NOT NULL AND sha256 IS NULL AND id::text > ${after}
        ORDER BY id::text LIMIT ${MOVE_BATCH}`)
    : await ctx.db.execute(sql`SELECT id, size, NULL::int AS held FROM attachments WHERE sha256 IS NULL AND id::text > ${after} ORDER BY id::text LIMIT ${MOVE_BATCH}`);
  return rowsOf<{ id: string; size: number; held: number | null }>(found).map(row => ({ id: row.id, size: Number(row.size), held: row.held === null ? null : Number(row.held) }));
}

/* A row's bytes as they come: from the old column a piece at a time, or from this machine's disk; none when neither has
   them here. */
async function sourceOf(ctx: Mover, row: Row): Promise<{ input: Readable; disk: boolean } | null> {
  if (row.held !== null && (row.held > 0 || row.size === 0)) return { input: Readable.from(oldPieces(ctx.db, row.id, row.held)), disk: false };
  const file = ctx.config.filesDir ? await open(join(ctx.config.filesDir, row.id)).catch(() => null) : null;
  return file ? { input: file.createReadStream(), disk: true } : null;
}

/* The store's copy opens to bytes of the hash it was stored under. One that does not open, or is not in the store of this
   machine, is no copy: its row keeps its bytes, and the round goes on with the next row. */
async function opensTo(ctx: Mover, sha256: string): Promise<boolean> {
  const key = await ctx.files.key(ctx.db);
  const hash = createHash('sha256');
  try {
    for await (const chunk of ctx.files.store().open(sha256, key)) hash.update(chunk as Buffer);
  } catch (err) {
    if (err instanceof SealRefused || (err instanceof StoreRefused && err.reason === 'missing')) return false;
    throw err;
  }
  return hash.digest('hex') === sha256;
}

/* The store still keeps the content and is not letting it go: the store's round takes the record's lock before it removes
   a content, so the two never cross. */
const stillKept = (sha256: string) => sql`EXISTS (SELECT 1 FROM net.files f WHERE f.sha256 = ${sha256} AND f.drop_at IS NULL FOR SHARE)`;

/* The update that names a row by its content, if its bytes are still the bytes stored and the store still keeps them. */
const naming = (id: string, moved: Moved, column: boolean) =>
  !moved.disk
    ? sql`UPDATE attachments SET sha256 = ${moved.sha256} WHERE id = ${id} AND sha256 IS NULL AND bytes IS NOT NULL
        AND encode(sha256(bytes), 'hex') = ${moved.sha256} AND ${stillKept(moved.sha256)} RETURNING id`
    : column
      ? sql`UPDATE attachments SET sha256 = ${moved.sha256} WHERE id = ${id} AND sha256 IS NULL AND (bytes IS NULL OR octet_length(bytes) = 0) AND ${stillKept(moved.sha256)} RETURNING id`
      : sql`UPDATE attachments SET sha256 = ${moved.sha256} WHERE id = ${id} AND sha256 IS NULL AND ${stillKept(moved.sha256)} RETURNING id`;

/* The row names its content in the store and goes on the list of the next reconciliation. It keeps its bytes, and a big
   file of 0.43 its disk file, until the CEO says yes to that reconciliation. */
async function settle(ctx: Mover, id: string, moved: Moved, column: boolean): Promise<boolean> {
  return ctx.db.transaction(async tx => {
    if (rowsOf(await tx.execute(naming(id, moved, column))).length !== 1) return false;
    await listMoved(tx, { id, ...moved });
    return true;
  });
}

/* The update that clears a listed row's bytes, if they are still the bytes stored and the store still keeps them. With
   the column gone, a row of a disk file has no byte left to clear. */
const clearing = (row: Listed, column: boolean) =>
  !row.disk
    ? sql`UPDATE attachments SET bytes = NULL WHERE id = ${row.id} AND sha256 = ${row.sha256} AND bytes IS NOT NULL
        AND encode(sha256(bytes), 'hex') = ${row.sha256} AND ${stillKept(row.sha256)} RETURNING id`
    : column
      ? sql`UPDATE attachments SET bytes = NULL WHERE id = ${row.id} AND sha256 = ${row.sha256} AND (bytes IS NULL OR octet_length(bytes) = 0) AND ${stillKept(row.sha256)} RETURNING id`
      : sql`SELECT id FROM attachments WHERE id = ${row.id} AND sha256 = ${row.sha256} AND ${stillKept(row.sha256)}`;

/* A listed row that was not cleared: one whose bytes are other bytes now is named no more, so it moves again as it reads;
   one gone, or named no more, leaves the list. One whose content the store is letting go just now stays for a later round. */
async function notCleared(tx: Pick<Ctx['db'], 'execute'>, row: Listed, column: boolean): Promise<void> {
  if (column && !row.disk) {
    await tx.execute(sql`UPDATE attachments SET sha256 = NULL WHERE id = ${row.id} AND sha256 = ${row.sha256} AND bytes IS NOT NULL AND encode(sha256(bytes), 'hex') <> ${row.sha256}`);
  }
  if (rowsOf(await tx.execute(sql`SELECT 1 AS one FROM attachments WHERE id = ${row.id} AND sha256 = ${row.sha256}`)).length === 0) await unlist(tx, row.id);
}

/* A listed row whose content the store of this machine does not keep whole, as on a machine that leads after another
   moved it, or one whose copy a fault of the disk spoiled: where its bytes are here, it is named no more, so it is read
   from them and moves again, for a reconciliation of its own. One whose bytes are not here either stays as it is. */
async function notKeptHere(ctx: Mover, row: Listed, column: boolean): Promise<void> {
  if (!(row.disk ? existsSync(join(ctx.config.filesDir!, row.id)) : column)) return;
  await ctx.db.transaction(async tx => {
    await tx.execute(
      row.disk
        ? sql`UPDATE attachments SET sha256 = NULL WHERE id = ${row.id} AND sha256 = ${row.sha256}`
        : sql`UPDATE attachments SET sha256 = NULL WHERE id = ${row.id} AND sha256 = ${row.sha256} AND bytes IS NOT NULL`,
    );
    if (rowsOf(await tx.execute(sql`SELECT 1 AS one FROM attachments WHERE id = ${row.id} AND sha256 = ${row.sha256}`)).length === 0) await unlist(tx, row.id);
  });
}

/* A listed row of a reconciliation the CEO said yes to gives up its bytes and leaves the list; then its disk file goes.
   Only once the store of this machine keeps the copy whole, which is then the only one: the store's round removes no
   content a row names, and the clearing holds its record. */
async function clearRow(ctx: Mover, row: Listed, column: boolean): Promise<boolean> {
  if (!(await opensTo(ctx, row.sha256))) return notKeptHere(ctx, row, column).then(() => false);
  const cleared = await ctx.db.transaction(async tx => {
    if (rowsOf(await tx.execute(clearing(row, column))).length !== 1) return notCleared(tx, row, column).then(() => false);
    await unlist(tx, row.id);
    return true;
  });
  if (cleared && row.disk) await rm(join(ctx.config.filesDir!, row.id), { force: true });
  return cleared;
}

/* The rows of reconciliations the CEO said yes to, each once in a round: a few, and more while the round has time. Says
   how many gave up their bytes. */
async function clearApproved(ctx: Mover, column: boolean, inTime: () => boolean): Promise<number> {
  let cleared = 0;
  let after = '';
  do {
    const rows = await approvedRows(ctx.db, after, CLEAR_BATCH);
    for (const row of rows) if (await clearRow(ctx, row, column)) cleared++;
    if (rows.length < CLEAR_BATCH) break;
    after = rows.at(-1)!.id;
  } while (inTime());
  if (cleared > 0) await noteCleared(ctx.db);
  return cleared;
}

/* Whether a row not named yet has its bytes on this machine: in the old column, or in a file on this machine's disk. */
async function bytesLeftHere(ctx: Mover, column: boolean): Promise<boolean> {
  const inColumn = column
    ? sql`SELECT EXISTS (SELECT 1 FROM attachments WHERE sha256 IS NULL AND (octet_length(bytes) > 0 OR (bytes IS NOT NULL AND size = 0))) AS there`
    : sql`SELECT false AS there`;
  if (rowsOf<{ there: boolean }>(await ctx.db.execute(inColumn))[0]?.there) return true;
  const onDisk = rowsOf<{ id: string }>(
    await ctx.db.execute(
      column
        ? sql`SELECT id FROM attachments WHERE sha256 IS NULL AND size > 0 AND (bytes IS NULL OR octet_length(bytes) = 0)`
        : sql`SELECT id FROM attachments WHERE sha256 IS NULL AND size > 0`,
    ),
  );
  return onDisk.some(row => existsSync(join(ctx.config.filesDir!, row.id)));
}

/* Drops the old column once no row holds a byte of it, in one short transaction that waits for no long lock, with the
   journal of the table made again without it; then gives the table's room back. Tried again at a later round when a lock
   is held. */
export async function finishMove(ctx: Pick<Ctx, 'db'>): Promise<boolean> {
  const { db } = ctx;
  if (!(await hasOldBytes(db))) return true;
  /* A row whose column holds no byte loses nothing with it: an empty file, or a big one on the disk of its machine. */
  const [left] = rowsOf<{ left: boolean }>(await db.execute(sql`SELECT EXISTS (SELECT 1 FROM attachments WHERE octet_length(bytes) > 0) AS left`));
  if (left?.left) return false;
  try {
    await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await tx.execute(sql`ALTER TABLE public.attachments DROP COLUMN bytes`);
      await tx.execute(sql`SELECT net.attach_journal_to('public.attachments'::regclass, 'attachments')`);
    });
  } catch (err) {
    if (hasCode(err, '55P03')) return false;
    throw err;
  }
  oldBytesGone(db);
  await db.execute(sql`VACUUM FULL public.attachments`);
  return true;
}

/* The answer of a server with no FILES_DIR, whose store is a folder of this run alone: the files stay in Postgres, so a
   row never gives up its bytes to a store that goes with a restart. It says so once for an app. */
function staysHere(place: Place, column: boolean): MoveRound {
  const stays = column && !place.told ? { stays: 'no_files_dir' as const } : {};
  place.told = place.told || column;
  return { moved: 0, finished: !column, ...stays };
}

/* Stores one row's file, checked by opening it again, and the row is named by it. Says whether it was named. */
async function moveRow(ctx: Mover, row: Row, column: boolean): Promise<boolean> {
  const source = await sourceOf(ctx, row);
  if (!source) return false;
  const kept = await ctx.files.put(ctx.db, source.input);
  if (!(await opensTo(ctx, kept.sha256)) || (source.disk && kept.size !== row.size)) return false;
  return settle(ctx, row.id, { sha256: kept.sha256, size: kept.size, disk: source.disk }, column);
}

/* More rows, a few at a time, while the round has time. Says how many were named. */
async function moveMore(ctx: Mover, place: Place, column: boolean, inTime: () => boolean): Promise<number> {
  let moved = 0;
  while (inTime()) {
    const rows = await nextRows(ctx, place.after, column);
    place.after = rows.length < MOVE_BATCH ? '' : rows.at(-1)!.id;
    for (const row of rows) if (await moveRow(ctx, row, column)) moved++;
    if (place.after === '') break;
  }
  return moved;
}

/* The reconciliation of the rows named since the last one, once no row whose bytes are here is left to name. */
async function readyNow(ctx: Mover, column: boolean): Promise<Reconciliation | null> {
  if (await bytesLeftHere(ctx, column)) return null;
  return reconcile(ctx.db);
}

/* The end of a round: the reconciliation, and the finish, with the room the database gave back when the column went just
   now. */
async function endRound(ctx: Mover, column: boolean): Promise<Pick<MoveRound, 'finished' | 'ready' | 'roomBack'>> {
  const ready = await readyNow(ctx, column);
  const finished = column ? await finishMove(ctx) : true;
  const roomBack = column && finished ? await noteRoomBack(ctx.db) : null;
  return { finished, ...(ready ? { ready } : {}), ...(roomBack ? { roomBack } : {}) };
}

/* One round of the mover, for at most budgetMs: more rows, then the rows the CEO said yes to clearing, then the
   reconciliation and the finish. A server with no FILES_DIR leaves the files in Postgres. */
export async function moveOldFiles(ctx: Mover, opts: { budgetMs?: number; now?: () => number } = {}): Promise<MoveRound> {
  const now = opts.now ?? Date.now;
  const budget = opts.budgetMs ?? MOVE_BUDGET_MS;
  const started = now();
  const inTime = () => now() - started < budget;
  const place = placeOf(ctx.files);
  const column = await hasOldBytes(ctx.db);
  if (!ctx.config.filesDir) return staysHere(place, column);
  const moved = await moveMore(ctx, place, column, inTime);
  const cleared = await clearApproved(ctx, column, inTime);
  return { moved, ...(cleared > 0 ? { cleared } : {}), ...(await endRound(ctx, column)) };
}
