import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { APP_NAME, migrateDb, openDb, type Db } from '../../src/db/client.js';
import { companies, jobs, machines, nodes, people } from '../../src/db/schema.js';
import { FOLLOW_LOCK, holdsMachine, tryGrant, type LeaderBuild } from '../../src/modules/network/follow.js';
import { ownPlan, SETUP, setUpCompany, TEST_SECRET, until } from '../helpers.js';
import { poolOf, realDatabase, sessionsWaitingOnALock, type RealDatabase } from './pg.js';

/* PGlite has one connection, so what keeps a word to install and a claim of work apart shows only here. Nothing rests on
   timing: a transaction holds a lock open, and the test goes on when the database itself says the others wait behind it. */
const COMMIT = 'b'.repeat(40);
const B: LeaderBuild = { version: '0.19.0', tag: COMMIT, digest: 'sha256:app', nodeDigest: 'sha256:node', updaterDigest: 'sha256:updater', commit: COMMIT };

let real: RealDatabase;
let db: Db;
let other: Db;
let app: FastifyInstance;
let companyId: string;
let personId: string;
let plan: string;

beforeAll(async () => {
  real = await realDatabase();
  await migrateDb(real.url);
  db = openDb(real.url, APP_NAME);
  other = openDb(real.url, APP_NAME);
  app = await buildApp({ db, config: loadConfig({ HORNHOOF_SECRET: TEST_SECRET, UPDATE_CHECK_MS: '0' }) });
  await setUpCompany(app);
  companyId = (await db.select().from(companies))[0]!.id;
  personId = (await db.select().from(people))[0]!.id;
  plan = await ownPlan(db, SETUP.email.trim().toLowerCase());
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

/* A worker that downloaded the build, with a node on it. */
async function worker(name: string) {
  const [row] = await db.insert(machines).values({ companyId, personId, machineKey: `${name}-0001-abcd`, hostname: name, role: 'worker', commit: 'a'.repeat(40), updateCommit: COMMIT, updateState: 'ready' }).returning();
  const [node] = await db.insert(nodes).values({ companyId, machineId: row!.id, status: 'ready' }).returning();
  return { id: row!.id, nodeId: node!.id };
}

async function holding(text: string, values: unknown[]): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: real.url });
  await client.connect();
  onTestFinished(() => client.end());
  await client.query('BEGIN');
  await client.query(text, values);
  return client;
}

const untilWaiting = (count: number): Promise<void> => until(async () => (await sessionsWaitingOnALock(real, APP_NAME)) >= count);
const grantOf = async (id: string) => (await db.select().from(machines).where(eq(machines.id, id)))[0]!.goCommit;
/* Every word to install that still counts is taken back, so one test's does not hold the next one's. */
const clearGrants = () => db.update(machines).set({ goCommit: null, goAt: null });

describe('a word to install and a claim of work', () => {
  it('gives the word to one of two workers that ask at once', async () => {
    await clearGrants();
    const [w1, w2] = [await worker('one'), await worker('two')];
    const holder = await holding('SELECT pg_advisory_xact_lock($1::bigint)', [FOLLOW_LOCK]);
    const now = new Date();
    const asks = [db.transaction(tx => tryGrant(tx, w1.id, B, now)), other.transaction(tx => tryGrant(tx, w2.id, B, now))];
    await untilWaiting(2);
    await holder.query('COMMIT');
    expect((await Promise.all(asks)).sort()).toEqual([false, true]);
    expect([await grantOf(w1.id), await grantOf(w2.id)].filter(Boolean)).toEqual([COMMIT]);
  });

  /* The turn asked first and holds the machine's row for sharing. The word to install waits for that row, and finds the
     turn running once it gets it. */
  it('gives no word to a machine a turn is starting on', async () => {
    await clearGrants();
    const w = await worker('busy');
    let asked!: () => void;
    const holdsRow = new Promise<void>(resolve => { asked = resolve; });
    const turn = db.transaction(async tx => {
      expect(await holdsMachine(tx, w.nodeId)).toBe(false);
      asked();
      await untilWaiting(1);
      await tx.insert(jobs).values({ companyId, subscriptionId: plan, nodeId: w.nodeId, kind: 'conversation', status: 'running', prompt: 'work', timeoutMs: 1000 });
    });
    await holdsRow;
    const grant = other.transaction(tx => tryGrant(tx, w.id, B, new Date()));
    await turn;
    expect(await grant).toBe(false);
    expect(await grantOf(w.id)).toBeNull();
  });

  it('holds a turn that asks after the word was given', async () => {
    await clearGrants();
    const w = await worker('told');
    const holder = await holding('SELECT 1 FROM machines WHERE id = $1 FOR UPDATE', [w.id]);
    await holder.query('UPDATE machines SET go_commit = $2, go_at = now() WHERE id = $1', [w.id, COMMIT]);
    const asks = db.transaction(tx => holdsMachine(tx, w.nodeId));
    await untilWaiting(1);
    await holder.query('COMMIT');
    expect(await asks).toBe(true);
  });
});
