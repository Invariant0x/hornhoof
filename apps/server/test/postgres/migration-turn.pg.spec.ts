import { expect, it } from 'vitest';
import { until } from '../helpers-basic.js';
import { holdMigrationTurn, migrateCandidate, privatePostgres, type PostgresFixture } from './helpers.js';
import { candidateHistory, migrationHistory } from './migration-fixture.js';

const publicTables = async (fixture: PostgresFixture) =>
  (await fixture.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'")).rows[0]!.n;

/* A migration holds a lock on each object it makes until it commits, and a cluster has room for a few thousand in all:
   six test files migrating at once on one part ran it out of shared memory. */
it('migrates a test database only in its turn, while no other test database of the cluster migrates', async () => {
  const fixture = await privatePostgres({ migrate: false });
  const release = await holdMigrationTurn('hh_pg_turn_holder');
  let settled = false;
  const migration = migrateCandidate(fixture).finally(() => { settled = true; });
  const waits = async () => (await fixture.admin.query<{ waits: boolean }>(
    `SELECT EXISTS (SELECT FROM pg_locks l JOIN pg_stat_activity a USING (pid)
      WHERE l.locktype = 'advisory' AND NOT l.granted AND a.application_name = $1) AS waits`,
    [`${fixture.name}_migration`],
  )).rows[0]!.waits;
  await until(async () => settled || await waits());
  expect(settled).toBe(false);
  expect(await publicTables(fixture)).toBe(0);
  await release();
  await migration;
  expect(await migrationHistory(fixture)).toEqual(candidateHistory());
});
