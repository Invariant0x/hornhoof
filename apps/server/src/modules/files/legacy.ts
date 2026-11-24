import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { ApiError } from '../../errors.js';

/* A file of a row from before the store, which the leading app has not moved yet: its bytes in the old column of the
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

/* How many bytes the old column of a row holds; 0 when the column or its bytes are gone. */
export async function oldBytesLength(db: Pick<Db, 'execute'>, id: string): Promise<number> {
  if (!(await hasOldBytes(db))) return 0;
  const [row] = rowsOf<{ n: number | null }>(await db.execute(sql`SELECT octet_length(bytes) AS n FROM attachments WHERE id = ${id}`));
  return Number(row?.n ?? 0);
}

async function* oldPieces(db: Pick<Db, 'execute'>, id: string, length: number) {
  for (let at = 0; at < length; at += PIECE_BYTES) {
    const [piece] = rowsOf<{ bytes: Uint8Array | null }>(await db.execute(sql`SELECT substring(bytes from ${at + 1} for ${PIECE_BYTES}) AS bytes FROM attachments WHERE id = ${id}`));
    if (!piece?.bytes) throw new Error('The file was removed or moved while it was being sent.');
    yield Buffer.from(piece.bytes);
  }
}

/* The bytes of a row from before the store, as they go out. */
export async function oldFileStream(ctx: { db: Pick<Db, 'execute'>; config: Pick<Config, 'filesDir'> }, id: string): Promise<Readable> {
  const length = await oldBytesLength(ctx.db, id);
  if (length > 0) return Readable.from(oldPieces(ctx.db, id, length));
  const file = ctx.config.filesDir ? await open(join(ctx.config.filesDir, id)).catch(() => null) : null;
  if (!file) throw fileLost();
  return file.createReadStream();
}
