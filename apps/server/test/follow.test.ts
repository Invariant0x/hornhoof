import { generateKeyPairSync } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, jobs, machines, nodes, people, testParts, testRuns } from '../src/db/schema.js';
import { FOLLOW_RETRY_MS, FOLLOW_TURN_MS, followOf, goodGrant, holdsMachine, leaderBuild, releaseHeld, type LeaderBuild } from '../src/modules/network/follow.js';
import type { Build } from '../src/modules/updates/registry.js';
import { as, connectNode, listen, ownPlan, setUpCompany, testApp, until } from './helpers.js';

const COMMIT = 'b'.repeat(40);
const OLD = 'a'.repeat(40);
const HOST_ID = hashToken('hornhoof-host:host-0000-abcd');
const BUILD: Build = { tag: COMMIT, digest: 'sha256:app', version: '0.19.0', commit: COMMIT, created: '', title: '', migrations: 0 };
const B: LeaderBuild = { version: '0.19.0', tag: COMMIT, digest: 'sha256:app', nodeDigest: 'sha256:node', updaterDigest: 'sha256:updater', commit: COMMIT };
const MINUTE = 60_000;

const VIA = 'x-hornhoof-via';
const keeperOf = (machine: string) => ({ remoteAddress: '127.0.0.1', headers: { [VIA]: machine, 'x-hornhoof-keeper': '1' } });
const newKey = (): string => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();

/* A server that runs the build of COMMIT, which the registry has, and no worker yet. */
async function company(env: NodeJS.ProcessEnv = {}) {
  const { app, db, config } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: HOST_ID, HORNHOOF_COMMIT: COMMIT, NODE_PING_MS: '2147483647', ...env });
  const ceo = await setUpCompany(app);
  const { ctx } = app;
  const find = vi.spyOn(ctx.updates, 'find').mockResolvedValue(BUILD);
  const siblings = vi.spyOn(ctx.updates, 'siblings').mockResolvedValue({ node: 'sha256:node', updater: 'sha256:updater' });
  const [acme] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  /* A worker of the network on an older build. */
  const worker = async (name: string, more: Partial<typeof machines.$inferInsert> = {}) =>
    (await db.insert(machines).values({ companyId: acme!.id, personId: owner!.id, machineKey: `${name}-0001-abcd`, hostname: name, role: 'worker', signKey: newKey(), networkId: hashToken(name), commit: OLD, ...more }).returning())[0]!.id;
  const report = async (machine: string, payload: object) => expect((await app.inject({ method: 'POST', url: '/api/network/report', payload, ...keeperOf(machine) })).statusCode).toBe(204);
  const view = async (machine: string) => (await app.inject({ url: '/api/network/peers', ...keeperOf(machine) })).json() as { build: LeaderBuild | null; go: { commit: string; until: string } | null };
  const rowOf = async (machine: string) => (await db.select().from(machines).where(eq(machines.id, machine)))[0]!;
  const ready = (machine: string) => report(machine, { update: { commit: COMMIT, state: 'ready' } });
  return { app, db, config, ctx, ceo, companyId: acme!.id, ownerId: owner!.id, find, siblings, worker, report, view, rowOf, ready };
}

describe("following the server's build", () => {
  it('knows its own build by its commit', async () => {
    const c = await company();
    expect(await leaderBuild(c.ctx)).toEqual(B);
    expect(c.find).toHaveBeenCalledWith(COMMIT);
    expect(c.siblings).toHaveBeenCalledWith(COMMIT);
    /* The registry is not asked again for a while. */
    await leaderBuild(c.ctx);
    expect(c.find).toHaveBeenCalledTimes(1);
  });

  /* Each is no build to follow: the workers stay where they are. */
  it.each([
    ['a commit the registry does not have', (c: Awaited<ReturnType<typeof company>>) => c.find.mockResolvedValue(null)],
    ['a build with no updater image', (c: Awaited<ReturnType<typeof company>>) => c.siblings.mockResolvedValue({ node: 'sha256:node', updater: '' })],
    ['a registry that does not answer', (c: Awaited<ReturnType<typeof company>>) => c.find.mockRejectedValue(new Error('The registry answered 503.'))],
  ])('knows no build of its own with %s', async (_name, spoil) => {
    const c = await company();
    spoil(c);
    expect(await leaderBuild(c.ctx)).toBeNull();
    expect((await c.view(await c.worker('mac'))).build).toBeNull();
  });

  it('asks nobody when it was built by hand and names no commit', async () => {
    const local = await company({ HORNHOOF_COMMIT: 'local' });
    expect(await leaderBuild(local.ctx)).toBeNull();
    expect(local.find).not.toHaveBeenCalled();
  });

  it('tells a worker of the build only while it runs another', async () => {
    const c = await company();
    const w = await c.worker('mac');
    expect(await c.view(w)).toMatchObject({ build: B, go: null });
    await c.report(w, { commit: COMMIT });
    expect(await c.view(w)).toMatchObject({ build: null, go: null });
    /* A server that knows no build of its own says nothing, and its workers stay where they are. */
    const local = await company({ HORNHOOF_COMMIT: 'local' });
    expect(await local.view(await local.worker('mac'))).toMatchObject({ build: null, go: null });
  });

  it('lets one worker install at a time, between turns', async () => {
    const c = await company();
    const [w1, w2] = [await c.worker('one'), await c.worker('two')];
    /* A machine that has not downloaded the build yet is told nothing but the build. */
    expect((await c.view(w1)).go).toBeNull();
    await c.ready(w1);
    await c.ready(w2);
    const first = await c.view(w1);
    expect(first).toMatchObject({ build: B, go: { commit: COMMIT } });
    expect(Date.parse(first.go!.until) - Date.now()).toBeGreaterThan(FOLLOW_TURN_MS - MINUTE);
    expect(await c.view(w2)).toMatchObject({ build: B, go: null });
    /* Asked again, it hears the same word, with the same end. */
    expect((await c.view(w1)).go).toEqual(first.go);

    /* The second machine waits while a turn or a test part runs on it, though the first is done. */
    await c.report(w1, { commit: COMMIT, update: null });
    const [node] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: w2, status: 'ready' }).returning();
    const plan = await ownPlan(c.db, 'ivan@acme.com');
    const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: plan, nodeId: node!.id, kind: 'conversation', status: 'running', prompt: 'work', timeoutMs: 1000 }).returning();
    expect((await c.view(w2)).go).toBeNull();
    await c.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job!.id));
    expect((await c.view(w2)).go).toMatchObject({ commit: COMMIT });
  });

  it('never extends a grant, and remembers a failure', async () => {
    const c = await company();
    const [w1, w2] = [await c.worker('one'), await c.worker('two')];
    await c.ready(w1);
    await c.ready(w2);
    const t0 = new Date('2031-03-10T12:00:00Z');
    const at = (ms: number) => new Date(t0.getTime() + ms);
    const first = await followOf(c.ctx, w1, t0);
    expect(first.go).toEqual({ commit: COMMIT, until: at(FOLLOW_TURN_MS).toISOString() });
    for (let minute = 1; minute < 15; minute++) expect((await followOf(c.ctx, w1, at(minute * MINUTE))).go).toEqual(first.go);
    /* The quarter of an hour is over: the word ends by itself, and this build is not tried again for hours. */
    for (const minute of [15, 16, 20, 60, 359]) expect((await followOf(c.ctx, w1, at(minute * MINUTE))).go, String(minute)).toBeNull();
    /* The other machine does not wait for the one that never came back. */
    expect((await followOf(c.ctx, w2, at(15 * MINUTE))).go).toMatchObject({ commit: COMMIT });
    await c.db.update(machines).set({ commit: COMMIT }).where(eq(machines.id, w2));
    expect((await followOf(c.ctx, w1, at(FOLLOW_RETRY_MS + MINUTE))).go).toEqual({ commit: COMMIT, until: at(FOLLOW_RETRY_MS + MINUTE + FOLLOW_TURN_MS).toISOString() });
  });

  it('ends a turn to install at once when the machine says the install failed', async () => {
    const c = await company();
    const [w1, w2] = [await c.worker('one'), await c.worker('two')];
    await c.ready(w1);
    await c.ready(w2);
    expect((await c.view(w1)).go).not.toBeNull();
    await c.report(w1, { update: { commit: COMMIT, state: 'failed' } });
    expect(await c.rowOf(w1)).toMatchObject({ updateState: 'failed', failedCommit: COMMIT });
    expect(goodGrant(await c.rowOf(w1), new Date())).toBe(false);
    expect((await c.view(w2)).go).toMatchObject({ commit: COMMIT });
    /* It downloads again and says so, but is not told to install this build again for hours. */
    await c.report(w2, { commit: COMMIT, update: null });
    await c.ready(w1);
    expect((await c.view(w1)).go).toBeNull();
    const later = new Date(Date.now() + FOLLOW_RETRY_MS + MINUTE);
    expect((await followOf(c.ctx, w1, later)).go).toMatchObject({ commit: COMMIT });
  });

  it('gives no word to install while the server does not lead or installs an update itself', async () => {
    const c = await company();
    const w = await c.worker('mac');
    await c.ready(w);
    const running = vi.spyOn(c.ctx.updater, 'status').mockReturnValue({ id: 'u', version: '0.19.0', state: 'running', step: 'pull', log: '', at: '' });
    expect(await followOf(c.ctx, w)).toMatchObject({ build: B, go: null });
    running.mockRestore();
    expect((await followOf(c.ctx, w)).go).not.toBeNull();
  });

  it('holds turns and test parts on a worker while it installs', async () => {
    const c = await company();
    const url = await listen(c.app);
    onTestFinished(() => c.app.close());
    /* The CEO's plan on a computer that became a worker of the network, and the orchestrator on that plan. */
    const connected = await c.app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(c.ceo) });
    const joined = (await c.app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: (connected.json() as { command: string }).command.split('--join ')[1], machineId: 'mac-0001-abcd', hostname: 'ivan-mac', os: 'darwin', arch: 'arm64' } })).json() as {
      machine: { id: string };
      nodes: { nodeId: string; subscriptionId: string; key: string }[];
    };
    const { nodeId, subscriptionId, key } = joined.nodes[0]!;
    const w = joined.machine.id;
    await c.db.update(machines).set({ role: 'worker', signKey: newKey(), networkId: hashToken('mac'), commit: OLD }).where(eq(machines.id, w));
    await c.db.update(agents).set({ subscriptionId }).where(eq(agents.kind, 'orchestrator'));
    const node = await connectNode(url, key);
    node.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [], skillFiles: true });
    await until(async () => (await c.db.select().from(nodes).where(eq(nodes.id, nodeId)))[0]!.status === 'ready');

    await c.ready(w);
    expect((await c.view(w)).go).not.toBeNull();
    expect(await c.db.transaction(tx => holdsMachine(tx, nodeId))).toBe(true);
    /* A turn that comes now waits, and a part of a test run finds no place there. */
    expect((await c.app.inject({ method: 'POST', url: '/api/agents/orchestrator/messages', payload: { text: 'hello' }, ...as(c.ceo) })).statusCode).toBeLessThan(300);
    const queued = () => c.db.select().from(jobs).where(and(eq(jobs.kind, 'conversation'), eq(jobs.status, 'queued')));
    await until(async () => (await queued()).length === 1);
    await releaseHeld(c.ctx);
    expect(await queued()).toHaveLength(1);
    expect(await c.db.select().from(jobs).where(eq(jobs.status, 'running'))).toEqual([]);
    expect(await c.db.select().from(testParts).innerJoin(testRuns, eq(testRuns.id, testParts.runId)).where(eq(testParts.status, 'running'))).toEqual([]);

    /* The machine reports the server's build: its turn to install is over, and what waited goes out by itself. */
    await c.report(w, { commit: COMMIT, update: null });
    expect(await c.db.transaction(tx => holdsMachine(tx, nodeId))).toBe(false);
    const run = await node.next();
    expect(run).toMatchObject({ type: 'job.run' });
    expect(await queued()).toEqual([]);
    node.close();
  });

  it('answers the join of a new installer with the build first', async () => {
    const c = await company({ HORNHOOF_IMAGE: 'ghcr.io/acme/hornhoof' });
    const command = async () => ((await c.app.inject({ method: 'POST', url: '/api/machines/command', ...as(c.ceo) })).json() as { command: string }).command.split('--join ')[1];
    const join = (code: string | undefined, extra: object, accept = 'text/plain') =>
      c.app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'mac-0001-abcd', hostname: 'ivan-mac', os: 'darwin', arch: 'arm64', ...extra }, headers: { accept } });
    const lines = (await join(await command(), { core: true })).body.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(`build ${COMMIT} ghcr.io/acme/hornhoof@sha256:app ghcr.io/acme/hornhoof-node@sha256:node ghcr.io/acme/hornhoof-updater@sha256:updater`);
    expect(lines[1]).toMatch(/^core hornhoof-/);
    /* An installer that asks for no core gets what it always got. */
    const plain = (await join(await command(), { machineId: 'tower-0003-abcd' })).body.trim().split('\n');
    expect(plain).toHaveLength(1);
    expect(plain[0]).not.toMatch(/^build /);
    const asJson = (await join(await command(), { machineId: 'laptop-0002-abcd', core: true }, 'application/json')).json() as { build: unknown };
    expect(asJson.build).toEqual(B);
  });

  it('keeps the build and the word to install out of a view that did not come through the peer link', async () => {
    const c = await company();
    const w = await c.worker('mac');
    await c.ready(w);
    const { workerView } = await import('../src/modules/network/join.js');
    expect(await workerView(c.ctx, w)).toMatchObject({ build: null, go: null });
    expect(await c.view(w)).toMatchObject({ build: B, go: { commit: COMMIT } });
  });
});
