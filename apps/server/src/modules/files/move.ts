import { rowsOf } from '../../db/result-rows.js';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson, type Person } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { ApiError } from '../../errors.js';
import { hasOldBytes } from './legacy.js';

/* The CEO's yes to the end of the move out of the database. The mover copies the file of each row from before the store
   into it, checks it there and names it on the row, but clears nothing: the bytes in Postgres, the column and the big
   files on the disk stay. Once every row whose bytes are on this machine is named, the rows named since the last
   reconciliation make a new one: its files, contents and bytes, the rows whose bytes are not here, the size of the
   database, and the digest of its list. The CEO, or the orchestrator for him, reads them and says yes to a digest; only
   then does the mover clear that list's rows, each only while Postgres finds its bytes are the bytes stored. */

type Tx = Pick<Db, 'execute'>;
const isoOf = (at: unknown): string | null => (at === null || at === undefined ? null : new Date(at as string).toISOString());
const numberOf = (n: unknown): number | null => (n === null || n === undefined ? null : Number(n));

export type Reconciliation = { digest: string; files: number; contents: number; bytes: number; notHere: number; databaseBytes: number };
export type FileMove = Reconciliation & {
  madeAt: string;
  approvedAt: string | null;
  approvedBy: string | null;
  clearedAt: string | null;
  databaseBytesAfter: number | null;
  /* Its rows that still hold their bytes. */
  left: number;
};
/* A named row as the list keeps it: the sha256 and size of the bytes stored, and whether they lay on the disk. */
export type Listed = { id: string; sha256: string; size: number; disk: boolean };

/* What a digest is of: each row of the list ordered by id, as "<id> <sha256> <size>" and a newline. */
export function digestOf(rows: Pick<Listed, 'id' | 'sha256' | 'size'>[]): string {
  const hash = createHash('sha256');
  for (const row of [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) hash.update(`${row.id} ${row.sha256} ${row.size}\n`);
  return hash.digest('hex');
}

/* Puts a row the mover named on the list, in the transaction that named it, for the next reconciliation. */
export async function listMoved(tx: Tx, row: Listed): Promise<void> {
  await tx.execute(sql`INSERT INTO net.file_move_rows (id, sha256, size, disk) VALUES (${row.id}, ${row.sha256}, ${row.size}, ${row.disk})
    ON CONFLICT (id) DO UPDATE SET sha256 = excluded.sha256, size = excluded.size, disk = excluded.disk, digest = NULL`);
}

export async function unlist(tx: Tx, id: string): Promise<void> {
  await tx.execute(sql`DELETE FROM net.file_move_rows WHERE id = ${id}`);
}

/* The rows of reconciliations the CEO said yes to that still hold their bytes, after one id, a few at a time. */
export async function approvedRows(db: Tx, after: string, limit: number): Promise<Listed[]> {
  const found = await db.execute(sql`SELECT r.id, r.sha256, r.size, r.disk FROM net.file_move_rows r JOIN net.file_moves m ON m.digest = r.digest
    WHERE m.approved_at IS NOT NULL AND r.id::text > ${after} ORDER BY r.id::text LIMIT ${limit}`);
  return rowsOf<{ id: string; sha256: string; size: string; disk: boolean }>(found).map(row => ({ ...row, size: Number(row.size) }));
}

/* Rows that name no content of the store yet, and are not empty: those still to move, or whose bytes are not here. */
async function unnamed(db: Tx): Promise<number> {
  return rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM attachments WHERE sha256 IS NULL AND size > 0`))[0]?.n ?? 0;
}

/* The reconciliation of the rows named since the last one, made once no row whose bytes are on this machine is left to
   name. None when no row was named since. */
export async function reconcile(db: Db): Promise<Reconciliation | null> {
  const rows = rowsOf<{ id: string; sha256: string; size: string }>(await db.execute(sql`SELECT id, sha256, size FROM net.file_move_rows WHERE digest IS NULL`)).map(row => ({
    ...row,
    size: Number(row.size),
  }));
  if (rows.length === 0) return null;
  const made = { digest: digestOf(rows), files: rows.length, contents: new Set(rows.map(row => row.sha256)).size, bytes: rows.reduce((sum, row) => sum + row.size, 0), notHere: await unnamed(db) };
  return db.transaction(async tx => {
    const [size] = rowsOf<{ n: string }>(await tx.execute(sql`SELECT pg_database_size(current_database()) AS n`));
    const reconciliation = { ...made, databaseBytes: Number(size!.n) };
    await tx.execute(sql`INSERT INTO net.file_moves (digest, files, contents, bytes, not_here, database_bytes)
      VALUES (${made.digest}, ${made.files}, ${made.contents}, ${made.bytes}, ${made.notHere}, ${reconciliation.databaseBytes}) ON CONFLICT (digest) DO NOTHING`);
    await tx.execute(sql`UPDATE net.file_move_rows SET digest = ${made.digest} WHERE digest IS NULL AND id = ANY(${`{${rows.map(row => row.id).join(',')}}`}::uuid[])`);
    return reconciliation;
  });
}

/* A reconciliation the CEO said yes to is cleared once none of its rows holds bytes. */
export async function noteCleared(db: Tx): Promise<void> {
  await db.execute(sql`UPDATE net.file_moves m SET cleared_at = now() WHERE m.approved_at IS NOT NULL AND m.cleared_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM net.file_move_rows r WHERE r.digest = m.digest)`);
}

/* The size of the database once the column went and the table gave its room back, on each reconciliation said yes to
   that has none yet. Says the size before the first of them and after. */
export async function noteRoomBack(db: Tx): Promise<{ before: number; after: number } | null> {
  const noted = rowsOf<{ before: string; after: string }>(await db.execute(sql`UPDATE net.file_moves SET database_bytes_after = pg_database_size(current_database())
    WHERE approved_at IS NOT NULL AND database_bytes_after IS NULL RETURNING database_bytes AS before, database_bytes_after AS after`));
  if (noted.length === 0) return null;
  return { before: Math.max(...noted.map(row => Number(row.before))), after: Number(noted[0]!.after) };
}

/* Every reconciliation of this database, the first first. */
export async function fileMoves(db: Tx): Promise<FileMove[]> {
  const found = await db.execute(sql`SELECT m.*, (SELECT count(*)::int FROM net.file_move_rows r WHERE r.digest = m.digest) AS left_rows
    FROM net.file_moves m ORDER BY m.made_at, m.digest`);
  return rowsOf<Record<string, unknown>>(found).map(row => ({
    digest: String(row.digest),
    files: Number(row.files),
    contents: Number(row.contents),
    bytes: Number(row.bytes),
    notHere: Number(row.not_here),
    databaseBytes: Number(row.database_bytes),
    madeAt: isoOf(row.made_at)!,
    approvedAt: isoOf(row.approved_at),
    approvedBy: (row.approved_by as string | null) ?? null,
    clearedAt: isoOf(row.cleared_at),
    databaseBytesAfter: numberOf(row.database_bytes_after),
    left: Number(row.left_rows),
  }));
}

/* The CEO's yes to one reconciliation, by its digest, once. by says who: person:<id>, or orchestrator:<id> for him. */
export async function approveMove(db: Tx, digest: string, by: string): Promise<void> {
  const done = rowsOf(await db.execute(sql`UPDATE net.file_moves SET approved_at = now(), approved_by = ${by} WHERE digest = ${digest} AND approved_at IS NULL RETURNING digest`));
  if (done.length === 1) return;
  const there = rowsOf(await db.execute(sql`SELECT 1 AS one FROM net.file_moves WHERE digest = ${digest}`)).length > 0;
  if (there) throw new ApiError(409, 'conflict', 'This reconciliation was approved already.', 'move_approved');
  throw new ApiError(404, 'not_found', 'No reconciliation of the move has this digest.', 'move_unknown');
}

const Approve = z.strictObject({ digest: z.string().regex(/^[0-9a-f]{64}$/) });

export function fileMoveRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;
  function ceo(me: Person): Person {
    if (!me.isOwner || me.viaHead) throw new ApiError(403, 'forbidden', 'Only the CEO says yes to clearing the moved files, by himself or through the orchestrator.', 'not_owner_session');
    return me;
  }

  /* Where the move stands: whether the old column is there, the rows not named yet, and every reconciliation. */
  app.get('/api/files/move', async req => {
    ceo(await requirePerson(req, db));
    return { column: await hasOldBytes(db), unnamed: await unnamed(db), moves: await fileMoves(db) };
  });

  /* The CEO's yes to the reconciliation with this digest: its rows give up their bytes at the mover's next rounds. */
  app.post('/api/files/move/approve', async req => {
    const me = ceo(await requirePerson(req, db));
    const { digest } = Approve.parse(req.body);
    await approveMove(db, digest, me.via ? `orchestrator:${me.via}` : `person:${me.id}`);
    return { approved: digest };
  });
}
