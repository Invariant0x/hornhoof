import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { hasCode } from '../../db/errors.js';
import { hasOldBytes, oldBytesGone, oldPieces } from './legacy.js';

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

export type MoveRound = { moved: number; waiting: number; finished: boolean };
type Mover = Pick<Ctx, 'db' | 'config' | 'files'>;
type Row = { id: string; size: number; held: number | null };

/* Where the mover stands on this app: files stored that wait for a second machine, by row, and the last row it looked at. */
type Place = { waiting: Map<string, { sha256: string; disk: boolean }>; after: string };
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

/* The store's copy opens to bytes of the hash it was stored under. */
async function opensTo(ctx: Mover, sha256: string): Promise<boolean> {
  const hash = createHash('sha256');
  for await (const chunk of ctx.files.store().open(sha256, await ctx.files.key(ctx.db))) hash.update(chunk as Buffer);
  return hash.digest('hex') === sha256;
}

/* The row names its content in the store and gives up its bytes, if they are still the bytes stored. */
async function settle(ctx: Mover, id: string, moved: { sha256: string; disk: boolean }, column: boolean): Promise<boolean> {
  if (!moved.disk) {
    const done = await ctx.db.execute(sql`UPDATE attachments SET sha256 = ${moved.sha256}, bytes = NULL
      WHERE id = ${id} AND bytes IS NOT NULL AND encode(sha256(bytes), 'hex') = ${moved.sha256} RETURNING id`);
    return rowsOf(done).length === 1;
  }
  const done = column
    ? await ctx.db.execute(sql`UPDATE attachments SET sha256 = ${moved.sha256}, bytes = NULL WHERE id = ${id} AND sha256 IS NULL AND (bytes IS NULL OR octet_length(bytes) = 0) RETURNING id`)
    : await ctx.db.execute(sql`UPDATE attachments SET sha256 = ${moved.sha256} WHERE id = ${id} AND sha256 IS NULL RETURNING id`);
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

/* One round of the mover, for at most budgetMs: first the rows whose stored files a second machine keeps now, then more
   rows, then the finish once none is left. */
export async function moveOldFiles(ctx: Mover, opts: { budgetMs?: number; now?: () => number } = {}): Promise<MoveRound> {
  const now = opts.now ?? Date.now;
  const started = now();
  const place = placeOf(ctx.files);
  const column = await hasOldBytes(ctx.db);
  /* With the column gone, only a big file on this machine's disk is left to move. */
  if (!column && !ctx.config.filesDir) return { moved: 0, waiting: 0, finished: true };
  let moved = 0;
  for (const [id, waiting] of place.waiting) {
    if (!(await ctx.files.settled(ctx.db, waiting.sha256, 0))) continue;
    if (await settle(ctx, id, waiting, column)) moved++;
    place.waiting.delete(id);
  }
  while (now() - started < (opts.budgetMs ?? MOVE_BUDGET_MS) && place.waiting.size < MAX_WAITING) {
    const rows = await nextRows(ctx, place.after, [...place.waiting.keys()], column);
    place.after = rows.length < MOVE_BATCH ? '' : rows.at(-1)!.id;
    for (const row of rows) {
      const source = await sourceOf(ctx, row);
      if (!source) continue;
      const kept = await ctx.files.put(ctx.db, source.input);
      if (!(await opensTo(ctx, kept.sha256)) || (source.disk && kept.size !== row.size)) continue;
      const waiting = { sha256: kept.sha256, disk: source.disk };
      if (!(await ctx.files.settled(ctx.db, kept.sha256, 0))) {
        place.waiting.set(row.id, waiting);
        continue;
      }
      if (await settle(ctx, row.id, waiting, column)) moved++;
    }
    if (place.after === '') break;
  }
  const finished = column && place.waiting.size === 0 ? await finishMove(ctx) : !column;
  return { moved, waiting: place.waiting.size, finished };
}
