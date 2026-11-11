import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc, eq, isNotNull } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { companies, machines, people, publicLinks } from '../src/db/schema.js';
import { storeThroughput } from '../src/modules/copies/measured.js';
import { rank, Ranking, rankOf } from '../src/modules/copies/order.js';
import { writeKeeperState } from '../src/modules/keeper/state.js';
import { unfit, type Candidate } from '../src/modules/copies/qualify.js';
import { setUpCompany, testApp, until } from './helpers.js';

const GIB = 2 ** 30;
const NOW = new Date('2026-11-11T12:00:00Z');
const day = (n: number): Date => new Date(Date.UTC(2026, 10, n));
const CEO = { isOwner: true, company: true, active: true, name: 'Ivan' };
const WHOLE = { isOwner: false, company: true, active: true, name: 'Maria' };
const LISTED = { isOwner: false, company: false, active: true, name: 'Zed' };

/* Made so long before now: within the last three days a machine is a newcomer, after them an established one. */
const hoursAgo = (hours: number): Date => new Date(NOW.getTime() - hours * 3_600_000);
const daysAgo = (days: number): Date => hoursAgo(24 * days);
/* What earns every point but the online share's: 60 of them. */
const FULL = { linkRttMs: 20, linkMbps: 100, internetRttMs: 20, internetMbps: 100, fsyncP99Ms: 2, memory: 16 * GIB, cores: 8 };
/* A share of a half, which is not the 95% class, with so many points in all: 70, 74, 75, 80 or 90. */
const POINTS: Record<number, Partial<Candidate>> = {
  70: { ...FULL, share: 0.5, memory: 4 * GIB, cores: 0 },
  74: { ...FULL, share: 0.5, memory: 4 * GIB, cores: 6.4 },
  75: { ...FULL, share: 0.5, memory: 4 * GIB },
  80: { ...FULL, share: 0.5 },
  90: { ...FULL, share: 0.75 },
};

/* A computer with the core that fits, joined two days ago, with the same measures as every other unless a case says. */
const candidate = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id, kind: 'computer', networkId: `${id}`.padEnd(32, '0'), server: false, role: 'worker', createdAt: hoursAgo(48), reportAt: new Date(NOW.getTime() - 20_000),
  memory: 8 * GIB, diskFree: 100 * GIB, fsyncP99Ms: 3, cores: 8, share: 1, linkRttMs: 20, linkMbps: 100, internetRttMs: 20, internetMbps: 100, pin: null, number: null, owner: CEO, ...over,
});
const LEADER = candidate('l', { server: true, role: 'data' });
const OPTS = { leader: 'l', dbSize: GIB, link: true, now: NOW, rescore: true };
const ranked = (all: Candidate[], over: Partial<typeof OPTS> = {}) => Object.fromEntries(rankOf(all, { ...OPTS, ...over }).map(({ id, ...rest }) => [id, rest]));
const numbers = (all: Candidate[], over: Partial<typeof OPTS> = {}) => Object.fromEntries(rankOf(all, { ...OPTS, ...over }).map(place => [place.id, place.number]));

describe('the order of the machines that may hold the data', () => {
  it('numbers the leader 1 and fit machines from 2 by owner, then age', () => {
    /* Newcomers with the same measures: only whose they are and their age tell them apart. */
    const a = candidate('a', { createdAt: hoursAgo(30) });
    const b = candidate('b', { createdAt: hoursAgo(60), owner: WHOLE });
    const c = candidate('c', { createdAt: hoursAgo(10) });
    expect(ranked([b, c, LEADER, a])).toEqual({
      l: { number: 1, why: 'server', data: true },
      a: { number: 2, why: 'new', data: true },
      c: { number: 3, why: 'new', data: true },
      b: { number: 4, why: 'next', data: false },
    });
  });

  it('numbers the leader 1 whatever it measures', () => {
    const leader = candidate('l', { server: true, role: 'data', reportAt: null, memory: GIB, fsyncP99Ms: null, share: 0 });
    expect(ranked([leader, candidate('a')]).l).toEqual({ number: 1, why: 'server', data: true });
    /* A pin ends when its machine becomes number 1. */
    expect(ranked([{ ...leader, pin: '3' }, candidate('a')]).l).toEqual({ number: 1, why: 'server', data: true, clearPin: true });
  });

  it('marks a copy whose person no longer sees the whole company', () => {
    const a = candidate('a', { createdAt: hoursAgo(30) });
    const b = candidate('b', { owner: LISTED, role: 'data' });
    const c = candidate('c', { createdAt: hoursAgo(10) });
    expect(ranked([a, b, c, LEADER])).toEqual({
      l: { number: 1, why: 'server', data: true },
      b: { number: null, why: null, data: false, leave: true },
      a: { number: 2, why: 'new', data: true },
      c: { number: 3, why: 'new', data: true },
    });
    expect(ranked([candidate('b', { owner: { ...WHOLE, active: false }, role: 'data' }), LEADER]).b).toEqual({ number: null, why: null, data: false, leave: true });
  });

  it("gives data only to whole-company people's fit computers", () => {
    const cases: [Partial<Candidate>, ReturnType<typeof unfit>][] = [
      [{ kind: 'phone' }, { why: 'phone' }],
      [{ kind: 'browser' }, { why: 'phone' }],
      [{ networkId: null }, { why: 'no_core' }],
      [{ owner: LISTED }, { why: 'scope', person: 'Zed' }],
      [{ owner: { ...LISTED, departments: 2 } }, { why: 'scope', person: 'Zed', departments: 2 }],
      [{ owner: { ...WHOLE, active: false } }, { why: 'scope', person: 'Maria' }],
      [{ fsyncP99Ms: null }, { why: 'measuring' }],
      [{ memory: null }, { why: 'measuring' }],
      [{ diskFree: null }, { why: 'measuring' }],
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
    /* A machine is taken on what it last measured, however long ago: a laptop asleep keeps its place. */
    expect(unfit(candidate('x', { reportAt: new Date(NOW.getTime() - 7 * 86_400_000) }), OPTS)).toBeNull();
    expect(unfit(candidate('x', { reportAt: null }), OPTS)).toBeNull();
  });

  it('takes 4 GB as Docker reports it', () => {
    expect(unfit(candidate('x', { memory: 3.8 * GIB }), OPTS)).toBeNull();
    expect(unfit(candidate('x', { memory: 3.5 * GIB }), OPTS)).toBeNull();
  });

  it('says of a machine that still gives up a copy that it does', () => {
    expect(unfit(candidate('a', { owes: true }), OPTS)).toEqual({ why: 'leaving' });
    expect(ranked([LEADER, candidate('a', { owes: true })]).a).toEqual({ number: null, why: null, data: false });
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

  it('ranks by the score once established', () => {
    /* A and B are nearly always there and measure little else; C is there half the time and has the most points. */
    const sparse = { linkRttMs: null, linkMbps: null, internetRttMs: null, internetMbps: null, createdAt: daysAgo(10) };
    const a = candidate('a', { ...sparse, share: 1 });
    const b = candidate('b', { ...sparse, share: 0.96, cores: 4 });
    const c = candidate('c', { ...FULL, share: 0.5, createdAt: daysAgo(10) });
    expect(numbers([c, b, a, LEADER])).toEqual({ l: 1, a: 2, b: 3, c: 4 });
    expect(ranked([c, b, a, LEADER]).c).toEqual({ number: 4, why: 'next', data: false });
    /* An established machine at 2 or 3 says how often it is there and what it is best or worst at. */
    expect(ranked([c, b, a, LEADER]).a!.why).toBe('always.slow_internet');
  });

  it('ranks newcomers by class and points, after every established machine', () => {
    const e = candidate('e', { ...POINTS[70], createdAt: daysAgo(10) });
    const n1 = candidate('n1', { ...POINTS[70], share: 1, owner: WHOLE });
    const n2 = candidate('n2', { ...FULL, share: 0.1 });
    expect(numbers([n2, n1, e, LEADER])).toEqual({ l: 1, e: 2, n1: 3, n2: 4 });
    /* Two of one class within five points keep the order they had. */
    const n3 = candidate('n3', { ...POINTS[70], number: 3 });
    const n4 = candidate('n4', { ...POINTS[74], number: 4 });
    expect(numbers([n4, n3, e, LEADER])).toEqual({ l: 1, e: 2, n3: 3, n4: 4 });
    /* With no place yet and the same points, the CEO's comes first. */
    const m1 = candidate('m1', { ...POINTS[70], owner: WHOLE });
    const m2 = candidate('m2', { ...POINTS[70] });
    expect(numbers([m1, m2, LEADER])).toEqual({ l: 1, m2: 2, m1: 3 });
  });

  it('keeps the order without a scoring', () => {
    const a = candidate('a', { ...POINTS[90], createdAt: daysAgo(10), number: 3 });
    const b = candidate('b', { ...POINTS[70], createdAt: daysAgo(10), number: 2 });
    expect(numbers([a, b, LEADER], { rescore: false })).toEqual({ l: 1, b: 2, a: 3 });
    expect(numbers([a, b, LEADER])).toEqual({ l: 1, a: 2, b: 3 });
  });

  it('keeps a place for a pinned machine', () => {
    const a = candidate('a', { ...POINTS[90], createdAt: daysAgo(10) });
    const b = candidate('b', { ...POINTS[70], createdAt: daysAgo(10), pin: '2' });
    expect(ranked([a, b, LEADER])).toMatchObject({ b: { number: 2, why: 'pinned', data: true }, a: { number: 3 } });
  });

  it('settles around a pin', () => {
    const a = candidate('a', { ...POINTS[70], createdAt: daysAgo(10), number: 2 });
    const p = candidate('p', { ...POINTS[75], createdAt: daysAgo(10), number: 3, pin: '3' });
    const b = candidate('b', { ...POINTS[80], createdAt: daysAgo(10), number: 4 });
    /* The pinned one is set aside, and B leads A by ten. */
    expect(numbers([a, p, b, LEADER])).toEqual({ l: 1, b: 2, p: 3, a: 4 });
  });

  it('leaves out a machine that does not take the server', () => {
    const b = candidate('b', { pin: 'none' });
    expect(ranked([candidate('a'), b, LEADER])).toMatchObject({ a: { number: 2 }, b: { number: null, why: 'out', data: false } });
    /* A copy that is kept out keeps its copy until the ranking hands it on. */
    expect(ranked([candidate('a'), { ...b, role: 'data' }, LEADER]).b).toEqual({ number: null, why: 'out', data: true });
  });

  it('says why a machine waits for its place', () => {
    const all = [candidate('a', { createdAt: hoursAgo(40) }), candidate('b', { createdAt: hoursAgo(30) }), candidate('c', { createdAt: hoursAgo(20) }), candidate('d', { createdAt: hoursAgo(10), role: 'data' }), LEADER];
    expect(ranked(all)).toMatchObject({ a: { number: 2, why: 'new' }, b: { number: 3, why: 'new' }, c: { number: 4, why: 'next', data: false }, d: { number: 5, why: 'handing', data: true } });
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
    expect(await c.places()).toEqual({ server: [1, 'server', 'data'], m1: [2, expect.any(String), 'data'], m3: [3, expect.any(String), 'data'], m2: [4, 'next', 'worker'] });
    expect(await rank(c.ctx)).toEqual({ changed: 0 });
  });

  it('swaps two numbers without a clash', async () => {
    const c = await company();
    const a = await c.joined(c.ownerId, 3);
    await c.joined(c.ownerId, 5);
    await c.joined(c.mariaId, 1);
    await rank(c.ctx);
    expect(await c.places()).toMatchObject({ m1: [2, expect.any(String), 'data'], m2: [3, expect.any(String), 'data'], m3: [4, 'next', 'worker'] });
    /* Both hold a copy and measure the same. Then the second measures far more than the first, and passes it. */
    expect(a.hostname).toBe('m1');
    await c.db.update(machines).set({ cores: 8, linkRttMs: 20, linkMbps: 100, internetRttMs: 20, internetMbps: 100 }).where(eq(machines.hostname, 'm2'));
    expect(await rank(c.ctx)).toEqual({ changed: 2 });
    expect(await c.places()).toMatchObject({ m2: [2, expect.any(String), 'data'], m1: [3, expect.any(String), 'data'], m3: [4, 'next', 'worker'] });
  });

  it('gives no place to a machine that does not fit, and none at all without the row of this server', async () => {
    const c = await company();
    const phone = await c.joined(c.ownerId, 2, { kind: 'phone' });
    /* One that never reported its memory is still being measured. */
    const stale = await c.joined(c.ownerId, 3, { memory: null });
    expect(await rank(c.ctx)).toEqual({ changed: 1 });
    expect(await c.places()).toEqual({ server: [1, 'server', 'data'], m1: [null, null, 'worker'], m2: [null, null, 'worker'] });
    await c.db.update(machines).set({ revokedAt: new Date() }).where(eq(machines.networkId, MACHINE_ID));
    await c.db.update(machines).set({ kind: 'computer', reportAt: new Date() }).where(eq(machines.id, phone.id));
    await c.db.update(machines).set({ memory: 8 * GIB }).where(eq(machines.id, stale.id));
    expect(await rank(c.ctx)).toEqual({ changed: 0 });
  });

  it('takes over the number of a machine that left with it', async () => {
    const c = await company();
    const a = await c.joined(c.ownerId, 3);
    await c.joined(c.ownerId, 5);
    const waiting = await c.joined(c.mariaId, 7);
    await rank(c.ctx);
    expect(await c.places()).toMatchObject({ m1: [2, expect.any(String), 'data'], m2: [3, expect.any(String), 'data'], m3: [4, 'next', 'worker'] });
    /* A machine goes with its number still on its row, as one that waited for a place does when it is disconnected,
       and as the server's own row does when the company is restored onto another install. */
    await c.db.update(machines).set({ revokedAt: new Date() }).where(eq(machines.id, waiting.id));
    await c.db.update(machines).set({ revokedAt: new Date() }).where(eq(machines.id, a.id));
    const later = await c.joined(c.mariaId, 9);
    await rank(c.ctx);
    const live = await c.db.select().from(machines).where(eq(machines.id, later.id));
    expect(live[0]).toMatchObject({ serverOrder: 3, role: 'data' });
    /* A row that left holds no number. */
    expect((await c.db.select().from(machines).where(isNotNull(machines.revokedAt))).map(row => row.serverOrder)).toEqual([null, null]);
  });

  it('gives no copy to a machine that still gives up the one it held', async () => {
    const c = await company();
    /* Its owner lost the scope and has it back, and the machine has not been wiped yet. */
    const leaving = await c.joined(c.ownerId, 3, { uploadState: 'received', dataLeftAt: new Date() });
    await rank(c.ctx);
    expect(await c.places()).toMatchObject({ m1: [null, null, 'worker'] });
    /* Once it holds nothing of before, it is a machine like any other. */
    await c.db.update(machines).set({ uploadState: null }).where(eq(machines.id, leaving.id));
    await rank(c.ctx);
    expect(await c.places()).toMatchObject({ m1: [2, expect.any(String), 'data'] });
  });

  it('keeps the last throughput', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hh-control-'));
    onTestFinished(() => rmSync(control, { recursive: true, force: true }));
    const { app, db } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: MACHINE_ID, HORNHOOF_CONTROL_DIR: control });
    await setUpCompany(app);
    const [acme] = await db.select().from(companies);
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const [a] = await db.insert(machines).values({ companyId: acme!.id, personId: owner!.id, machineKey: 'a', role: 'data', networkId: 'a'.repeat(32) }).returning();
    const [b] = await db.insert(machines).values({ companyId: acme!.id, personId: owner!.id, machineKey: 'b', role: 'worker', networkId: 'b'.repeat(32), linkMbps: 7 }).returning();
    const said = (throughput: Record<string, { mbps: number; at: string }> | undefined) =>
      writeKeeperState(control, { mode: 'lead', at: new Date().toISOString(), link: null, ...(throughput ? { throughput } : {}) });
    const rate = async (id: string) => (await db.select().from(machines).where(eq(machines.id, id)))[0]!.linkMbps;
    const at = new Date().toISOString();
    said({ [a!.id]: { mbps: 80, at } });
    expect(await storeThroughput(app.ctx)).toBe(1);
    expect([await rate(a!.id), await rate(b!.id)]).toEqual([80, 7]);
    /* Written once: the same word again changes no row. */
    expect(await storeThroughput(app.ctx)).toBe(0);
    /* A day with nothing sent to it, or a keeper that says nothing at all, keeps what the row has. */
    said({});
    expect(await storeThroughput(app.ctx)).toBe(0);
    said(undefined);
    expect(await storeThroughput(app.ctx)).toBe(0);
    expect(await rate(a!.id)).toBe(80);
    said({ [a!.id]: { mbps: 20, at }, 'not-a-machine': { mbps: 5, at } });
    expect(await storeThroughput(app.ctx)).toBe(1);
    expect(await rate(a!.id)).toBe(20);
  });

  it('ranks every minute while it leads', async () => {
    const c = await company();
    const late = await c.joined(c.ownerId, 2, { fsyncP99Ms: null });
    const ranking = new Ranking(c.ctx, { everyMs: 100 });
    onTestFinished(() => ranking.stop());
    ranking.start();
    await until(async () => (await c.places()).server?.[0] === 1);
    expect((await c.places()).m1).toEqual([null, null, 'worker']);
    await c.db.update(machines).set({ fsyncP99Ms: 3 }).where(eq(machines.id, late.id));
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
