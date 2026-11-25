import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, machines, people, publicLinks } from '../src/db/schema.js';
import { noteGaveUp } from '../src/modules/copies/measured.js';
import { setPriority } from '../src/modules/copies/priority.js';
import { copyRetryTaken } from '../src/modules/copies/retry.js';
import { copyOrder } from '../src/modules/copies/slots.js';
import { writeKeeperState } from '../src/modules/keeper/state.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';

const GIB = 2 ** 30;
/* The key of the computer the server runs on, and the id its keeper runs under: the hash of that key. */
const HOST_KEY = 'host-0000-abcd';
const MACHINE_ID = hashToken(`hornhoof-host:${HOST_KEY}`);
const OWN = { remoteAddress: '127.0.0.1', headers: { 'x-hornhoof-via': 'keeper' } };
const newKey = (): string => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
const day = (n: number): Date => new Date(Date.UTC(2026, 10, n));

/* The company's server leading, with its own row L, and the CEO's fit machines A, B and C, ranked 2, 3 and 4. */
async function company() {
  const control = mkdtempSync(join(tmpdir(), 'hh-priority-'));
  onTestFinished(() => rmSync(control, { recursive: true, force: true }));
  const { app, db, config } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: MACHINE_ID, HORNHOOF_CONTROL_DIR: control });
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  await app.inject({ method: 'POST', url: '/api/network/certificate', payload: { signKey: newKey() }, ...OWN });
  await db.insert(publicLinks).values({ companyId: acme!.id, name: 'acme', url: 'https://acme.hornhoof.test', keyEnc: 'k', tunnelEnc: 't' });
  let made = 0;
  const joined = async (hostname: string, more: Partial<typeof machines.$inferInsert> = {}) => {
    made += 1;
    const values = {
      companyId: acme!.id, personId: owner!.id, machineKey: `joined-${made}`, hostname, role: 'worker' as const, networkId: `${made}`.repeat(32), createdAt: day(made),
      reportAt: new Date(), memory: 8 * GIB, diskFree: 500 * GIB, fsyncP99Ms: 3, ...more,
    };
    return (await db.insert(machines).values(values).returning())[0]!;
  };
  const [a, b, c] = [await joined('a'), await joined('b'), await joined('c')];
  const put = (id: string, payload: object, who: object = as(ceo)) => app.inject({ method: 'PUT', url: `/api/machines/${id}/priority`, payload, ...who });
  const rowOf = async (id: string) => (await db.select().from(machines).where(eq(machines.id, id)))[0]!;
  const placeOf = async (id: string) => {
    const row = await rowOf(id);
    return [row.serverOrder, row.serverWhy, row.serverPin];
  };
  const scoredAt = async () => {
    const [row] = (await db.execute(sql`SELECT rescored_at AS at FROM net.ranking`) as unknown as { rows: { at: string }[] }).rows;
    return row ? new Date(row.at).getTime() : null;
  };
  const leader = (await db.select().from(machines).where(eq(machines.networkId, MACHINE_ID)))[0]!;
  /* The first ranking, as the app runs it once it leads. */
  await app.ctx.ranking.now({ rescore: true });
  const refusal = (res: { statusCode: number; json(): unknown }) => {
    const { error } = res.json() as { error: { code: string; reason?: string; message: string } };
    return [res.statusCode, error.reason ?? error.code, error.message];
  };
  return { app, db, config, ctx: app.ctx, control, ceo, owner: owner!, leader, a: a!, b: b!, c: c!, joined, put, rowOf, placeOf, scoredAt, refusal };
}

describe("the CEO's choice of a machine's place", () => {
  it('pins a place', async () => {
    const c = await company();
    expect([await c.placeOf(c.a.id), await c.placeOf(c.b.id), await c.placeOf(c.c.id)]).toEqual([[2, expect.any(String), null], [3, expect.any(String), null], [4, 'next', null]]);
    const before = await c.scoredAt();
    const res = await c.put(c.b.id, { pin: 2 });
    expect([res.statusCode, res.body]).toEqual([204, '']);
    expect([await c.placeOf(c.b.id), (await c.placeOf(c.a.id))[0]]).toEqual([[2, 'pinned', '2'], 3]);
    expect(await c.scoredAt()).toBeGreaterThan(before!);
  });

  it('takes the place from another pin', async () => {
    const c = await company();
    expect((await c.put(c.a.id, { pin: 2 })).statusCode).toBe(204);
    expect((await c.put(c.b.id, { pin: 2 })).statusCode).toBe(204);
    expect((await c.placeOf(c.a.id))[2]).toBeNull();
    expect(await c.placeOf(c.b.id)).toEqual([2, 'pinned', '2']);
  });

  it('unpins', async () => {
    const c = await company();
    expect((await c.put(c.b.id, { pin: 2 })).statusCode).toBe(204);
    const before = await c.scoredAt();
    expect((await c.put(c.b.id, { pin: null })).statusCode).toBe(204);
    expect((await c.placeOf(c.b.id))[2]).toBeNull();
    expect((await c.placeOf(c.b.id))[1]).not.toBe('pinned');
    expect(await c.scoredAt()).toBeGreaterThan(before!);
  });

  it('keeps a machine out', async () => {
    const c = await company();
    expect((await c.put(c.c.id, { pin: 'none' })).statusCode).toBe(204);
    expect(await c.placeOf(c.c.id)).toEqual([null, 'out', 'none']);
    /* Coming back, it may take the last place, which is there again once it counts. */
    expect((await c.put(c.c.id, { pin: 4 })).statusCode).toBe(204);
    expect(await c.placeOf(c.c.id)).toEqual([4, 'pinned', '4']);
  });

  it("refuses a pin on the server's machine", async () => {
    const c = await company();
    /* The computer the server runs on, as its owner joined it: the card the Machines tab marks as the server. */
    const host = await c.joined('server-box', { machineKey: HOST_KEY, networkId: null, role: null });
    for (const pin of [2, 'none', null] as const) {
      expect(c.refusal(await c.put(host.id, { pin }))).toEqual([409, 'leader_pin', 'Move the server to another machine first.']);
      await expect(setPriority(c.ctx, c.leader.id, pin)).rejects.toMatchObject({ status: 409, reason: 'leader_pin' });
    }
    expect([(await c.rowOf(host.id)).serverPin, (await c.rowOf(c.leader.id)).serverPin]).toEqual([null, null]);
    /* The server's own row is no machine people act on. */
    expect(c.refusal(await c.put(c.leader.id, { pin: 2 })).slice(0, 2)).toEqual([404, 'machine_unknown']);
  });

  it('refuses the only up-to-date copy', async () => {
    const c = await company();
    const copy = (n: string) => `copy_${n.repeat(16)}_1`;
    await c.db.update(machines).set({ role: 'data', copyName: copy('1'), copyState: 'ready' }).where(eq(machines.id, c.a.id));
    await c.db.update(machines).set({ role: 'data', copyName: copy('2'), copyState: 'ready' }).where(eq(machines.id, c.b.id));
    const said = (name: string, b: 'pace' | 'behind') => writeKeeperState(c.control, { mode: 'lead', at: new Date().toISOString(), link: null, copies: [{ name: copy('1'), state: 'sync' }, { name, state: b }] });
    said(copy('2'), 'behind');
    expect(c.refusal(await c.put(c.a.id, { pin: 'none' }))).toEqual([409, 'only_copy', 'a holds the only up-to-date copy; give another machine a place first.']);
    expect((await c.rowOf(c.a.id)).serverPin).toBeNull();
    /* A copy that is behind may be kept out while another is up to date. Its seat remains occupied until its wipe. */
    expect((await c.put(c.b.id, { pin: 'none' })).statusCode).toBe(204);
    expect(await c.rowOf(c.b.id)).toMatchObject({ role: 'worker', uploadState: 'waiting' });
    expect((await c.rowOf(c.c.id)).role).toBe('worker');
    expect(c.refusal(await c.put(c.a.id, { pin: 'none' }))[1]).toBe('only_copy');
    expect((await c.app.inject({
      method: 'POST', url: '/api/network/report', payload: { wiped: true }, remoteAddress: '127.0.0.1',
      headers: { 'x-hornhoof-via': c.b.id, 'x-hornhoof-keeper': '1' },
    })).statusCode).toBe(204);
    await c.ctx.ranking.now();
    expect(await c.rowOf(c.c.id)).toMatchObject({ role: 'data', uploadState: null });
    await c.db.update(machines).set({ copyName: copy('3'), copyState: 'ready' }).where(eq(machines.id, c.c.id));
    said(copy('3'), 'pace');
    expect((await c.put(c.a.id, { pin: 'none' })).statusCode).toBe(204);
    expect((await c.rowOf(c.a.id)).serverPin).toBe('none');
  });

  it('refuses a place it cannot take', async () => {
    const c = await company();
    for (const payload of [{ pin: 1 }, { pin: 5 }, { pin: 2.5 }, { pin: 'x' }, {}]) {
      const res = await c.put(c.b.id, payload);
      expect([res.statusCode, (res.json() as { error: { code: string } }).error.code], JSON.stringify(payload)).toEqual([400, 'validation']);
    }
    expect((await c.rowOf(c.b.id)).serverPin).toBeNull();
    const phone = await c.joined('phone', { kind: 'phone', networkId: null, role: null });
    expect(c.refusal(await c.put(phone.id, { pin: 2 }))).toEqual([400, 'unfit', 'This machine cannot take the server.']);
    /* It may still be kept out, which changes nothing for it. */
    expect((await c.put(phone.id, { pin: 'none' })).statusCode).toBe(204);
  });

  it('answers the CEO alone, by himself or through the orchestrator', async () => {
    const c = await company();
    const p = await invitePerson(c.app, c.ceo, { name: 'Pat', email: 'pat@acme.test', access: { whole: true } });
    expect(c.refusal(await c.put(c.b.id, { pin: 2 }, as(p))).slice(0, 2)).toEqual([403, 'not_owner_session']);
    expect((await c.rowOf(c.b.id)).serverPin).toBeNull();
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    expect((await c.put(c.b.id, { pin: 2 }, { headers: orchestratorHeaders(c.owner.id, orchestrator!.id) })).statusCode).toBe(204);
    expect((await c.rowOf(c.b.id)).serverPin).toBe('2');
  });

  it('answers try again when the ranking fails', async () => {
    const c = await company();
    const now = c.ctx.ranking.now.bind(c.ctx.ranking);
    let failed = false;
    c.ctx.ranking.now = opts => (failed ? now(opts) : ((failed = true), Promise.reject(new Error('the database is away'))));
    expect(c.refusal(await c.put(c.b.id, { pin: 2 }))).toEqual([503, 'try_again', 'Try again in a minute.']);
    /* The pin is stored, and the next run places it. */
    expect(await c.placeOf(c.b.id)).toEqual([3, expect.any(String), '2']);
    await c.ctx.ranking.now();
    expect(await c.placeOf(c.b.id)).toEqual([2, 'pinned', '2']);
  });
});

describe('a copy whose keeper gave it up', () => {
  const retry = (c: Awaited<ReturnType<typeof company>>, id: string, who: object = as(c.ceo)) => c.app.inject({ method: 'POST', url: `/api/machines/${id}/copy/retry`, ...who });
  const GAVE_UP = { since: '2026-11-24T20:00:00.000Z', attempts: 4, why: 'failed' as const };

  it('is asked for again by the CEO alone, for a copy that was given up alone, and the keeper is told until it makes one', async () => {
    const c = await company();
    /* Nothing was given up: nothing to ask for. */
    expect(c.refusal(await retry(c, c.b.id))).toEqual([409, 'copy_not_given_up', "This machine's copy was not given up."]);
    noteGaveUp(c.ctx, c.b.id, GAVE_UP);
    const p = await invitePerson(c.app, c.ceo, { name: 'Pat', email: 'pat@acme.test', access: { whole: true } });
    expect(c.refusal(await retry(c, c.b.id, as(p))).slice(0, 2)).toEqual([403, 'not_owner_session']);
    expect(await copyOrder(c.ctx, await c.rowOf(c.b.id))).not.toHaveProperty('retry');
    expect((await retry(c, c.b.id)).statusCode).toBe(204);
    expect(await copyOrder(c.ctx, await c.rowOf(c.b.id))).toMatchObject({ retry: true });
    /* Another machine's copy is not asked for. */
    expect(await copyOrder(c.ctx, await c.rowOf(c.a.id))).not.toHaveProperty('retry');
    /* The keeper still says it gave the copy up: the word stands. Once it makes one, it does not. */
    copyRetryTaken(c.ctx, 'another-machine');
    expect(await copyOrder(c.ctx, await c.rowOf(c.b.id))).toMatchObject({ retry: true });
    copyRetryTaken(c.ctx, c.b.id);
    expect(await copyOrder(c.ctx, await c.rowOf(c.b.id))).not.toHaveProperty('retry');
    /* The orchestrator acts for the CEO. */
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    expect((await retry(c, c.b.id, { headers: orchestratorHeaders(c.owner.id, orchestrator!.id) })).statusCode).toBe(204);
    expect(c.refusal(await retry(c, '00000000-0000-4000-8000-000000000000')).slice(0, 2)).toEqual([404, 'machine_unknown']);
  });

  it('is told of a path measured too weak for a copy that is not whole, and of none else', async () => {
    const c = await company();
    const weak = { linkMbps: 1, linkRttMs: 40 };
    expect(await copyOrder(c.ctx, { ...(await c.rowOf(c.b.id)), ...weak, copyState: 'making' })).toMatchObject({ weak: 'slow' });
    expect(await copyOrder(c.ctx, { ...(await c.rowOf(c.b.id)), linkMbps: 100, linkRttMs: 4000, copyState: 'remaking' })).toMatchObject({ weak: 'late' });
    expect(await copyOrder(c.ctx, { ...(await c.rowOf(c.b.id)), ...weak, copyState: null })).toMatchObject({ weak: 'slow' });
    /* A copy that is whole keeps its path; a path nothing was measured on, or a good one, is none. */
    expect(await copyOrder(c.ctx, { ...(await c.rowOf(c.b.id)), ...weak, copyState: 'ready' })).not.toHaveProperty('weak');
    expect(await copyOrder(c.ctx, { ...(await c.rowOf(c.b.id)), linkMbps: null, linkRttMs: null, copyState: 'making' })).not.toHaveProperty('weak');
    expect(await copyOrder(c.ctx, { ...(await c.rowOf(c.b.id)), linkMbps: 50, linkRttMs: 30, copyState: 'making' })).not.toHaveProperty('weak');
  });

  it('gives no data to a machine whose path is measured too weak for a copy, and keeps its place', async () => {
    const c = await company();
    const roles = async () => [(await c.rowOf(c.a.id)).role, (await c.rowOf(c.b.id)).role, (await c.rowOf(c.c.id)).role];
    expect(await roles()).toEqual(['data', 'data', 'worker']);
    /* A gave its data up and is measured at 1 Mbps: its seat goes to the next machine, and it keeps a place in the order. */
    await c.db.update(machines).set({ role: 'worker', linkMbps: 1 }).where(eq(machines.id, c.a.id));
    await c.app.ctx.ranking.now({ rescore: true });
    expect(await roles()).toEqual(['worker', 'data', 'data']);
    expect((await c.rowOf(c.a.id)).serverOrder).not.toBeNull();
    /* With nothing measured on its path it is tried: a machine without that measure is given the data as before. */
    await c.db.update(machines).set({ role: 'worker', linkMbps: null, linkRttMs: null }).where(eq(machines.id, c.c.id));
    await c.app.ctx.ranking.now({ rescore: true });
    expect((await c.rowOf(c.c.id)).role).toBe('data');
  });
});
