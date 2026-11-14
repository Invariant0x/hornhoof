/* eslint-disable hornhoof/no-ddl-on-shared-database -- These run on Postgres databases this file makes and drops, shared with no other test. */
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { APP_NAME, migrateDb, openDb, type Db } from '../../src/db/client.js';
import { writeGate } from '../../src/db/gate.js';
import { nodeSource, withSource } from '../../src/db/sources.js';
import { runMerge } from '../../src/modules/merge/apply.js';
import { complete } from '../../src/modules/merge/check.js';
import { keptDatabases } from '../../src/modules/merge/kept.js';
import { pick } from '../../src/modules/merge/picks.js';
import { keptSource, type MergeSource } from '../../src/modules/merge/source.js';
import { TEST_SECRET } from '../helpers-basic.js';
import { ENDLESS_LEASE } from '../prepare-environment.js';
import { forkDatabase, onRealServer, poolOf, realServer, realUrlOf } from './pg.js';

const COMPANY = randomUUID();
const OWNER = randomUUID();
const PLAN = randomUUID();
const AGENT = randomUUID();
const DEPARTMENT = randomUUID();
const TASKS = [randomUUID(), randomUUID()];

/* One live database and what was forked off it, all dropped when the test ends. */
let live: string;
let made: string[];
let open: (pg.Pool | pg.Client)[];

beforeEach(async () => {
  live = `hh_${randomBytes(6).toString('hex')}`;
  made = [live];
  open = [];
  await onRealServer([`CREATE DATABASE ${live}`]);
  await migrateDb(realUrlOf(live));
  await run(live, ENDLESS_LEASE);
  await run(live, `INSERT INTO companies (id, name) VALUES ('${COMPANY}', 'Acme');
    INSERT INTO people (id, company_id, name, email, status, scope_kind, is_owner) VALUES ('${OWNER}', '${COMPANY}', 'Ivan', 'ivan@acme.test', 'active', 'company', true);
    INSERT INTO subscriptions (id, company_id, provider, kind, label, owner_person_id, status) VALUES ('${PLAN}', '${COMPANY}', 'claude', 'personal', 'Plan', '${OWNER}', 'ready');
    INSERT INTO departments (id, company_id, name, role_code) VALUES ('${DEPARTMENT}', '${COMPANY}', 'Development', 'DEV');
    INSERT INTO agents (id, company_id, kind, name, model, department_id, subscription_id) VALUES ('${AGENT}', '${COMPANY}', 'worker', 'Ana', '', '${DEPARTMENT}', '${PLAN}');
    INSERT INTO tasks (id, company_id, number, title, department_id) VALUES ('${TASKS[0]}', '${COMPANY}', 1, 'One', '${DEPARTMENT}'), ('${TASKS[1]}', '${COMPANY}', 2, 'Two', '${DEPARTMENT}')`);
  // A database of its own with every migration takes as long as the machine needs, so neither hook has a time limit.
}, 0);

afterEach(async () => {
  for (const client of open) await client.end().catch(() => undefined);
  await onRealServer(made.map(name => `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
}, 0);

/* Statements on one database as the admin, on a connection of their own that ends with them. */
async function run<T extends pg.QueryResultRow = pg.QueryResultRow>(database: string, text: string, params?: unknown[]): Promise<T[]> {
  const client = new pg.Client({ connectionString: realUrlOf(database) });
  await client.connect();
  try {
    const answer = (await client.query<T>(text, params)) as pg.QueryResult<T> | pg.QueryResult<T>[];
    return Array.isArray(answer) ? answer.at(-1)!.rows : answer.rows;
  } finally {
    await client.end();
  }
}

/* The app's own pool on the live database: fenced, with its 5 s limit on a transaction. */
function appDb(): Db {
  const db = openDb(realUrlOf(live), APP_NAME, { fenced: true });
  open.push(poolOf(db));
  return db;
}
const close = async (db: Db): Promise<void> => {
  await poolOf(db).end();
  open = open.filter(client => client !== poolOf(db));
};

/* A database set aside as a restore leaves one: a copy of the live one as it is now, with its connections off. */
async function fork(): Promise<string> {
  const name = `hornhoof_before_t${randomBytes(4).toString('hex')}`;
  made.push(name);
  await forkDatabase(live, name);
  return name;
}
/* What the test then writes into it is what that database went on to do. */
async function into(name: string, text: string, params?: unknown[]): Promise<void> {
  await onRealServer([`ALTER DATABASE ${name} WITH ALLOW_CONNECTIONS true`]);
  await run(name, text, params);
}

const config = () => loadConfig({ HORNHOOF_SECRET: TEST_SECRET, DATABASE_URL: `${realUrlOf(live)}?options=-c%20statement_timeout%3D0&application_name=hornhoof` });
const merges = (db: Db, name: string, kept = true) =>
  run<{ id: string }>(live, `INSERT INTO net.merges (source, label) VALUES ($1, 'the kept database') RETURNING id`, [`${kept ? 'kept' : 'machine'}:${name}`]).then(rows => ({ id: rows[0]!.id, label: 'the kept database', kept, companyId: COMPANY }));
const titles = (database: string) => run<{ number: number; title: string }>(database, 'SELECT number, title FROM tasks ORDER BY number').then(rows => rows.map(row => row.title));
const quiet = { log: () => undefined };

async function merged(db: Db, name: string, kept: boolean, opts: Parameters<typeof runMerge>[3] = quiet) {
  const merge = await merges(db, name, kept);
  const databases = keptDatabases(db, config());
  const source = await databases.open(name, merge.label);
  try {
    return { merge, result: await runMerge(db, merge, source, opts) };
  } finally {
    await source.close();
  }
}
async function checked(db: Db, name: string, mergeId: string) {
  const source = await keptDatabases(db, config()).open(name, 'the kept database');
  try {
    return await complete(db, mergeId, source);
  } finally {
    await source.close();
  }
}

describe('a merge on real Postgres', () => {
  it('reads one snapshot, of the kept database and not the live one', async () => {
    const name = await fork();
    await run(live, `UPDATE tasks SET title = 'Live' WHERE number = 1`);
    await into(name, `UPDATE tasks SET title = 'Kept' WHERE number = 1`);
    /* The app's address names the live database, with settings of its own sessions in it. */
    const source: MergeSource = await keptSource(config(), name, 'the kept database');
    try {
      expect(await source.query<{ name: string }>('SELECT current_database() AS name')).toEqual([{ name }]);
      expect(await source.query<{ n: number }>('SELECT count(*)::int AS n FROM public.tasks')).toEqual([{ n: 2 }]);
      /* A row another session adds meanwhile is not in what the source reads: its first query took the snapshot. */
      await run(name, `INSERT INTO tasks (company_id, number, title) VALUES ('${COMPANY}', 3, 'Added meanwhile')`);
      expect(await source.query<{ n: number }>('SELECT count(*)::int AS n FROM public.tasks')).toEqual([{ n: 2 }]);
      expect(await source.query<{ title: string }>('SELECT title FROM public.tasks WHERE number = 1')).toEqual([{ title: 'Kept' }]);
      await expect(source.query(`UPDATE public.tasks SET title = 'x'`)).rejects.toThrow(/read-only transaction/);
    } finally {
      await source.close();
    }
    expect((await run<{ n: number }>(name, 'SELECT count(*)::int AS n FROM tasks'))[0]!.n).toBe(3);
  });

  it('merges a fork of one cluster by its journal', async () => {
    const name = await fork();
    const db = appDb();
    /* Each side goes on: a change only the fork made, one both made, and one the same source wrote on both. */
    await into(name, `UPDATE tasks SET body = 'Only there' WHERE number = 1; UPDATE tasks SET title = 'Two there' WHERE number = 2`);
    await db.execute(`UPDATE tasks SET title = 'Two here' WHERE number = 2`);
    const forked = openDb(realUrlOf(name), 'hornhoof-test-fork');
    open.push(poolOf(forked));
    await withSource(nodeSource('n1', 'jobs', 7), () => forked.execute(`UPDATE departments SET about = 'From the node, there'`));
    await withSource(nodeSource('n1', 'jobs', 7), () => db.execute(`UPDATE departments SET about = 'From the node, here'`));
    await close(forked);
    const { merge, result } = await merged(db, name, false);
    expect(result.path).toBe('journal');
    /* One cluster counts its transactions once, so the two sides' changes have other xact ids. */
    const xacts = async (database: string) => (await run<{ xact: string }>(database, `SELECT xact FROM net.journal WHERE tbl = 'tasks' AND op = 'update'`)).map(row => row.xact);
    const [here, there] = [await xacts(live), await xacts(name)];
    expect(there.filter(xact => here.includes(xact))).toEqual([]);
    const [one, two] = await run<{ title: string; body: string }>(live, 'SELECT title, body FROM tasks ORDER BY number');
    expect([one!.body, two!.title]).toEqual(['Only there', 'Two here']);
    /* What the leader made of the node's message stays: it has its own result of that input. */
    expect(await run(live, 'SELECT about FROM departments')).toEqual([{ about: 'From the node, here' }]);
    expect(await run(live, `SELECT tbl, how FROM net.merge_rows WHERE merge = $1`, [merge.id])).toEqual([{ tbl: 'departments', how: 'skipped' }]);
    expect(await run(live, `SELECT tbl, kind, cols FROM net.merge_conflicts WHERE merge = $1`, [merge.id])).toEqual([{ tbl: 'tasks', kind: 'differs', cols: ['title'] }]);
    const consumed = await run<{ how: string; n: number }>(live, `SELECT how, count(*)::int AS n FROM net.merge_consumed WHERE merge = $1 GROUP BY how ORDER BY how`, [merge.id]);
    expect(Object.fromEntries(consumed.map(row => [row.how, row.n]))).toMatchObject({ applied: 1, conflict: 1, skipped: 2 });
    expect(result.counts).toMatchObject({ changed: 1, conflicts: 1, skipped: 2 });
    expect(await checked(db, name, merge.id)).toEqual({ ok: true, missing: [] });
  });

  it('writes wait for the merge', async () => {
    const name = await fork();
    await into(name, `UPDATE tasks SET body = 'Only there' WHERE number = 1`);
    const db = appDb();
    await db.execute('SELECT 1');
    await run(live, `INSERT INTO people (company_id, name, email, status, scope_kind) VALUES ('${COMPANY}', 'Maria', 'maria@acme.test', 'invited', 'company')`);
    /* The merge is held longer than the app lets any transaction of its own live. */
    let reached!: () => void;
    const atFirst = new Promise<void>(resolve => (reached = resolve));
    const merging = merged(db, name, false, { ...quiet, onUnit: async n => { if (n === 1) { reached(); await new Promise(resolve => setTimeout(resolve, 7000)); } } });
    await atFirst;
    const moved = db.execute(`UPDATE tasks SET title = 'Moved meanwhile' WHERE number = 2`).then(() => Date.now());
    const accepted = db.transaction(async tx => {
      await tx.execute(`UPDATE people SET status = 'active', password_hash = 'x' WHERE email = 'maria@acme.test'`);
    }).then(() => Date.now());
    await new Promise(resolve => setTimeout(resolve, 1500));
    /* They wait at the gate, before any transaction of theirs: no lock is held or waited for on their account. */
    expect(writeGate.inside()).toBe(0);
    expect(await run(live, `SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid WHERE a.application_name = $1 AND NOT l.granted`, [APP_NAME])).toEqual([]);
    expect((await run<{ title: string }>(live, 'SELECT title FROM tasks WHERE number = 2'))[0]!.title).toBe('Two');
    const { merge, result } = await merging;
    const done = Date.now();
    expect(result.heldMs).toBeGreaterThanOrEqual(7000);
    /* They land after the merge's commit, none ended by the app's own limit, and the merge lists nothing of them. */
    expect([(await moved) >= done - 50, (await accepted) >= done - 50]).toEqual([true, true]);
    expect((await run<{ title: string; body: string }>(live, 'SELECT title, body FROM tasks ORDER BY number'))).toEqual([{ title: 'One', body: 'Only there' }, { title: 'Moved meanwhile', body: '' }]);
    expect((await run<{ status: string }>(live, `SELECT status FROM people WHERE email = 'maria@acme.test'`))[0]!.status).toBe('active');
    expect([result.counts.changed, await run(live, 'SELECT 1 FROM net.merge_conflicts WHERE merge = $1', [merge.id])]).toEqual([1, []]);
  });

  it('ends without a change when a session outside the gate holds what it must lock', async () => {
    const name = await fork();
    await into(name, `UPDATE tasks SET body = 'Only there' WHERE number = 1`);
    const db = appDb();
    const outside = new pg.Client({ connectionString: realUrlOf(live) });
    open.push(outside);
    await outside.connect();
    await outside.query(`BEGIN; UPDATE tasks SET title = 'Held' WHERE number = 2`);
    const began = Date.now();
    await expect(merged(db, name, false)).rejects.toThrow('Another session held a table the merge must lock, for longer than 10 s.');
    expect(Date.now() - began).toBeGreaterThanOrEqual(9000);
    await outside.query('ROLLBACK');
    expect(await run(live, 'SELECT status FROM net.merges')).toEqual([{ status: 'pending' }]);
    expect((await run<{ body: string }>(live, 'SELECT body FROM tasks WHERE number = 1'))[0]!.body).toBe('');
    /* The gate is open again for the app. */
    await db.execute(`UPDATE tasks SET title = 'After' WHERE number = 2`);
  });

  it("holds the app's writes briefly on a big company", async () => {
    await run(live, `INSERT INTO tasks (company_id, number, title, department_id) SELECT '${COMPANY}', n, 'Task ' || n, '${DEPARTMENT}' FROM generate_series(3, 2000) n;
      INSERT INTO task_events (company_id, task_id, kind) SELECT '${COMPANY}', '${TASKS[0]}', 'comment' FROM generate_series(1, 5000);
      INSERT INTO agent_events (company_id, agent_id, kind, data) SELECT '${COMPANY}', '${AGENT}', 'text', '{}'::jsonb FROM generate_series(1, 50000)`);
    const name = await fork();
    await into(name, `INSERT INTO tasks (company_id, number, title, department_id) SELECT '${COMPANY}', n, 'Later ' || n, '${DEPARTMENT}' FROM generate_series(2001, 2050) n;
      INSERT INTO task_events (company_id, task_id, kind) SELECT '${COMPANY}', '${TASKS[1]}', 'comment' FROM generate_series(1, 100);
      INSERT INTO agent_events (company_id, agent_id, kind, data) SELECT '${COMPANY}', '${AGENT}', 'text', '{"later": true}'::jsonb FROM generate_series(1, 1000)`);
    const db = appDb();
    const { merge, result } = await merged(db, name, true);
    expect(result.path).toBe('compare');
    expect(result.counts).toMatchObject({ added: 1150, conflicts: 0 });
    /* The company waited for less than its writes may wait at the gate. */
    expect(result.heldMs).toBeLessThan(30_000);
    const [counts] = await run<{ tasks: number; events: number; said: number }>(live, `SELECT (SELECT count(*) FROM tasks)::int AS tasks, (SELECT count(*) FROM task_events)::int AS events, (SELECT count(*) FROM agent_events)::int AS said`);
    expect(counts).toEqual({ tasks: 2050, events: 5100, said: 51000 });
    expect(await checked(db, name, merge.id)).toEqual({ ok: true, missing: [] });
  }, 300_000);

  it('merges a database plan 7 kept', async () => {
    const name = await fork();
    /* As a build before merges left it: without their records, and one migration short. */
    await into(name, `DROP TABLE net.merge_rows, net.merge_conflicts, net.merge_consumed, net.merges, net.restores, net.horizon;
      DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations);
      INSERT INTO departments (company_id, name, role_code) VALUES ('${COMPANY}', 'Sales', 'SALES')`);
    const db = appDb();
    const { merge, result } = await merged(db, name, true);
    expect([result.path, result.counts.added]).toEqual(['compare', 1]);
    expect((await run<{ name: string }>(live, 'SELECT name FROM departments ORDER BY name')).map(row => row.name)).toEqual(['Development', 'Sales']);
    expect(await checked(db, name, merge.id)).toEqual({ ok: true, missing: [] });
  });

  it('drops only a kept database', async () => {
    const name = await fork();
    const db = appDb();
    const databases = keptDatabases(db, config());
    expect(await databases.list()).toContain(name);
    expect(await databases.list()).not.toContain(live);
    /* Its connections were off: opening it turns them on. */
    expect((await run<{ allowed: boolean }>(live, 'SELECT datallowconn AS allowed FROM pg_database WHERE datname = $1', [name]))[0]!.allowed).toBe(false);
    const source = await databases.open(name, 'the kept database');
    expect(await source.query<{ n: number }>('SELECT count(*)::int AS n FROM public.tasks')).toEqual([{ n: 2 }]);
    await source.close();
    await databases.drop(name);
    expect(await databases.list()).not.toContain(name);
    /* Nothing that is no kept database is ever dropped, or even opened. */
    for (const other of [live, 'hornhoof', 'postgres', `${name}"; DROP DATABASE ${live}; --`]) {
      await expect(databases.drop(other)).rejects.toThrow('This is not a database a restore kept.');
      await expect(databases.open(other, 'x')).rejects.toThrow('This is not a database a restore kept.');
    }
    expect((await run(live, 'SELECT 1 AS here FROM companies'))).toEqual([{ here: 1 }]);
  });

  it('an older bundle restored, then the database from before', async () => {
    /* The live database is what the restore went back to; the kept one is the company as it went on after that. */
    const name = await fork();
    await into(name, `INSERT INTO tasks (company_id, number, title, department_id) VALUES ('${COMPANY}', 3, 'Added later', '${DEPARTMENT}');
      INSERT INTO departments (company_id, name, role_code) VALUES ('${COMPANY}', 'Sales', 'SALES');
      UPDATE tasks SET title = 'Changed later', status = 'working' WHERE number = 1;
      DELETE FROM tasks WHERE number = 2`);
    const before = await run(live, `SELECT to_jsonb(t) AS row FROM tasks t ORDER BY number`);
    const departments = await run(live, `SELECT to_jsonb(d) AS row FROM departments d ORDER BY name`);
    const db = appDb();
    const { merge, result } = await merged(db, name, true);
    expect(result.counts).toMatchObject({ added: 2, changed: 0, deleted: 0, conflicts: 1 });
    /* Every row it added is added; the row it changed is listed, with this side's value kept; the one it removed stays. */
    expect(await titles(live)).toEqual(['One', 'Two', 'Added later']);
    expect(await run(live, 'SELECT tbl, kind, op, cols FROM net.merge_conflicts WHERE merge = $1', [merge.id])).toEqual([{ tbl: 'tasks', kind: 'differs', op: 'update', cols: ['title', 'status'] }]);
    /* No value of this side changed: row by row, but for the rows that were added. */
    expect(await run(live, `SELECT to_jsonb(t) AS row FROM tasks t WHERE number < 3 ORDER BY number`)).toEqual(before);
    expect(await run(live, `SELECT to_jsonb(d) AS row FROM departments d WHERE name <> 'Sales' ORDER BY name`)).toEqual(departments);
    expect(await checked(db, name, merge.id)).toEqual({ ok: true, missing: [] });
  });

  it('settles a conflict, and brings a file back with its bytes', async () => {
    await run(live, `INSERT INTO attachments (company_id, agent_id, media_type, bytes, size) VALUES ('${COMPANY}', '${AGENT}', 'text/plain', 'the same on both'::bytea, 16)`);
    const name = await fork();
    await into(name, `UPDATE tasks SET title = 'Kept title' WHERE number = 1;
      INSERT INTO attachments (company_id, agent_id, media_type, bytes, size) VALUES ('${COMPANY}', '${AGENT}', 'text/plain', 'only there'::bytea, 10)`);
    const db = appDb();
    const { merge, result } = await merged(db, name, true);
    /* A file both hold is told the same by its hash, and the one that is added comes with its bytes. */
    expect(result.counts).toMatchObject({ added: 1, conflicts: 1 });
    expect((await run<{ said: string }>(live, `SELECT convert_from(bytes, 'UTF8') AS said FROM attachments ORDER BY size`)).map(row => row.said)).toEqual(['only there', 'the same on both']);
    /* The CEO takes the other side's title: a pick's own transaction, on the app's pool with its limits. */
    const [conflict] = await run<{ id: string }>(live, 'SELECT id FROM net.merge_conflicts WHERE merge = $1', [merge.id]);
    const ctx = { db, bus: { publish: () => undefined }, applyParked: async () => undefined, log: { warn: () => undefined } } as unknown as Parameters<typeof pick>[0];
    expect(await pick(ctx, { kind: 'ceo', personId: OWNER }, { ids: [conflict!.id] }, 'there')).toMatchObject({ settled: 1, there: 1, refused: [] });
    expect(await titles(live)).toEqual(['Kept title', 'Two']);
    expect(await run(live, 'SELECT picked, picked_by FROM net.merge_conflicts WHERE id = $1', [conflict!.id])).toEqual([{ picked: 'there', picked_by: `person:${OWNER}` }]);
    expect(await checked(db, name, merge.id)).toEqual({ ok: true, missing: [] });
  });

  it('stops the commit when another session writes a FENCE while the merge transaction runs', async () => {
    const name = await fork();
    await into(name, `UPDATE tasks SET body = 'Only there' WHERE number = 1`);
    const db = appDb();
    const merging = merged(db, name, false, {
      ...quiet,
      onUnit: async n => {
        if (n === 1) await run(live, `UPDATE net_local.lease SET until = '-infinity'`);
      },
    });
    const err = await merging.then(
      () => null,
      (e: unknown) => e as { message: string; cause?: { code?: string; message?: string } },
    );
    expect([err?.message.split('\n')[0], err?.cause?.code, err?.cause?.message]).toEqual([
      'Failed query: commit',
      'HHF01',
      'This machine holds no lease now, so nothing was changed.',
    ]);
    expect(await run(live, 'SELECT status FROM net.merges')).toEqual([{ status: 'pending' }]);
    expect((await run<{ body: string }>(live, 'SELECT body FROM tasks WHERE number = 1'))[0]!.body).toBe('');
  });

  it('sees a lease renewal committed by another session while the merge transaction runs', async () => {
    const name = await fork();
    await into(name, `UPDATE tasks SET body = 'Only there' WHERE number = 1`);
    const db = appDb();
    await run(live, `UPDATE net_local.lease SET until = '-infinity'`);
    const { result } = await merged(db, name, false, {
      ...quiet,
      onUnit: async n => {
        if (n === 1) await run(live, `UPDATE net_local.lease SET until = 'infinity'`);
      },
    });
    expect(result.counts.changed).toBe(1);
    expect(await run(live, 'SELECT status FROM net.merges')).toEqual([{ status: 'applied' }]);
    expect((await run<{ body: string }>(live, 'SELECT body FROM tasks WHERE number = 1'))[0]!.body).toBe('Only there');
  });

  it('names the server its tests run on', () => {
    expect(realServer()).toMatch(/^postgres/);
  });
});
