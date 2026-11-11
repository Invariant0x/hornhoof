/* eslint-disable hornhoof/no-ddl-on-shared-database -- These run on Postgres databases the file makes and drops, shared with no other test. */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PUBLIC_REVOKES } from '../../src/db/agent-sql.js';
import { migrateDb } from '../../src/db/client.js';
import { keeperSql } from '../../src/modules/keeper/lease-store.js';
import { ensurePublication, ensureReplica, PUBLICATION, REPLICA_ROLE, replicaPassword, replicaReady } from '../../src/modules/keeper/replica.js';
import { ENDLESS_LEASE } from '../prepare-environment.js';
import { until } from '../helpers.js';
import { onRealServer, realDatabase, type RealDatabase } from './pg.js';

const PASSWORD = replicaPassword(Buffer.alloc(32, 7));
const OTHER = replicaPassword(Buffer.alloc(32, 8));

let real: RealDatabase;
let empty: RealDatabase;

/* The role belongs to the server, so a run before may have left it with another password; each test sets its own. */
beforeAll(async () => {
  real = await realDatabase();
  empty = await realDatabase();
  await migrateDb(real.url);
  await real.admin.query(ENDLESS_LEASE);
  await real.admin.query(`INSERT INTO companies (name) VALUES ('Acme'); INSERT INTO authority (cert_pem, key_enc) VALUES ('cert', 'sealed')`);
});

afterAll(async () => {
  await real.drop();
  await empty.drop();
  await onRealServer([`DROP ROLE IF EXISTS ${REPLICA_ROLE}`]);
});

const withUser = (url: string, password: string): string => {
  const next = new URL(url);
  next.username = REPLICA_ROLE;
  next.password = password;
  return next.href;
};

/* What the role gets when it connects with this password and runs one statement, or the failure's code. */
async function asReplica<R extends pg.QueryResultRow>(url: string, password: string, text: string): Promise<R[] | string> {
  const client = new pg.Client({ connectionString: withUser(url, password) });
  try {
    await client.connect();
    return (await client.query<R>(text)).rows;
  } catch (err) {
    return String((err as { code?: string }).code);
  } finally {
    await client.end().catch(() => undefined);
  }
}

const make = (url: string, password: string): Promise<void> => ensureReplica(() => keeperSql(url, { timeoutMs: 20_000 }), password);

describe("the role a copy reads another machine's database with", () => {
  it('lets a copy read every table and write none', async () => {
    await make(real.url, PASSWORD);
    await make(real.url, PASSWORD);
    expect(await asReplica(real.url, PASSWORD, 'SELECT name FROM companies')).toEqual([{ name: 'Acme' }]);
    expect(await asReplica(real.url, PASSWORD, 'SELECT count(*)::int AS n FROM net.journal WHERE false')).toEqual([{ n: 0 }]);
    expect(await asReplica(real.url, PASSWORD, 'SELECT count(*) >= 0 AS read FROM net_local.state')).toEqual([{ read: true }]);
    expect(await asReplica(real.url, PASSWORD, 'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations WHERE false')).toEqual([{ n: 0 }]);
    /* A table the app hides behind row level security with no policy still shows its rows to a copy. */
    expect((await real.admin.query<{ on: boolean }>(`SELECT relrowsecurity AS on FROM pg_class WHERE oid = 'public.authority'::regclass`)).rows).toEqual([{ on: true }]);
    expect(await asReplica(real.url, PASSWORD, 'SELECT cert_pem FROM authority')).toEqual([{ cert_pem: 'cert' }]);
    expect(await asReplica(real.url, PASSWORD, `INSERT INTO companies (name) VALUES ('Other')`)).toBe('42501');
    expect(await asReplica(real.url, PASSWORD, 'CREATE TABLE public.mine (id int)')).toBe('42501');
    /* It reads where a sequence stands, as a dump of a table's rows does, and moves none. */
    expect(await asReplica(real.url, PASSWORD, 'SELECT last_value >= 0 AS read FROM drizzle.__drizzle_migrations_id_seq')).toEqual([{ read: true }]);
    expect(await asReplica(real.url, PASSWORD, `SELECT nextval('drizzle.__drizzle_migrations_id_seq')`)).toBe('42501');
    const { rows } = await real.admin.query(`SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, left(rolpassword, 19) AS kept FROM pg_authid WHERE rolname = $1`, [REPLICA_ROLE]);
    expect(rows).toEqual([{ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: true, rolbypassrls: true, kept: 'SCRAM-SHA-256$4096:' }]);
    /* A table made later is read too. */
    await real.admin.query('CREATE TABLE public.later (id int PRIMARY KEY); INSERT INTO public.later VALUES (1)');
    expect(await asReplica(real.url, PASSWORD, 'SELECT id FROM later')).toEqual([{ id: 1 }]);
    await real.admin.query('DROP TABLE public.later');
    /* Another password takes the place of the first. */
    await make(real.url, OTHER);
    expect(await asReplica(real.url, PASSWORD, 'SELECT 1')).toBe('28P01');
    expect(await asReplica(real.url, OTHER, 'SELECT 1 AS one')).toEqual([{ one: 1 }]);
  });

  it("publishes the company's schemas", async () => {
    const sql = keeperSql(real.url, { timeoutMs: 20_000 });
    await ensurePublication(sql);
    await ensurePublication(sql);
    await sql.close();
    const { rows } = await real.admin.query<{ schema: string }>(
      `SELECT n.nspname AS schema FROM pg_publication p JOIN pg_publication_namespace pn ON pn.pnpubid = p.oid JOIN pg_namespace n ON n.oid = pn.pnnspid WHERE p.pubname = $1 ORDER BY 1`,
      [PUBLICATION],
    );
    expect(rows.map(row => row.schema)).toEqual(['net', 'public']);
    expect((await real.admin.query('SELECT 1 FROM pg_publication_rel r JOIN pg_publication p ON p.oid = r.prpubid WHERE p.pubname = $1', [PUBLICATION])).rows).toEqual([]);
  });

  it('keeps the password out of every statement', async () => {
    const seen: string[] = [];
    const lines: string[] = [];
    let watching = true;
    const watch = (async () => {
      while (watching) {
        const { rows } = await real.admin.query<{ query: string }>(`SELECT query FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query <> ''`);
        seen.push(...rows.map(row => row.query));
      }
    })();
    await make(real.url, PASSWORD);
    /* One that is ended midway: the role's statement waits on the role's row, which the test holds changed, and its
       session is ended there. */
    const holder = new pg.Client({ connectionString: real.url });
    await holder.connect();
    await holder.query(`BEGIN; ALTER ROLE ${REPLICA_ROLE} CONNECTION LIMIT -1`);
    const cut = make(real.url, PASSWORD).catch((err: Error) => void lines.push(`Could not make the role: ${err.message}`));
    await until(async () => (await real.admin.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'DO $replica$%'`)).rows.length > 0);
    await real.admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'DO $replica$%'`);
    await cut;
    await holder.query('ROLLBACK');
    await holder.end();
    watching = false;
    await watch;
    expect(lines).toHaveLength(1);
    expect(seen.some(query => query.startsWith('DO $replica$'))).toBe(true);
    for (const text of [...seen, ...lines]) expect(text.includes(PASSWORD)).toBe(false);
    expect(await asReplica(real.url, PASSWORD, 'SELECT 1 AS one')).toEqual([{ one: 1 }]);
  });

  it('knows when a database lacks the grants', async () => {
    await make(real.url, PASSWORD);
    const there = keeperSql(real.url, { timeoutMs: 20_000 });
    const elsewhere = keeperSql(empty.url, { timeoutMs: 20_000 });
    await empty.admin.query('CREATE SCHEMA net; CREATE TABLE net.journal (id int PRIMARY KEY)');
    expect(await replicaReady(there)).toBe(true);
    /* The role is the server's, and in this database it may enter nothing yet. */
    expect(await replicaReady(elsewhere)).toBe(false);
    expect(await asReplica(empty.url, PASSWORD, 'SELECT count(*)::int AS n FROM net.journal')).toBe('42501');
    await make(empty.url, PASSWORD);
    expect(await replicaReady(elsewhere)).toBe(true);
    expect(await asReplica(empty.url, PASSWORD, 'SELECT count(*)::int AS n FROM net.journal')).toEqual([{ n: 0 }]);
    await there.close();
    await elsewhere.close();
  });

  it('clears its search path where the app took that from everyone else', async () => {
    const taken = await realDatabase();
    try {
      await taken.admin.query('CREATE SCHEMA net; CREATE TABLE net.journal (id int PRIMARY KEY)');
      const there = keeperSql(taken.url, { timeoutMs: 20_000 });
      /* The app's start takes this function from everyone, and a subscription and pg_dump both call it first. */
      await taken.admin.query(PUBLIC_REVOKES);
      const CLEAR = "SELECT pg_catalog.set_config('search_path', '', false) AS path";
      await make(taken.url, PASSWORD);
      expect(await asReplica(taken.url, PASSWORD, CLEAR)).toEqual([{ path: '' }]);
      expect(await replicaReady(there)).toBe(true);
      /* A database whose role lost the right, as one made ready by a build before, is not ready, and is set right. */
      await taken.admin.query(`REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM ${REPLICA_ROLE}`);
      expect(await asReplica(taken.url, PASSWORD, CLEAR)).toBe('42501');
      expect(await replicaReady(there)).toBe(false);
      await make(taken.url, PASSWORD);
      expect(await replicaReady(there)).toBe(true);
      /* Nothing else the app refuses comes back with it. */
      expect(await asReplica(taken.url, PASSWORD, 'SELECT pg_reload_conf()')).toBe('42501');
      await there.close();
    } finally {
      await taken.drop();
    }
  });

  it('publishes only tables a copy can follow', async () => {
    /* A table with no primary key would make the publication refuse the leader's own updates of it. */
    const { rows } = await real.admin.query<{ name: string }>(
      `SELECT format('%I.%I', n.nspname, c.relname) AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname IN ('public', 'net') AND c.relkind IN ('r', 'p') AND NOT EXISTS (SELECT FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary) ORDER BY 1`,
    );
    expect(rows.map(row => row.name)).toEqual([]);
  });
});
