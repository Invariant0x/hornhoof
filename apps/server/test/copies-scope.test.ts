import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { decryptSecret } from '../src/crypto/secrets.js';
import { certificates, companies, departments, machines, peerSecrets, people, publicLinks } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { activeRecovery } from '../src/modules/backups/recovery.js';
import { rank } from '../src/modules/copies/order.js';
import { CUT_TRIES_MS, cutReplication, leaveData } from '../src/modules/copies/scope.js';
import type { CopySlot, Replication } from '../src/modules/copies/slots.js';
import { peerSecret, revokedSerials } from '../src/modules/network/store.js';
import { fakeRelay } from './fake-relay.js';
import { as, invitePerson, setUpCompany, testApp, until } from './helpers.js';

const MACHINE_ID = 'a1b2c3d4'.repeat(4);
const OWN = { remoteAddress: '127.0.0.1', headers: { 'x-hornhoof-via': 'keeper' } };
const D_ID = 'd0d0d0d0d0d0d0d0'.padEnd(32, '1');
const E_ID = 'e0e0e0e0e0e0e0e0'.padEnd(32, '1');
const W_ID = 'f0f0f0f0f0f0f0f0'.padEnd(32, '1');
const GIB = 2 ** 30;

/* The slots of the server's Postgres as a test sets them, and what was done to them, in order. */
function fakeReplication(seen: string[], during: () => Promise<void> = async () => undefined) {
  const state = { slots: [] as CopySlot[], stuck: false, standby: '' };
  const replication: Replication = {
    slots: async () => state.slots.map(slot => ({ ...slot })),
    end: async pid => {
      seen.push(`end ${pid}`);
      await during();
      if (!state.stuck) state.slots = state.slots.map(slot => (slot.pid === pid ? { ...slot, pid: null } : slot));
    },
    drop: async name => {
      const slot = state.slots.find(found => found.name === name);
      if (slot?.pid != null) throw new Error(`replication slot "${name}" is active`);
      seen.push(`drop ${name}`);
      state.slots = state.slots.filter(found => found.name !== name);
    },
    standby: async () => state.standby,
  };
  return { state, replication };
}

async function company() {
  const relay = await fakeRelay();
  const control = mkdtempSync(join(tmpdir(), 'hh-copies-scope-'));
  onTestFinished(() => rmSync(control, { recursive: true, force: true }));
  const { app, db, config } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: MACHINE_ID, RELAY_URL: relay.url, HORNHOOF_CONTROL_DIR: control });
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@acme.test', access: { whole: true } });
  const [p] = await db.select().from(people).where(eq(people.email, 'maria@acme.test'));
  const [department] = await db.insert(departments).values({ companyId: acme!.id, name: 'Marketing', roleCode: 'CMO' }).returning();
  const departmentId = department!.id;
  expect((await app.inject({ method: 'PUT', url: '/api/link', payload: { name: 'acme' }, ...as(ceo) })).statusCode).toBe(200);
  await app.inject({ method: 'POST', url: '/api/network/certificate', payload: { signKey: 'server-key' }, ...OWN });
  /* The peer services' secrets and the visitor key, as machines with the core hold them. */
  await peerSecret(db, config, 'app', true);
  await peerSecret(db, config, 'data', true);
  await db.insert(peerSecrets).values({ kind: 'visit', secretEnc: 'sealed' });
  let made = 0;
  const machine = async (personId: string, hostname: string, networkId: string, more: Partial<typeof machines.$inferInsert> = {}) => {
    made += 1;
    const values = {
      companyId: acme!.id, personId, machineKey: `joined-${made}`, hostname, networkId, role: 'worker' as const, signKey: `key-${made}`,
      reportAt: new Date(), memory: 8 * GIB, diskFree: 500 * GIB, fsyncP99Ms: 3, ...more,
    };
    const [row] = await db.insert(machines).values(values).returning();
    await db.insert(certificates).values({ serial: `c0ffee0${made}`, machineId: row!.id, until: new Date(Date.now() + 86_400_000) });
    return { ...row!, serial: `c0ffee0${made}` };
  };
  /* Maria's copy and her worker, and a copy of the CEO's. */
  const d = await machine(p!.id, 'maria-mac', D_ID, { role: 'data', serverOrder: 2, copyState: 'ready', copyName: `copy_${D_ID.slice(0, 16)}_1` });
  const w = await machine(p!.id, 'maria-laptop', W_ID);
  const e = await machine(owner!.id, 'dev-mac', E_ID, { role: 'data', serverOrder: 3, copyState: 'ready', copyName: `copy_${E_ID.slice(0, 16)}_1` });
  const seen: string[] = [];
  const rowOf = async (id: string) => (await db.select().from(machines).where(eq(machines.id, id)))[0]!;
  const linkRow = async () => (await db.select().from(publicLinks))[0]!;
  const keyOf = async () => decryptSecret((await linkRow()).keyEnc, config.secret);
  const secrets = async () => (await db.select(only(peerSecrets, 'kind')).from(peerSecrets)).map(row => row.kind).sort();
  const listed = { departments: [departmentId], teams: [] };
  const patch = (access: object = listed, id = p!.id) => app.inject({ method: 'PATCH', url: `/api/people/${id}`, payload: { access }, ...as(ceo) });
  const personOf = async (id = p!.id) => (await db.select().from(people).where(eq(people.id, id)))[0]!;
  const keyChanges = () => relay.calls.filter(call => call === 'POST /api/v1/links/acme/key').length;
  return { app, db, config, control, relay, ceo, maria, companyId: acme!.id, p: p!, owner: owner!, d, w, e, seen, rowOf, linkRow, keyOf, secrets, patch, personOf, keyChanges, listed };
}

const slotOf = (networkId: string, attempt = 1, pid: number | null = 4242): CopySlot => ({ name: `copy_${networkId.slice(0, 16)}_${attempt}`, pid, walStatus: 'reserved', confirmed: '0/3000000' });

describe("a machine whose owner no longer sees the whole company", () => {
  it('takes the data away at once', async () => {
    const c = await company();
    const { state, replication } = fakeReplication(c.seen);
    c.app.ctx.replication = replication;
    state.slots = [slotOf(D_ID), slotOf(E_ID, 1, 5151)];
    const before = await c.keyOf();
    await c.app.inject({ method: 'POST', url: '/api/backups/recovery', ...as(c.ceo) });
    expect(await activeRecovery(c.db, c.config)).not.toBeNull();

    expect((await c.patch()).statusCode).toBe(200);
    expect(await c.personOf()).toMatchObject({ scopeKind: 'listed' });
    const d = await c.rowOf(c.d.id);
    expect(d).toMatchObject({ serverOrder: null, role: 'worker', uploadState: 'waiting', revokedAt: null, networkId: D_ID });
    expect(d.dataLeftAt).toBeInstanceOf(Date);
    expect(await revokedSerials(c.db)).toEqual([c.d.serial]);
    /* What the machine knew of the link opens nothing: the peer services' secrets, the visitor key and the link's key. */
    await until(async () => (await c.linkRow()).nextKeyEnc === null && (await c.keyOf()) !== before);
    expect(c.keyChanges()).toBe(1);
    expect(c.relay.bindings.get('acme')!.key).toBe(await c.keyOf());
    expect(await c.keyOf()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await until(() => c.relay.calls.includes('POST /api/v1/links/acme/visitor-key'));
    expect((await c.secrets()).filter(kind => kind !== 'visit')).toEqual([]);
    /* The recovery file was saved with the key of before, so the CEO is asked to save it anew. */
    expect(await activeRecovery(c.db, c.config)).toBeNull();
  });

  it('cuts the copy before anything new is written', async () => {
    const c = await company();
    const at: { role: string | null; nextKeyEnc: string | null; scope: string }[] = [];
    const look = async () => void at.push({ role: (await c.rowOf(c.d.id)).role, nextKeyEnc: (await c.linkRow()).nextKeyEnc, scope: (await c.personOf()).scopeKind });
    const { state, replication } = fakeReplication(c.seen, look);
    c.app.ctx.replication = replication;
    state.slots = [slotOf(D_ID), slotOf(E_ID, 1, 5151)];
    expect((await c.patch()).statusCode).toBe(200);
    /* Its connection was ended and its slot dropped while nothing of the change was written yet. */
    expect(c.seen).toEqual(['end 4242', `drop copy_${D_ID.slice(0, 16)}_1`]);
    expect(at).toEqual([{ role: 'data', nextKeyEnc: null, scope: 'company' }]);
    expect(state.slots.map(slot => slot.name)).toEqual([`copy_${E_ID.slice(0, 16)}_1`]);
  });

  it('answers try again when the slot will not go', async () => {
    const c = await company();
    const { state, replication } = fakeReplication(c.seen);
    c.app.ctx.replication = replication;
    state.slots = [slotOf(D_ID)];
    state.stuck = true;
    const before = { key: await c.keyOf(), secrets: await c.secrets() };
    /* The time a cut is tried for is virtual: the test moves it by the whole of it once the first try was made. */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    onTestFinished(() => void vi.useRealTimers());
    const triedFor = async <T>(ms: number, cut: Promise<T>): Promise<T> => {
      const ends = c.seen.length;
      await until(() => c.seen.length > ends);
      await vi.advanceTimersByTimeAsync(ms);
      return cut;
    };
    await expect(triedFor(200, cutReplication(replication, [{ networkId: D_ID }], { triesMs: 200 }))).rejects.toMatchObject({ status: 503, reason: 'try_again', message: 'Try again in a minute.' });
    expect(CUT_TRIES_MS).toBe(5000);
    const res = await triedFor(CUT_TRIES_MS, c.patch());
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ reason: 'try_again' });
    expect(await c.personOf()).toMatchObject({ scopeKind: 'company' });
    expect(await c.rowOf(c.d.id)).toMatchObject({ serverOrder: 2, role: 'data', uploadState: null, dataLeftAt: null });
    expect({ key: await c.keyOf(), secrets: await c.secrets() }).toEqual(before);
    expect(await revokedSerials(c.db)).toEqual([]);
  });

  it('leaves the rest alone', async () => {
    const c = await company();
    c.app.ctx.replication = fakeReplication(c.seen).replication;
    const before = { w: await c.rowOf(c.w.id), e: await c.rowOf(c.e.id) };
    expect((await c.patch()).statusCode).toBe(200);
    expect(await c.rowOf(c.w.id)).toEqual(before.w);
    expect(await c.rowOf(c.e.id)).toMatchObject({ role: 'data', uploadState: null, dataLeftAt: null, copyName: before.e.copyName });
    const live = await c.db.select(only(certificates, 'serial')).from(certificates).where(and(isNull(certificates.revokedAt)));
    expect(live.map(row => row.serial)).toEqual(expect.arrayContaining([c.w.serial, c.e.serial]));
    /* A change that takes nobody's data away changes no key: one department for another, and a person with no copy. */
    const calls = c.keyChanges();
    expect((await c.patch()).statusCode).toBe(200);
    expect(c.keyChanges()).toBe(calls);
  });

  it('retires without changing keys', async () => {
    const c = await company();
    const before = { key: await c.keyOf(), secrets: await c.db.select().from(peerSecrets), calls: c.keyChanges() };
    /* The ranking handed Maria's copy to another machine; she still sees the whole company. */
    const now = new Date();
    await c.db.transaction(tx => leaveData(c.app.ctx, tx, [c.d.id], now, { lost: false }));
    expect(await c.rowOf(c.d.id)).toMatchObject({ role: 'worker', uploadState: 'waiting', dataLeftAt: null, serverOrder: 2, revokedAt: null });
    expect(await revokedSerials(c.db)).toEqual([c.d.serial]);
    expect((await c.linkRow()).nextKeyEnc).toBeNull();
    expect({ key: await c.keyOf(), secrets: await c.db.select().from(peerSecrets), calls: c.keyChanges() }).toEqual(before);
  });

  it('takes the data from a copy being retired', async () => {
    const c = await company();
    c.app.ctx.replication = fakeReplication(c.seen).replication;
    /* The ranking handed Maria's copy on: a worker's row that still holds the secrets and owes its database. */
    await c.db.transaction(tx => leaveData(c.app.ctx, tx, [c.d.id], new Date(), { lost: false }));
    const before = await c.keyOf();
    expect((await c.patch()).statusCode).toBe(200);
    const d = await c.rowOf(c.d.id);
    expect(d).toMatchObject({ role: 'worker', uploadState: 'waiting', serverOrder: null });
    expect(d.dataLeftAt).toBeInstanceOf(Date);
    await until(async () => (await c.linkRow()).nextKeyEnc === null && (await c.keyOf()) !== before);
    expect(c.keyChanges()).toBe(1);
    expect((await c.secrets()).filter(kind => kind !== 'visit')).toEqual([]);
    /* What the leader already took from it is not asked for again. */
    expect((await c.patch({ whole: true })).statusCode).toBe(200);
    await c.db.update(machines).set({ uploadState: 'kept', dataLeftAt: null }).where(eq(machines.id, c.d.id));
    expect((await c.patch()).statusCode).toBe(200);
    const kept = await c.rowOf(c.d.id);
    expect(kept).toMatchObject({ role: 'worker', uploadState: 'kept' });
    expect(kept.dataLeftAt).toBeInstanceOf(Date);
    await until(() => c.keyChanges() === 2);
  });

  it('changes the link key when a retiring machine is disconnected', async () => {
    const c = await company();
    c.app.ctx.replication = fakeReplication(c.seen).replication;
    await c.db.transaction(tx => leaveData(c.app.ctx, tx, [c.d.id], new Date(), { lost: false }));
    const before = await c.keyOf();
    expect((await c.app.inject({ method: 'POST', url: `/api/machines/${c.d.id}/disconnect`, ...as(c.ceo) })).statusCode).toBe(204);
    const d = await c.rowOf(c.d.id);
    expect([d.revokedAt, d.dataLeftAt].map(at => at instanceof Date)).toEqual([true, true]);
    await until(async () => (await c.linkRow()).nextKeyEnc === null && (await c.keyOf()) !== before);
    expect(c.keyChanges()).toBe(1);
  });

  it('scores the order after a lost scope', async () => {
    const c = await company();
    c.app.ctx.replication = fakeReplication(c.seen).replication;
    const asked: object[] = [];
    c.app.ctx.ranking.now = async (opts = {}) => void asked.push(opts);
    expect((await c.patch()).statusCode).toBe(200);
    await until(() => asked.length > 0);
    expect(asked).toEqual([{ rescore: true }]);
  });

  it("refuses to take the server's scope", async () => {
    const c = await company();
    const { state, replication } = fakeReplication(c.seen);
    c.app.ctx.replication = replication;
    state.slots = [slotOf(D_ID)];
    /* The machine the app itself runs on is Maria's now. */
    await c.db.update(machines).set({ networkId: null }).where(eq(machines.networkId, MACHINE_ID));
    await c.db.update(machines).set({ networkId: MACHINE_ID, serverOrder: null }).where(eq(machines.id, c.d.id));
    const before = { key: await c.keyOf(), secrets: await c.secrets() };
    const res = await c.patch();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ reason: 'leader_scope', message: 'maria-mac runs the company server. Move the server to another machine first.' });
    expect(c.seen).toEqual([]);
    expect(await c.personOf()).toMatchObject({ scopeKind: 'company' });
    expect(await c.rowOf(c.d.id)).toMatchObject({ role: 'data', uploadState: null, dataLeftAt: null });
    expect({ key: await c.keyOf(), secrets: await c.secrets() }).toEqual(before);
  });

  it('finishes a key change after a lost answer', async () => {
    const c = await company();
    c.app.ctx.replication = fakeReplication(c.seen).replication;
    c.app.ctx.ranking.stop();
    const before = await c.keyOf();
    c.relay.loseAnswer = true;
    expect((await c.patch()).statusCode).toBe(200);
    /* The relay holds the new key, and this server still the old one with the new one beside it. */
    await until(() => c.keyChanges() === 1 && !c.relay.loseAnswer);
    const waiting = await c.linkRow();
    expect(waiting.nextKeyEnc).not.toBeNull();
    expect(await c.keyOf()).toBe(before);
    expect(c.relay.bindings.get('acme')!.key).toBe(decryptSecret(waiting.nextKeyEnc!, c.config.secret));
    await rank(c.app.ctx);
    expect((await c.linkRow()).nextKeyEnc).toBeNull();
    expect(await c.keyOf()).toBe(c.relay.bindings.get('acme')!.key);
    expect(c.keyChanges()).toBe(1);
  });

  it('asks again after the relay was down', async () => {
    const c = await company();
    c.app.ctx.replication = fakeReplication(c.seen).replication;
    c.app.ctx.ranking.stop();
    const before = await c.keyOf();
    c.relay.down = true;
    expect((await c.patch()).statusCode).toBe(200);
    await until(() => c.relay.calls.some(call => call.startsWith('GET /api/v1/links/acme/route')));
    await rank(c.app.ctx);
    expect((await c.linkRow()).nextKeyEnc).not.toBeNull();
    expect(c.relay.bindings.get('acme')!.key).toBe(before);
    c.relay.down = false;
    await rank(c.app.ctx);
    expect((await c.linkRow()).nextKeyEnc).toBeNull();
    expect(c.relay.bindings.get('acme')!.key).toBe(await c.keyOf());
    expect(await c.keyOf()).not.toBe(before);
  });

  it('takes the data from a row a restore brought back', async () => {
    const c = await company();
    const { state, replication } = fakeReplication(c.seen);
    c.app.ctx.replication = replication;
    c.app.ctx.ranking.stop();
    state.slots = [slotOf(D_ID)];
    const before = await c.keyOf();
    /* The person is listed, and their machine holds the data all the same. */
    await c.db.update(people).set({ scopeKind: 'listed' }).where(eq(people.id, c.p.id));
    await rank(c.app.ctx);
    expect(c.seen).toEqual(['end 4242', `drop copy_${D_ID.slice(0, 16)}_1`]);
    expect(await c.rowOf(c.d.id)).toMatchObject({ serverOrder: null, role: 'worker', uploadState: 'waiting' });
    expect(await revokedSerials(c.db)).toEqual([c.d.serial]);
    expect(await c.keyOf()).not.toBe(before);
    expect(await c.rowOf(c.e.id)).toMatchObject({ serverOrder: 2, role: 'data', uploadState: null });
  });

  it('changes the link key when a data machine is disconnected', async () => {
    const c = await company();
    const { state, replication } = fakeReplication(c.seen);
    c.app.ctx.replication = replication;
    state.slots = [slotOf(D_ID), slotOf(E_ID, 1, 5151)];
    const disconnect = (id: string) => c.app.inject({ method: 'POST', url: `/api/machines/${id}/disconnect`, ...as(c.ceo) });
    /* A worker goes as before: no slot, and the link keeps its key. */
    const before = await c.keyOf();
    expect((await disconnect(c.w.id)).statusCode).toBe(204);
    expect(c.seen).toEqual([]);
    expect((await c.linkRow()).nextKeyEnc).toBeNull();
    expect(c.keyChanges()).toBe(0);
    /* A copy is cut first, and leaves holding no key of the link. */
    expect((await disconnect(c.e.id)).statusCode).toBe(204);
    expect(c.seen).toEqual(['end 5151', `drop copy_${E_ID.slice(0, 16)}_1`]);
    const e = await c.rowOf(c.e.id);
    expect(e.revokedAt).toBeInstanceOf(Date);
    expect(e.dataLeftAt).toBeInstanceOf(Date);
    expect(e).toMatchObject({ serverOrder: null, uploadState: null });
    await until(async () => (await c.linkRow()).nextKeyEnc === null && (await c.keyOf()) !== before);
    expect(c.keyChanges()).toBe(1);
  });

  it("cuts a disabled person's copy as a Disconnect does", async () => {
    const c = await company();
    const { state, replication } = fakeReplication(c.seen);
    c.app.ctx.replication = replication;
    state.slots = [slotOf(D_ID)];
    const before = await c.keyOf();
    expect((await c.app.inject({ method: 'PATCH', url: `/api/people/${c.p.id}`, payload: { status: 'disabled' }, ...as(c.ceo) })).statusCode).toBe(200);
    expect(c.seen).toEqual(['end 4242', `drop copy_${D_ID.slice(0, 16)}_1`]);
    for (const id of [c.d.id, c.w.id]) expect((await c.rowOf(id)).revokedAt).toBeInstanceOf(Date);
    expect((await c.rowOf(c.d.id)).dataLeftAt).toBeInstanceOf(Date);
    await until(async () => (await c.linkRow()).nextKeyEnc === null && (await c.keyOf()) !== before);
  });

  it('hides the name when the public link goes while copies need it', async () => {
    const c = await company();
    c.app.ctx.replication = fakeReplication(c.seen).replication;
    const remove = () => c.app.inject({ method: 'DELETE', url: '/api/link', ...as(c.ceo) });
    const shown = async () => (await c.app.inject({ url: '/api/link', ...as(c.ceo) })).json().link as { name: string } | null;
    expect(await shown()).toMatchObject({ name: 'acme' });
    expect((await remove()).statusCode).toBe(204);
    /* The public name is let go, and a name of the relay's own choosing takes its place for the machines alone. */
    const hidden = await c.linkRow();
    expect(hidden).toMatchObject({ hidden: true });
    expect(hidden.name).not.toBe('acme');
    expect([c.relay.bindings.has('acme'), c.relay.bindings.has(hidden.name)]).toEqual([false, true]);
    /* To people there is no link, and Settings offers to turn one on; the tunnel's settings say whose name it is. */
    expect(await shown()).toBeNull();
    expect(JSON.parse(readFileSync(join(c.control, 'tunnel.json'), 'utf8'))).toMatchObject({ name: hidden.name, hidden: true });
    /* Removed again, it stays: the copies still need it. */
    expect((await remove()).statusCode).toBe(204);
    expect(await c.linkRow()).toMatchObject({ name: hidden.name, hidden: true });
    /* A public link turned on over it replaces it, as any rename does. */
    expect((await c.app.inject({ method: 'PUT', url: '/api/link', payload: { name: 'acme' }, ...as(c.ceo) })).statusCode).toBe(200);
    expect(await c.linkRow()).toMatchObject({ name: 'acme', hidden: false });
    expect([c.relay.bindings.has('acme'), c.relay.bindings.has(hidden.name)]).toEqual([true, false]);
    expect(await shown()).toMatchObject({ name: 'acme' });
    /* With no other machine holding the data it goes as before. */
    await c.db.update(machines).set({ role: 'worker' }).where(eq(machines.role, 'data')).catch(() => undefined);
    await c.db.update(machines).set({ role: 'data' }).where(eq(machines.networkId, MACHINE_ID));
    expect((await remove()).statusCode).toBe(204);
    expect(c.relay.bindings.has('acme')).toBe(false);
    expect(await c.db.select().from(publicLinks)).toEqual([]);
  });
});
