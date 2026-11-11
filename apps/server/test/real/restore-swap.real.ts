import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDb } from '../../src/db/client.js';
import { until } from '../helpers.js';
import { realDatabase, realServer, type RealDatabase } from './pg.js';

/* The statements the updater runs for the swap of a restore, read from where its image takes them. */
const sqlOf = (name: string) => readFileSync(new URL(`../../../updater/${name}.sql`, import.meta.url), 'utf8');
const CUTOVER = 'hornhoof-cutover';

const nameOf = (real: RealDatabase) => new URL(real.url).pathname.slice(1);
const urlOf = (database: string, app?: string): string => {
  const url = new URL(realServer());
  url.pathname = `/${database}`;
  if (app) url.searchParams.set('application_name', app);
  return url.href;
};

/* A session that may be ended under the test says nothing about it. */
async function session(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  client.on('error', () => undefined);
  await client.connect();
  return client;
}

/* Connects anew, asks which database answered, and leaves: the mark of the database, or refused. */
async function knock(database: string): Promise<string> {
  try {
    const client = await session(urlOf(database));
    const { rows } = await client.query<{ mark: string }>(`SELECT COALESCE((SELECT string_agg(name, ',') FROM companies), '') AS mark`);
    await client.end();
    return rows[0]!.mark;
  } catch {
    return 'refused';
  }
}

let old: RealDatabase;
let restored: RealDatabase;
let server: pg.Client;
const made: string[] = [];

beforeAll(async () => {
  [old, restored] = [await realDatabase(), await realDatabase()];
  for (const real of [old, restored]) {
    real.admin.on('error', () => undefined);
    await migrateDb(real.url);
    made.push(nameOf(real));
  }
  server = await session(realServer());
  await old.admin.query(`INSERT INTO companies (name) VALUES ('Old')`);
  await old.admin.query(`INSERT INTO net_local.state (term_number, term_machine, machine, cluster) VALUES (41, 'm-old', 'm-old', 'c-old')`);
  await old.admin.query(`INSERT INTO net_local.lease (term_number, term_machine, kind, until, sync) VALUES (42, 'm-old', 'normal', 'infinity', 'alone')`);
  await restored.admin.query(`INSERT INTO companies (name) VALUES ('Restored')`);
  await restored.admin.query(`INSERT INTO net_local.state (term_number, term_machine, machine, cluster) VALUES (7, 'm-then', 'm-then', 'c-then')`);
  await restored.admin.query(`INSERT INTO net_local.lease (term_number, term_machine, kind, until, sync) VALUES (7, 'm-then', 'normal', 'infinity', 'alone')`);
});

afterAll(async () => {
  for (const name of made) {
    await server.query(`ALTER DATABASE ${name} WITH ALLOW_CONNECTIONS true`).catch(() => undefined);
    await server.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
  }
  await server.end();
});

describe('the swap of a restore, on real Postgres', () => {
  it('closes the old database, reads what the restored one keeps, and lets the restored one take its name', async () => {
    const name = nameOf(old);
    const before = `${name}_before`;
    made.push(before);
    /* Someone who keeps coming back, as the keeper does. */
    const knocks: string[] = [];
    let knocking = true;
    const comer = (async () => {
      while (knocking) {
        knocks.push(await knock(name));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    })();
    await until(() => knocks.includes('Old'));

    /* A database cannot close itself: that is why the updater closes it from another session. */
    await expect(old.admin.query(`ALTER DATABASE ${name} WITH ALLOW_CONNECTIONS false`)).rejects.toThrow('cannot disallow connections for current database');

    /* Two copies followed the old database, and one follows another database of the server. */
    await old.admin.query(`SELECT pg_create_logical_replication_slot('copy_aaaaaaaaaaaaaaaa_1', 'pgoutput'), pg_create_logical_replication_slot('copy_bbbbbbbbbbbbbbbb_3', 'pgoutput')`);
    await restored.admin.query(`SELECT pg_create_logical_replication_slot('copy_cccccccccccccccc_1', 'pgoutput')`);
    const slots = async () => (await server.query<{ name: string }>(`SELECT slot_name::text AS name FROM pg_replication_slots WHERE slot_name LIKE 'copy\_%' ORDER BY 1`)).rows.map(row => row.name);
    expect(await slots()).toEqual(['copy_aaaaaaaaaaaaaaaa_1', 'copy_bbbbbbbbbbbbbbbb_3', 'copy_cccccccccccccccc_1']);

    /* As the updater does: the session that reads is on the database first, then the connections go off. */
    const reader = await session(urlOf(name, CUTOVER));
    const answered = reader.query(`${sqlOf('cutover')}\n${sqlOf('carry')}`) as unknown as Promise<pg.QueryResult[]>;
    await until(async () => (await server.query(`SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND application_name = $2`, [name, CUTOVER])).rows.length === 1);
    await server.query(`ALTER DATABASE ${name} WITH ALLOW_CONNECTIONS false`);
    const results = await answered;
    const [kept, carry] = results.slice(-2).map(result => Object.values(result.rows[0] as Record<string, unknown>)[0]);
    expect(kept).toEqual({ term: 42, machine: 'm-old', cluster: 'c-old' });
    /* The slots of the database that closed went with it, so no copy reads on from it; another database's stays. */
    expect(await slots()).toEqual(['copy_cccccccccccccccc_1']);
    await restored.admin.query(`SELECT pg_drop_replication_slot('copy_cccccccccccccccc_1')`);
    expect(carry).toMatchObject({ people: [], invites: [], machines: [], serials: [], recoveryKeys: [] });
    /* Nobody else is on it, and nobody gets in. */
    expect((await server.query(`SELECT application_name FROM pg_stat_activity WHERE datname = $1`, [name])).rows).toEqual([{ application_name: CUTOVER }]);
    const closedAt = knocks.length;
    await until(() => knocks.length >= closedAt + 3);
    expect(knocks.slice(closedAt + 1)).toEqual(knocks.slice(closedAt + 1).map(() => 'refused'));
    await reader.end();

    /* The restored one goes by the old one's machine and cluster, at a term no lower, with no lease. */
    const adopting = await session(restored.url);
    await adopting.query(`SELECT set_config('hornhoof.term', $1, false), set_config('hornhoof.machine', $2, false), set_config('hornhoof.cluster', $3, false)`, ['42', 'm-old', 'c-old']);
    await adopting.query(sqlOf('adopt'));
    expect((await adopting.query(`SELECT term_number::int AS term, term_machine, machine, cluster FROM net_local.state`)).rows).toEqual([{ term: 42, term_machine: 'm-then', machine: 'm-old', cluster: 'c-old' }]);
    expect((await adopting.query(`SELECT 1 FROM net_local.lease`)).rows).toEqual([]);
    /* A term of the restored one that is higher stays, and a state that was never written is written. */
    await adopting.query(`UPDATE net_local.state SET term_number = 50`);
    await adopting.query(sqlOf('adopt'));
    expect((await adopting.query(`SELECT term_number::int AS term FROM net_local.state`)).rows).toEqual([{ term: 50 }]);
    await adopting.query(`DELETE FROM net_local.state`);
    await adopting.query(sqlOf('adopt'));
    expect((await adopting.query(`SELECT term_number::int AS term, term_machine, machine, cluster FROM net_local.state`)).rows).toEqual([{ term: 42, term_machine: 'm-old', machine: 'm-old', cluster: 'c-old' }]);
    /* With no machine to go by, only the term is kept. */
    await adopting.query(`SELECT set_config('hornhoof.term', '60', false), set_config('hornhoof.machine', '', false), set_config('hornhoof.cluster', '', false)`);
    await adopting.query(sqlOf('adopt'));
    expect((await adopting.query(`SELECT term_number::int AS term, machine FROM net_local.state`)).rows).toEqual([{ term: 60, machine: 'm-old' }]);
    await adopting.end();
    await restored.admin.end();

    /* The names change hands from another database, and whoever comes next lands in the restored one. */
    await server.query(`ALTER DATABASE ${name} RENAME TO ${before}`);
    await server.query(`ALTER DATABASE ${nameOf(restored)} RENAME TO ${name}`);
    await until(() => knocks.at(-1) === 'Restored');
    knocking = false;
    await comer;
    expect(await knock(before)).toBe('refused');
  });
});
