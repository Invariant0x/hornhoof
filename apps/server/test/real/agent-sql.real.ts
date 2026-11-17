/* eslint-disable hornhoof/no-ddl-on-shared-database -- These run on a Postgres database each of them makes and drops, shared with no other test. */
import Fastify from 'fastify';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { openAgentSql, type AgentSql } from '../../src/db/agent-sql.js';
import { APP_NAME, migrateDb, openDb, type Db } from '../../src/db/client.js';
import { NotConfirmed, notConfirmed } from '../../src/db/confirm.js';
import { LEASE_REFUSED } from '../../src/db/net.js';
import { registerErrorHandling } from '../../src/errors.js';
import { ENDLESS_LEASE } from '../prepare-environment.js';
import { poolOf, realDatabase, type RealDatabase } from './pg.js';

const DENIED = '42501';
const WAITING_FOR_A_COPY = `wait_event = 'SyncRep'`;
const SESSION_WAIT_MS = 10_000;
const LIMIT_ENDED = (route: string) => new RegExp(`^The 5 s limit ended a transaction of ${route} after (\\d+) ms\\.$`);

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
/* The call's error, or what it answered when it did not fail. */
const failureOf = (call: Promise<unknown>): Promise<unknown> => call.then(
  answer => ({ answered: answer }),
  (err: unknown) => err,
);

let real: RealDatabase;

beforeAll(async () => {
  real = await realDatabase();
  await migrateDb(real.url);
  await real.admin.query(ENDLESS_LEASE);
  await real.admin.query(`INSERT INTO companies (name) VALUES ('Acme')`);
  await real.admin.query(`INSERT INTO agents (company_id, kind, name, model) SELECT id, 'worker', 'Bruno', '' FROM companies`);
});

afterAll(async () => {
  await real.drop();
});

/* openAgentSql gives its roles a new password, so a test opens its own and closes it after. */
async function agentSql(url = real.url): Promise<AgentSql> {
  const agents = (await openAgentSql(url))!;
  onTestFinished(() => agents.close());
  return agents;
}

function appDb(url = real.url): Db {
  const db = openDb(url, APP_NAME, { fenced: true });
  onTestFinished(() => poolOf(db).end());
  return db;
}

function warnings(): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    lines.push(args.join(' '));
  });
  onTestFinished(() => spy.mockRestore());
  return lines;
}

/* The pid of the first session that satisfies the condition. It gives up, so that a test that went wrong fails on its own and
   nothing goes on polling into the next test, where it would act on another session. */
async function sessionWhere(condition: string): Promise<number> {
  for (const end = Date.now() + SESSION_WAIT_MS; Date.now() < end; await sleep(20)) {
    const { rows } = await real.admin.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND ${condition} LIMIT 1`);
    if (rows[0]) return rows[0].pid;
  }
  throw new Error(`No session where ${condition} came within ${SESSION_WAIT_MS} ms.`);
}

async function sessionGone(pid: number): Promise<void> {
  for (;;) {
    const { rowCount } = await real.admin.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (!rowCount) return;
    await sleep(20);
  }
}

/* Whether the call failed over the warning itself, and not over something else that is also not confirmed. */
function heardAWarning(err: unknown): boolean {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if (e instanceof NotConfirmed) return true;
  }
  return false;
}

describe('the agent roles', () => {
  it('refuses the agent roles what would undo a fence', async () => {
    const agents = await agentSql();
    expect(await failureOf(agents.run('ALTER TABLE tasks DISABLE TRIGGER net_journal', 'write'))).toMatchObject({ message: expect.stringContaining('must be owner') });
    const denied = [
      'SET session_replication_role = replica',
      'SELECT * FROM net_local.lease',
      'SELECT * FROM net.journal',
      `INSERT INTO net.journal (xact, tbl, op, key, cols) VALUES (gen_random_uuid(), 'x', 'insert', '{}', '{}')`,
      'DELETE FROM applied',
      'DELETE FROM tool_calls',
      'SELECT net.attach_journal()',
      'SELECT pg_cancel_backend(1)',
      `SELECT lo_from_bytea(0, '\\x00')`,
      `SELECT set_config('transaction_timeout', '0', true)`,
      `SELECT query_to_xml('select 1', true, true, '')`,
      `SELECT ts_rewrite('x'::tsquery, 'SELECT ''x''::tsquery, ''y''::tsquery')`,
    ];
    for (const text of denied) expect(await failureOf(agents.run(text, 'write')), text).toMatchObject({ code: DENIED });
    /* The orchestrator reads where changes came from, column by column, and changes none of it. */
    for (const text of ['SELECT * FROM applied', 'SELECT * FROM tool_calls']) await expect(agents.run(text, 'write'), text).resolves.toHaveLength(1);
    await expect(agents.run(`SELECT net.assert_lease('2 s', NULL)`, 'write')).resolves.toHaveLength(1);
    expect(await failureOf(agents.run(`SELECT net.assert_lease('2 s', NULL)`, 'read'))).toMatchObject({ code: DENIED });
  });

  it('keeps its own settings whatever the address says', async () => {
    const address = new URL(real.url);
    address.searchParams.set('options', '-c hornhoof.fenced=off -c transaction_timeout=0');
    address.searchParams.set('application_name', 'x');
    const that = address.toString();

    const db = appDb(that);
    const shown = async (text: string): Promise<unknown> => Object.values(((await db.execute(sql.raw(text))) as unknown as pg.QueryResult<Record<string, unknown>>).rows[0]!)[0];
    expect(await shown('SHOW hornhoof.fenced')).toBe('on');
    expect(await shown('SHOW transaction_timeout')).toBe('5s');
    expect(await shown(`SELECT current_setting('application_name')`)).toBe(APP_NAME);

    const agents = await agentSql(that);
    expect((await agents.run('SHOW transaction_timeout', 'write'))[0]!.rows).toEqual([{ transaction_timeout: '5s' }]);
  });

  it('cannot cancel another session of its own role', async () => {
    const agents = await agentSql();
    const sleeping = agents.run('SELECT pg_sleep(2)', 'write');
    const pid = await sessionWhere(`query LIKE '%pg_sleep(2)%'`);
    expect(await failureOf(agents.run(`SELECT pg_cancel_backend(${pid})`, 'write'))).toMatchObject({ code: DENIED });
    await expect(sleeping).resolves.toHaveLength(1);
  });

  it('refuses before COMMIT a text that sleeps past the lease', async () => {
    const agents = await agentSql();
    const journalled = async (): Promise<number> => (await real.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM net.journal WHERE tbl = 'agents'`)).rows[0]!.n;
    const before = await journalled();
    await real.admin.query(`UPDATE net_local.lease SET until = clock_timestamp() + interval '3 s'`);
    onTestFinished(async () => {
      await real.admin.query(`UPDATE net_local.lease SET until = 'infinity'`);
    });

    expect(await failureOf(agents.run('SELECT pg_sleep(2); UPDATE agents SET name = name', 'write'))).toMatchObject({ code: LEASE_REFUSED });

    expect(await journalled()).toBe(before);
  });

  it('ends a call that runs over 5 s', async () => {
    const agents = await agentSql();
    expect(await failureOf(agents.run('SELECT pg_sleep(6)', 'write'))).toSatisfy(notConfirmed);
  });
});

describe("the app's transactions", () => {
  it('keeps the process up and names the route when the limit ends an idle transaction', async () => {
    const lines = warnings();
    const db = appDb();
    const app = Fastify();
    onTestFinished(() => app.close());
    registerErrorHandling(app);
    app.get('/slow', async () =>
      db.transaction(async tx => {
        await tx.execute(sql`SELECT 1`);
        await sleep(6000);
        await tx.execute(sql`SELECT 1`);
        return {};
      }),
    );

    const res = await app.inject({ method: 'GET', url: '/slow' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { reason: 'not_confirmed' } });
    const named = lines.filter(line => LIMIT_ENDED('GET /slow').test(line));
    expect(named).toHaveLength(1);
    const ms = Number(LIMIT_ENDED('GET /slow').exec(named[0]!)![1]);
    expect(ms).toBeGreaterThanOrEqual(5000);
    expect(ms).toBeLessThanOrEqual(6500);
    await expect(db.execute(sql`SELECT 1`)).resolves.toBeDefined();
  });

  it('takes a session the admin ended for no timeout', async () => {
    const lines = warnings();
    const db = appDb();
    const ended = failureOf(
      db.transaction(async tx => {
        const { rows } = (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)) as unknown as pg.QueryResult<{ pid: number }>;
        await real.admin.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);
        await sessionGone(rows[0]!.pid);
        await tx.execute(sql`SELECT 1`);
      }),
    );
    expect(await ended).toSatisfy(notConfirmed);
    expect(lines.filter(line => line.startsWith('The 5 s limit'))).toEqual([]);
    await expect(db.execute(sql`SELECT 1`)).resolves.toBeDefined();
  });

  it('ends a transaction of the app that runs over 5 s', async () => {
    const lines = warnings();
    const db = appDb();
    expect(await failureOf(db.transaction(tx => tx.execute(sql`SELECT pg_sleep(6)`)))).toSatisfy(notConfirmed);
    expect(lines.filter(line => LIMIT_ENDED('work outside a request').test(line))).toHaveLength(1);
    await expect(db.execute(sql`SELECT 1`)).resolves.toBeDefined();
  });

  it('refuses PREPARE TRANSACTION', async () => {
    await real.admin.query('BEGIN');
    onTestFinished(async () => {
      await real.admin.query('ROLLBACK');
    });
    expect(await failureOf(real.admin.query(`PREPARE TRANSACTION 'x'`))).toMatchObject({ message: expect.stringContaining('prepared transactions are disabled') });
  });
});

/* The server's processes hear a reload one after another, and the one that tells a commit to wait may come last, so that a
   commit right after the reload may not wait yet. This writes until a commit waits, and lets that one go. No commit may wait
   while a test still has to open the agents' roles, so a test calls this itself, once what it needs is open. */
async function commitsWaitForACopy(): Promise<void> {
  await real.admin.query(`ALTER SYSTEM SET synchronous_standby_names = 'FIRST 1 (nobody)'`);
  await real.admin.query('SELECT pg_reload_conf()');
  const probe = new pg.Client({ connectionString: real.url });
  await probe.connect();
  try {
    while (!(await aCommitWaits(probe)));
  } finally {
    await probe.end();
  }
}

async function aCommitWaits(probe: pg.Client): Promise<boolean> {
  let done = false;
  const write = probe.query('UPDATE companies SET name = name').then(() => {
    done = true;
  });
  while (!done) {
    const { rowCount } = await real.admin.query(`SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'SyncRep'`);
    if (rowCount) {
      await write;
      return true;
    }
    await sleep(10);
  }
  return false;
}

/* The commit goes through on its own only once no commit waits any more, which the next test and the next file need: the
   setting is the server's, and they share that server. */
async function commitsGoOn(): Promise<void> {
  await real.admin.query('ALTER SYSTEM RESET synchronous_standby_names');
  await real.admin.query('SELECT pg_reload_conf()');
  await real.admin.query('UPDATE companies SET name = name');
}

describe('a database call that front gave an id', () => {
  const INVOCATION = '00000000-0000-4000-8000-0000000000a1';
  const LATE = '00000000-0000-4000-8000-0000000000a2';
  const JOB = '00000000-0000-4000-8000-0000000000b1';
  const kept = async (id: string) => ({
    calls: (await real.admin.query('SELECT answer FROM tool_calls WHERE id = $1', [id])).rows,
    sources: (await real.admin.query('SELECT source FROM applied WHERE base = $1', [`tool:${id}`])).rows,
  });

  it('is recorded in the commit that the fence checks, and not at all when that commit is refused', async () => {
    const agents = await agentSql();
    /* A job with nothing behind it, which the check of that is told to let pass. */
    await real.admin.query(`BEGIN; SET LOCAL session_replication_role = replica;
      INSERT INTO jobs (id, company_id, subscription_id, prompt, timeout_ms, status) VALUES ('${JOB}', gen_random_uuid(), gen_random_uuid(), 'x', 1000, 'running'); COMMIT`);
    const call = (invocation: string) => ({ invocation, jobId: JOB, answer: (results: unknown[]) => ({ said: results.length }) });

    await agents.run('UPDATE agents SET name = name', 'write', call(INVOCATION));
    expect(await kept(INVOCATION)).toEqual({ calls: [{ answer: { said: 1 } }], sources: [{ source: `tool:${INVOCATION}:0` }] });

    await real.admin.query(`UPDATE net_local.lease SET until = '-infinity'`);
    onTestFinished(async () => void (await real.admin.query(`UPDATE net_local.lease SET until = 'infinity'`)));
    expect(await failureOf(agents.run('UPDATE agents SET name = name', 'write', call(LATE)))).toMatchObject({ code: LEASE_REFUSED });
    expect(await kept(LATE)).toEqual({ calls: [], sources: [] });
  });
});

describe('a commit that waits for a copy', () => {
  const notesSaying = async (text: string): Promise<number> => (await real.admin.query('SELECT 1 FROM notebook_notes WHERE text = $1', [text])).rowCount ?? 0;
  const aNote = (text: string): string => `INSERT INTO notebook_notes (company_id, number, text) SELECT id, (SELECT count(*) + 1 FROM notebook_notes), '${text}' FROM companies`;
  const cancelTheWait = async (): Promise<void> => {
    await real.admin.query('SELECT pg_cancel_backend($1)', [await sessionWhere(WAITING_FOR_A_COPY)]);
  };

  afterEach(commitsGoOn);

  it('reports a cancelled wait as not confirmed, with the row committed', async () => {
    const db = appDb();
    await commitsWaitForACopy();
    const failed = failureOf(db.execute(sql.raw(aNote('Cancelled'))));
    await cancelTheWait();
    expect(await failed).toSatisfy(heardAWarning);
    expect(await notesSaying('Cancelled')).toBe(1);
  });

  /* Postgres turns a statement's timeout off right before the commit, as it does the limit of 5 s, so neither ends this wait. */
  it('does not end the wait at its own statement timeout, and reports the cancel as not confirmed', async () => {
    const client = await poolOf(appDb()).connect();
    onTestFinished(() => client.release(true));
    await commitsWaitForACopy();
    await client.query('SET statement_timeout = 300');
    const failed = failureOf(client.query(aNote('Timed out')));
    const waiting = await sessionWhere(WAITING_FOR_A_COPY);
    await sleep(600);
    expect(await sessionWhere(`pid = ${waiting} AND ${WAITING_FOR_A_COPY}`)).toBe(waiting);
    await cancelTheWait();
    expect(await failed).toSatisfy(heardAWarning);
    expect(await notesSaying('Timed out')).toBe(1);
  });

  it('reports a session the admin ended while it waits as not confirmed', async () => {
    const db = appDb();
    await commitsWaitForACopy();
    const failed = failureOf(db.execute(sql.raw(aNote('Terminated'))));
    await real.admin.query('SELECT pg_terminate_backend($1)', [await sessionWhere(WAITING_FOR_A_COPY)]);
    expect(await failed).toSatisfy(notConfirmed);
  });

  it("reports a cancelled wait of the agent role's commit as not confirmed", async () => {
    const agents = await agentSql();
    await commitsWaitForACopy();
    const failed = failureOf(agents.run('UPDATE agents SET name = name', 'write'));
    await cancelTheWait();
    expect(await failed).toSatisfy(heardAWarning);
  });
});
