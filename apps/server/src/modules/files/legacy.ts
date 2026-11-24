import type { Dirent } from 'node:fs';
import { open, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { ApiError } from '../../errors.js';
import { SET_ASIDE } from './sweep.js';

/* A file of a row from before the store, which the mover has not moved yet: its bytes in the old column of the
   row, read a piece at a time, or, for one over 50 MB, on the disk of the machine that took it, in FILES_DIR under the
   row's id. Once every row is moved the column goes, and nothing here is read any more. */
const PIECE_BYTES = 1024 * 1024;
const rowsOf = <T>(answer: unknown): T[] => (Array.isArray(answer) ? answer : (answer as { rows: T[] }).rows);

export const fileLost = () => new ApiError(410, 'gone', 'This file was kept on one machine before files had a store, and that machine is gone with it.', 'file_lost');

/* Whether the old column is still there. Once it went from a database it never comes back, so that answer is kept for
   that database. */
const columnGone = new WeakSet<object>();
export async function hasOldBytes(db: Pick<Db, 'execute'>): Promise<boolean> {
  if (columnGone.has(db)) return false;
  const [row] = rowsOf<{ there: boolean }>(
    await db.execute(sql`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'attachments' AND column_name = 'bytes') AS there`),
  );
  if (!row?.there) columnGone.add(db);
  return Boolean(row?.there);
}

/* The column went from this database just now. */
export function oldBytesGone(db: Pick<Db, 'execute'>): void {
  columnGone.add(db);
}

/* How many bytes the old column of a row holds; 0 when the column or its bytes are gone. */
export async function oldBytesLength(db: Pick<Db, 'execute'>, id: string): Promise<number> {
  if (!(await hasOldBytes(db))) return 0;
  const [row] = rowsOf<{ n: number | null }>(await db.execute(sql`SELECT octet_length(bytes) AS n FROM attachments WHERE id = ${id}`));
  return Number(row?.n ?? 0);
}

export async function* oldPieces(db: Pick<Db, 'execute'>, id: string, length: number) {
  for (let at = 0; at < length; at += PIECE_BYTES) {
    const [piece] = rowsOf<{ bytes: Uint8Array | null }>(await db.execute(sql`SELECT substring(bytes from ${at + 1} for ${PIECE_BYTES}) AS bytes FROM attachments WHERE id = ${id}`));
    if (!piece?.bytes) throw new Error('The file was removed or moved while it was being sent.');
    yield Buffer.from(piece.bytes);
  }
}

/* The bytes of a row from before the store, as they go out; an empty file has none to keep anywhere. */
export async function oldFileStream(ctx: { db: Pick<Db, 'execute'>; config: Pick<Config, 'filesDir'> }, id: string): Promise<Readable> {
  const length = await oldBytesLength(ctx.db, id);
  if (length > 0) return Readable.from(oldPieces(ctx.db, id, length));
  const file = ctx.config.filesDir ? await open(join(ctx.config.filesDir, id)).catch(() => null) : null;
  if (file) return file.createReadStream();
  const [row] = rowsOf<{ size: number }>(await ctx.db.execute(sql`SELECT size FROM attachments WHERE id = ${id}`));
  if (row && Number(row.size) === 0) return Readable.from([]);
  throw fileLost();
}

/* The name a big file of 0.43 lies under in FILES_DIR: its row's id. */
const ROW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IDS_AT_ONCE = 500;

/* The big files of 0.43 in the folder that are as old as the cutoff. */
async function oldOnDisk(dir: string, cutoff: Date): Promise<string[]> {
  const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[])).filter(entry => entry.isFile() && ROW_ID.test(entry.name));
  const old: string[] = [];
  for (const { name } of entries) if (((await stat(join(dir, name)).catch(() => null))?.mtime ?? cutoff) < cutoff) old.push(name);
  return old;
}

/* Of these row ids, those no row has. */
async function rowless(db: Pick<Db, 'execute'>, ids: string[]): Promise<string[]> {
  const rows = rowsOf<{ id: string }>(await db.execute(sql`SELECT id::text AS id FROM attachments WHERE id = ANY(${`{${ids.join(',')}}`}::uuid[])`));
  const named = new Set(rows.map(row => row.id));
  return ids.filter(id => !named.has(id));
}

const setAside = async (db: Pick<Db, 'execute'>): Promise<boolean> => Boolean(rowsOf<{ aside: boolean }>(await db.execute(sql`SELECT ${SET_ASIDE} AS aside`))[0]?.aside);

/* Removes the big files of 0.43 on this machine's disk whose row is gone, as retention takes the rows of old tasks before
   the mover came to them (#2036), once they are as old as the cutoff, as 0.43 removed them. A file still to move stays,
   and so do the store and any other file in the folder; and all of them while a database set aside may be merged back.
   Says how many went. */
export async function dropLeftOnDisk(ctx: { db: Pick<Db, 'execute'>; config: Pick<Config, 'filesDir'> }, cutoff: Date): Promise<number> {
  const dir = ctx.config.filesDir;
  if (!dir) return 0;
  const old = await oldOnDisk(dir, cutoff);
  if (!old.length || (await setAside(ctx.db))) return 0;
  let dropped = 0;
  for (let at = 0; at < old.length; at += IDS_AT_ONCE) {
    for (const id of await rowless(ctx.db, old.slice(at, at + IDS_AT_ONCE))) {
      await rm(join(dir, id), { force: true });
      dropped++;
    }
  }
  return dropped;
}
