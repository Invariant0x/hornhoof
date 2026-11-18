import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { Person } from '../../src/auth/session.js';
import { loadConfig } from '../../src/config.js';
import { APP_NAME, migrateDb, openDb, type Db } from '../../src/db/client.js';
import { agents, companies, computerRuns, jobs, machineAccess, machines, people, subscriptions } from '../../src/db/schema.js';
import { Computers } from '../../src/modules/computer/access.js';
import { hostIdOf, revokeMachineRows } from '../../src/modules/network/join.js';
import { thisMachine } from '../../src/modules/network/store.js';
import { setUpCompany, TEST_SECRET, until } from '../helpers.js';
import { poolOf, realDatabase, sessionsWaitingOnALock, type RealDatabase } from './pg.js';

/* PGlite has one connection, so what keeps a close, a Disconnect and a keeper's ask apart shows only here. Nothing rests
   on timing: a transaction holds the machine's row, and the test goes on when the database itself says the others wait
   behind it. */
let real: RealDatabase;
let db: Db;
let other: Db;
let app: FastifyInstance;
let mine: Computers;
let theirs: Computers;
let companyId: string;
let ceo: Person;
let job: { id: string; agentId: string; companyId: string };

beforeAll(async () => {
  real = await realDatabase();
  await migrateDb(real.url);
  db = openDb(real.url, APP_NAME);
  other = openDb(real.url, APP_NAME);
  const config = loadConfig({ HORNHOOF_SECRET: TEST_SECRET, UPDATE_CHECK_MS: '0', HORNHOOF_MACHINE_ID: hostIdOf('server-0001-abcd') });
  app = await buildApp({ db, config });
  await setUpCompany(app);
  companyId = (await db.select().from(companies))[0]!.id;
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  /* The CEO as their session knows them. */
  ceo = { id: owner!.id, companyId, name: owner!.name, email: owner!.email, title: owner!.title, status: owner!.status, scopeKind: owner!.scopeKind, isOwner: true, isCeoDelegate: owner!.isCeoDelegate };
  /* Two connections of the same app, as two requests have. */
  mine = app.ctx.computer;
  theirs = new Computers({ ...app.ctx, db: other });
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [sub] = await db.select().from(subscriptions);
  const [turn] = await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId: orchestrator!.id, kind: 'conversation', prompt: 'hi', timeoutMs: 900000, status: 'running' }).returning();
  job = { id: turn!.id, agentId: orchestrator!.id, companyId };
});

/* A beforeAll that failed leaves some of these unset, and its failure is the one to see. The database goes in any case. */
afterAll(async () => {
  try {
    await app?.close();
    if (db) await poolOf(db).end();
    if (other) await poolOf(other).end();
  } finally {
    await real?.drop();
  }
});

/* The server's own machine, which the CEO owns and opens with no key, reachable for both connections. */
async function ownMachine(): Promise<string> {
  const { id } = await thisMachine(db, app.ctx.config, companyId);
  await db.delete(computerRuns).where(eq(computerRuns.machineId, id));
  await db.delete(machineAccess).where(eq(machineAccess.machineId, id));
  mine.seen(id, true);
  theirs.seen(id, true);
  return id;
}

/* Another connection that holds the machine's row until the test lets go. */
async function holdingRow(machine: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: real.url });
  await client.connect();
  onTestFinished(() => client.end());
  await client.query('BEGIN');
  await client.query('SELECT id FROM machines WHERE id = $1 FOR UPDATE', [machine]);
  return client;
}

const untilWaiting = (count: number): Promise<void> => until(async () => (await sessionsWaitingOnALock(real, APP_NAME)) >= count);
const runsOf = (machine: string) => db.select().from(computerRuns).where(eq(computerRuns.machineId, machine)).orderBy(computerRuns.createdAt, computerRuns.id);
const start = async (machine: string) => ((await mine.start(job, machine, 'true', 300)) as { id: string }).id;

describe("a machine's access between requests that come at once", () => {
  it('gives each command to one of two asks of its keeper', async () => {
    const machine = await ownMachine();
    await mine.setOpen(ceo, machine, true);
    await start(machine);
    const holder = await holdingRow(machine);
    const asks = [mine.take(machine, []), theirs.take(machine, [])];
    await untilWaiting(2);
    await holder.query('COMMIT');
    const taken = (await Promise.all(asks)).flatMap(ask => ask.runs.map(run => run.id));
    expect(taken).toHaveLength(1);
    expect((await runsOf(machine)).map(run => run.state)).toEqual(['sent']);
  });

  it('never hands a command out once the close is kept', async () => {
    const machine = await ownMachine();
    await mine.setOpen(ceo, machine, true);
    const id = await start(machine);
    const holder = await holdingRow(machine);
    /* The close stands in line first, the keeper's ask behind it. */
    const closing = mine.setOpen(ceo, machine, false);
    await untilWaiting(1);
    const asking = theirs.take(machine, []);
    await untilWaiting(2);
    await holder.query('COMMIT');
    await closing;
    expect(await asking).toEqual({ access: null, runs: [], forget: [] });
    expect((await runsOf(machine)).map(run => [run.id, run.state, run.exit])).toEqual([[id, 'done', 126]]);
  });

  it('starts no command on a machine that is being closed', async () => {
    const machine = await ownMachine();
    await mine.setOpen(ceo, machine, true);
    const holder = await holdingRow(machine);
    const closing = mine.setOpen(ceo, machine, false);
    await untilWaiting(1);
    const starting = theirs.start(job, machine, 'true', 300);
    await untilWaiting(2);
    await holder.query('COMMIT');
    await closing;
    expect(await starting).toBe('closed');
    expect(await runsOf(machine)).toEqual([]);
  });

  it('opens nothing on a machine that is disconnected meanwhile', async () => {
    const [row] = await db.insert(machines).values({ companyId, personId: ceo.id, machineKey: `gone-${Date.now()}`, hostname: 'gone', role: 'worker', networkId: `${Date.now()}`.padStart(64, 'f') }).returning();
    const machine = row!.id;
    mine.seen(machine, true);
    const holder = await holdingRow(machine);
    /* The open waits for the row; Disconnect, which marks the row and drops its access, is let through first. */
    const opening = mine.setOpen(ceo, machine, true).then(() => 'opened', (err: { reason?: string }) => err.reason ?? 'failed');
    await untilWaiting(1);
    await holder.query('UPDATE machines SET revoked_at = now() WHERE id = $1', [machine]);
    await holder.query('COMMIT');
    expect(await opening).toBe('no_core');
    await other.transaction(tx => revokeMachineRows(tx, [machine], new Date()));
    expect(await db.select().from(machineAccess).where(eq(machineAccess.machineId, machine))).toEqual([]);
  });

  it('goes by the person as they are now, not as their session knew them', async () => {
    const machine = await ownMachine();
    await db.update(people).set({ status: 'disabled' }).where(eq(people.id, ceo.id));
    onTestFinished(async () => void (await db.update(people).set({ status: 'active' }).where(eq(people.id, ceo.id))));
    /* The session still says active: the open reads the person again, under the hold a Disable waits for. */
    expect(await mine.setOpen(ceo, machine, true).then(() => 'opened', (err: { reason?: string }) => err.reason ?? 'failed')).toBe('not_machine_owner');
    expect(await db.select().from(machineAccess).where(eq(machineAccess.machineId, machine))).toEqual([]);
  });
});
