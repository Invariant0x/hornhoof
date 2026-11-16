import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { companies, machines, people } from '../src/db/schema.js';
import { copiesView, dataViews } from '../src/modules/copies/view.js';
import { writeKeeperState } from '../src/modules/keeper/state.js';
import { saveLink } from '../src/modules/link/link.js';
import { thisMachine } from '../src/modules/network/store.js';
import { setUpCompany, testApp } from './helpers.js';

const NOW = new Date('2026-11-11T12:00:00.000Z');
const HOST = 'a1b2c3d4'.repeat(4);
const TUNNEL = { serverAddr: 'relay.hornhoof.test', serverPort: 443, protocol: 'wss' };
type Slot = { name: string; pid: number | null; walStatus: string | null; confirmed: string | null };
type KeeperCopy = { name: string; state: 'sync' | 'pace' | 'behind' | 'silent' };

/* A company whose server leads, with a link, its pulse at NOW, and what the test says of its slots and its keeper. */
async function stand() {
  const control = mkdtempSync(join(tmpdir(), 'hh-control-'));
  const { app, db, config } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: HOST, HORNHOOF_CONTROL_DIR: control });
  await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const leader = await thisMachine(db, config, acme!.id);
  await db.update(machines).set({ hostname: 'rack-01', serverOrder: 1, serverWhy: 'server', reportAt: NOW }).where(eq(machines.id, leader.id));
  await saveLink(db, config, acme!.id, { name: 'acme', url: 'https://acme.hornhoof.test', key: 'k'.repeat(32), tunnel: TUNNEL });
  await db.execute(sql`INSERT INTO net.pulse (at) VALUES (${NOW.toISOString()}::timestamptz) ON CONFLICT (id) DO UPDATE SET at = excluded.at`);
  const slots: Slot[] = [];
  app.ctx.replication = { slots: async () => slots, end: async () => undefined, drop: async () => undefined, standby: async () => '' };
  let n = 0;
  /* A machine that keeps a copy: its row, its slot read by a walsender, and a report that just came. */
  const copy = async (hostname: string, over: Partial<typeof machines.$inferInsert> = {}, walsender = true) => {
    n += 1;
    const name = `copy_${String(n).repeat(16)}_1`;
    const [row] = await db
      .insert(machines)
      .values({ companyId: acme!.id, personId: owner!.id, machineKey: `copy-${n}`, hostname, kind: 'computer', role: 'data', networkId: String(n).repeat(64), serverOrder: n + 1, copyName: name, reportAt: NOW, ...over })
      .returning();
    slots.push({ name, pid: walsender ? 100 + n : null, walStatus: 'reserved', confirmed: '0/3000000' });
    return { id: row!.id, name };
  };
  const keeper = (copies: KeeperCopy[], at = NOW) => writeKeeperState(control, { mode: 'lead', at: at.toISOString(), link: null, copies });
  const lineOf = async (id: string) => (await dataViews(app.ctx, NOW)).get(id)?.copy;
  return { app, db, acme: acme!, owner: owner!, leader, copy, keeper, lineOf, slots };
}

const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("what the Machines tab says of the company's data", () => {
  it("writes each copy's line", async () => {
    const s = await stand();
    const making = await s.copy('m-making', { copyState: 'making', copyProgress: 40 });
    const remaking = await s.copy('m-remaking', { copyState: 'remaking', copyProgress: 10, copyAt: ago(1000) });
    const full = await s.copy('m-full', { copyState: 'stopped', copyError: 'disk_full' });
    const setup = await s.copy('m-setup', { copyState: 'stopped', copyError: 'setup' });
    const stopped = await s.copy('m-stopped', { copyState: 'stopped', copyError: 'apply' });
    expect(await s.lineOf(making.id)).toEqual({ line: 'making', progress: 40 });
    expect(await s.lineOf(remaking.id)).toEqual({ line: 'remaking', progress: 10 });
    expect(await s.lineOf(full.id)).toEqual({ line: 'stopped', why: 'disk_full' });
    expect(await s.lineOf(setup.id)).toEqual({ line: 'stopped', why: 'setup' });
    expect(await s.lineOf(stopped.id)).toEqual({ line: 'stopped', why: null });
    /* A machine that led saves what it did before its copy is made again. */
    const saving = await s.copy('m-saving', { copyState: 'saving', copyAt: ago(1000) });
    expect(await s.lineOf(saving.id)).toEqual({ line: 'saving' });
    /* A machine that was just given the data and has said nothing of a copy yet is making one, not asleep. */
    const fresh = await s.copy('m-fresh', { copyName: null }, false);
    expect(await s.lineOf(fresh.id)).toEqual({ line: 'making', progress: 0 });
  });

  it('tells a copy that sleeps from one that is behind, catches up or is up to date', async () => {
    const s = await stand();
    const noSender = await s.copy('m-no-sender', { copyState: 'ready', copyAt: ago(600_000) }, false);
    const silent = await s.copy('m-silent', { copyState: 'ready', copyAt: ago(200_000), reportAt: ago(180_000) });
    const behind = await s.copy('m-behind', { copyState: 'ready', copyAt: ago(270_000) });
    const ready = await s.copy('m-ready', { copyState: 'ready', copyAt: ago(500) });
    const near = await s.copy('m-near', { copyState: 'ready', copyAt: ago(30_000) });
    const even = await s.copy('m-even', { copyState: 'ready', copyAt: NOW });
    s.keeper([{ name: ready.name, state: 'pace' }, { name: near.name, state: 'behind' }, { name: behind.name, state: 'behind' }]);
    expect(await s.lineOf(noSender.id)).toEqual({ line: 'asleep', since: ago(600_000).toISOString() });
    expect(await s.lineOf(silent.id)).toEqual({ line: 'asleep', since: ago(200_000).toISOString() });
    expect(await s.lineOf(behind.id)).toEqual({ line: 'behind', minutes: 4 });
    expect(await s.lineOf(ready.id)).toEqual({ line: 'ready' });
    expect(await s.lineOf(near.id)).toEqual({ line: 'catching_up' });
    /* The keeper's word is what makes a copy up to date: one it does not name is not, however near it is. */
    expect(await s.lineOf(even.id)).toEqual({ line: 'catching_up' });
    /* A word of a keeper that stopped writing makes none up to date either. */
    s.keeper([{ name: ready.name, state: 'sync' }], ago(60_000));
    expect(await s.lineOf(ready.id)).toEqual({ line: 'catching_up' });
    s.keeper([{ name: ready.name, state: 'sync' }]);
    expect(await s.lineOf(ready.id)).toEqual({ line: 'ready' });
  });

  it('gives each machine its place, or why it holds no copy', async () => {
    const s = await stand();
    const held = await s.copy('m-copy', { copyState: 'ready', copyAt: NOW });
    const [next] = await s.db
      .insert(machines)
      .values({ companyId: s.acme.id, personId: s.owner.id, machineKey: 'next', hostname: 'm-next', kind: 'computer', role: 'worker', networkId: 'e'.repeat(64), serverOrder: 4, serverWhy: 'next', reportAt: NOW })
      .returning();
    const [phone] = await s.db
      .insert(machines)
      .values({ companyId: s.acme.id, personId: s.owner.id, machineKey: 'phone', hostname: 'm-phone', kind: 'phone', role: null, reportAt: NOW })
      .returning();
    /* What a machine measures keeps it from nothing: one with little memory, room and a slow disk waits only for the ranking. */
    const [small] = await s.db
      .insert(machines)
      .values({ companyId: s.acme.id, personId: s.owner.id, machineKey: 'small', hostname: 'm-small', kind: 'computer', role: 'worker', networkId: 'f'.repeat(64), reportAt: NOW, memory: 2 * 2 ** 30, diskFree: 2 ** 30, fsyncP99Ms: 59.1 })
      .returning();
    const [left] = await s.db
      .insert(machines)
      .values({ companyId: s.acme.id, personId: s.owner.id, machineKey: 'left', hostname: 'm-left', kind: 'computer', role: 'worker', networkId: 'd'.repeat(64), reportAt: NOW, dataLeftAt: ago(86_400_000), uploadState: 'waiting' })
      .returning();
    const views = await dataViews(s.app.ctx, NOW);
    expect(views.get(s.leader.id)).toEqual({ number: 1, why: 'server', pin: null, unfit: null, copy: null, leftAt: null, led: null });
    expect(views.get(held.id)).toMatchObject({ number: 2, why: null, unfit: null, copy: { line: 'catching_up' }, leftAt: null });
    expect(views.get(next!.id)).toEqual({ number: 4, why: 'next', pin: null, unfit: null, copy: null, leftAt: null, led: null });
    expect(views.get(phone!.id)).toEqual({ number: null, why: null, pin: null, unfit: { why: 'phone' }, copy: null, leftAt: null, led: null });
    expect(views.get(small!.id)).toEqual({ number: null, why: null, pin: null, unfit: null, copy: null, leftAt: null, led: null });
    expect(views.get(left!.id)).toMatchObject({ number: null, copy: null, leftAt: ago(86_400_000).toISOString() });
  });

  it('says why a machine that holds the data has no place', async () => {
    const s = await stand();
    /* Its copy is up to date, but its person no longer sees the whole company, until the ranking takes the data from it. */
    const [anna] = await s.db.insert(people).values({ companyId: s.acme.id, name: 'Anna', email: 'anna@acme.test', status: 'active', scopeKind: 'listed' }).returning();
    const held = await s.copy('m-anna', { personId: anna!.id, copyState: 'ready', copyAt: NOW, serverOrder: null, fsyncP99Ms: 59.1 });
    s.keeper([{ name: held.name, state: 'sync' }]);
    expect((await dataViews(s.app.ctx, NOW)).get(held.id)).toEqual({ number: null, why: null, pin: null, unfit: { why: 'scope', person: 'Anna', departments: 0 }, copy: { line: 'ready' }, leftAt: null, led: null });
    /* One of the CEO's with no place yet says nothing against it, whatever its disk does. */
    const mine = await s.copy('m-mine', { copyState: 'ready', copyAt: NOW, serverOrder: null, fsyncP99Ms: 59.1 });
    expect((await dataViews(s.app.ctx, NOW)).get(mine.id)).toMatchObject({ number: null, unfit: null });
  });

  it('shows the place and the pin', async () => {
    const s = await stand();
    const fit = { memory: 8 * 2 ** 30, diskFree: 500 * 2 ** 30, fsyncP99Ms: 3 };
    const pinned = await s.copy('m-pinned', { copyState: 'ready', copyAt: NOW, serverOrder: 3, serverWhy: 'always.best_link', serverPin: '3', ...fit });
    const [out] = await s.db
      .insert(machines)
      .values({ companyId: s.acme.id, personId: s.owner.id, machineKey: 'out', hostname: 'm-out', kind: 'computer', role: 'worker', networkId: 'e'.repeat(64), serverWhy: 'out', serverPin: 'none', reportAt: NOW, ...fit })
      .returning();
    const views = await dataViews(s.app.ctx, NOW);
    /* The key of the words is the one the ranking stored, whatever it is. */
    expect(views.get(pinned.id)).toMatchObject({ number: 3, why: 'always.best_link', pin: 3 });
    expect(views.get(out!.id)).toEqual({ number: null, why: 'out', pin: 'none', unfit: null, copy: null, leftAt: null, led: null });
  });

  it('notes the old leader once it is up to date', async () => {
    const s = await stand();
    const a = await s.copy('mac', { copyState: 'making', copyProgress: 10 });
    const b = await s.copy('deb', { copyState: 'ready', copyAt: NOW });
    const handed = (from: string, at: Date, heard: Date | null) =>
      s.db.execute(sql`INSERT INTO net.handovers (id, from_machine_id, term_number, term_machine, applied, to_machine_id, at, kind, heard_at)
        VALUES (gen_random_uuid(), ${from}, 7, 'a', '0/1', ${s.leader.id}, ${at.toISOString()}::timestamptz, 'takeover', ${heard?.toISOString() ?? null}::timestamptz)`);
    const ledOf = async (id: string) => (await dataViews(s.app.ctx, NOW)).get(id)?.led;
    /* The server was taken from mac, which was last heard two minutes before. */
    await handed(a.id, ago(600_000), ago(720_000));
    expect(await ledOf(a.id)).toBeNull();
    /* A copy it finished before it led says nothing of now. */
    await s.db.update(machines).set({ copyState: 'ready', copyAt: ago(900_000) }).where(eq(machines.id, a.id));
    expect(await ledOf(a.id)).toBeNull();
    await s.db.update(machines).set({ copyAt: ago(60_000) }).where(eq(machines.id, a.id));
    /* Only on the word of the keeper that leads that the copy holds every change: one that lags says so instead. */
    expect(await ledOf(a.id)).toBeNull();
    s.keeper([{ name: a.name, state: 'sync' }, { name: b.name, state: 'pace' }]);
    expect(await ledOf(a.id)).toEqual({ until: ago(720_000).toISOString() });
    expect(await ledOf(b.id)).toBeNull();
    expect(await ledOf(s.leader.id)).toBeNull();
    /* A later handover, from another machine and with no time it was last heard: only that one is the old leader. */
    await handed(b.id, ago(120_000), null);
    expect(await ledOf(a.id)).toBeNull();
    expect(await ledOf(b.id)).toEqual({ until: ago(120_000).toISOString() });
  });

  it('names every copy', async () => {
    const s = await stand();
    /* Three while one is handed over. */
    for (const hostname of ['mac', 'deb', 'nuc']) await s.copy(hostname, { copyState: 'ready', copyAt: ago(500) });
    expect((await copiesView(s.app.ctx, NOW))?.copies.map(copy => copy.hostname)).toEqual(['mac', 'deb', 'nuc']);
  });

  it('says who holds the company, and since when only the leader does', async () => {
    const s = await stand();
    /* No copy ever. */
    expect(await copiesView(s.app.ctx, NOW)).toBeNull();
    const a = await s.copy('mac', { copyState: 'ready', copyAt: ago(500) });
    s.keeper([{ name: a.name, state: 'pace' }]);
    expect(await copiesView(s.app.ctx, NOW)).toEqual({ leader: 'rack-01', copies: [{ hostname: 'mac', sync: false }], onlySince: null });
    const b = await s.copy('deb', { copyState: 'ready', copyAt: ago(700) });
    s.keeper([{ name: a.name, state: 'pace' }, { name: b.name, state: 'sync' }]);
    expect(await copiesView(s.app.ctx, NOW)).toEqual({ leader: 'rack-01', copies: [{ hostname: 'mac', sync: false }, { hostname: 'deb', sync: true }], onlySince: null });
    /* One catches up and one sleeps: only the leader holds what came after the newer of the two. */
    s.keeper([{ name: a.name, state: 'behind' }]);
    s.slots[1]!.pid = null;
    await s.db.update(machines).set({ copyAt: ago(30_000) }).where(eq(machines.id, a.id));
    await s.db.update(machines).set({ copyAt: ago(900_000) }).where(eq(machines.id, b.id));
    expect(await copiesView(s.app.ctx, NOW)).toMatchObject({ leader: 'rack-01', onlySince: ago(30_000).toISOString() });
  });
});
