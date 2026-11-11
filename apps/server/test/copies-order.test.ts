import { generateKeyPairSync } from 'node:crypto';
import { asc, eq, isNotNull } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { companies, machines, people, publicLinks } from '../src/db/schema.js';
import { rank, Ranking, rankOf } from '../src/modules/copies/order.js';
import { unfit, type Candidate } from '../src/modules/copies/qualify.js';
import { setUpCompany, testApp, until } from './helpers.js';

const GIB = 2 ** 30;
const NOW = new Date('2026-11-11T12:00:00Z');
const day = (n: number): Date => new Date(Date.UTC(2026, 10, n));
const CEO = { isOwner: true, company: true, active: true, name: 'Ivan' };
const WHOLE = { isOwner: false, company: true, active: true, name: 'Maria' };
const LISTED = { isOwner: false, company: false, active: true, name: 'Zed' };

/* A computer with the core whose report is fresh and fits. */
const candidate = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id, kind: 'computer', networkId: `${id}`.padEnd(32, '0'), server: false, role: 'worker', createdAt: day(1), reportAt: new Date(NOW.getTime() - 20_000),
  memory: 8 * GIB, diskFree: 100 * GIB, fsyncP99Ms: 3, owner: CEO, ...over,
});
const LEADER = candidate('l', { server: true, role: 'data' });
const OPTS = { leader: 'l', dbSize: GIB, link: true, now: NOW };
const ranked = (all: Candidate[], over: Partial<typeof OPTS> = {}) => Object.fromEntries(rankOf(all, { ...OPTS, ...over }).map(({ id, ...rest }) => [id, rest]));

describe('the order of the machines that may hold the data', () => {
  it('numbers the leader 1 and fit machines from 2 by owner, then age', () => {
    const a = candidate('a', { createdAt: day(3) });
    const b = candidate('b', { createdAt: day(1), owner: WHOLE });
    const c = candidate('c', { createdAt: day(5) });
    expect(ranked([b, c, LEADER, a])).toEqual({
      l: { number: 1, why: 'server', data: true },
      a: { number: 2, why: null, data: true },
      c: { number: 3, why: null, data: true },
      b: { number: 4, why: 'next', data: false },
    });
  });

  it('keeps the machines that hold a copy ahead', () => {
    const a = candidate('a', { createdAt: day(3) });
    const b = candidate('b', { createdAt: day(1), owner: WHOLE, role: 'data' });
    const c = candidate('c', { createdAt: day(5) });
    expect(ranked([a, b, c, LEADER])).toMatchObject({ b: { number: 2, data: true }, a: { number: 3, data: true }, c: { number: 4, why: 'next', data: false } });
    /* A copy keeps its data wherever it stands, and whatever its machine measures now. */
    const d = candidate('d', { createdAt: day(2), role: 'data', memory: GIB });
    const e = candidate('e', { createdAt: day(4), role: 'data', owner: WHOLE, reportAt: null });
    expect(ranked([a, b, d, e, LEADER])).toMatchObject({ d: { number: 2, data: true }, b: { number: 3, data: true }, e: { number: 4, why: null, data: true }, a: { number: 5, why: 'next', data: false } });
  });

  it('marks a copy whose person no longer sees the whole company', () => {
    const a = candidate('a', { createdAt: day(3) });
    const b = candidate('b', { owner: LISTED, role: 'data' });
    const c = candidate('c', { createdAt: day(5) });
    expect(ranked([a, b, c, LEADER])).toEqual({
      l: { number: 1, why: 'server', data: true },
      b: { number: null, why: null, data: false, leave: true },
      a: { number: 2, why: null, data: true },
      c: { number: 3, why: null, data: true },
    });
    expect(ranked([candidate('b', { owner: { ...WHOLE, active: false }, role: 'data' }), LEADER]).b).toEqual({ number: null, why: null, data: false, leave: true });
  });

  it("gives data only to whole-company people's fit computers", () => {
    const cases: [Partial<Candidate>, ReturnType<typeof unfit>][] = [
      [{ kind: 'phone' }, { why: 'phone' }],
      [{ kind: 'browser' }, { why: 'phone' }],
      [{ networkId: null }, { why: 'no_core' }],
      [{ owner: LISTED }, { why: 'scope', person: 'Zed' }],
      [{ owner: { ...WHOLE, active: false } }, { why: 'scope', person: 'Maria' }],
      [{ reportAt: new Date(NOW.getTime() - 180_000) }, { why: 'measuring' }],
      [{ reportAt: null }, { why: 'measuring' }],
      [{ fsyncP99Ms: null }, { why: 'measuring' }],
      [{ memory: null }, { why: 'measuring' }],
      [{ memory: 3 * GIB }, { why: 'memory', memory: 3 * GIB }],
      [{ diskFree: 12 * GIB }, { why: 'disk', free: 12 * GIB, need: 13 * GIB }],
      [{ fsyncP99Ms: 50 }, { why: 'fsync', p99: 50 }],
    ];
    cases.forEach(([over, why], at) => {
      const row = candidate(`m${at}`, over);
      expect([over, unfit(row, OPTS)]).toEqual([over, why]);
      expect([over, ranked([LEADER, row])[row.id]]).toEqual([over, { number: null, why: null, data: false }]);
    });
    /* The first failure is the reason. */
    expect(unfit(candidate('x', { kind: 'phone', owner: LISTED, memory: GIB }), OPTS)).toEqual({ why: 'phone' });
    expect(unfit(candidate('x', { owner: LISTED, memory: GIB }), { ...OPTS, link: false })).toEqual({ why: 'scope', person: 'Zed' });
    expect(unfit(candidate('x'), OPTS)).toBeNull();
    /* The server's own row has no joined computer's id, and is one all the same. */
    expect(unfit(candidate('x', { networkId: null, server: true }), OPTS)).toBeNull();
  });

  it('takes 4 GB as Docker reports it', () => {
    expect(unfit(candidate('x', { memory: 3.8 * GIB }), OPTS)).toBeNull();
    expect(unfit(candidate('x', { memory: 3.5 * GIB }), OPTS)).toBeNull();
  });

  it('gives no copy without a link', () => {
    const a = candidate('a');
    const b = candidate('b', { owner: WHOLE });
    expect(ranked([a, b, LEADER], { link: false })).toEqual({
      l: { number: 1, why: 'server', data: true },
      a: { number: null, why: null, data: false },
      b: { number: null, why: null, data: false },
    });
    expect(unfit(a, { ...OPTS, link: false })).toEqual({ why: 'no_link' });
  });
});

const MACHINE_ID = 'a1b2c3d4'.repeat(4);
const OWN = { remoteAddress: '127.0.0.1', headers: { 'x-hornhoof-via': 'keeper' } };
const newKey = (): string => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();

async function company() {
  const { app, db, config } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: MACHINE_ID });
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const [maria] = await db.insert(people).values({ companyId: acme!.id, name: 'Maria', email: 'maria@acme.test', status: 'active', scopeKind: 'company' }).returning();
  /* The server's own row, as its keeper's first ask makes it. */
  await app.inject({ method: 'POST', url: '/api/network/certificate', payload: { signKey: newKey() }, ...OWN });
  await db.insert(publicLinks).values({ companyId: acme!.id, name: 'acme', url: 'https://acme.hornhoof.test', keyEnc: 'k', tunnelEnc: 't' });
  let made = 0;
  /* A computer with the core, joined on a day of its own, whose keeper just reported measures that fit. */
  const joined = async (personId: string, createdDay: number, more: Partial<typeof machines.$inferInsert> = {}) => {
    made += 1;
    const values = {
      companyId: acme!.id, personId, machineKey: `joined-${made}`, hostname: `m${made}`, role: 'worker' as const, networkId: `${made}`.padStart(32, '0'), createdAt: day(createdDay),
      reportAt: new Date(), memory: 8 * GIB, diskFree: 500 * GIB, fsyncP99Ms: 3, ...more,
    };
    return (await db.insert(machines).values(values).returning())[0]!;
  };
  const places = async () =>
    Object.fromEntries((await db.select().from(machines).where(isNotNull(machines.networkId)).orderBy(asc(machines.createdAt))).map(row => [row.hostname || 'server', [row.serverOrder, row.serverWhy, row.role]]));
  return { app, db, config, ctx: app.ctx, ownerId: owner!.id, mariaId: maria!.id, joined, places };
}

describe('the ranking on the server', () => {
  it('writes only what changes', async () => {
    const c = await company();
    await c.joined(c.ownerId, 3);
    await c.joined(c.mariaId, 1);
    await c.joined(c.ownerId, 5);
    /* The server's row, and the two that get a place among the first three; the fourth gets a place too. */
    expect(await rank(c.ctx)).toEqual({ changed: 4 });
    expect(await c.places()).toEqual({ server: [1, 'server', 'data'], m1: [2, null, 'data'], m3: [3, null, 'data'], m2: [4, 'next', 'worker'] });
    expect(await rank(c.ctx)).toEqual({ changed: 0 });
  });

  it('swaps two numbers without a clash', async () => {
    const c = await company();
    const a = await c.joined(c.ownerId, 3);
    await c.joined(c.ownerId, 5);
    await c.joined(c.mariaId, 1);
    await rank(c.ctx);
    expect(await c.places()).toMatchObject({ m1: [2, null, 'data'], m2: [3, null, 'data'], m3: [4, 'next', 'worker'] });
    /* Both hold a copy now, so only their ages decide between them. */
    await c.db.update(machines).set({ createdAt: day(7) }).where(eq(machines.id, a.id));
    expect(await rank(c.ctx)).toEqual({ changed: 2 });
    expect(await c.places()).toMatchObject({ m2: [2, null, 'data'], m1: [3, null, 'data'], m3: [4, 'next', 'worker'] });
  });

  it('gives no place to a machine that does not fit, and none at all without the row of this server', async () => {
    const c = await company();
    const phone = await c.joined(c.ownerId, 2, { kind: 'phone' });
    const stale = await c.joined(c.ownerId, 3, { reportAt: new Date(Date.now() - 180_000) });
    expect(await rank(c.ctx)).toEqual({ changed: 1 });
    expect(await c.places()).toEqual({ server: [1, 'server', 'data'], m1: [null, null, 'worker'], m2: [null, null, 'worker'] });
    await c.db.update(machines).set({ revokedAt: new Date() }).where(eq(machines.networkId, MACHINE_ID));
    await c.db.update(machines).set({ kind: 'computer', reportAt: new Date() }).where(eq(machines.id, phone.id));
    await c.db.update(machines).set({ reportAt: new Date() }).where(eq(machines.id, stale.id));
    expect(await rank(c.ctx)).toEqual({ changed: 0 });
  });

  it('ranks every minute while it leads', async () => {
    const c = await company();
    const late = await c.joined(c.ownerId, 2, { reportAt: null });
    const ranking = new Ranking(c.ctx, { everyMs: 100 });
    onTestFinished(() => ranking.stop());
    ranking.start();
    await until(async () => (await c.places()).server?.[0] === 1);
    expect((await c.places()).m1).toEqual([null, null, 'worker']);
    await c.db.update(machines).set({ reportAt: new Date() }).where(eq(machines.id, late.id));
    await until(async () => (await c.places()).m1?.[0] === 2);
    ranking.stop();
    const other = await c.joined(c.mariaId, 3);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect((await c.db.select().from(machines).where(eq(machines.id, other.id)))[0]!.serverOrder).toBeNull();
  });

  it('ranks again at once when asked, one more time at most', async () => {
    const c = await company();
    const ranking = new Ranking(c.ctx, { everyMs: 3_600_000 });
    onTestFinished(() => ranking.stop());
    ranking.start();
    await until(async () => (await c.places()).server?.[0] === 1);
    await c.joined(c.ownerId, 2);
    ranking.now();
    ranking.now();
    ranking.now();
    await until(async () => (await c.places()).m1?.[0] === 2);
  });
});
