import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc, eq, isNotNull, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { certificates, companies, departments, machineOnline, machines, peerSecrets, people, personAccess, publicLinks, teams } from '../src/db/schema.js';
import { storeThroughput } from '../src/modules/copies/measured.js';
import { candidates, planRoles, rank, Ranking, rankOf } from '../src/modules/copies/order.js';
import { onlineShare } from '../src/modules/network/join.js';
import { writeKeeperState } from '../src/modules/keeper/state.js';
import { unfit, type Candidate } from '../src/modules/copies/qualify.js';
import { Relay } from '../src/modules/link/relay.js';
import { fakeRelay } from './fake-relay.js';
import { as, setUpCompany, testApp, until } from './helpers.js';

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
  memory: 8 * GIB, fsyncP99Ms: 3, cores: 8, share: 1, linkRttMs: 20, linkMbps: 100, internetRttMs: 20, internetMbps: 100, pin: null, number: null, owner: CEO, ...over,
});
const LEADER = candidate('l', { server: true, role: 'data' });
const OPTS = { leader: 'l', link: true, now: NOW, rescore: true };
const ranked = (all: Candidate[], over: Partial<typeof OPTS> = {}) => Object.fromEntries(rankOf(all, { ...OPTS, ...over }).map(({ id, ...rest }) => [id, rest]));
const numbers = (all: Candidate[], over: Partial<typeof OPTS> = {}) => Object.fromEntries(rankOf(all, { ...OPTS, ...over }).map(place => [place.id, place.number]));

describe('the order of the machines that may hold the data', () => {
  it('numbers the leader 1 and fit machines from 2 by owner, then age', () => {
    /* Newcomers with the same measures: only whose they are and their age tell them apart. */
    const a = candidate('a', { createdAt: hoursAgo(30) });
    const b = candidate('b', { createdAt: hoursAgo(60), owner: WHOLE });
    const c = candidate('c', { createdAt: hoursAgo(10) });
    expect(ranked([b, c, LEADER, a])).toEqual({
      l: { number: 1, why: 'server' },
      a: { number: 2, why: 'new' },
      c: { number: 3, why: 'new' },
      b: { number: 4, why: 'next' },
    });
  });

  it('numbers the leader 1 whatever it measures', () => {
    const leader = candidate('l', { server: true, role: 'data', reportAt: null, memory: GIB, fsyncP99Ms: null, share: 0 });
    expect(ranked([leader, candidate('a')]).l).toEqual({ number: 1, why: 'server' });
    /* A pin ends when its machine becomes number 1. */
    expect(ranked([{ ...leader, pin: '3' }, candidate('a')]).l).toEqual({ number: 1, why: 'server', clearPin: true });
  });

  it('marks a copy whose person no longer sees the whole company', () => {
    const a = candidate('a', { createdAt: hoursAgo(30) });
    const b = candidate('b', { owner: LISTED, role: 'data' });
    const c = candidate('c', { createdAt: hoursAgo(10) });
    expect(ranked([a, b, c, LEADER])).toEqual({
      l: { number: 1, why: 'server' },
      b: { number: null, why: null, leave: true },
      a: { number: 2, why: 'new' },
      c: { number: 3, why: 'new' },
    });
    expect(ranked([candidate('b', { owner: { ...WHOLE, active: false }, role: 'data' }), LEADER]).b).toEqual({ number: null, why: null, leave: true });
  });

  it("gives data only to whole-company people's fit computers", () => {
    const cases: [Partial<Candidate>, ReturnType<typeof unfit>][] = [
      [{ kind: 'phone' }, { why: 'phone' }],
      [{ kind: 'browser' }, { why: 'phone' }],
      [{ networkId: null }, { why: 'no_core' }],
      [{ owner: LISTED }, { why: 'scope', person: 'Zed' }],
      [{ owner: { ...LISTED, departments: 2 } }, { why: 'scope', person: 'Zed', departments: 2 }],
      [{ owner: { ...WHOLE, active: false } }, { why: 'scope', person: 'Maria' }],
    ];
    cases.forEach(([over, why], at) => {
      const row = candidate(`m${at}`, over);
      expect([over, unfit(row, OPTS)]).toEqual([over, why]);
      expect([over, ranked([LEADER, row])[row.id]]).toEqual([over, { number: null, why: null }]);
    });
    /* The first failure is the reason. */
    expect(unfit(candidate('x', { kind: 'phone', owner: LISTED }), OPTS)).toEqual({ why: 'phone' });
    expect(unfit(candidate('x', { owner: LISTED }), { ...OPTS, link: false })).toEqual({ why: 'scope', person: 'Zed' });
    expect(unfit(candidate('x'), OPTS)).toBeNull();
    /* The server's own row has no joined computer's id, and is one all the same. */
    expect(unfit(candidate('x', { networkId: null, server: true }), OPTS)).toBeNull();
    /* A machine is taken on what it last measured, however long ago: a laptop asleep keeps its place. */
    expect(unfit(candidate('x', { reportAt: new Date(NOW.getTime() - 7 * 86_400_000) }), OPTS)).toBeNull();
    expect(unfit(candidate('x', { reportAt: null }), OPTS)).toBeNull();
  });

  it('gives a full machine of the company its place whatever it measures', () => {
    /* A disk that saves slowly under load, as Docker's on a Mac while the copy is poured in, or as the leader's own. */
    const slow = [59, 59.1, 800].map(fsyncP99Ms => ({ fsyncP99Ms }));
    /* A machine that has measured nothing yet takes its place at once, with nothing to wait for. */
    const none = { memory: null, fsyncP99Ms: null, cores: null, share: null, linkRttMs: null, linkMbps: null, internetRttMs: null, internetMbps: null };
    const little = [{ memory: GIB }, { memory: 0, cores: 1 }, { role: 'data' as const, memory: GIB }];
    for (const over of [...slow, none, ...little]) {
      const row = candidate('a', over);
      expect([over, unfit(row, OPTS)]).toEqual([over, null]);
      expect([over, ranked([LEADER, row]).a]).toEqual([over, { number: 2, why: 'new' }]);
    }
    /* What it measures only orders it among the others. */
    expect(numbers([LEADER, candidate('a', none), candidate('b', { fsyncP99Ms: 800 }), candidate('c')])).toEqual({ l: 1, c: 2, b: 3, a: 4 });
  });

  it('keeps the place of a machine that still gives up a copy', () => {
    /* It gets no data while it owes what it held, which is the roles' to say; its place is its own. */
    expect(unfit(candidate('a', { owes: true }), OPTS)).toBeNull();
    expect(ranked([LEADER, candidate('a', { owes: true })]).a).toEqual({ number: 2, why: 'new' });
  });

  it('gives no copy without a link', () => {
    const a = candidate('a');
    const b = candidate('b', { owner: WHOLE });
    expect(ranked([a, b, LEADER], { link: false })).toEqual({
      l: { number: 1, why: 'server' },
      a: { number: null, why: null },
      b: { number: null, why: null },
    });
    expect(unfit(a, { ...OPTS, link: false })).toEqual({ why: 'no_link' });
  });

  it('ranks the new leader first after a takeover and the old one as any', () => {
    /* B took the server from A, which was number 1 and is a copy now; C scores above A. */
    const old = { createdAt: daysAgo(10), role: 'data' as const };
    const a = candidate('a', { ...old, server: true, number: 1, ...POINTS[70] });
    const b = candidate('b', { ...old, number: 2, share: 0.2 });
    const c = candidate('c', { createdAt: daysAgo(10), number: 3, ...POINTS[90] });
    expect(numbers([a, b, c], { leader: 'b' })).toEqual({ b: 1, c: 2, a: 3 });
    expect(ranked([a, b, c], { leader: 'b' }).b).toEqual({ number: 1, why: 'server' });
  });

  it('ranks by the score once established', () => {
    /* A and B are nearly always there and measure little else; C is there half the time and has the most points. */
    const sparse = { linkRttMs: null, linkMbps: null, internetRttMs: null, internetMbps: null, createdAt: daysAgo(10) };
    const a = candidate('a', { ...sparse, share: 1 });
    const b = candidate('b', { ...sparse, share: 0.96, cores: 4 });
    const c = candidate('c', { ...FULL, share: 0.5, createdAt: daysAgo(10) });
    expect(numbers([c, b, a, LEADER])).toEqual({ l: 1, a: 2, b: 3, c: 4 });
    expect(ranked([c, b, a, LEADER]).c).toEqual({ number: 4, why: 'next' });
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
    expect(ranked([a, b, LEADER])).toMatchObject({ b: { number: 2, why: 'pinned' }, a: { number: 3 } });
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
    expect(ranked([candidate('a'), b, LEADER])).toMatchObject({ a: { number: 2 }, b: { number: null, why: 'out' } });
    /* A copy that is kept out keeps its copy until the ranking hands it on. */
    expect(ranked([candidate('a'), { ...b, role: 'data' }, LEADER]).b).toEqual({ number: null, why: 'out' });
  });

  it('says why a machine waits for its place', () => {
    const all = [candidate('a', { createdAt: hoursAgo(40) }), candidate('b', { createdAt: hoursAgo(30) }), candidate('c', { createdAt: hoursAgo(20) }), candidate('d', { createdAt: hoursAgo(10), role: 'data' }), LEADER];
    expect(ranked(all)).toMatchObject({ a: { number: 2, why: 'new' }, b: { number: 3, why: 'new' }, c: { number: 4, why: 'next' }, d: { number: 5, why: 'handing' } });
  });
});

describe('who holds a copy after a ranking', () => {
  const HOUR = 3_600_000;
  type Plan = Parameters<typeof planRoles>[0];
  const at = (id: string, number: number) => ({ id, number });
  const holds = (id: string, number: number | null, out = false) => ({ id, number, out });
  const plan = (over: Partial<Plan>) =>
    planRoles({ numbered: [], data: [], eligible: new Set(['A', 'B', 'C', 'D', 'E']), ready: new Set(), sync: null, handoverAt: null, now: NOW, ceo: false, ...over });
  const NOTHING = { grant: [], retire: null, handover: false };

  it('gives free seats at once', () => {
    expect(plan({ numbered: [at('B', 3), at('A', 2), at('C', 4)] })).toEqual({ grant: ['A', 'B'], retire: null, handover: false });
  });

  it('fills the seat of a lost copy', () => {
    expect(plan({ numbered: [at('A', 2), at('B', 3)], data: [holds('A', 2)] })).toEqual({ grant: ['B'], retire: null, handover: false });
  });

  it('hands a copy over, once a day or on the CEO\'s word', () => {
    const over = { numbered: [at('A', 2), at('B', 3)], data: [holds('A', 2), holds('C', 4)], ready: new Set(['A', 'C']) };
    expect(plan({ ...over, handoverAt: new Date(NOW.getTime() - 25 * HOUR) })).toEqual({ grant: ['B'], retire: null, handover: true });
    expect(plan({ ...over, handoverAt: null })).toEqual({ grant: ['B'], retire: null, handover: true });
    expect(plan({ ...over, handoverAt: new Date(NOW.getTime() - 23 * HOUR) })).toEqual(NOTHING);
    expect(plan({ ...over, handoverAt: new Date(NOW.getTime() - 23 * HOUR), ceo: true })).toEqual({ grant: ['B'], retire: null, handover: true });
  });

  it('makes one copy at a time', () => {
    const over = { numbered: [at('A', 2), at('B', 3)], data: [holds('A', 2), holds('C', 4)], ready: new Set(['C']) };
    expect(plan(over)).toEqual(NOTHING);
    expect(plan({ ...over, ceo: true })).toEqual(NOTHING);
    expect(plan({ ...over, ready: new Set(['A', 'C']), ceo: true }).grant).toEqual(['B']);
  });

  it('waits for the copy being made', () => {
    const over = { numbered: [at('B', 2), at('D', 3)], data: [holds('B', 2), holds('C', 4)] };
    expect(plan({ ...over, ready: new Set(['C']) })).toEqual(NOTHING);
    expect(plan({ ...over, ready: new Set(['B', 'C']) })).toEqual({ grant: ['D'], retire: null, handover: true });
  });

  it('retires only after the new copy is up to date', () => {
    const over = { numbered: [at('A', 2), at('B', 3)], data: [holds('A', 2), holds('B', 3), holds('C', 4)] };
    expect(plan({ ...over, ready: new Set(['A', 'C']) }).retire).toBeNull();
    /* The one commits wait for is never the one that goes: the controller moves that first. */
    expect(plan({ ...over, ready: new Set(['A', 'B', 'C']), sync: 'C' }).retire).toBeNull();
    expect(plan({ ...over, ready: new Set(['A', 'B', 'C']), sync: 'A' })).toEqual({ grant: [], retire: 'C', handover: false });
  });

  it('keeps a copy that only stopped qualifying', () => {
    const over = { numbered: [at('A', 2)], ready: new Set(['A', 'C']), sync: 'A' };
    expect(plan({ ...over, data: [holds('A', 2), holds('C', null)] }).retire).toBeNull();
    /* Only the CEO's "does not take the server" lowers the number of copies. */
    expect(plan({ ...over, data: [holds('A', 2), holds('C', null, true)] }).retire).toBe('C');
  });

  it("keeps the target's copy", () => {
    /* The server is to move to D (4): it gets the data at once, beside the two copies, and no ranking retires it. */
    const copies = { numbered: [at('A', 2), at('B', 3), at('D', 4)], ready: new Set(['A', 'B']), sync: 'A' };
    expect(plan({ ...copies, data: [holds('A', 2), holds('B', 3)], target: 'D' })).toEqual({ grant: ['D'], retire: null, handover: false });
    const three = { ...copies, data: [holds('A', 2), holds('B', 3), holds('D', 4)], ready: new Set(['A', 'B', 'D']) };
    expect(plan({ ...three, target: 'D' })).toEqual(NOTHING);
    /* It does not take a seat from the machines at 2 and 3. */
    expect(plan({ numbered: [at('A', 2), at('B', 3), at('D', 4)], data: [holds('D', 4)], target: 'D' }).grant).toEqual(['A', 'B']);
    /* With the request gone the extra copy is retired as before. */
    expect(plan(three)).toEqual({ grant: [], retire: 'D', handover: false });
    /* A target with no number gets nothing. */
    expect(plan({ numbered: [at('A', 2), at('B', 3)], data: [holds('A', 2), holds('B', 3)], ready: new Set(['A', 'B']), target: 'D' })).toEqual(NOTHING);
    /* One of the two places itself gets its copy without waiting for the day's handover, and alone. */
    const waiting = { numbered: [at('D', 2), at('B', 3)], data: [holds('A', 4), holds('C', 5)], ready: new Set(['A', 'C']), handoverAt: new Date(NOW.getTime() - HOUR) };
    expect(plan(waiting)).toEqual(NOTHING);
    expect(plan({ ...waiting, target: 'B' })).toEqual({ grant: ['B'], retire: null, handover: false });
    /* A target that may get no data now, as one that still owes what it held or is away, gets none for the asking:
       the request waits until it may. */
    const owes = new Set(['A', 'B']);
    expect(plan({ ...copies, data: [holds('A', 2), holds('B', 3)], eligible: owes, target: 'D' })).toEqual(NOTHING);
    expect(plan({ ...waiting, eligible: new Set(['A', 'C', 'D']), target: 'B' })).toEqual(NOTHING);
  });

  it('keeps the only copy', () => {
    expect(plan({ data: [holds('C', null, true)], ready: new Set(['C']) })).toEqual(NOTHING);
  });

  it('retires one a run', () => {
    const data = [holds('A', 2), holds('B', 3), holds('C', 4), holds('E', null)];
    const over = { numbered: [at('A', 2), at('B', 3)], data, ready: new Set(['A', 'B', 'C', 'E']), sync: 'A' };
    expect(plan(over).retire).toBe('E');
    expect(plan({ ...over, data: data.slice(0, 3).concat(holds('D', 5)) }).retire).toBe('D');
  });

  it('gives no data to a machine being wiped', () => {
    expect(plan({ numbered: [at('A', 2), at('B', 3)], eligible: new Set(['A']) })).toEqual({ grant: ['A'], retire: null, handover: false });
  });

  it('gives a free seat to the next machine that is there when the one above is away', () => {
    /* B at 3 is asleep, or still gives up what it held: the copy is not left unmade for it. */
    expect(plan({ numbered: [at('A', 2), at('B', 3), at('C', 4), at('D', 5)], data: [holds('A', 2)], eligible: new Set(['A', 'C', 'D']) })).toEqual({ grant: ['C'], retire: null, handover: false });
    /* Back, it takes its copy by a handover, and the machine that stood in keeps its own until that one is up to date. */
    const back = { numbered: [at('A', 2), at('B', 3), at('C', 4)], data: [holds('A', 2), holds('C', 4)] };
    expect(plan({ ...back, ready: new Set(['A', 'C']) })).toEqual({ grant: ['B'], retire: null, handover: true });
    expect(plan({ ...back, data: [...back.data, holds('B', 3)], ready: new Set(['A', 'B', 'C']), sync: 'A' })).toEqual({ grant: [], retire: 'C', handover: false });
  });
});

const MACHINE_ID = 'a1b2c3d4'.repeat(4);
const OWN = { remoteAddress: '127.0.0.1', headers: { 'x-hornhoof-via': 'keeper' } };
const newKey = (): string => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();

async function company(env: NodeJS.ProcessEnv = {}) {
  const { app, db, config } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: MACHINE_ID, ...env });
  const ceo = await setUpCompany(app);
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
  return { app, db, config, ctx: app.ctx, ceo, ownerId: owner!.id, mariaId: maria!.id, joined, places };
}

describe('the ranking on the server', () => {
  it('writes only what changes', async () => {
    const c = await company();
    await c.joined(c.ownerId, 3);
    await c.joined(c.mariaId, 1);
    await c.joined(c.ownerId, 5);
    /* The server's row, and the two that get a place among the first three; the fourth gets a place too. */
    expect(await rank(c.ctx)).toEqual({ changed: 4, scored: true });
    expect(await c.places()).toEqual({ server: [1, 'server', 'data'], m1: [2, expect.any(String), 'data'], m3: [3, expect.any(String), 'data'], m2: [4, 'next', 'worker'] });
    expect(await rank(c.ctx)).toEqual({ changed: 0, scored: false });
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
    /* A run that does not score keeps the order, and only words anew why the second stands where it does. */
    expect(await rank(c.ctx)).toEqual({ changed: 1, scored: false });
    expect(await c.places()).toMatchObject({ m1: [2, expect.any(String), 'data'], m2: [3, expect.any(String), 'data'] });
    expect(await rank(c.ctx, undefined, { rescore: true })).toEqual({ changed: 2, scored: true });
    expect(await c.places()).toMatchObject({ m2: [2, expect.any(String), 'data'], m1: [3, expect.any(String), 'data'], m3: [4, 'next', 'worker'] });
  });

  it('makes a hidden name for a company with no link, once another machine is there to keep a copy', async () => {
    const relay = await fakeRelay();
    const c = await company({ RELAY_URL: relay.url });
    await c.db.delete(publicLinks);
    const binds = (at: { calls: string[] }) => at.calls.filter(call => call.startsWith('POST ') && call.endsWith('/bindings')).length;
    /* A company of one machine asks hornhoof.org for nothing. */
    expect(await rank(c.ctx)).toMatchObject({ scored: true });
    expect([binds(relay), await c.db.select().from(publicLinks)]).toEqual([0, []]);
    /* With a machine that may keep a copy, and hornhoof.org away: no name, and no copy. */
    await c.joined(c.ownerId, 3);
    await relay.close();
    await rank(c.ctx);
    expect(await c.db.select().from(publicLinks)).toEqual([]);
    expect(await c.places()).toMatchObject({ m1: [null, null, 'worker'] });
    /* Once hornhoof.org answers: a name of its own choosing, hidden, and the machine gets its place. */
    const back = await fakeRelay();
    (c.ctx.links as unknown as { relay: Relay }).relay = new Relay(back.url);
    await rank(c.ctx);
    const [link] = await c.db.select().from(publicLinks);
    expect(link).toMatchObject({ hidden: true });
    expect(back.bindings.has(link!.name)).toBe(true);
    expect((await c.places()).m1![0]).toBe(2);
    expect((await c.app.inject({ url: '/api/link', ...as(c.ceo) })).json().link).toBeNull();
    /* The next ranking asks for nothing more. */
    expect(binds(back)).toBe(1);
    await rank(c.ctx);
    expect(binds(back)).toBe(1);
  });

  it('gives no place to a machine that does not fit, and none at all without the row of this server', async () => {
    const c = await company();
    const phone = await c.joined(c.ownerId, 2, { kind: 'phone' });
    const browser = await c.joined(c.ownerId, 3, { kind: 'browser' });
    expect(await rank(c.ctx)).toEqual({ changed: 1, scored: true });
    expect(await c.places()).toEqual({ server: [1, 'server', 'data'], m1: [null, null, 'worker'], m2: [null, null, 'worker'] });
    await c.db.update(machines).set({ revokedAt: new Date() }).where(eq(machines.networkId, MACHINE_ID));
    await c.db.update(machines).set({ kind: 'computer', reportAt: new Date() }).where(eq(machines.id, phone.id));
    await c.db.update(machines).set({ kind: 'computer' }).where(eq(machines.id, browser.id));
    expect(await rank(c.ctx)).toEqual({ changed: 0, scored: false });
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
    /* It has its place, and no data while it owes what it held. */
    expect(await c.places()).toMatchObject({ m1: [2, expect.any(String), 'worker'] });
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
    const late = await c.joined(c.ownerId, 2, { kind: 'phone' });
    const ranking = new Ranking(c.ctx, { everyMs: 100 });
    onTestFinished(() => ranking.stop());
    ranking.start();
    await until(async () => (await c.places()).server?.[0] === 1);
    expect((await c.places()).m1).toEqual([null, null, 'worker']);
    await c.db.update(machines).set({ kind: 'computer' }).where(eq(machines.id, late.id));
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
    void ranking.now();
    void ranking.now();
    void ranking.now();
    await until(async () => (await c.places()).m1?.[0] === 2);
  });
  it('ends for whoever asked, and fails for them when the run fails', async () => {
    const c = await company();
    await c.joined(c.ownerId, 1);
    await c.joined(c.ownerId, 2);
    const ranking = new Ranking(c.ctx, { everyMs: 3_600_000 });
    onTestFinished(() => ranking.stop());
    ranking.start();
    await ranking.now();
    expect(await c.places()).toMatchObject({ m1: [2, expect.any(String), 'data'], m2: [3, expect.any(String), 'data'] });
    /* The second now measures far better, which only a scoring sees. The database refuses the run that was to score:
       the caller hears it, and the run after it scores in its place though nobody asks it to. */
    await c.db.update(machines).set({ cores: 8, linkRttMs: 20, linkMbps: 100, internetRttMs: 20, internetMbps: 100 }).where(eq(machines.hostname, 'm2'));
    const transaction = c.ctx.db.transaction;
    c.ctx.db.transaction = (() => Promise.reject(new Error('the database is away'))) as typeof transaction;
    await expect(ranking.now({ rescore: true })).rejects.toThrow('the database is away');
    c.ctx.db.transaction = transaction;
    await ranking.now();
    expect(await c.places()).toMatchObject({ m2: [2, expect.any(String), 'data'], m1: [3, expect.any(String), 'data'] });
  });

  /* A week of being online so much of each day, for the share the score reads. */
  const online = async (c: Awaited<ReturnType<typeof company>>, machineId: string, share: number) => {
    for (let back = 0; back <= 8; back++) {
      const day = new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
      await c.db.insert(machineOnline).values({ machineId, day, seconds: Math.round(86_400 * share) });
    }
  };
  const HOUR = 3_600_000;

  it('keeps its number while asleep', async () => {
    const c = await company();
    const a = await c.joined(c.ownerId, 1);
    await rank(c.ctx);
    expect(await c.places()).toMatchObject({ m1: [2, expect.any(String), 'data'] });
    /* Its last report is thirty hours old, and the order is scored again. */
    await c.db.update(machines).set({ reportAt: new Date(Date.now() - 30 * HOUR) }).where(eq(machines.id, a.id));
    expect(await rank(c.ctx, undefined, { rescore: true })).toMatchObject({ scored: true });
    expect(await c.places()).toMatchObject({ m1: [2, expect.any(String), 'data'] });
  });

  it('scores once a day, and at once when a machine joins', async () => {
    const c = await company();
    const t0 = new Date();
    await c.joined(c.ownerId, 1);
    await c.joined(c.ownerId, 2);
    expect(await rank(c.ctx, t0)).toMatchObject({ scored: true });
    expect(await c.places()).toMatchObject({ m1: [2, expect.any(String), 'data'], m2: [3, expect.any(String), 'data'] });
    /* The second now measures far better than the first above it. */
    await c.db.update(machines).set({ cores: 8, linkRttMs: 20, linkMbps: 100, internetRttMs: 20, internetMbps: 100 }).where(eq(machines.hostname, 'm2'));
    expect((await rank(c.ctx, new Date(t0.getTime() + HOUR))).scored).toBe(false);
    expect(await c.places()).toMatchObject({ m1: [2, expect.any(String), 'data'], m2: [3, expect.any(String), 'data'] });
    const day = new Date(t0.getTime() + 24 * HOUR);
    expect((await rank(c.ctx, day)).scored).toBe(true);
    expect(await c.places()).toMatchObject({ m2: [2, expect.any(String), 'data'], m1: [3, expect.any(String), 'data'] });
    const [{ at }] = (await c.db.execute(sql`SELECT rescored_at AS at FROM net.ranking`) as unknown as { rows: { at: string }[] }).rows as [{ at: string }];
    expect(new Date(at).getTime()).toBe(day.getTime());
    /* A machine that joins is given its number by the next run, whatever the day. */
    await c.joined(c.mariaId, 3);
    expect(await rank(c.ctx, new Date(day.getTime() + HOUR))).toMatchObject({ scored: true });
    expect((await c.places()).m3).toEqual([4, 'next', 'worker']);
  });

  it('frees the place and the pin of a machine that left, and clears the pin of the machine that leads', async () => {
    const c = await company();
    await rank(c.ctx);
    const gone = await c.joined(c.ownerId, 1, { serverOrder: 2, serverPin: '2', revokedAt: new Date() });
    await c.db.update(machines).set({ serverPin: '3' }).where(eq(machines.networkId, MACHINE_ID));
    await c.joined(c.ownerId, 2);
    expect(await rank(c.ctx)).toMatchObject({ scored: true });
    expect((await c.db.select().from(machines).where(eq(machines.id, gone.id)))[0]).toMatchObject({ serverOrder: null, serverPin: null, serverWhy: null });
    expect((await c.db.select().from(machines).where(eq(machines.networkId, MACHINE_ID)))[0]).toMatchObject({ serverOrder: 1, serverPin: null });
    expect((await c.places()).m2).toEqual([2, expect.any(String), 'data']);
  });

  it('hands a copy over, and retires the old one only once the new one is up to date', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hh-control-'));
    onTestFinished(() => rmSync(control, { recursive: true, force: true }));
    const c = await company({ HORNHOOF_CONTROL_DIR: control });
    const seen: string[] = [];
    const catalog = { standby: '', slots: [] as { name: string; pid: number | null; walStatus: string | null; confirmed: string | null }[] };
    c.ctx.replication = {
      slots: async () => catalog.slots,
      end: async () => undefined,
      drop: async name => {
        seen.push(`drop ${name}`);
        catalog.slots = catalog.slots.filter(slot => slot.name !== name);
      },
      standby: async () => catalog.standby,
    };
    /* The name of a machine's copy starts with its own id. A and B hold the copies; C joined ten days ago too and is always there, where B is half the time. */
    const copy = (n: string) => `copy_${n.repeat(16)}_1`;
    const a = await c.joined(c.ownerId, 1, { networkId: '1'.repeat(32), role: 'data', serverOrder: 2, copyName: copy('1'), copyState: 'ready' });
    const b = await c.joined(c.ownerId, 1, { networkId: '2'.repeat(32), role: 'data', serverOrder: 3, copyName: copy('2'), copyState: 'ready' });
    const cc = await c.joined(c.ownerId, 1, { networkId: '3'.repeat(32) });
    await online(c, a.id, 1);
    await online(c, b.id, 0.5);
    await online(c, cc.id, 1);
    await c.db.insert(certificates).values({ serial: 'b1', machineId: b.id, until: new Date(Date.now() + 86_400_000) });
    catalog.slots = [{ name: copy('2'), pid: null, walStatus: 'reserved', confirmed: '0/1' }];
    const said = (copies: { name: string; state: 'sync' | 'pace' | 'behind' | 'silent' }[]) => writeKeeperState(control, { mode: 'lead', at: new Date().toISOString(), link: null, copies });
    const rowOf = async (id: string) => (await c.db.select().from(machines).where(eq(machines.id, id)))[0]!;
    const secrets = await c.db.select().from(peerSecrets);

    said([{ name: copy('1'), state: 'sync' }, { name: copy('2'), state: 'pace' }]);
    await rank(c.ctx, undefined, { rescore: true });
    /* C takes the third place and gets the data; B stands at four and keeps its copy while it is handed over. */
    expect(await rowOf(cc.id)).toMatchObject({ serverOrder: 3, role: 'data' });
    expect(await rowOf(b.id)).toMatchObject({ serverOrder: 4, serverWhy: 'handing', role: 'data', uploadState: null });
    const [{ at }] = (await c.db.execute(sql`SELECT handover_at AS at FROM net.ranking`) as unknown as { rows: { at: string | null }[] }).rows as [{ at: string | null }];
    expect(at).not.toBeNull();
    /* C's copy is still being made: nothing is retired. */
    await c.db.update(machines).set({ copyName: copy('3'), copyState: 'making' }).where(eq(machines.id, cc.id));
    said([{ name: copy('1'), state: 'sync' }, { name: copy('2'), state: 'pace' }, { name: copy('3'), state: 'behind' }]);
    await rank(c.ctx);
    expect([(await rowOf(b.id)).role, seen]).toEqual(['data', []]);
    /* It is up to date when the run looks, and behind again by the time the run comes to cut: nothing is cut. */
    const upToDate = () => said([{ name: copy('1'), state: 'sync' }, { name: copy('2'), state: 'pace' }, { name: copy('3'), state: 'pace' }]);
    upToDate();
    const finishKey = c.ctx.links.finishKey;
    c.ctx.links.finishKey = async () => {
      said([{ name: copy('1'), state: 'sync' }, { name: copy('2'), state: 'pace' }, { name: copy('3'), state: 'behind' }]);
      return 'none';
    };
    await rank(c.ctx);
    c.ctx.links.finishKey = finishKey;
    expect([(await rowOf(b.id)).role, seen]).toEqual(['data', []]);
    /* Up to date and staying so, but the keeper names B's copy the one commits wait for at the last look: nothing is cut. */
    upToDate();
    catalog.standby = `FIRST 1 ("${copy('2')}")`;
    await rank(c.ctx);
    expect([(await rowOf(b.id)).role, seen]).toEqual(['data', []]);
    /* Commits wait for A's: B is cut from the leader's changes first, then told to give up what it holds. */
    catalog.standby = `FIRST 1 ("${copy('1')}")`;
    await rank(c.ctx);
    expect(seen).toEqual([`drop ${copy('2')}`]);
    expect(await rowOf(b.id)).toMatchObject({ role: 'worker', uploadState: 'waiting', dataLeftAt: null, serverOrder: 4 });
    expect((await c.db.select().from(certificates).where(eq(certificates.serial, 'b1')))[0]!.revokedAt).not.toBeNull();
    /* Its owner still sees the whole company: no key of the company changes. */
    expect(await c.db.select().from(peerSecrets)).toEqual(secrets);
    expect((await c.db.select().from(publicLinks))[0]!.nextKeyEnc).toBeNull();
  });
  it('gives a full machine of the company a place and a copy at once, whatever it measures and however it measures', async () => {
    const c = await company();
    /* A keeper that reported, but has no measure of its own yet, and one whose disk saves slowly while its copy is poured in. */
    await c.joined(c.ownerId, 1, { memory: null, diskFree: null, fsyncP99Ms: null });
    await c.joined(c.ownerId, 2, { fsyncP99Ms: 59.1, memory: GIB, diskFree: GIB });
    await rank(c.ctx);
    expect(await c.places()).toMatchObject({ server: [1, 'server', 'data'], m1: [2, expect.any(String), 'data'], m2: [3, expect.any(String), 'data'] });
    /* The leader's own disk under load holds no copy back either. */
    await c.db.update(machines).set({ fsyncP99Ms: 806.7 }).where(eq(machines.networkId, MACHINE_ID));
    await rank(c.ctx, new Date(), { rescore: true });
    expect(await c.places()).toMatchObject({ server: [1, 'server', 'data'], m1: [2, expect.any(String), 'data'], m2: [3, expect.any(String), 'data'] });
  });

  it('gives the data only to a machine that reports, and none back to one that still owes what it held', async () => {
    const c = await company();
    /* The first is asleep since yesterday, the second still gives up the copy it held: the third and fourth get the data. */
    const asleep = await c.joined(c.ownerId, 1, { reportAt: new Date(Date.now() - 30 * 3_600_000) });
    const owing = await c.joined(c.ownerId, 2, { uploadState: 'waiting' });
    await c.joined(c.ownerId, 3);
    await c.joined(c.ownerId, 4);
    await rank(c.ctx);
    expect(await c.places()).toMatchObject({ m1: [2, expect.any(String), 'worker'], m2: [3, expect.any(String), 'worker'], m3: [4, 'next', 'data'], m4: [5, 'next', 'data'] });
    /* Awake again, the first takes its copy by a handover; the second waits its day, and the machines that stood in
       keep their copies meanwhile. */
    await c.db.update(machines).set({ reportAt: new Date() }).where(eq(machines.id, asleep.id));
    await c.db.update(machines).set({ uploadState: null }).where(eq(machines.id, owing.id));
    await rank(c.ctx);
    expect(await c.places()).toMatchObject({ m1: [2, expect.any(String), 'data'], m2: [3, expect.any(String), 'worker'], m3: [4, 'handing', 'data'], m4: [5, 'handing', 'data'] });
  });

  it("counts the departments a person sees once each, and none for one who is switched off", async () => {
    const c = await company();
    const [acme] = await c.db.select().from(companies);
    const [sales, support] = await c.db.insert(departments).values([{ companyId: acme!.id, name: 'Sales', roleCode: 'CSO' }, { companyId: acme!.id, name: 'Support', roleCode: 'CCO' }]).returning();
    const [one, two] = await c.db.insert(teams).values([{ companyId: acme!.id, departmentId: sales!.id, name: 'One' }, { companyId: acme!.id, departmentId: sales!.id, name: 'Two' }]).returning();
    const [zed] = await c.db.insert(people).values({ companyId: acme!.id, name: 'Zed', email: 'zed@acme.test', status: 'active', scopeKind: 'listed' }).returning();
    /* One department whole and two teams of it, then a team of another department. */
    await c.db.insert(personAccess).values([{ companyId: acme!.id, personId: zed!.id, departmentId: sales!.id }, { companyId: acme!.id, personId: zed!.id, teamId: one!.id }, { companyId: acme!.id, personId: zed!.id, teamId: two!.id }]);
    const his = await c.joined(zed!.id, 1);
    const seen = async () => (await candidates(c.db)).find(m => m.id === his.id)!.owner.departments;
    expect(await seen()).toBe(1);
    const [other] = await c.db.insert(teams).values({ companyId: acme!.id, departmentId: support!.id, name: 'Other' }).returning();
    await c.db.insert(personAccess).values({ companyId: acme!.id, personId: zed!.id, teamId: other!.id });
    expect(await seen()).toBe(2);
    await c.db.update(people).set({ status: 'disabled' }).where(eq(people.id, zed!.id));
    expect(await seen()).toBeUndefined();
  });

  it('reads every share in one look, as each machine alone would give it', async () => {
    const c = await company();
    const [a, b] = [await c.joined(c.ownerId, 1), await c.joined(c.ownerId, 9)];
    const now = new Date();
    for (let back = 0; back <= 8; back++) {
      const day = new Date(now.getTime() - back * 86_400_000).toISOString().slice(0, 10);
      await c.db.insert(machineOnline).values([{ machineId: a.id, day, seconds: 43_200 }, { machineId: b.id, day, seconds: 20_000 }]);
    }
    const shares = Object.fromEntries((await candidates(c.db, now)).map(m => [m.id, m.share]));
    for (const id of [a.id, b.id]) expect(shares[id]).toBeCloseTo((await onlineShare(c.db, id, now))!, 10);
    expect(shares[a.id]).toBeGreaterThan(0.4);
    /* The Machines tab reads no share: it only says why a machine cannot take the server. */
    expect((await candidates(c.db, now, { shares: false })).every(m => m.share === null)).toBe(true);
  });
});
