import { randomUUID } from 'node:crypto';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { MIGRATIONS } from '../../src/db/client.js';
import { until } from '../helpers-basic.js';
import { holdMigrationTurn, migrateCandidate, privatePostgres, templateName, type PostgresFixture } from './helpers.js';
import { candidateHistory, folderHistory, migrationHistory } from './migration-fixture.js';

const publicTables = async (fixture: PostgresFixture) =>
  (await fixture.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'")).rows[0]!.n;
const database = async (fixture: PostgresFixture, name: string) =>
  (await fixture.admin.query<{ datistemplate: boolean; datallowconn: boolean }>('SELECT datistemplate, datallowconn FROM pg_database WHERE datname = $1', [name])).rows[0];

/* The first migrations of the candidate and a mark of this test, so the template they make is this test's own. */
async function ownMigrations(fixture: PostgresFixture, count: number): Promise<string> {
  const journal = JSON.parse(await readFile(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  const folder = await mkdtemp(join(tmpdir(), 'hh-pg-template-'));
  fixture.cleanup(() => rm(folder, { recursive: true, force: true }));
  const entries = journal.entries.slice(0, count);
  await mkdir(join(folder, 'meta'));
  await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  await Promise.all(entries.map(entry => copyFile(join(MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))));
  await appendFile(join(folder, `${entries.at(-1)!.tag}.sql`), `\n-- ${randomUUID()}\n`);
  return folder;
}

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

/* Thirteen files waiting in one line for 127 migrations each ran past the runner's limit on a busy machine. */
it('copies a test database from the template the cluster migrated once, with no migration waiting for its turn', async () => {
  const first = await privatePostgres();
  const release = await holdMigrationTurn('hh_pg_turn_holder');
  try {
    const copy = await privatePostgres();
    expect(await migrationHistory(copy)).toEqual(candidateHistory());
    expect(await migrationHistory(first)).toEqual(candidateHistory());
    expect(await database(copy, templateName(MIGRATIONS))).toEqual({ datistemplate: true, datallowconn: false });
  } finally { await release(); }
});

it('makes a template again that a stopped run left half made, and lets no session into a whole one', async () => {
  const fixture = await privatePostgres({ migrate: false });
  const folder = await ownMigrations(fixture, 2), name = templateName(folder);
  await fixture.admin.query(`CREATE DATABASE "${name}"`);
  fixture.cleanup(async () => {
    await fixture.admin.query(`ALTER DATABASE "${name}" WITH IS_TEMPLATE false`);
    await fixture.admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  });
  const copy = await privatePostgres({ migrations: folder });
  expect(await migrationHistory(copy)).toEqual(folderHistory(folder));
  expect(await database(fixture, name)).toEqual({ datistemplate: true, datallowconn: false });
});
