import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { Manifest } from './bundle.js';

/* The bundles the company's data machine made, as net.backups keeps them. The head is kept as recorded, and what a
   bundle says of itself is always read from it, so a later check reads the same words that were signed. */
export type BackupRow = Manifest & { head: string; holders: string[] };

type Stored = { head: string; holders: string[] } & Record<string, unknown>;
type Tx = Pick<Db, 'execute'>;

const rowsOf = <T>(answer: unknown): T[] => (Array.isArray(answer) ? answer : (answer as { rows: T[] }).rows);
const rowOf = (stored: Stored): BackupRow => ({ ...(JSON.parse((JSON.parse(stored.head) as { manifest: string }).manifest) as Manifest), head: stored.head, holders: stored.holders });
/* A list as the database reads one: every value here is an id or an age key, quoted all the same. */
const listOf = (values: string[]): string => `{${values.map(value => `"${value.replace(/(["\\])/g, '\\$1')}"`).join(',')}}`;

/* Keeps a bundle's record once; false when it was there already. */
export async function recordBundle(tx: Tx, row: BackupRow): Promise<boolean> {
  const made = await tx.execute(sql`INSERT INTO net.backups (id, company_id, dumped_at, made_at, reason, size, sha256, signer, serial, recovery, recipients, migrations, head, holders)
    VALUES (${row.id}, ${row.company}, ${row.dumpedAt}::timestamptz, ${row.madeAt}::timestamptz, ${row.reason}, ${row.size}, ${row.sha256}, ${row.signer}, ${row.serial}, ${row.recovery},
      ${listOf(row.recipients)}::text[], ${row.migrations}, ${row.head}, ${listOf(row.holders)}::uuid[])
    ON CONFLICT (id) DO NOTHING RETURNING id`);
  return rowsOf(made).length > 0;
}

/* Newest first. */
/* The bundles there are, newest first. forks: none leaves out the bundles of databases set aside before a merge, which
   are no backup of the database in use; only gives those alone, made since that time. */
export async function bundleRows(db: Tx, opts: { limit?: number; withRecovery?: boolean; forks?: 'none' | { since: Date }; sinceRestore?: boolean } = {}): Promise<BackupRow[]> {
  /* sinceRestore: only the bundles made after the company was last restored, which alone hold it as it is now. */
  const opened = sql`${opts.withRecovery ? sql`recovery IS NOT NULL` : sql`true`} AND ${opts.sinceRestore ? sql`made_at > COALESCE((SELECT max(at) FROM net.restores), '-infinity')` : sql`true`}`;
  const kind = opts.forks === 'none' ? sql`reason <> 'fork'` : opts.forks ? sql`reason = 'fork' AND made_at > ${opts.forks.since.toISOString()}::timestamptz` : sql`true`;
  const found = await db.execute(sql`SELECT head, holders FROM net.backups WHERE ${opened} AND ${kind} ORDER BY made_at DESC, id LIMIT ${opts.limit ?? 100}`);
  return rowsOf<Stored>(found).map(rowOf);
}

export async function bundleRow(db: Tx, id: string): Promise<BackupRow | null> {
  const [found] = rowsOf<Stored>(await db.execute(sql`SELECT head, holders FROM net.backups WHERE id = ${id}`));
  return found ? rowOf(found) : null;
}

export async function setHolders(tx: Tx, id: string, holders: string[]): Promise<void> {
  await tx.execute(sql`UPDATE net.backups SET holders = ${listOf(holders)}::uuid[] WHERE id = ${id}`);
}
