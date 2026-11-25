import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { openAgentSql, type AgentSql } from '../../src/db/agent-sql.js';
import { APP_NAME, KEEPER_NAME, MIGRATE_NAME, migrateDb, openDb, type Db } from '../../src/db/client.js';
import { notConfirmed } from '../../src/db/confirm.js';
import { LeaseHolder } from '../../src/modules/keeper/lease-holder.js';
import { keeperSql, leaseOfMachine, leaseStore, type LeaseStore } from '../../src/modules/keeper/lease-store.js';
import { ENDLESS_LEASE } from '../prepare-environment.js';
import { until } from '../helpers.js';
import { poolOf, realDatabase, type RealDatabase } from './pg.js';

const FAR = new Date('2999-01-01T00:00:00Z');
const A_NOTE = `INSERT INTO notebook_notes (company_id, number, text) SELECT id, (SELECT count(*) + 1 FROM notebook_notes), 'A note' FROM companies`;
const OLD_ROWS = `INSERT INTO net.journal (xact, at, tbl, op, key, cols)
  SELECT gen_random_uuid(), now() - interval '8 days', 'notebook_notes', 'insert', '{}'::jsonb, '{}' FROM generate_series(1, 5)`;

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
});

afterAll(async () => {
  await real.drop();
});

/* Each test leaves the lease as the fixture gives it, so the next one starts under a lease that holds. */
afterEach(async () => {
  await real.admin.query('DELETE FROM net_local.lease; DELETE FROM net_local.state; DELETE FROM applied; DELETE FROM net.journal');
  await real.admin.query(ENDLESS_LEASE);
});

function keeper(): { run: ReturnType<typeof keeperSql>; lease: LeaseStore } {
  const run = keeperSql(real.url);
  const lease = leaseStore(run, { machineId: 'machine-a' });
  onTestFinished(() => lease.close());
  return { run, lease };
}

async function agentSql(): Promise<AgentSql> {
  const agents = (await openAgentSql(real.url))!;
  onTestFinished(() => agents.close());
  return agents;
}

function appDb(): Db {
  const db = openDb(real.url, APP_NAME, { fenced: true });
  onTestFinished(() => poolOf(db).end());
  return db;
}

async function named(name: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: real.url, application_name: name });
  /* The admin's session is told when the server ends another's; a client of a test only notes it. */
  client.on('error', () => {});
  await client.connect();
  onTestFinished(() => client.end().catch(() => {}));
  return client;
}

const sessions = async (condition: string): Promise<number[]> =>
  (await real.admin.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND ${condition} ORDER BY pid`)).rows.map(row => row.pid);

/* The pid of the first session that satisfies the condition, once there is one. */
async function sessionWhere(condition: string): Promise<number> {
  let found: number | undefined;
  await until(async () => (found = (await sessions(condition))[0]) !== undefined);
  return found!;
}

const leaseEnded = async (): Promise<boolean> => (await real.admin.query<{ ended: boolean }>(`SELECT until = '-infinity' AS ended FROM net_local.lease`)).rows[0]!.ended;

/* The server's processes hear a reload one after another, so a commit right after it may not wait yet: this writes until one
   waits, and lets that one go. */
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
    await new Promise(resolve => setImmediate(resolve));
  }
  return false;
}

/* The setting is the server's, which the next test and the next file share. A commit of the admin waits like any other, so
   the admin's own wait is cancelled until one goes through. */
async function commitsGoOn(): Promise<void> {
  await real.admin.query('ALTER SYSTEM RESET synchronous_standby_names');
  await real.admin.query('SELECT pg_reload_conf()');
  const probe = new pg.Client({ connectionString: real.url });
  await probe.connect();
  try {
    while (await aCommitWaits(probe));
  } finally {
    await probe.end();
  }
}

/* What a session that sets nothing commits under, as a new session of the database reads it. */
async function sessionsCommitUnder(setting: string): Promise<boolean> {
  const probe = new pg.Client({ connectionString: real.url });
  await probe.connect();
  try {
    return (await probe.query<{ synchronous_commit: string }>('SHOW synchronous_commit')).rows[0]!.synchronous_commit === setting;
  } finally {
    await probe.end();
  }
}

/* The server's own setting, as a hand puts it in postgresql.auto.conf. It is the server's, which the next test and the
   next file share: the reload comes first, and then it is waited for until a new session gets it. */
async function serverCommitsUnder(setting: string | null): Promise<void> {
  await real.admin.query(setting ? `ALTER SYSTEM SET synchronous_commit = '${setting}'` : 'ALTER SYSTEM RESET synchronous_commit');
  await real.admin.query('SELECT pg_reload_conf()');
  await until(() => sessionsCommitUnder(setting ?? 'on'));
}

describe("the keeper's lease on real Postgres", () => {
  it("ends the app's and the agents' sessions, and no other", async () => {
    const { lease } = keeper();
    const db = appDb();
    await db.execute(sql`SELECT 1`);
    const agents = await agentSql();
    const sleeping = failureOf(agents.run('SELECT pg_sleep(600)', 'write'));
    /* The orchestrator's SQL runs over a session of the app's own. */
    const sleeper = await sessionWhere(`application_name = '${APP_NAME}' AND query LIKE '%pg_sleep(600)%'`);
    const [app] = await sessions(`application_name = '${APP_NAME}' AND usename = current_user AND pid <> ${sleeper}`);
    const keeperClient = await named(KEEPER_NAME);
    const migrate = await named(MIGRATE_NAME);
    await keeperClient.query('SELECT 1');
    await migrate.query('SELECT 1');

    expect(await lease.endSessions()).toBe(2);

    expect(await sleeping).toSatisfy(notConfirmed);
    await until(async () => (await sessions(`pid IN (${app}, ${sleeper})`)).length === 0);
    await expect(keeperClient.query('SELECT 1')).resolves.toBeDefined();
    await expect(migrate.query('SELECT 1')).resolves.toBeDefined();
    /* The pool finds its connection gone and opens another. */
    await until(() => db.execute(sql`SELECT 1`).then(() => true, () => false));
  });

  describe('while commits wait for a copy', () => {
    afterEach(commitsGoOn);

    it('ends a commit that waits when the lease ends', async () => {
      const { lease } = keeper();
      const db = appDb();
      await db.execute(sql`SELECT 1`);
      await commitsWaitForACopy();
      const failed = failureOf(db.execute(sql.raw(A_NOTE)));
      await sessionWhere(`application_name = '${APP_NAME}' AND wait_event = 'SyncRep'`);

      await lease.fence();

      expect(await failed).toSatisfy(notConfirmed);
      expect(await leaseEnded()).toBe(true);
    });

    it('takes and renews without waiting for a copy', async () => {
      const { lease } = keeper();
      await commitsWaitForACopy();
      const term = await lease.take('normal', FAR);
      expect(await lease.renew(term, 'normal', FAR, false)).toBe(true);
    });
  });

  describe('when the server gives every session synchronous_commit local', () => {
    beforeEach(() => serverCommitsUnder('local'));
    afterEach(() => serverCommitsUnder(null));

    it("lets the app's writes commit, since the app asks for on itself", async () => {
      const db = appDb();
      const notes = async (): Promise<number | null> => (await real.admin.query('SELECT 1 FROM notebook_notes')).rowCount;
      const before = await notes();
      await expect(db.execute(sql.raw(A_NOTE))).resolves.toBeDefined();
      expect(await notes()).toBe(before! + 1);
    });

    it('is seen by the keeper, which sets it on, says so and leads', async () => {
      const lines: string[] = [];
      const lease = leaseOfMachine({ databaseUrl: real.url, machineId: 'machine-a' }, line => lines.push(line))!;
      onTestFinished(() => lease.close());
      expect(await lease.commitSetting()).toEqual({ setting: 'local', source: 'configuration file' });
      const holder = new LeaseHolder({ lease, updaterBusy: () => false, log: line => lines.push(line) });
      await holder.tick();
      await holder.look();

      expect(holder.mode()).toBe('lead');
      expect(await sessionsCommitUnder('on')).toBe(true);
      expect(await lease.commitSetting()).toEqual({ setting: 'on', source: 'configuration file' });
      expect(lines.filter(line => line.includes('"local"'))).toHaveLength(1);
    });
  });

  it('opens a new connection after its own is ended', async () => {
    const { run } = keeper();
    await run.query('SELECT 1');
    const [pid] = await sessions(`application_name = '${KEEPER_NAME}'`);
    await real.admin.query('SELECT pg_terminate_backend($1)', [pid]);
    await until(async () => (await sessions(`pid = ${pid}`)).length === 0);

    await until(() => run.query('SELECT 1').then(() => true, () => false));
    expect(await sessions(`application_name = '${KEEPER_NAME}'`)).not.toContain(pid);
  });

  it('a renewal that arrives after the fence changes nothing', async () => {
    const { lease } = keeper();
    const term = await lease.take('normal', FAR);
    await lease.fence();
    expect(await lease.renew(term, 'normal', FAR, false)).toBe(false);
    expect(await leaseEnded()).toBe(true);
  });

  it('prunes old sources as the keeper', async () => {
    const { lease } = keeper();
    await lease.take('normal', FAR);
    await real.admin.query(`INSERT INTO applied (source, base, at) VALUES ('web:old:0', 'web:old', now() - interval '8 days'), ('web:new:0', 'web:new', now())`);
    expect(await lease.prune()).toBe(1);
    expect((await real.admin.query<{ source: string }>('SELECT source FROM applied')).rows).toEqual([{ source: 'web:new:0' }]);
    /* The step's going is a change like any other, and a copy would hear of it. */
    expect((await real.admin.query(`SELECT 1 FROM net.journal WHERE tbl = 'applied' AND op = 'delete'`)).rowCount).toBe(1);
  });

  it('prunes as the keeper only while the lease holds', async () => {
    const { lease } = keeper();
    const term = await lease.take('normal', FAR);
    expect(term.machine).toBe('machine-a');
    await real.admin.query(OLD_ROWS);
    /* The keeper's own session passes the fence, as it does when it prunes and writes the horizon. */
    expect(await lease.prune()).toBe(5);
    expect((await real.admin.query('SELECT 1 FROM net.journal')).rowCount).toBe(0);
    expect((await real.admin.query<{ near: boolean }>(`SELECT abs(extract(epoch FROM now() - interval '7 days' - below)) < 5 AS near FROM net.horizon`)).rows).toEqual([{ near: true }]);
    /* Once the lease ended nobody knows who reads the journal: nothing more goes. */
    await real.admin.query(OLD_ROWS);
    await lease.fence();
    expect(await lease.prune()).toBe(0);
    expect((await real.admin.query('SELECT 1 FROM net.journal')).rowCount).toBe(5);
  });
});
