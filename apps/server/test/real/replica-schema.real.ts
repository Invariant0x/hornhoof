/* eslint-disable hornhoof/no-ddl-on-shared-database -- Two fresh Postgres clusters, used only by this test. */
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expect, it, onTestFinished } from 'vitest';
import { migrateDb } from '../../src/db/client.js';
import { readerGrantsFor, readerRole } from '../../src/db/agent-sql.js';
import { CopyMaker } from '../../src/modules/keeper/copy.js';
import { keeperSql } from '../../src/modules/keeper/lease-store.js';
import { ensureReplica } from '../../src/modules/keeper/replica.js';
import { realCluster, run } from './pg.js';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const EXTRA = 'Reviewer "with\nquotes"';
const PASSWORD = 'test-replication-password';
const MAPPED = 'mapped_reader';

/* The two Postgres clusters use the compose image, or a local Postgres for workspaces without Docker. */
async function clusters(dir: string) {
  const bin = process.env.HH_REPLICA_PG_BIN;
  if (bin) {
    const start = async (name: string) => {
      const host = join(dir, name);
      mkdirSync(host);
      const data = join(host, 'data');
      await run(join(bin, 'initdb'), ['-D', data, '-U', 'hornhoof', '-A', 'trust', '--no-locale', '-E', 'UTF8']);
      const control = ['-D', data];
      await run(join(bin, 'pg_ctl'), [...control, '-l', join(host, 'postgres.log'), '-o', `-h '' -k ${host}`, 'start']);
      onTestFinished(async () => { await run(join(bin, 'pg_ctl'), [...control, '-m', 'immediate', 'stop']); });
      const config = { host, user: 'hornhoof', database: 'hornhoof' };
      await run(join(bin, 'createdb'), ['-h', host, '-U', 'hornhoof', 'hornhoof']);
      const admin = new pg.Client(config);
      await admin.connect();
      onTestFinished(() => admin.end());
      return { host, admin, url: `postgres://hornhoof@localhost/hornhoof?host=${encodeURIComponent(host)}` };
    };
    const leader = await start('leader');
    const copy = await start('copy');
    return { leader, copy, env: { TEST_PG_BIN: bin, TEST_TARGET: copy.host, TEST_LEADER: leader.host, PGDATA: join(copy.host, 'data') } };
  }
  const network = `hh-schema-${randomBytes(6).toString('hex')}`;
  await run('docker', ['network', 'create', network]);
  onTestFinished(async () => { await run('docker', ['network', 'rm', network]); });
  const leader = await realCluster({ network, name: `${network}-leader` });
  onTestFinished(() => leader.close());
  const copy = await realCluster({ network, name: `${network}-copy` });
  onTestFinished(() => copy.close());
  return { leader, copy, env: { TEST_TARGET: copy.host, TEST_LEADER: leader.host } };
}

it('loads the full leader schema on the first request into a clean Postgres', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-schema-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const { leader, copy, env } = await clusters(dir);
  await migrateDb(leader.url);
  const reader = readerRole('hornhoof');
  await leader.admin.query(readerGrantsFor(reader));
  const extra = pg.escapeIdentifier(EXTRA);
  await leader.admin.query(`
    CREATE ROLE ${extra} SUPERUSER LOGIN;
    GRANT SELECT ON agents TO ${extra};
    CREATE POLICY extra_reader ON agents FOR SELECT TO ${extra}, pg_read_all_data USING (true);
    CREATE ROLE ${MAPPED};
    CREATE FOREIGN DATA WRAPPER test_wrapper NO HANDLER;
    CREATE SERVER test_server FOREIGN DATA WRAPPER test_wrapper;
    CREATE USER MAPPING FOR ${MAPPED} SERVER test_server;
    CREATE ROLE acl_only;
    GRANT SELECT ON agents TO acl_only;
  `);
  await ensureReplica(() => keeperSql(leader.url), PASSWORD);
  const names = [reader, EXTRA, MAPPED];
  const roles = () => copy.admin.query<{ rolname: string }>(
    'SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname',
    [names],
  );
  expect((await roles()).rows).toEqual([]);
  const postgres = new URL(copy.url);
  postgres.pathname = '/postgres';
  const admin = keeperSql(postgres.href);
  onTestFinished(() => admin.close());
  const maker = new CopyMaker({
    admin, db: () => keeperSql(copy.url), controlDir: dir, dir, networkId: 'ab'.repeat(32), password: PASSWORD,
    diskFree: () => 100 * 2 ** 30, log: () => {}, publisher: { host: 'keeper', port: 5432 },
  });
  onTestFinished(() => maker.stop());
  await maker.tick({ slot: null, leaderSize: null, migrations: null, old: null, upload: null, lastAttempt: null });
  expect(JSON.parse(readFileSync(join(dir, 'schema.json'), 'utf8'))).toMatchObject({ attempt: 1, database: 'hornhoof' });
  const said = await run('bash', [join(ROOT, 'apps/server/test/real/replica-schema-updater.sh')], { env: { ...env, TEST_ROOT: ROOT, CONTROL: dir, SERVER_DIR: dir } });
  expect(said).toBe('');
  expect(readFileSync(join(dir, 'schema', '1.done'), 'utf8')).toBe('');
  expect((await copy.admin.query("SELECT roles::text[] AS roles FROM pg_policies WHERE policyname = 'extra_reader'")).rows).toEqual([{ roles: [EXTRA, 'pg_read_all_data'] }]);
  expect((await copy.admin.query("SELECT roles::text[] AS roles FROM pg_policies WHERE policyname = $1", [`${reader}_agents`])).rows).toEqual([{ roles: [reader] }]);
  expect((await roles()).rows).toEqual(expect.arrayContaining(names.map(rolname => ({
    rolname, rolcanlogin: false, rolinherit: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false,
  }))));
  expect((await copy.admin.query("SELECT usename FROM pg_user_mappings WHERE srvname = 'test_server'")).rows).toEqual([{ usename: MAPPED }]);
  expect((await copy.admin.query("SELECT FROM pg_roles WHERE rolname = 'acl_only'")).rowCount).toBe(0);
  const { rows } = await copy.admin.query(
    "SELECT has_table_privilege(rolname, 'agents', 'SELECT') AS reads FROM pg_roles WHERE rolname = ANY($1)",
    [names],
  );
  expect(rows).toEqual(names.map(() => ({ reads: false })));
});
