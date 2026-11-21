import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, machines, people, publicLinks } from '../src/db/schema.js';
import { claimMove, moveTarget } from '../src/modules/copies/move.js';
import type { Sql } from '../src/modules/keeper/lease-store.js';
import { writeKeeperState } from '../src/modules/keeper/state.js';
import { queryOf } from '../src/modules/merge/leader.js';
import { as, invitePerson, setUpCompany, testApp, until } from './helpers.js';

const GIB = 2 ** 30;
/* The key of the computer the server runs on, and the id its keeper runs under: the hash of that key. */
const HOST_KEY = 'host-0000-abcd';
const MACHINE_ID = hashToken(`hornhoof-host:${HOST_KEY}`);
const OWN = { remoteAddress: '127.0.0.1', headers: { 'x-hornhoof-via': 'keeper' } };
const newKey = (): string => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
const day = (n: number): Date => new Date(Date.UTC(2026, 10, n));

type Move = { request: string; machine_id: string; from_machine_id: string; asked_by: string; state: string; reason: string | null };

/* The company's server leading, with its own row L, the copies A (2) and B (3), a fit machine D at 4 that holds no
   copy, and a machine U that has no number. */
async function company(env: NodeJS.ProcessEnv = {}) {
  const control = env.HORNHOOF_CONTROL_DIR ?? mkdtempSync(join(tmpdir(), 'hh-move-'));
  onTestFinished(() => rmSync(control, { recursive: true, force: true }));
  const { app, db, config } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: MACHINE_ID, HORNHOOF_CONTROL_DIR: control, ...env });
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
  const [a, b, d] = [await joined('a'), await joined('b'), await joined('d')];
  const u = await joined('u', { kind: 'phone', networkId: null, role: null });
  const leader = (await db.update(machines).set({ hostname: 'rack' }).where(eq(machines.networkId, MACHINE_ID)).returning())[0]!;
  /* The first ranking, as the app runs it once it leads: A and B get the two copies. */
  await app.ctx.ranking.now({ rescore: true });
  const rowOf = async (id: string) => (await db.select().from(machines).where(eq(machines.id, id)))[0]!;
  const moves = async () => (await db.execute(sql`SELECT request::text, machine_id::text, from_machine_id::text, asked_by::text, state, reason FROM net.move`) as unknown as { rows: Move[] }).rows;
  const post = (id: string, who: object = as(ceo)) => app.inject({ method: 'POST', url: `/api/machines/${id}/move`, ...who });
  const cancel = (id: string, who: object = as(ceo)) => app.inject({ method: 'DELETE', url: `/api/machines/${id}/move`, ...who });
  const listed = async (who: object = as(ceo)) => (await app.inject({ url: '/api/machines', ...who })).json() as { move: unknown; canMove: boolean };
  const refusal = (res: { statusCode: number; json(): unknown }) => {
    const { error } = res.json() as { error: { code: string; reason?: string; message: string } };
    return [res.statusCode, error.reason ?? error.code, error.message];
  };
  /* The keeper's own session, as far as these functions ask it. */
  const keeper: Sql = { query: async <R>(text: string, params?: unknown[]) => ({ rows: await queryOf(db)<R>(text, params) }) };
  return { app, db, config, ctx: app.ctx, control, ceo, owner: owner!, leader, a: a!, b: b!, d: d!, u, joined, rowOf, moves, post, cancel, listed, refusal, keeper };
}

describe("the CEO's request to move the server", () => {
  it('asks for a move and waits for a replica seat when both are occupied', async () => {
    const c = await company();
    expect([(await c.rowOf(c.a.id)).role, (await c.rowOf(c.b.id)).role, (await c.rowOf(c.d.id)).role]).toEqual(['data', 'data', 'worker']);
    expect([(await c.rowOf(c.d.id)).serverOrder, (await c.listed()).move]).toEqual([4, null]);
    const ranked: unknown[] = [];
    const now = c.ctx.ranking.now.bind(c.ctx.ranking);
    c.ctx.ranking.now = opts => (ranked.push(opts), now(opts));
    const res = await c.post(c.d.id);
    expect([res.statusCode, res.json()]).toEqual([202, { state: 'preparing' }]);
    expect(await c.moves()).toEqual([{ request: expect.any(String) as string, machine_id: c.d.id, from_machine_id: c.leader.id, asked_by: c.owner.id, state: 'preparing', reason: null }]);
    /* A request never gives the target a third replica. */
    expect([(await c.rowOf(c.a.id)).role, (await c.rowOf(c.b.id)).role, (await c.rowOf(c.d.id)).role]).toEqual(['data', 'data', 'worker']);
    expect(ranked).toEqual([{ rescore: false }]);
    expect((await c.listed()).move).toEqual({ machine: c.d.id, state: 'preparing', reason: null, leader: 'rack', progress: null });
    /* One remaining copy is ready, so the ranking can retire the other. */
    const name = 'copy_1111111111111111_1';
    await c.db.update(machines).set({ copyName: name, copyState: 'making' }).where(eq(machines.id, c.a.id));
    writeKeeperState(c.control, { mode: 'lead', at: new Date().toISOString(), link: null, copies: [{ name, state: 'pace' }] });
    await c.ctx.ranking.now();
    expect((await c.rowOf(c.b.id)).role).toBe('data');

    await c.db.update(machines).set({ copyState: 'ready' }).where(eq(machines.id, c.a.id));
    await c.ctx.ranking.now();
    expect(await c.rowOf(c.b.id)).toMatchObject({ role: 'worker', uploadState: 'waiting' });
    await c.ctx.ranking.now();
    expect(await c.rowOf(c.d.id)).toMatchObject({ role: 'worker' });
    await c.db.update(machines).set({ uploadState: null }).where(eq(machines.id, c.b.id));
    await c.ctx.ranking.now();
    expect(await c.rowOf(c.d.id)).toMatchObject({ role: 'data' });
    /* While its copy is being made, how far it is. */
    await c.db.update(machines).set({ copyState: 'making', copyProgress: 40 }).where(eq(machines.id, c.d.id));
    expect((await c.listed()).move).toMatchObject({ progress: 40 });
    await c.db.update(machines).set({ copyState: 'ready', copyProgress: null }).where(eq(machines.id, c.d.id));
    expect((await c.listed()).move).toMatchObject({ progress: null });
    /* The keeper reads the target by its network id, and the later rankings leave its copy alone. */
    expect(await moveTarget(c.keeper)).toBe(c.d.networkId);
    await c.ctx.ranking.now({ rescore: true });
    expect((await c.rowOf(c.d.id)).role).toBe('data');
  });

  it('refuses what cannot move', async () => {
    const c = await company();
    /* The computer the server runs on, as its owner joined it: the card the Machines tab marks as the server. */
    const host = await c.joined('server-box', { machineKey: HOST_KEY, networkId: null, role: null });
    expect(c.refusal(await c.post(host.id))).toEqual([409, 'already_leader', 'server-box runs the company server already.']);
    expect(c.refusal(await c.post(c.u.id))).toEqual([409, 'no_number', 'u cannot take the server now.']);
    writeFileSync(join(c.control, 'status.json'), JSON.stringify({ id: 'x', state: 'running', step: 'pull' }));
    expect(c.refusal(await c.post(c.d.id))).toEqual([409, 'updating', 'Hornhoof is updating. Move the server once the update ended.']);
    rmSync(join(c.control, 'status.json'));
    expect(await c.moves()).toEqual([]);

    expect((await c.post(c.d.id)).statusCode).toBe(202);
    await c.db.execute(sql`UPDATE net.move SET state = 'switching'`);
    const moving = await c.post(c.a.id);
    expect(c.refusal(moving)).toEqual([409, 'switching', 'The server is moving to d now.']);
    /* The machine is named apart from the words, for a screen that says them in another language. */
    expect((moving.json() as { error: { details: unknown } }).error.details).toEqual({ host: 'd' });
    expect(await c.moves()).toMatchObject([{ machine_id: c.d.id, state: 'switching' }]);

    /* The CEO alone, by himself or through the orchestrator. */
    const p = await invitePerson(c.app, c.ceo, { name: 'Pat', email: 'pat@acme.test', access: { whole: true } });
    expect(c.refusal(await c.post(c.a.id, as(p))).slice(0, 2)).toEqual([403, 'not_owner_session']);
    expect(c.refusal(await c.cancel(c.d.id, as(p))).slice(0, 2)).toEqual([403, 'not_owner_session']);
    const [orchestrator] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const inside = { headers: orchestratorHeaders(c.owner.id, orchestrator!.id) };
    expect(c.refusal(await c.post(c.a.id, inside))).toEqual(c.refusal(moving));
    expect(c.refusal(await c.cancel(c.d.id, inside))).toEqual(c.refusal(await c.cancel(c.d.id)));
    expect((await c.post(c.leader.id)).statusCode).toBe(404);
    expect((await c.post('7c9e6679-7425-40de-944b-e07fc1f90ae7')).statusCode).toBe(404);
  });

  it('refuses the machine that leads as a joined computer', async () => {
    /* As after a switch: the machine this app runs on is a computer its owner joined. */
    const c = await company();
    await c.db.update(machines).set({ machineKey: 'joined-leader' }).where(eq(machines.id, c.leader.id));
    expect(c.refusal(await c.post(c.leader.id))).toEqual([409, 'already_leader', 'rack runs the company server already.']);
  });

  it('answers 503 outside the lead', async () => {
    const control = mkdtempSync(join(tmpdir(), 'hh-move-'));
    writeKeeperState(control, { mode: 'lead', at: new Date().toISOString(), link: null });
    const c = await company({ HORNHOOF_KEEPER: 'on', HORNHOOF_CONTROL_DIR: control });
    await c.app.ready();
    await until(() => c.ctx.mode.current() === 'lead');
    writeKeeperState(control, { mode: 'read', at: new Date().toISOString(), link: null });
    await c.ctx.mode.check();
    expect((await c.post(c.d.id)).statusCode).toBe(503);
    expect((await c.cancel(c.d.id)).statusCode).toBe(503);
    expect((await c.listed()).canMove).toBe(false);
  });

  it('replaces and cancels a request', async () => {
    const c = await company();
    expect((await c.post(c.d.id)).statusCode).toBe(202);
    const [first] = await c.moves();
    expect((await c.post(c.a.id)).statusCode).toBe(202);
    const [second, ...more] = await c.moves();
    expect([second!.machine_id, second!.state, more, second!.request === first!.request]).toEqual([c.a.id, 'preparing', [], false]);
    expect(c.refusal(await c.cancel(c.b.id)).slice(0, 2)).toEqual([404, 'not_found']);
    const res = await c.cancel(c.a.id);
    expect([res.statusCode, res.body, await c.moves()]).toEqual([204, '', []]);
    expect((await c.cancel(c.a.id)).statusCode).toBe(404);
    expect(await moveTarget(c.keeper)).toBeNull();

    /* A request that failed is taken off the screen the same way, and a new one takes its place. */
    expect((await c.post(c.d.id)).statusCode).toBe(202);
    await c.db.execute(sql`UPDATE net.move SET state = 'failed', reason = 'behind', ended_at = now()`);
    expect((await c.listed()).move).toMatchObject({ machine: c.d.id, state: 'failed', reason: 'behind' });
    expect(await moveTarget(c.keeper)).toBeNull();
    expect((await c.post(c.a.id)).statusCode).toBe(202);
    expect(await c.moves()).toMatchObject([{ machine_id: c.a.id, state: 'preparing', reason: null }]);

    /* Once the server is moving, nothing calls it off. */
    await c.db.execute(sql`UPDATE net.move SET state = 'switching'`);
    expect(c.refusal(await c.cancel(c.a.id))).toEqual([409, 'switching', 'The server is moving to a now.']);
    expect(await c.moves()).toHaveLength(1);
  });

  it('answers try_again when the ranking fails', async () => {
    const c = await company();
    c.ctx.ranking.now = () => Promise.reject(new Error('the database is away'));
    expect(c.refusal(await c.post(c.d.id))).toEqual([503, 'try_again', 'Try again in a minute.']);
    /* The request is stored, and the next ranking gives the target its copy. */
    expect(await c.moves()).toMatchObject([{ machine_id: c.d.id, state: 'preparing' }]);
  });

  it('claims only the request it saw', async () => {
    const c = await company();
    expect((await c.post(c.d.id)).statusCode).toBe(202);
    const [first] = await c.moves();
    expect(await claimMove(c.keeper, first!.request)).toBe(true);
    expect(await c.moves()).toMatchObject([{ request: first!.request, state: 'switching' }]);
    /* Claimed once: a second claim of it finds it no longer preparing. */
    expect(await claimMove(c.keeper, first!.request)).toBe(false);

    await c.db.execute(sql`UPDATE net.move SET state = 'preparing'`);
    expect((await c.post(c.a.id)).statusCode).toBe(202);
    const [second] = await c.moves();
    expect(await claimMove(c.keeper, first!.request)).toBe(false);
    expect(await c.moves()).toMatchObject([{ request: second!.request, machine_id: c.a.id, state: 'preparing' }]);
    expect((await c.cancel(c.a.id)).statusCode).toBe(204);
    expect(await claimMove(c.keeper, second!.request)).toBe(false);
  });

  it('says who may move', async () => {
    const c = await company();
    const p = await invitePerson(c.app, c.ceo, { name: 'Pat', email: 'pat@acme.test', access: { whole: true } });
    expect((await c.post(c.d.id)).statusCode).toBe(202);
    expect((await c.listed()).canMove).toBe(true);
    const theirs = await c.listed(as(p));
    expect([theirs.canMove, theirs.move]).toEqual([false, { machine: c.d.id, state: 'preparing', reason: null, leader: 'rack', progress: null }]);
  });
});
