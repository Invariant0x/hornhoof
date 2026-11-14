import { PGlite } from '@electric-sql/pglite';
import { onTestFinished } from 'vitest';
import type { Db } from '../src/db/client.js';
import type { MergeSource } from '../src/modules/merge/source.js';
import { asTestDb, openTestDb } from './helpers-db.js';

export type Side = { client: PGlite; db: Db };

let forks = 0;

/* A copy of a database as it is now, which then goes its own way. Two PGlites from one data directory count their
   transactions alike, so the copy says it is another cluster: its transactions get other xact ids than the original's. */
export async function forkOf(client: PGlite): Promise<Side> {
  const copy = new PGlite({ loadDataDir: await client.dumpDataDir('none') });
  onTestFinished(() => copy.close());
  const side = await asTestDb(copy);
  forks += 1;
  await copy.exec(`UPDATE net_local.state SET cluster = cluster || '-fork-${forks}'`);
  return { client: copy, db: side.db as unknown as Db };
}

/* A database as plan 7 kept one: without the records of merges, and one migration short. */
export async function asPlan7(client: PGlite): Promise<void> {
  // eslint-disable-next-line hornhoof/no-ddl-on-shared-database -- Only ever a fork's own database, which closes with its test.
  await client.exec(`DROP TABLE net.merge_rows, net.merge_conflicts, net.merge_consumed, net.merges, net.restores, net.horizon;
    DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)`);
}

/* A PGlite as a merge's source. It has one connection, so nothing else may use this database until the source closes. */
export async function pgliteSource(client: PGlite, label: string): Promise<MergeSource> {
  await client.exec('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  return {
    label,
    query: async <T>(text: string, params?: unknown[]) => (await client.query<T>(text, params)).rows,
    close: async () => {
      await client.exec('ROLLBACK');
    },
  };
}

/* A leader, and forks of it as it is when each is asked for. */
export async function twoSides(): Promise<{ leader: Side; fork(): Promise<Side & { source: () => Promise<MergeSource> }> }> {
  const opened = await openTestDb();
  onTestFinished(() => opened.client.close());
  const leader: Side = { client: opened.client, db: opened.db as unknown as Db };
  return {
    leader,
    fork: async () => {
      const side = await forkOf(leader.client);
      return { ...side, source: () => pgliteSource(side.client, 'the fork') };
    },
  };
}
