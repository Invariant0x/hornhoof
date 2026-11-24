import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { hasCode } from '../../db/errors.js';
import { hasOldBytes, oldBytesGone, oldPieces } from './legacy.js';
import { SealRefused } from './seal.js';

/* Moves the bytes an older Hornhoof kept in Postgres, and the big files it kept on the disk of the machine that took
   them, into the store, while the app leads and the server goes on serving. The state is in the rows alone: a row that
   still holds bytes is not moved yet. A row gives up its bytes only in an update that proves the bytes it clears are the
   bytes the store keeps, and only once a second machine keeps them where the company has one. A crash or a restart goes
   on from the next row: what was stored already is found there again. Once no row holds a byte, the column goes and the
   table gives its room back. */

/* Rows looked at a time. */
const MOVE_BATCH = 5;
/* Files stored and waiting for a second machine at most, before the mover stores more. */
const MAX_WAITING = 200;
/* How long one round moves files at most, so the minute round goes on. */
export const MOVE_BUDGET_MS = 20_000;

const rowsOf = <T>(answer: unknown): T[] => (Array.isArray(answer) ? answer : (answer as { rows: T[] }).rows);

/* stays says, once for an app, that the files stay in Postgres because the server has no FILES_DIR to keep them in. */
export type MoveRound = { moved: number; waiting: number; finished: boolean; stays?: 'no_files_dir' };
type Mover = Pick<Ctx, 'db' | 'config' | 'files'>;
type Row = { id: string; size: number; held: number | null };

/* Where the mover stands on this app: files stored that wait for a second machine, by row, the last row it looked at,
   and whether it said the files stay where they are. */
type Place = { waiting: Map<string, { sha256: string; disk: boolean }>; after: string; told?: boolean };
const places = new WeakMap<object, Place>();
const placeOf = (files: object): Place => {
  let place = places.get(files);
  if (!place) places.set(files, (place = { waiting: new Map(), after: '' }));
  return place;
};

/* The next rows with bytes to move: those of the old column while it is there, or, with it gone, a row that names no
   content of the store yet and whose file may lie on this machine's disk. An empty file, which has no byte to see, is moved
   too. */
async function nextRows(ctx: Mover, after: string, skip: string[], column: boolean): Promise<Row[]> {
  const others = `{${skip.join(',')}}`;
  const found = column
    ? await ctx.db.execute(sql`SELECT id, size, octet_length(bytes) AS held FROM attachments WHERE bytes IS NOT NULL AND id::text > ${after}
        AND NOT (id = ANY(${others}::uuid[])) ORDER BY id::text LIMIT ${MOVE_BATCH}`)
    : await ctx.db.execute(sql`SELECT id, size, NULL::int AS held FROM attachments WHERE sha256 IS NULL AND id::text > ${after}
        AND NOT (id = ANY(${others}::uuid[])) ORDER BY id::text LIMIT ${MOVE_BATCH}`);
  return rowsOf<{ id: string; size: number; held: number | null }>(found).map(row => ({ id: row.id, size: Number(row.size), held: row.held === null ? null : Number(row.held) }));
}

/* A row's bytes as they come: from the old column a piece at a time, or from this machine's disk; none when neither has
   them here. */
async function sourceOf(ctx: Mover, row: Row): Promise<{ input: Readable; disk: boolean } | null> {
  if (row.held !== null && (row.held > 0 || row.size === 0)) return { input: Readable.from(oldPieces(ctx.db, row.id, row.held)), disk: false };
  const file = ctx.config.filesDir ? await open(join(ctx.config.filesDir, row.id)).catch(() => null) : null;
  return file ? { input: file.createReadStream(), disk: true } : null;
}

/* The store's copy opens to bytes of the hash it was stored under. One that does not open is no copy: its row keeps its
   bytes, and the round goes on with the next row. */
async function opensTo(ctx: Mover, sha256: string): Promise<boolean> {
  const key = await ctx.files.key(ctx.db);
  const hash = createHash('sha256');
  try {
    for await (const chunk of ctx.files.store().open(sha256, key)) hash.update(chunk as Buffer);
  } catch (err) {
    if (err instanceof SealRefused) return false;
    throw err;
  }
  return hash.digest('hex') === sha256;
}

/* The store still keeps the content and is not letting it go: the store's round takes the record's lock before it removes
   a content, so the two never cross. */
const stillKept = (sha256: string) => sql`EXISTS (SELECT 1 FROM net.files f WHERE f.sha256 = ${sha256} AND f.drop_at IS NULL FOR SHARE)`;

/* The row names its content in the store and gives up its bytes, if they are still the bytes stored and the store still
   keeps them. */
async function settle(ctx: Mover, id: string, moved: { sha256: string; disk: boolean }, column: boolean): Promise<boolean> {
  if (!moved.disk) {
    const done = await ctx.db.execute(sql`UPDATE attachments SET sha256 = ${moved.sha256}, bytes = NULL
      WHERE id = ${id} AND bytes IS NOT NULL AND encode(sha256(bytes), 'hex') = ${moved.sha256} AND ${stillKept(moved.sha256)} RETURNING id`);
    return rowsOf(done).length === 1;
  }
  const done = column
    ? await ctx.db.execute(sql`UPDATE attachments SET sha256 = ${moved.sha256}, bytes = NULL WHERE id = ${id} AND sha256 IS NULL AND (bytes IS NULL OR octet_length(bytes) = 0) AND ${stillKept(moved.sha256)} RETURNING id`)
    : await ctx.db.execute(sql`UPDATE attachments SET sha256 = ${moved.sha256} WHERE id = ${id} AND sha256 IS NULL AND ${stillKept(moved.sha256)} RETURNING id`);
  if (rowsOf(done).length !== 1) return false;
  await rm(join(ctx.config.filesDir!, id), { force: true });
  return true;
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

/* The contents stored for rows that wait for a second machine are in use, as a row's are, however long that machine is
   away: no round of the store lets them go. One the store let go meanwhile is stored again later, as its row still holds
   the bytes. */
async function keepWaiting(ctx: Mover, place: Place): Promise<void> {
  const contents = [...new Set([...place.waiting.values()].map(waiting => waiting.sha256))];
  if (contents.length === 0) return;
  const list = `{${contents.join(',')}}`;
  const kept = rowsOf<{ sha256: string }>(await ctx.db.execute(sql`UPDATE net.files SET unused_since = NULL
    WHERE sha256 = ANY(${list}::text[]) AND drop_at IS NULL RETURNING sha256`));
  const still = new Set(kept.map(row => row.sha256));
  for (const [id, waiting] of place.waiting) if (!still.has(waiting.sha256)) place.waiting.delete(id);
}

/* The answer of a server with no FILES_DIR, whose store is a folder of this run alone: the files stay in Postgres, so a
   row never gives up its bytes to a store that goes with a restart. It says so once for an app. */
function staysHere(place: Place, column: boolean): MoveRound {
  const stays = column && !place.told ? { stays: 'no_files_dir' as const } : {};
  place.told = place.told || column;
  return { moved: 0, waiting: 0, finished: !column, ...stays };
}

/* The rows whose stored files a second machine keeps now give up their bytes. Says how many did. */
async function settleWaiting(ctx: Mover, place: Place, column: boolean): Promise<number> {
  await keepWaiting(ctx, place);
  let moved = 0;
  for (const [id, waiting] of place.waiting) {
    if (!(await ctx.files.settled(ctx.db, waiting.sha256, 0))) continue;
    if (await settle(ctx, id, waiting, column)) moved++;
    place.waiting.delete(id);
  }
  return moved;
}

/* Stores one row's file, checked by opening it again, and the row gives up its bytes at once, or waits for a second
   machine. Says whether it gave them up. */
async function moveRow(ctx: Mover, place: Place, row: Row, column: boolean): Promise<boolean> {
  const source = await sourceOf(ctx, row);
  if (!source) return false;
  const kept = await ctx.files.put(ctx.db, source.input);
  if (!(await opensTo(ctx, kept.sha256)) || (source.disk && kept.size !== row.size)) return false;
  const waiting = { sha256: kept.sha256, disk: source.disk };
  if (!(await ctx.files.settled(ctx.db, kept.sha256, 0))) {
    place.waiting.set(row.id, waiting);
    return false;
  }
  return settle(ctx, row.id, waiting, column);
}

/* More rows, a few at a time, while the round has time and not too many wait. Says how many gave up their bytes. */
async function moveMore(ctx: Mover, place: Place, column: boolean, inTime: () => boolean): Promise<number> {
  let moved = 0;
  while (inTime() && place.waiting.size < MAX_WAITING) {
    const rows = await nextRows(ctx, place.after, [...place.waiting.keys()], column);
    place.after = rows.length < MOVE_BATCH ? '' : rows.at(-1)!.id;
    for (const row of rows) if (await moveRow(ctx, place, row, column)) moved++;
    if (place.after === '') break;
  }
  return moved;
}

/* One round of the mover, for at most budgetMs: first the rows whose stored files a second machine keeps now, then more
   rows, then the finish once none is left. A server with no FILES_DIR leaves the files in Postgres. */
export async function moveOldFiles(ctx: Mover, opts: { budgetMs?: number; now?: () => number } = {}): Promise<MoveRound> {
  const now = opts.now ?? Date.now;
  const budget = opts.budgetMs ?? MOVE_BUDGET_MS;
  const started = now();
  const place = placeOf(ctx.files);
  const column = await hasOldBytes(ctx.db);
  if (!ctx.config.filesDir) return staysHere(place, column);
  const moved = (await settleWaiting(ctx, place, column)) + (await moveMore(ctx, place, column, () => now() - started < budget));
  const finished = column && place.waiting.size === 0 ? await finishMove(ctx) : !column;
  return { moved, waiting: place.waiting.size, finished };
}
