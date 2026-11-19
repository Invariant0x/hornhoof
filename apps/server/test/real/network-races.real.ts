import { generateKeyPairSync, sign } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config.js';
import { hashToken } from '../../src/crypto/tokens.js';
import { APP_NAME, migrateDb, openDb, type Db } from '../../src/db/client.js';
import { certificates, companies, machines, people } from '../../src/db/schema.js';
import { claimRenewal, hostIdOf, issueTicket, lockLiveMachine, revokeMachineRows } from '../../src/modules/network/join.js';
import { joinMessage } from '../../src/modules/network/join-proof.js';
import { certify, makeAuthorityOnce } from '../../src/modules/network/store.js';
import { setUpCompany, TEST_SECRET, until } from '../helpers.js';
import { poolOf, realDatabase, sessionsWaitingOnALock, type RealDatabase } from './pg.js';

/* PGlite has one connection, so what the lock on a machine's row is for shows only here. Nothing rests on timing: a
   transaction holds a lock open, and the test goes on when the database itself says the others wait behind it. */
let real: RealDatabase;
let db: Db;
let other: Db;
let app: FastifyInstance;
let config: Config;
let companyId: string;
let personId: string;

beforeAll(async () => {
  real = await realDatabase();
  await migrateDb(real.url);
  db = openDb(real.url, APP_NAME);
  other = openDb(real.url, APP_NAME);
  config = loadConfig({ HORNHOOF_SECRET: TEST_SECRET, UPDATE_CHECK_MS: '0' });
  app = await buildApp({ db, config });
  await setUpCompany(app);
  companyId = (await db.select().from(companies))[0]!.id;
  personId = (await db.select().from(people))[0]!.id;
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

const newKey = (): string => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();

function signedJoin(ticket: string, machineKey: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const networkId = hostIdOf(machineKey);
  const signKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const signature = sign(null, Buffer.from(joinMessage(ticket, networkId)), privateKey).toString('base64');
  return { ticket, networkId, signKey, signature };
}

/* A worker of the network with one certificate, as a join leaves it. */
async function worker(name: string) {
  const signKey = newKey();
  const machineKey = `${name}-0001-abcd`;
  const [row] = await db.insert(machines).values({ companyId, personId, machineKey, hostname: name, role: 'worker', signKey, networkId: hostIdOf(machineKey) }).returning();
  const authority = await makeAuthorityOnce(db, config, companyId);
  await certify(db, authority, { id: row!.id, role: 'worker', signKey });
  return { id: row!.id, signKey, machineKey, authority };
}

/* Ending the client when the test ends rolls back what a failed test left open, so the waiting transactions get to finish. */
async function holding(text: string, values: unknown[]): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: real.url });
  await client.connect();
  onTestFinished(() => client.end());
  await client.query('BEGIN');
  await client.query(text, values);
  return client;
}

const untilWaiting = (count: number): Promise<void> => until(async () => (await sessionsWaitingOnALock(real, APP_NAME)) >= count);
const liveCertificates = (machineId: string) => db.select().from(certificates).where(and(eq(certificates.machineId, machineId), isNull(certificates.revokedAt)));
const MACHINE_ROW = 'SELECT 1 FROM machines WHERE id = $1 FOR UPDATE';

describe("the lock on a machine's row", () => {
  it('lets one of two renewals of the same moment count', async () => {
    const w = await worker('twice');
    const at = new Date();
    const claim = (from: Db) =>
      from.transaction(async tx => {
        const row = await lockLiveMachine(tx, w.id);
        return row ? claimRenewal(tx, row, at) : false;
      });
    const holder = await holding(MACHINE_ROW, [w.id]);
    const claims = [claim(db), claim(other)];
    await untilWaiting(2);
    await holder.query('COMMIT');
    expect((await Promise.all(claims)).sort()).toEqual([false, true]);
    expect((await db.select().from(machines).where(eq(machines.id, w.id)))[0]!.renewAt).toEqual(at);
  });

  /* The certificate is issued while the Disconnect already waits for the row. The Disconnect comes after it and revokes
     it; without the lock it would have revoked only what it could see, and the new certificate would outlive it. */
  it('leaves no certificate of a machine disconnected while one is issued', async () => {
    const w = await worker('racing');
    let holdsRow!: () => void;
    const locked = new Promise<void>(resolve => { holdsRow = resolve; });
    const issue = db.transaction(async tx => {
      const row = await lockLiveMachine(tx, w.id);
      holdsRow();
      await untilWaiting(1);
      await certify(tx, w.authority, { id: row!.id, role: 'worker', signKey: w.signKey });
    });
    await locked;
    const disconnect = other.transaction(async tx => {
      const now = new Date();
      await tx.update(machines).set({ revokedAt: now }).where(eq(machines.id, w.id));
      await revokeMachineRows(tx, [w.id], now);
    });
    await Promise.all([issue, disconnect]);
    expect(await liveCertificates(w.id)).toEqual([]);
    expect(await db.select().from(certificates).where(eq(certificates.machineId, w.id))).toHaveLength(2);
  });

  it('finds no live machine once a Disconnect that came first commits', async () => {
    const w = await worker('late');
    const holder = await holding('UPDATE machines SET revoked_at = now() WHERE id = $1', [w.id]);
    const found = db.transaction(tx => lockLiveMachine(tx, w.id));
    await untilWaiting(1);
    await holder.query('COMMIT');
    expect(await found).toBeNull();
  });

  /* Both take the machine's row first and its ticket after: the other way round each would hold what the other waits
     for, and the database would end one of them. Whichever comes first, no certificate outlives the Disconnect. */
  it('lets a join and a Disconnect of one machine take their turns', async () => {
    const machineKey = 'leaving-0001-abcd';
    const [row] = await db.insert(machines).values({ companyId, personId, machineKey, hostname: 'leaving' }).returning();
    const ticket = await issueTicket(db, row!.id);
    const holder = await holding(MACHINE_ROW, [row!.id]);
    const join = app.inject({ method: 'POST', url: '/api/network/join', payload: signedJoin(ticket, machineKey) });
    const disconnect = other.transaction(async tx => {
      const now = new Date();
      await tx.update(machines).set({ revokedAt: now }).where(eq(machines.id, row!.id));
      await revokeMachineRows(tx, [row!.id], now);
    });
    await untilWaiting(2);
    await holder.query('COMMIT');
    const [answer] = await Promise.all([join, disconnect]);
    expect([200, 410]).toContain(answer.statusCode);
    expect(await liveCertificates(row!.id)).toEqual([]);
  });

  it('gives two identical signed joins one certificate and one refusal', async () => {
    const machineKey = 'joining-0001-abcd';
    const [row] = await db.insert(machines).values({ companyId, personId, machineKey, hostname: 'joining' }).returning();
    const ticket = await issueTicket(db, row!.id);
    const payload = signedJoin(ticket, machineKey);
    const holder = await holding('SELECT 1 FROM machine_tickets WHERE ticket_hash = $1 FOR UPDATE', [hashToken(ticket)]);
    const joins = [0, 1].map(() => app.inject({ method: 'POST', url: '/api/network/join', payload }));
    await untilWaiting(2);
    await holder.query('COMMIT');
    const answers = await Promise.all(joins);
    expect(answers.map(a => a.statusCode).sort()).toEqual([200, 410]);
    expect(answers.find(a => a.statusCode === 410)!.json().error.reason).toBe('ticket_used');
    expect(await liveCertificates(row!.id)).toHaveLength(1);
  });
});
