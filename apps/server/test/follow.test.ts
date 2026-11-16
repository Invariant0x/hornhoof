import { createHmac, generateKeyPairSync } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi, type MockInstance } from 'vitest';
import { hashToken } from '../src/crypto/tokens.js';
import { agents, companies, departments, jobs, machines, nodeCodes, nodes, people, subscriptions, testParts, testRuns } from '../src/db/schema.js';
import { enqueueTurn, orchestratorOf, pump } from '../src/modules/conversation/queue.js';
import { pickBuiltin } from '../src/modules/nodes/builtin.js';
import { builtinOf } from '../src/modules/nodes/hub.js';
import { FOLLOW_RETRY_MS, FOLLOW_TURN_MS, buildSoon, followOf, goodGrant, holdsBuiltin, holdsMachine, installingBuiltins, installingMachines, installs, leaderBuild, machineInstalls, nextToInstall, refreshBuild, releaseHeld, type LeaderBuild } from '../src/modules/network/follow.js';
import type { Build } from '../src/modules/updates/registry.js';
import { as, connectNode, listen, nextOf, ownPlan, setUpCompany, testApp, until } from './helpers.js';
import { gets } from './test-runs-company.js';

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
type Spies = { find: MockInstance<(tag: string) => Promise<Build | null>>; siblings: MockInstance<(tag: string) => Promise<{ node: string; updater: string }>> };

/* spoil: what the registry says otherwise, set before the server first asks it. */
async function company(env: NodeJS.ProcessEnv = {}, spoil: (registry: Spies) => void = () => undefined) {
  const { app, db, config } = await testApp({ TUNNEL_HOST: 'localhost', HORNHOOF_MACHINE_ID: HOST_ID, HORNHOOF_COMMIT: COMMIT, NODE_PING_MS: '2147483647', ...env });
  const { ctx } = app;
  const find = vi.spyOn(ctx.updates, 'find').mockResolvedValue(BUILD);
  const siblings = vi.spyOn(ctx.updates, 'siblings').mockResolvedValue({ node: 'sha256:node', updater: 'sha256:updater' });
  spoil({ find, siblings });
  const ceo = await setUpCompany(app);
  /* The server asks the registry off the path of any request, and a view names the build once it has heard. */
  await refreshBuild(ctx);
  const [acme] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  /* A worker of the network on an older build. */
  const worker = async (name: string, more: Partial<typeof machines.$inferInsert> = {}) =>
    (await db.insert(machines).values({ companyId: acme!.id, personId: owner!.id, machineKey: `${name}-0001-abcd`, hostname: name, role: 'worker', signKey: newKey(), networkId: hashToken(name), commit: OLD, ...more }).returning())[0]!.id;
  const report = async (machine: string, payload: object) => expect((await app.inject({ method: 'POST', url: '/api/network/report', payload, ...keeperOf(machine) })).statusCode).toBe(204);
  const view = async (machine: string) => (await app.inject({ url: '/api/network/peers', ...keeperOf(machine) })).json() as { build: LeaderBuild | null; go: { commit: string; until: string; leftMs: number } | null };
  const rowOf = async (machine: string) => (await db.select().from(machines).where(eq(machines.id, machine)))[0]!;
  const ready = (machine: string) => report(machine, { update: { commit: COMMIT, state: 'ready' } });
  return { app, db, config, ctx, ceo, companyId: acme!.id, ownerId: owner!.id, find, siblings, worker, report, view, rowOf, ready };
}

describe("following the server's build", () => {
  it('knows its own build by its commit', async () => {
    const c = await company();
    expect(leaderBuild(c.ctx)).toEqual(B);
    expect(c.find).toHaveBeenCalledWith(COMMIT);
    expect(c.siblings).toHaveBeenCalledWith(COMMIT);
    /* The registry is not asked again for a while, and never on the way of a request. */
    const asked = c.find.mock.calls.length;
    leaderBuild(c.ctx);
    await c.view(await c.worker('mac'));
    expect(c.find).toHaveBeenCalledTimes(asked);
  });

  /* Each is no build to follow: the workers stay where they are. */
  it.each([
    ['a commit the registry does not have', (registry: Spies) => void registry.find.mockResolvedValue(null)],
    ['a build with no updater image', (registry: Spies) => void registry.siblings.mockResolvedValue({ node: 'sha256:node', updater: '' })],
    ['a registry that does not answer', (registry: Spies) => void registry.find.mockRejectedValue(new Error('The registry answered 503.'))],
  ])('knows no build of its own with %s', async (_name, spoil) => {
    const c = await company({}, spoil);
    expect(leaderBuild(c.ctx)).toBeNull();
    expect((await c.view(await c.worker('mac'))).build).toBeNull();
  });

  it('asks nobody when it was built by hand and names no commit', async () => {
    const local = await company({ HORNHOOF_COMMIT: 'local' });
    expect(leaderBuild(local.ctx)).toBeNull();
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
    expect((await c.view(w1)).go).toMatchObject({ commit: COMMIT, until: first.go!.until });

    /* The second machine waits while a turn or a test part runs on it, though the first is done. */
    await c.report(w1, { commit: COMMIT, update: null });
    const [node] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: w2, status: 'ready' }).returning();
    const plan = await ownPlan(c.db, 'ivan@acme.com');
    const [job] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: plan, nodeId: node!.id, kind: 'conversation', status: 'running', prompt: 'work', timeoutMs: 1000 }).returning();
    expect((await c.view(w2)).go).toBeNull();
    await c.db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job!.id));
    /* A check of the plan that went out to the machine and has not begun there yet counts as work on it too. */
    const [check] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: plan, nodeId: node!.id, prompt: 'check', timeoutMs: 1000 }).returning();
    expect((await c.view(w2)).go).toBeNull();
    await c.db.update(jobs).set({ status: 'failed' }).where(eq(jobs.id, check!.id));
    expect((await c.view(w2)).go).toMatchObject({ commit: COMMIT });
  });

  it('gives a machine that keeps a copy its turn as it gives a worker one', async () => {
    const c = await company();
    const [copy, w] = [await c.worker('copy', { role: 'data', copyState: 'ready' }), await c.worker('two')];
    expect(await c.view(copy)).toMatchObject({ build: B, go: null });
    await c.ready(copy);
    await c.ready(w);
    /* One machine at a time, whichever kind: the worker waits for the copy. */
    expect((await c.view(copy)).go).toMatchObject({ commit: COMMIT });
    expect((await c.view(w)).go).toBeNull();
    expect([...(await installingMachines(c.db, c.config))]).toEqual([copy]);
    await c.report(copy, { commit: COMMIT, update: null });
    expect(await c.view(copy)).toMatchObject({ build: null, go: null });
    expect((await c.view(w)).go).toMatchObject({ commit: COMMIT });
    /* A copy's own built-in node runs the work of the company's keys: while a turn or a part of a test run is on it, the
       copy waits, as it waits for the work of its plans' nodes. */
    const again = await c.worker('three', { role: 'data', copyState: 'ready' });
    const [{ networkId }] = [await c.rowOf(again)];
    const [sub] = await c.db.insert(subscriptions).values({ companyId: c.companyId, provider: 'anthropic_api', kind: 'api_key', label: 'Key', status: 'ready', ownerPersonId: c.ownerId }).returning();
    const [turn] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId: sub!.id, prompt: 'x', timeoutMs: 60_000, status: 'running', startedAt: new Date(), builtinMachine: networkId }).returning();
    await c.report(w, { commit: COMMIT, update: null });
    await c.ready(again);
    expect((await c.view(again)).go).toBeNull();
    await c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, turn!.id));
    expect((await c.view(again)).go).toMatchObject({ commit: COMMIT });
    /* With the word given, nothing new goes to its built-in node. */
    expect(await c.db.transaction(tx => holdsBuiltin(tx, c.config, networkId))).toBe(true);
    expect(await c.db.transaction(tx => holdsBuiltin(tx, c.config, HOST_ID))).toBe(false);
    expect([...(await installingBuiltins(c.db, c.config))]).toEqual([networkId]);
    await c.report(again, { commit: COMMIT, update: null });
    /* The machine the server itself runs on follows nobody. */
    await c.app.inject({ method: 'POST', url: '/api/network/certificate', payload: { signKey: newKey() }, remoteAddress: '127.0.0.1', headers: { [VIA]: 'keeper' } });
    const [server] = await c.db.select().from(machines).where(eq(machines.networkId, HOST_ID));
    await c.db.update(machines).set({ commit: OLD, updateCommit: COMMIT, updateState: 'ready' }).where(eq(machines.id, server!.id));
    expect(await followOf(c.ctx, server!.id)).toEqual({ build: null, go: null });
    expect(await c.db.transaction(tx => holdsBuiltin(tx, c.config, HOST_ID))).toBe(false);
    expect([[...(await installingMachines(c.db, c.config))], [...(await installingBuiltins(c.db, c.config))]]).toEqual([[], []]);
  });

  it('lets the machine the company was installed on follow once the server runs elsewhere', async () => {
    const c = await company();
    /* The server moved here in a planned switch: the row the company's install made for its first machine is of a
       machine that keeps a copy now, and this server's own row is another. */
    const first = await c.worker('debian', { machineKey: `server:${hashToken('debian')}`, role: 'data', copyState: 'ready' });
    await c.ready(first);
    const said = await c.view(first);
    expect(said).toMatchObject({ build: B, go: { commit: COMMIT } });
    /* It takes its turn as any machine does: while it installs, its built-in node is held and no other machine begins. */
    const [{ networkId }] = [await c.rowOf(first)];
    expect(await c.db.transaction(tx => holdsBuiltin(tx, c.config, networkId))).toBe(true);
    const w = await c.worker('mac');
    await c.ready(w);
    expect((await c.view(w)).go).toBeNull();
    await c.report(first, { commit: COMMIT, update: null });
    expect((await c.view(w)).go).toMatchObject({ commit: COMMIT });
    /* A stale word of this server's own row, left from the time it followed, holds nothing and nobody. */
    await c.app.inject({ method: 'POST', url: '/api/network/certificate', payload: { signKey: newKey() }, remoteAddress: '127.0.0.1', headers: { [VIA]: 'keeper' } });
    const [own] = await c.db.select().from(machines).where(eq(machines.networkId, HOST_ID));
    await c.db.update(machines).set({ commit: OLD, goCommit: COMMIT, goAt: new Date(), updateCommit: COMMIT, updateState: 'installing', reportAt: new Date() }).where(eq(machines.id, own!.id));
    await c.report(w, { commit: COMMIT, update: null });
    const late = await c.worker('late');
    await c.ready(late);
    expect((await c.view(late)).go).toMatchObject({ commit: COMMIT });
    expect(await c.db.transaction(tx => holdsBuiltin(tx, c.config, HOST_ID))).toBe(false);
    expect([[...(await installingMachines(c.db, c.config))], [...(await installingBuiltins(c.db, c.config))]]).toEqual([[late], [(await c.rowOf(late)).networkId]]);
  });

  it('never extends a grant, and remembers a failure', async () => {
    const c = await company();
    const [w1, w2] = [await c.worker('one'), await c.worker('two')];
    await c.ready(w1);
    await c.ready(w2);
    const t0 = new Date('2031-03-10T12:00:00Z');
    const at = (ms: number) => new Date(t0.getTime() + ms);
    const first = await followOf(c.ctx, w1, t0);
    expect(first.go).toEqual({ commit: COMMIT, until: at(FOLLOW_TURN_MS).toISOString(), leftMs: FOLLOW_TURN_MS });
    /* The same end each time, with less of the stretch left, which the machine counts by its own clock. */
    for (let minute = 1; minute < 15; minute++) expect((await followOf(c.ctx, w1, at(minute * MINUTE))).go).toEqual({ ...first.go, leftMs: FOLLOW_TURN_MS - minute * MINUTE });
    /* The quarter of an hour is over: the word ends by itself, and this build is not tried again for hours. */
    for (const minute of [15, 16, 20, 60, 359]) expect((await followOf(c.ctx, w1, at(minute * MINUTE))).go, String(minute)).toBeNull();
    /* The other machine does not wait for the one that never came back. */
    expect((await followOf(c.ctx, w2, at(15 * MINUTE))).go).toMatchObject({ commit: COMMIT });
    await c.db.update(machines).set({ commit: COMMIT }).where(eq(machines.id, w2));
    expect((await followOf(c.ctx, w1, at(FOLLOW_RETRY_MS + MINUTE))).go).toEqual({ commit: COMMIT, until: at(FOLLOW_RETRY_MS + MINUTE + FOLLOW_TURN_MS).toISOString(), leftMs: FOLLOW_TURN_MS });
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

  it('counts the hours to the next try from the failure, not from its last mention', async () => {
    const c = await company();
    const w = await c.worker('mac');
    await c.ready(w);
    expect((await c.view(w)).go).not.toBeNull();
    await c.report(w, { update: { commit: COMMIT, state: 'failed' } });
    const first = (await c.rowOf(w)).failedAt!;
    /* The machine goes on saying so with every report. */
    await c.db.update(machines).set({ failedAt: new Date(first.getTime() - 3 * 3_600_000) }).where(eq(machines.id, w));
    await c.report(w, { update: { commit: COMMIT, state: 'failed' } });
    expect((await c.rowOf(w)).failedAt!.getTime()).toBe(first.getTime() - 3 * 3_600_000);
    /* A failure at another build, or one that comes after the machine was ready again, is a new one. */
    await c.ready(w);
    await c.report(w, { update: { commit: COMMIT, state: 'failed' } });
    expect((await c.rowOf(w)).failedAt!.getTime()).toBeGreaterThanOrEqual(first.getTime());
  });

  it('keeps a machine that says it installs for as long as it says so, and lets no other begin', async () => {
    const c = await company();
    const [w1, w2] = [await c.worker('one'), await c.worker('two')];
    await c.ready(w1);
    await c.ready(w2);
    const t0 = new Date();
    expect((await followOf(c.ctx, w1, t0)).go).not.toBeNull();
    await c.report(w1, { update: { commit: COMMIT, state: 'installing' } });
    /* Its quarter of an hour is over, and it is at it still: it reported a moment ago. */
    const late = new Date(t0.getTime() + FOLLOW_TURN_MS + MINUTE);
    await c.db.update(machines).set({ reportAt: new Date(late.getTime() - 20_000) }).where(eq(machines.id, w1));
    expect(goodGrant(await c.rowOf(w1), late)).toBe(false);
    expect(installs(await c.rowOf(w1), late)).toBe(true);
    expect((await installingMachines(c.db, c.config, late)).has(w1)).toBe(true);
    expect((await followOf(c.ctx, w2, late)).go).toBeNull();
    /* A machine that fell silent holds nothing. */
    const silent = new Date(late.getTime() + 5 * MINUTE);
    expect(installs(await c.rowOf(w1), silent)).toBe(false);
    expect((await installingMachines(c.db, c.config, silent)).has(w1)).toBe(false);
    expect((await followOf(c.ctx, w2, silent)).go).toMatchObject({ commit: COMMIT });
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
    const joined = (await c.app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: (connected.json() as { command: string }).command.split('--join ')[1], machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64' } })).json() as {
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
    expect(await machineInstalls(c.db, nodeId)).toBe(true);
    /* A check of the plan is not sent there, and says why. */
    const check = await c.app.inject({ method: 'POST', url: `/api/subscriptions/${subscriptionId}/test`, ...as(c.ceo) });
    expect(check.statusCode).toBe(409);
    expect((check.json() as { error: { reason: string } }).error.reason).toBe('machine_updating');
    expect(await c.db.select().from(jobs)).toEqual([]);
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
      c.app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64', ...extra }, headers: { accept } });
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

  it('asks the registry again when a join comes while the server knows no build of its own', async () => {
    /* The registry failed when the server first asked, and answers since. */
    const c = await company({}, registry => void registry.find.mockRejectedValueOnce(new Error('The registry answered 503.')));
    expect(leaderBuild(c.ctx)).toBeNull();
    const code = ((await c.app.inject({ method: 'POST', url: '/api/machines/command', ...as(c.ceo) })).json() as { command: string }).command.split('--join ')[1];
    const joined = await c.app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64', core: true }, headers: { accept: 'text/plain' } });
    /* A join command works once, so its answer names the build: the core comes up on the server's build, not on the newest. */
    expect(joined.body.split('\n')[0]).toMatch(new RegExp(`^build ${COMMIT} `));
    /* A view still never waits for the registry. */
    const asked = c.find.mock.calls.length;
    await c.view(await c.worker('tower'));
    expect(c.find).toHaveBeenCalledTimes(asked);
  });

  /* The installer gives up on its join after half a minute, and a join command works once. */
  it('asks the registry before a join command is used up, and for a moment only', async () => {
    const c = await company({}, registry => void registry.find.mockRejectedValueOnce(new Error('The registry answered 503.')));
    const code = ((await c.app.inject({ method: 'POST', url: '/api/machines/command', ...as(c.ceo) })).json() as { command: string }).command.split('--join ')[1];
    const usedWhenAsked: (Date | null)[] = [];
    c.find.mockImplementation(async () => {
      usedWhenAsked.push((await c.db.select().from(nodeCodes))[0]!.usedAt);
      return BUILD;
    });
    const joined = await c.app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code, machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64', core: true }, headers: { accept: 'text/plain' } });
    expect(joined.body.split('\n')[0]).toMatch(new RegExp(`^build ${COMMIT} `));
    expect(usedWhenAsked).toEqual([null]);

    /* A registry that never answers holds a join no longer than the moment given it, and the join goes on without. */
    const silent = await company({}, registry => void registry.find.mockRejectedValueOnce(new Error('The registry answered 503.')));
    silent.find.mockReturnValue(new Promise<Build>(() => undefined));
    expect(await buildSoon(silent.ctx, 20)).toBeNull();
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

/* The CEO's plan on a computer that joined as a worker of the network, with its node connected, and the people who work
   there: a worker agent busy with a long turn, another that waits for one, and the orchestrator and a head of that plan. */
async function busyWorker(env: NodeJS.ProcessEnv = {}) {
  const c = await company(env);
  const url = await listen(c.app);
  onTestFinished(() => c.app.close());
  const connected = await c.app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(c.ceo) });
  const joined = (await c.app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: (connected.json() as { command: string }).command.split('--join ')[1], machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64' } })).json() as {
    machine: { id: string };
    nodes: { nodeId: string; subscriptionId: string; key: string }[];
  };
  const { nodeId, subscriptionId, key } = joined.nodes[0]!;
  const w = joined.machine.id;
  await c.db.update(machines).set({ role: 'worker', signKey: newKey(), networkId: hashToken('mac'), commit: OLD }).where(eq(machines.id, w));
  const node = await connectNode(url, key);
  onTestFinished(() => node.close());
  node.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [], skillFiles: true });
  await until(async () => (await c.db.select().from(nodes).where(eq(nodes.id, nodeId)))[0]!.status === 'ready');
  const [dept] = await c.db.insert(departments).values({ companyId: c.companyId, templateKey: 'development', roleCode: 'DEV' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker') =>
    (await c.db.insert(agents).values({ companyId: c.companyId, departmentId: dept!.id, subscriptionId, nodeId, kind, model: '', roleKey: kind === 'head' ? 'DEV-HEAD' : 'DEV-BE', name }).returning())[0]!;
  const orchestrator = (await orchestratorOf(c.ctx, c.companyId))!;
  await c.db.update(agents).set({ subscriptionId, nodeId }).where(eq(agents.id, orchestrator.id));
  const [dev, bob, head] = [await hire('Dev', 'worker'), await hire('Bob', 'worker'), await hire('Hana', 'head')];
  const [long] = await c.db.insert(jobs).values({ companyId: c.companyId, subscriptionId, agentId: dev.id, nodeId, kind: 'conversation', prompt: 'A long one', status: 'running', startedAt: new Date(), timeoutMs: 9_000_000 }).returning();
  const turnFor = (agentId: string) => enqueueTurn(c.ctx, { companyId: c.companyId, agentId, prompt: 'Your turn', createdBy: null });
  const statusOf = async (jobId: string) => (await c.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, jobId)))[0]!.status;
  const end = (jobId: string) => c.db.update(jobs).set({ status: 'done', finishedAt: new Date() }).where(eq(jobs.id, jobId));
  /* Whether the node got a turn of this agent: once a pump of its own has run, every earlier one has sent what it would. */
  const gotTurnOf = async (agentId: string) => {
    await pump(c.ctx, agentId);
    return gets(c.ctx, node, 'job.run');
  };
  return { ...c, w, node, nodeId, orchestrator: orchestrator.id, bob: bob.id, head: head.id, long: long!.id, turnFor, statusOf, end, gotTurnOf };
}

describe('a busy worker that waits for its turn to install', () => {
  const HOLD = 400;

  it('keeps one machine at a time off new work: of those with the build, the first that joined, while none installs', async () => {
    const c = await company();
    const [one, two] = [await c.worker('one'), await c.worker('two')];
    expect(await nextToInstall(c.ctx)).toBeNull();
    await c.ready(two);
    expect(await nextToInstall(c.ctx)).toMatchObject({ id: two });
    await c.ready(one);
    expect(await nextToInstall(c.ctx)).toMatchObject({ id: one });
    /* While one installs, none waits for it: the others work on. */
    expect((await c.view(one)).go).not.toBeNull();
    expect(await nextToInstall(c.ctx)).toBeNull();
    /* Its try failed, so it is not tried again for hours, and the next one is. */
    await c.report(one, { update: { commit: COMMIT, state: 'failed' } });
    expect(await nextToInstall(c.ctx)).toMatchObject({ id: two });
    /* A machine that stopped saying it has the build waits for nothing. */
    await c.db.update(machines).set({ reportAt: new Date(Date.now() - 3 * MINUTE) }).where(eq(machines.id, two));
    expect(await nextToInstall(c.ctx)).toBeNull();
  });

  it("sends the work of the company's keys to another built-in node while this machine is next to install", async () => {
    const NODE_KEY = 'builtin-follow-key-0123456789abcdef';
    const c = await company({ NODE_KEY });
    const url = await listen(c.app);
    onTestFinished(() => c.app.close());
    const w = await c.worker('mac');
    const machine = hashToken('mac');
    const node = await connectNode(url, `builtin.${machine}.${createHmac('sha256', NODE_KEY).update(`hornhoof builtin node ${machine}`).digest('hex')}`);
    onTestFinished(() => node.close());
    node.send({ type: 'hello', version: '0.3.0', loggedIn: true, running: [], skillFiles: true });
    await until(() => c.ctx.hub.isReady(builtinOf(machine)));
    expect(await pickBuiltin(c.ctx, c.db, machine)).toBe(machine);
    await c.ready(w);
    /* The server's own built-in node is not connected here, so no built-in node takes it now. */
    expect(await pickBuiltin(c.ctx, c.db, machine)).toBeNull();
    await c.report(w, { commit: COMMIT, update: null });
    expect(await pickBuiltin(c.ctx, c.db, machine)).toBe(machine);
  });

  /* As on 16.11: the MacBook had the build from 10:01 and installed it at 14:02, as a turn always ran there. */
  it('takes no new turn while it waits, and hears its turn once the turns that run there ended', async () => {
    const m = await busyWorker();
    await m.ready(m.w);
    expect((await m.view(m.w)).go).toBeNull();

    const job = await m.turnFor(m.bob);
    expect(await m.gotTurnOf(m.bob)).toBe(false);
    expect(await m.statusOf(job)).toBe('queued');

    await m.end(m.long);
    expect((await m.view(m.w)).go).toMatchObject({ commit: COMMIT });
    /* It installs and runs the build: the turn that waited goes out by itself. */
    await m.report(m.w, { commit: COMMIT, update: null });
    expect(await nextOf(m.node, 'job.run')).toMatchObject({ jobId: job });
  });

  it('lets the orchestrator and a head in past their limit while other work runs there, and then holds them for the install', async () => {
    const m = await busyWorker({ NODE_LEADER_HOLD_MS: String(HOLD) });
    /* The clock and the wake at the limit go only as far as the test moves them. */
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    onTestFinished(() => { vi.useRealTimers(); });
    await m.ready(m.w);
    expect((await m.view(m.w)).go).toBeNull();

    const led = await m.turnFor(m.orchestrator);
    await vi.advanceTimersByTimeAsync(HOLD - 1);
    expect(await m.gotTurnOf(m.orchestrator)).toBe(false);
    /* At the limit the orchestrator's turn goes by itself, and a head's goes as it comes; the worker's long turn runs. */
    await vi.advanceTimersByTimeAsync(1);
    expect(await nextOf(m.node, 'job.run')).toMatchObject({ jobId: led });
    const headed = await m.turnFor(m.head);
    expect(await nextOf(m.node, 'job.run')).toMatchObject({ jobId: headed });

    /* Once only their own turns are left, they wait too, so they never keep the machine from its turn. */
    await m.end(m.long);
    const next = await m.turnFor(m.bob);
    await m.end(led);
    const later = await m.turnFor(m.orchestrator);
    expect(await m.gotTurnOf(m.orchestrator)).toBe(false);
    expect((await m.view(m.w)).go).toBeNull();
    await m.end(headed);
    expect((await m.view(m.w)).go).toMatchObject({ commit: COMMIT });
    expect([await m.statusOf(later), await m.statusOf(next)]).toEqual(['queued', 'queued']);
  });
});
