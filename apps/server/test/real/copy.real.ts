import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HIDDEN, openAgentSql, readerRole } from '../../src/db/agent-sql.js';
import { copyName, PASSFILE_THERE } from '../../src/modules/keeper/copy.js';
import { keeperSql, leaseStore } from '../../src/modules/keeper/lease-store.js';
import { REPLICA_ROLE } from '../../src/modules/keeper/replica.js';
import { pair, type Pair } from './pair.js';

let p: Pair;

beforeAll(async () => {
  p = await pair();
  /* A company with a note, a file of some size, and a row of a table the app hides. */
  await p.leader.admin.query(`INSERT INTO companies (name) VALUES ('Acme')`);
  await p.leader.admin.query(`INSERT INTO notebook_notes (company_id, number, text) SELECT id, 1, 'A note' FROM companies`);
  await p.leader.admin.query(`INSERT INTO authority (cert_pem, key_enc) VALUES ('cert', 'sealed')`);
  await p.leader.admin.query(`INSERT INTO net.pulse (at) VALUES (clock_timestamp())`);
}, 300_000);

afterAll(async () => {
  await p?.close();
}, 120_000);

/* The tables of the two schemas a copy follows. */
const TABLES = `SELECT format('%I.%I', schemaname, tablename) AS name FROM pg_tables WHERE schemaname IN ('public', 'net') ORDER BY 1`;
/* Every row of a table as one hash, whatever order they lie in. */
const hashOf = async (on: pg.Client, table: string): Promise<string> =>
  (await on.query<{ hash: string }>(`SELECT count(*) || ':' || coalesce(md5(string_agg(t::text, '|' ORDER BY t::text)), '') AS hash FROM ${table} t`)).rows[0]!.hash;

async function connected(url: string, user?: { name: string; password: string }): Promise<pg.Client> {
  const next = new URL(url);
  if (user) {
    next.username = user.name;
    next.password = user.password;
  }
  const client = new pg.Client({ connectionString: next.href });
  await client.connect();
  return client;
}

describe('a copy of the company on a second Postgres', () => {
  it('makes a copy that holds every row', async () => {
    const name = copyName(p.networkId, 1);
    expect(p.maker.mode()).toBe('off');
    await p.until(() => p.maker.report()?.state === 'ready');
    expect(p.maker.mode()).toBe('read');
    expect(p.maker.report()).toMatchObject({ state: 'ready', error: null, name, old: null });
    expect(p.lines).toEqual([]);
    /* A copy may take the server over, and a keeper leads on no database whose network functions anyone may run: the
       schema came with no rights, and they are closed on the copy as the leader's own migration closes them. */
    const fences = keeperSql(p.copyUrl('hornhoof'), { timeoutMs: 20_000 });
    try {
      expect((await leaseStore(fences, { machineId: p.networkId }).problems()).filter(line => line.startsWith('PUBLIC may still run net.'))).toEqual([]);
      /* The maker asks whether the file with the reading role's password is there before a copy joins a new leader. */
      const there = async (file: string) => (await fences.query<{ there: boolean }>(PASSFILE_THERE, [file])).rows[0]!.there;
      const folder = (await fences.query<{ data_directory: string }>('SHOW data_directory')).rows[0]!.data_directory;
      expect([await there(`${folder}/replica.pgpass`), await there(`${folder}/no-such-file`)]).toEqual([true, false]);
    } finally {
      await fences.close();
    }

    const copy = await connected(p.copyUrl('hornhoof'));
    try {
      /* Every table is through its first copy, and holds what the leader's holds, the hidden ones too. */
      const states = await copy.query<{ state: string }>(`SELECT DISTINCT srsubstate AS state FROM pg_subscription_rel`);
      expect(states.rows).toEqual([{ state: 'r' }]);
      const tables = (await p.leader.admin.query<{ name: string }>(TABLES)).rows.map(row => row.name);
      expect((await copy.query<{ name: string }>(TABLES)).rows.map(row => row.name)).toEqual(tables);
      expect(tables.length).toBeGreaterThan(80);
      /* The pulse is the leader's own clock on the copy. */
      const pulse = (await p.leader.admin.query<{ at: Date }>('SELECT at FROM net.pulse')).rows[0]!.at;
      await p.until(async () => p.maker.report()?.at === pulse.toISOString());
      const differing: string[] = [];
      for (const table of tables) if ((await hashOf(copy, table)) !== (await hashOf(p.leader.admin, table))) differing.push(table);
      expect(differing).toEqual([]);
      for (const hidden of ['authority', ...HIDDEN.filter(table => table === 'sessions')]) expect(tables).toContain(`public.${hidden}`);
      expect((await copy.query('SELECT cert_pem FROM authority')).rows).toEqual([{ cert_pem: 'cert' }]);

      /* A change on the leader is on the copy within moments, with the journal's row of it. */
      await p.leader.admin.query(`INSERT INTO notebook_notes (company_id, number, text) SELECT id, 2, 'Another note' FROM companies`);
      await p.until(async () => (await copy.query(`SELECT 1 FROM notebook_notes WHERE number = 2`)).rows.length === 1, 20_000);
      const journal = (await p.leader.admin.query<{ id: string }>(`SELECT id::text FROM net.journal ORDER BY id`)).rows.map(row => row.id);
      await p.until(async () => (await copy.query('SELECT count(*)::int AS n FROM net.journal')).rows[0].n === journal.length, 20_000);
      expect((await copy.query<{ id: string }>(`SELECT id::text FROM net.journal ORDER BY id`)).rows.map(row => row.id)).toEqual(journal);
      /* The copy never held a term, and takes none: its own state and lease are empty. */
      expect((await copy.query('SELECT count(*)::int AS n FROM net_local.state')).rows).toEqual([{ n: 0 }]);
      expect((await copy.query('SELECT count(*)::int AS n FROM net_local.lease')).rows).toEqual([{ n: 0 }]);
      /* Its schema came with the leader's count of migrations. */
      const migrations = (await p.leader.admin.query<{ n: number }>('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0]!.n;
      expect(p.maker.migrations()).toBe(migrations);
      /* Its slot on the leader goes by the copy's name, and its connection answers each second. */
      const slot = await p.leader.admin.query<{ active: boolean }>(`SELECT active FROM pg_replication_slots WHERE slot_name = $1`, [name]);
      expect(slot.rows).toEqual([{ active: true }]);
      expect((await p.leader.admin.query(`SELECT 1 FROM pg_stat_replication WHERE application_name = $1`, [name])).rows).toHaveLength(1);
      expect((await copy.query<{ setting: string }>(`SELECT setting FROM pg_settings WHERE name = 'wal_receiver_status_interval'`)).rows).toEqual([{ setting: '1' }]);
    } finally {
      await copy.end();
    }

    /* The role a merge reads the copy with has its rights there too, and writes nothing. */
    const reader = await connected(p.copyUrl('hornhoof'), { name: REPLICA_ROLE, password: p.password });
    try {
      expect((await reader.query('SELECT count(*) > 0 AS some FROM net.journal')).rows).toEqual([{ some: true }]);
      expect((await reader.query('SELECT count(*)::int AS n FROM net_local.state')).rows).toEqual([{ n: 0 }]);
      await expect(reader.query(`INSERT INTO companies (name) VALUES ('Other')`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await reader.end();
    }
  }, 600_000);

  it("gives Operations' role its rights on a schema that came later", async () => {
    await p.until(() => p.maker.report()?.state === 'ready');
    /* As the copy's app does when its keeper's first word takes it out of off: the role did not come with the schema. */
    const role = readerRole('hornhoof');
    const admin = await connected(p.copyUrl('hornhoof'));
    try {
      const before = await admin.query<{ may: boolean }>(`SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = $1) AND has_any_column_privilege($1, 'public.tasks', 'SELECT') AS may`, [role]).catch(() => ({ rows: [{ may: false }] }));
      expect(before.rows).toEqual([{ may: false }]);
      const agents = await openAgentSql(p.copyUrl('hornhoof'));
      expect(agents).not.toBeNull();
      await agents!.close();
      const may = async (what: string) => (await admin.query<{ may: boolean }>(`SELECT has_any_column_privilege($1, $2, 'SELECT') AS may`, [role, what])).rows[0]!.may;
      expect(await may('public.tasks')).toBe(true);
      for (const closed of ['public.applied', 'public.tool_calls', 'net.journal', 'net.pulse', 'net_local.lease']) expect([closed, await may(closed)]).toEqual([closed, false]);
    } finally {
      await admin.end();
    }
  }, 600_000);
});
