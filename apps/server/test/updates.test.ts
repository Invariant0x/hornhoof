import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, utimesSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agentEvents, agents, companies, departments, jobs, machines, nodeCodes, people, subscriptions } from '../src/db/schema.js';
import { only } from '../src/db/selections.js';
import { publishWorking } from '../src/modules/events/store.js';
import { appOn, as, connectNode, invitePerson, listen, sessionFrom, SETUP, setUpCompany, testApp, until } from './helpers.js';
import { openTestDb } from './helpers-db.js';
import { writeKeeperState, type Mode } from '../src/modules/keeper/state.js';
import { turnsHeld } from '../src/modules/updates/drain.js';
import { recordJobProgram, SILENT_TURN_MS } from '../src/modules/tasks/silent.js';
import { listenAt } from '../../../test-support/ports.mjs';

/* Lets a test hold the next count of working agents the update routes read, so something can happen meanwhile. */
const pause = vi.hoisted(() => ({ next: undefined as undefined | { reached: () => void; resume: Promise<void> } }));
vi.mock('../src/modules/events/store.js', async importOriginal => {
  const real = await importOriginal<typeof import('../src/modules/events/store.js')>();
  return {
    ...real,
    workingCount: async (...args: Parameters<typeof real.workingCount>) => {
      const held = pause.next;
      pause.next = undefined;
      const n = await real.workingCount(...args);
      if (held) {
        held.reached();
        await held.resume;
      }
      return n;
    },
  };
});

/* Holds the next count until the returned resume is called; the first promise settles once the count is read. */
function holdNextCount(): { counted: Promise<void>; resume: () => void } {
  let reached!: () => void, resume!: () => void;
  const counted = new Promise<void>(r => (reached = r));
  pause.next = { reached, resume: new Promise<void>(r => (resume = r)) };
  return { counted, resume };
}
const settled = () => new Promise(r => setImmediate(r));

type FakeBuild = { commit: string; version?: string; title?: string; migrations?: number; created?: string };
const ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64';
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';

const digestOf = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const appIndex = (ref: string) => JSON.stringify({
  manifests: [
    { digest: `sha256:m-${ref}-other`, platform: { os: 'linux', architecture: ARCH === 'amd64' ? 'arm64' : 'amd64' } },
    { digest: `sha256:m-${ref}`, platform: { os: 'linux', architecture: ARCH } },
    { digest: `sha256:m-${ref}-att`, platform: { os: 'unknown', architecture: 'unknown' } },
  ],
}, null, 2);
const partIndex = (part: string, ref: string) => JSON.stringify({ manifests: [{ digest: `sha256:m-${part}-${ref}`, platform: { os: 'linux', architecture: ARCH } }] });

/* A registry that serves an index per tag, a manifest per platform and a config blob with the build's labels. The node
   and updater images of every build are there too, by the build's tags and its commit, unless lacking names them. */
async function fakeRegistry(
  tags: Record<string, FakeBuild>,
  lacking: string[] = [],
): Promise<{ base: string; set(tag: string, build: FakeBuild): void; fail(status: number | null): void; calls: string[]; digests: Record<string, string> }> {
  const calls: string[] = [];
  /* The digest of each tag's index: the SHA-256 of the bytes the registry sent for it; "hornhoof-node:<tag>" for the
     node image's. */
  const digests: Record<string, string> = {};
  let failing: number | null = null;
  const reg: FastifyInstance = Fastify();
  reg.addHook('onRequest', async (req, reply) => {
    calls.push(req.url);
    if (failing) return reply.code(failing).send({ errors: [{ code: 'TOOMANYREQUESTS' }] });
  });
  reg.get('/token', async req => {
    const scope = (req.query as { scope: string }).scope;
    expect(scope).toMatch(/^repository:acme\/hornhoof(-node|-updater)?:pull$/);
    return { token: `anon-${scope.split(':')[1]}` };
  });
  for (const part of ['hornhoof-node', 'hornhoof-updater']) {
    reg.get(`/v2/acme/${part}/manifests/:ref`, async (req, reply) => {
      const { ref } = req.params as { ref: string };
      expect(req.headers.authorization).toBe(`Bearer anon-acme/${part}`);
      const known = Object.entries(tags).some(([tag, b]) => tag === ref || b.commit === ref);
      if (!known || lacking.includes(part)) return reply.code(404).send({ errors: [{ code: 'MANIFEST_UNKNOWN' }] });
      expect(req.headers.accept).toContain(OCI_INDEX);
      const index = partIndex(part, tags[ref]?.commit ?? ref);
      digests[`${part}:${ref}`] = digestOf(index);
      return reply.type(OCI_INDEX).send(index);
    });
  }
  reg.get('/v2/acme/hornhoof/tags/list', async req => {
    expect(req.headers.authorization).toBe('Bearer anon-acme/hornhoof');
    return { name: 'acme/hornhoof', tags: Object.keys(tags) };
  });
  reg.get('/v2/acme/hornhoof/manifests/:ref', async (req, reply) => {
    const { ref } = req.params as { ref: string };
    if (ref.startsWith('sha256:m-')) {
      return reply.type('application/vnd.oci.image.manifest.v1+json').send({ config: { digest: `sha256:c-${ref.slice(9)}` } });
    }
    if (!tags[ref]) return reply.code(404).send({ errors: [{ code: 'MANIFEST_UNKNOWN' }] });
    expect(req.headers.accept).toContain(OCI_INDEX);
    const index = appIndex(ref);
    digests[ref] = digestOf(index);
    return reply.type(OCI_INDEX).send(index);
  });
  reg.get('/v2/acme/hornhoof/blobs/:digest', async req => {
    const tag = (req.params as { digest: string }).digest.slice('sha256:c-'.length);
    const b = tags[tag]!;
    const labels: Record<string, string> = { 'org.opencontainers.image.revision': b.commit };
    if (b.version) labels['org.opencontainers.image.version'] = b.version;
    if (b.title) labels['io.hornhoof.title'] = b.title;
    if (b.migrations !== undefined) labels['io.hornhoof.migrations'] = String(b.migrations);
    return { created: b.created ?? '2026-10-30T01:00:00Z', config: { Labels: labels } };
  });
  await listenAt(port => reg.listen({ port, host: '127.0.0.1' }));
  onTestFinished(() => reg.close());
  return {
    base: `http://127.0.0.1:${(reg.server.address() as AddressInfo).port}`,
    set: (tag, build) => (tags[tag] = build),
    fail: status => { failing = status; },
    calls,
    digests,
  };
}

const updatableApp = (registry: { base: string }, commit: string, control: string, env: NodeJS.ProcessEnv = {}) =>
  testApp({
    HORNHOOF_IMAGE: 'ghcr.io/acme/hornhoof',
    REGISTRY_URL: registry.base,
    HORNHOOF_VERSION: '0.4.0',
    HORNHOOF_COMMIT: commit,
    HORNHOOF_CONTROL_DIR: control,
    ...env,
  });

async function company(registry: { base: string }, commit = 'aaa', control = mkdtempSync(join(tmpdir(), 'hh-control-')), env: NodeJS.ProcessEnv = {}) {
  const { app, db } = await updatableApp(registry, commit, control, env);
  return { app, db, control, ceo: await setUpCompany(app) };
}

/* A company whose app leads on a keeper's word, with an agent at work, and the step down the keeper can order. */
async function leadingCompany(registry: { base: string }) {
  const control = mkdtempSync(join(tmpdir(), 'hh-control-'));
  const say = (mode: Mode) => writeKeeperState(control, { mode, at: new Date().toISOString(), link: null });
  const { app, db } = await updatableApp(registry, 'aaa', control, { HORNHOOF_KEEPER: 'on' });
  /* Said once the app is built and not yet started, so a slow build cannot make the word stale. */
  say('lead');
  const ceo = await setUpCompany(app);
  updaterAlive(control);
  const [acme] = await db.select().from(companies);
  const [sub] = await db.select().from(subscriptions);
  const [job] = await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: (await db.select().from(agents))[0]!.id, prompt: 'x', status: 'running', timeoutMs: 1000 }).returning();
  const stepDown = async () => {
    say('read');
    await app.ctx.mode.check();
  };
  return { app, db, ceo, control, acme: acme!, job: job!, say, stepDown };
}

/* A company whose server can restart on the same database and control folder, with its worker Zed at work, as the
   restart finds it. first is the server before the restart; restart stops it and starts the next one. */
async function restartingCompany() {
  const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
  const control = mkdtempSync(join(tmpdir(), 'hh-control-'));
  const env = { HORNHOOF_IMAGE: 'ghcr.io/acme/hornhoof', REGISTRY_URL: registry.base, HORNHOOF_VERSION: '0.4.0', HORNHOOF_COMMIT: 'aaa', HORNHOOF_CONTROL_DIR: control };
  const { client } = await openTestDb();
  onTestFinished(() => client.close());
  const { app: first, db } = await appOn(client, env);
  const ceo = await setUpCompany(first);
  updaterAlive(control);
  const [acme] = await db.select().from(companies);
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const [zed] = await db.insert(agents).values({ companyId: acme!.id, kind: 'worker', name: 'Zed', model: '' }).returning();
  const [job] = await db
    .insert(jobs)
    .values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: zed!.id, prompt: 'x', kind: 'conversation', status: 'running', startedAt: new Date(), timeoutMs: 1000 })
    .returning();
  /* Ready, as a server that listens is: it leads from then on. */
  const restart = async () => {
    await first.close();
    const next = await appOn(client, env);
    await next.app.ready();
    return next;
  };
  return { first, restart, ceo, control, registry, db, acme: acme!, orchestrator: orchestrator!, job: job! };
}

/* The updater is alive when it touched alive in the last 30 seconds. A touch an hour ahead of the clock stays that fresh
   all through a test on any machine; one more than 30 seconds back is old already. */
const updaterAlive = (control: string, ageSeconds = -3600) => {
  writeFileSync(join(control, 'alive'), '');
  const when = Date.now() / 1000 - ageSeconds;
  utimesSync(join(control, 'alive'), when, when);
};
const request = (control: string) => (existsSync(join(control, 'request.json')) ? JSON.parse(readFileSync(join(control, 'request.json'), 'utf8')) : null);
const SHA = 'b'.repeat(40);
const HELD_AFTER_MS = 10 * 60_000;
/* An update that waits for the agents, as the screens and the orchestrator see it. */
const WAITS = { version: '0.4.1', commit: SHA, since: expect.any(String), until: expect.any(String), turns: expect.any(Array), lost: [] };
/* What the updater is asked for: the build the server read, by digest, and the node and updater images of its commit. */
const asked = (registry: { digests: Record<string, string> }, id: string) => ({
  id,
  version: '0.4.1',
  commit: SHA,
  tag: SHA,
  digest: registry.digests.latest,
  nodeDigest: registry.digests[`hornhoof-node:${SHA}`],
  updaterDigest: registry.digests[`hornhoof-updater:${SHA}`],
});

describe('the node image install.sh names', () => {
  const MACHINE = { machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64' };
  const LAPTOP = { ...MACHINE, machineId: 'laptop-0002-abcd', hostname: 'dev-laptop' };
  const BY_TAG = `ghcr.io/acme/hornhoof-node:${SHA}`;
  const THIS_SERVER = 'curl -fsSL http://localhost:8080/install.sh | bash';
  /* What a machine gets that runs the command: the image in the script at the command's address, which anyone may read. */
  const imageOf = async (app: FastifyInstance, command = THIS_SERVER) => {
    const { pathname } = new URL(command.match(/^curl -fsSL (\S+) \| bash/)![1]!);
    return (await app.inject({ url: pathname })).body.match(/^BUILD_IMAGE="(.*)"$/m)?.[1];
  };
  const ownDigest = (registry: { digests: Record<string, string> }) => `ghcr.io/acme/hornhoof-node@${registry.digests[`hornhoof-node:${SHA}`]}`;

  it("is the digest of the image CI built from this server's commit, not latest or another build's", async () => {
    const registry = await fakeRegistry({ '0.4.0': { commit: SHA, version: '0.4.0' }, '0.6.1': { commit: 'f'.repeat(40), version: '0.6.1' }, latest: { commit: 'f'.repeat(40), version: '0.6.1' } });
    const { app } = await company(registry, SHA);
    expect(await imageOf(app)).toBe(ownDigest(registry));
    expect(registry.digests[`hornhoof-node:${SHA}`]).toMatch(/^sha256:[0-9a-f]{64}$/);

    /* Anyone may read install.sh, so the digest once known takes no more calls to the registry. */
    const calls = registry.calls.length;
    expect(await imageOf(app)).toBe(ownDigest(registry));
    expect(registry.calls).toHaveLength(calls);
  });

  it('is the same in every command that installs or updates a node', async () => {
    const registry = await fakeRegistry({ '0.4.0': { commit: SHA, version: '0.4.0' } });
    const { app, db } = await testApp({ HORNHOOF_IMAGE: 'ghcr.io/acme/hornhoof', REGISTRY_URL: registry.base, HORNHOOF_VERSION: '0.4.0', HORNHOOF_COMMIT: SHA });
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { ...SETUP, orchestrator: { mode: 'personal', provider: 'claude' } } });
    const ceo = sessionFrom(setup);
    const post = async (url: string, payload: object = {}) => app.inject({ method: 'POST', url, payload, ...as(ceo) });
    const joinWith = async (command: string, machine: object) => (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: command.split('--join ')[1]!, ...machine } })).json();

    const machineCommand = (await post('/api/machines/command')).json();
    await joinWith(machineCommand.command, MACHINE);
    const connected = (await post('/api/subscriptions/connect', { providers: ['codex'] })).json();
    const plan = connected.subscriptions[0].id as string;
    /* A plan's command that ran out leaves the plan waiting, and its owner makes a new one. */
    await db.update(nodeCodes).set({ expiresAt: new Date(Date.now() - 1000) });
    const planCommand = (await post(`/api/subscriptions/${plan}/command`)).json();
    const joined = await joinWith(planCommand.command, MACHINE);
    const laptop = await joinWith((await post('/api/machines/command')).json().command, LAPTOP);
    const addPlan = (await post(`/api/machines/${laptop.machine.id}/plans`, { subscription: plan })).json();

    /* A node from before machine keys cannot sign in here: the answer names the command that updates it. */
    const node = joined.nodes[0] as { nodeId: string; key: string };
    (await connectNode(await listen(app), node.key)).send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], terminals: true });
    await until(() => app.ctx.hub.isReady({ kind: 'node', nodeId: node.nodeId }));
    const update = (await post(`/api/subscriptions/${plan}/signin`, { fresh: false })).json().error.details.command as string;

    const commands = { setup: setup.json().command, machine: machineCommand.command, connect: connected.command, plan: planCommand.command, addPlan: addPlan.command, update };
    const seen = Object.fromEntries(await Promise.all(Object.entries(commands).map(async ([name, command]) => [name, await imageOf(app, command as string)])));
    const image = ownDigest(registry);
    expect(seen).toEqual({ setup: image, machine: image, connect: image, plan: image, addPlan: image, update: image });
  });

  it("is the commit's tag, never latest, while the registry lacks the image", async () => {
    const registry = await fakeRegistry({ latest: { commit: 'f'.repeat(40), version: '0.6.1' } });
    const { app } = await company(registry, SHA);
    expect(await imageOf(app)).toBe(BY_TAG);
  });

  it("is the commit's tag, never latest, when the registry fails, and the script is still served", async () => {
    const registry = await fakeRegistry({ '0.4.0': { commit: SHA, version: '0.4.0' } });
    registry.fail(503);
    const { app } = await company(registry, SHA);
    expect(await imageOf(app)).toBe(BY_TAG);
    expect((await app.inject({ url: '/install.sh' })).statusCode).toBe(200);
  });

  it('says "local" for a server CI did not build, and asks no registry', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.0' } });
    const { app } = await testApp({ HORNHOOF_IMAGE: 'ghcr.io/acme/hornhoof', REGISTRY_URL: registry.base });
    expect(await imageOf(app)).toBe('local');
    expect(registry.calls).toEqual([]);
  });

  it('tells the log when the registry fails', async () => {
    const registry = await fakeRegistry({ '0.4.0': { commit: SHA, version: '0.4.0' } });
    registry.fail(503);
    const lines: string[] = [];
    const { app } = await testApp({ HORNHOOF_IMAGE: 'ghcr.io/acme/hornhoof', REGISTRY_URL: registry.base, HORNHOOF_COMMIT: SHA }, { level: 'warn', stream: { write: (line: string) => void lines.push(line) } });
    await imageOf(app);
    const said = lines.map(line => JSON.parse(line) as { msg: string; error?: { message?: string } }).find(line => line.msg.includes('node image'));
    expect(said?.error?.message).toContain('503');
  });
});

describe('updates', () => {
  it('finds a newer build of the main line', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1', title: 'Hire from the staff card', migrations: 6 } });
    const { app, ceo } = await company(registry);
    const res = await app.inject({ method: 'POST', url: '/api/updates/check', ...as(ceo) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.current).toMatchObject({ version: '0.4.0', commit: 'aaa' });
    expect(body.available).toBe(true);
    expect(body).not.toHaveProperty('liveCheck');
    expect(body.latest).toMatchObject({ tag: 'latest', version: '0.4.1', commit: SHA, title: 'Hire from the staff card', migrations: 6, created: '2026-10-30T01:00:00Z' });
    expect(body.checkedAt).toEqual(expect.any(String));
    expect(body.error).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json()).toEqual(body);
  });

  it('says nothing is new when the latest build is the running one', async () => {
    const registry = await fakeRegistry({ latest: { commit: 'aaa', version: '0.4.0' } });
    const { app, ceo } = await company(registry);
    const body = (await app.inject({ method: 'POST', url: '/api/updates/check', ...as(ceo) })).json();
    expect(body.available).toBe(false);
    expect(body.latest.commit).toBe('aaa');
  });

  it('lists published versions newest first', async () => {
    const registry = await fakeRegistry({
      latest: { commit: 'ccc', version: '0.10.0' },
      '0.3.0': { commit: 'c03', version: '0.3.0' },
      '0.4.0': { commit: 'c04', version: '0.4.0' },
      '0.10.0': { commit: 'ccc', version: '0.10.0' },
      abc123: { commit: 'abc123' },
    });
    const { app, ceo } = await company(registry);
    const body = (await app.inject({ method: 'POST', url: '/api/updates/check', ...as(ceo) })).json();
    expect(body.versions.map((v: { tag: string }) => v.tag)).toEqual(['0.10.0', '0.4.0', '0.3.0']);
    expect(body.versions[1]).toMatchObject({ version: '0.4.0', commit: 'c04' });
  });

  it('keeps the last result when the registry fails', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, ceo } = await company(registry);
    const first = (await app.inject({ method: 'POST', url: '/api/updates/check', ...as(ceo) })).json();
    registry.fail(429);
    const res = await app.inject({ method: 'POST', url: '/api/updates/check', ...as(ceo) });
    expect(res.statusCode).toBe(200);
    const second = res.json();
    expect(second.error).toEqual(expect.stringContaining('429'));
    expect(second.latest).toEqual(first.latest);
    expect(second.available).toBe(true);
    expect(second.checkedAt).toBe(first.checkedAt);
  });

  it('is only for people with the whole company', async () => {
    const registry = await fakeRegistry({ latest: { commit: 'bbb' } });
    const { app, db, ceo } = await company(registry);
    const [acme] = await db.select().from(companies);
    const [sales] = await db.insert(departments).values({ companyId: acme!.id, name: 'Sales', roleCode: 'SAL' }).returning();
    const seller = await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', access: { departments: [sales!.id] } });
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(seller) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/updates/check', ...as(seller) })).statusCode).toBe(403);
    expect(registry.calls).toEqual([]);
  });

  it('asks the updater for a version, by the commit of its build', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' }, '0.4.1': { commit: SHA, version: '0.4.1' } });
    const { app, ceo, control } = await company(registry);
    updaterAlive(control);
    await app.inject({ method: 'POST', url: '/api/updates/check', ...as(ceo) });
    const res = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest' }, ...as(ceo) });
    expect(res.statusCode).toBe(202);
    /* The digests pin the exact build the server read, whatever the tag points at later, and the node and updater
       images made from its commit. */
    expect(request(control)).toEqual(asked(registry, res.json().id));
    expect(request(control).nodeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(request(control).updaterDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(new Set([request(control).digest, request(control).nodeDigest, request(control).updaterDigest]).size).toBe(3);
    writeFileSync(join(control, 'status.json'), JSON.stringify({ id: res.json().id, version: '0.4.1', state: 'running', step: 'pull', log: 'Downloading 0.4.1.\n', at: '2026-10-30T01:00:00Z' }));
    const view = (await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json();
    expect(view.updater).toEqual({ present: true, status: expect.objectContaining({ state: 'running', step: 'pull' }), waiting: null, calledOff: null });
    const again = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: '0.4.1' }, ...as(ceo) });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.reason).toBe('update_running');
  });

  it('waits for a merge', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, db, ceo, control } = await company(registry);
    updaterAlive(control);
    const update = () => app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: false }, ...as(ceo) });
    /* A database from before a restore is still being brought back: migrations could part the two shapes. */
    await db.execute(sql`INSERT INTO net.merges (source, label) VALUES ('kept:hornhoof_before_t1', 'a database')`);
    for (const status of ['pending', 'applied']) {
      await db.execute(sql`UPDATE net.merges SET status = ${status}`);
      const refused = await update();
      expect([status, refused.statusCode, refused.json().error.reason, refused.json().error.message]).toEqual([
        status, 409, 'merge_pending', 'A database from before a restore is still being brought back. Wait for it, or leave it out in Settings, under Company & access.',
      ]);
      expect(app.ctx.updater.claimed()).toBeNull();
    }
    await db.execute(sql`UPDATE net.merges SET status = 'merged'`);
    expect((await update()).statusCode).toBe(202);
  });

  it('refuses an update while the server moves', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, db, ceo, control } = await company(registry);
    updaterAlive(control);
    const update = () => app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: false }, ...as(ceo) });
    /* The CEO asked the server moved to another machine: an update would cut the copy it is to move with. */
    const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
    const row = (hostname: string) => db.insert(machines).values({ companyId: owner!.companyId, personId: owner!.id, machineKey: `joined-${hostname}`, hostname }).returning();
    const [[from], [to]] = [await row('rack'), await row('studio')];
    await db.execute(sql`INSERT INTO net.move (machine_id, from_machine_id, asked_by, asked_at, state) VALUES (${to!.id}, ${from!.id}, ${owner!.id}, now(), 'preparing')`);
    for (const state of ['preparing', 'switching']) {
      await db.execute(sql`UPDATE net.move SET state = ${state}`);
      const refused = await update();
      expect([state, refused.statusCode, refused.json().error.reason, refused.json().error.message]).toEqual([state, 409, 'moving', 'The server is moving to studio. Update once it moved.']);
      expect(app.ctx.updater.claimed()).toBeNull();
    }
    /* A request that failed moves nothing. */
    await db.execute(sql`UPDATE net.move SET state = 'failed', reason = 'behind', ended_at = now()`);
    expect((await update()).statusCode).toBe(202);
  });

  it('one restore or update at a time', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, db, ceo, control } = await company(registry);
    updaterAlive(control);
    const bundle = '0f0f0f0f-0000-4000-8000-00000000000a';
    const update = (payload: object = { version: 'latest', whenIdle: false }) => app.inject({ method: 'POST', url: '/api/updates', payload, ...as(ceo) });
    /* A restore of a bundle nobody recorded: it claims the updater first, and is refused for the bundle only after. */
    const restore = async () => {
      const answer = await app.inject({ method: 'POST', url: `/api/backups/${bundle}/restore`, payload: {}, ...as(ceo) });
      return answer.statusCode === 404 ? 'free' : (answer.json().error.reason as string);
    };
    const reasonOf = async (asked: ReturnType<typeof update>) => (await asked).json().error?.reason as string | undefined;
    const restoreSays = (state: string, step: string) => writeFileSync(join(control, 'restore-status.json'), JSON.stringify({ attempt: 'a1', id: bundle, state, step, line: '', at: '2026-11-10T08:00:00Z', kept: null }));

    /* A restore its keeper still prepares. */
    expect(app.ctx.updater.claim('restore', 'a1')).toBeNull();
    expect(await reasonOf(update())).toBe('restore_running');
    expect(await restore()).toBe('restore_busy');
    app.ctx.updater.free('a1');
    /* A restore the updater runs, which its status says. */
    restoreSays('running', 'swap');
    expect(await reasonOf(update())).toBe('restore_running');
    expect(await restore()).toBe('restore_busy');
    /* At a step of the keeper's the status alone holds nothing: only an order does. */
    restoreSays('running', 'open');
    expect(await restore()).toBe('free');
    restoreSays('failed', 'swap');
    expect(await restore()).toBe('free');
    expect(app.ctx.updater.claimed()).toBeNull();

    /* An update that waits for the agents. */
    const [acme] = await db.select().from(companies);
    const [sub] = await db.select().from(subscriptions);
    const [orchestrator] = await db.select().from(agents);
    const [job] = await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: orchestrator!.id, prompt: 'build', status: 'running', timeoutMs: 1000 }).returning();
    expect((await update({ version: 'latest', whenIdle: true })).statusCode).toBe(202);
    expect(await restore()).toBe('restore_busy');
    /* Another update takes its place, as it always did; one that fails leaves the first waiting, and holding. */
    expect((await update({ version: 'latest', whenIdle: true })).statusCode).toBe(202);
    expect((await update({ version: 'no-such-build', whenIdle: true })).statusCode).toBe(400);
    expect(await restore()).toBe('restore_busy');
    /* Called off, it holds nothing. */
    expect((await app.inject({ method: 'DELETE', url: '/api/updates', ...as(ceo) })).statusCode).toBe(204);
    expect(await restore()).toBe('free');
    await db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job!.id));

    /* Asked in the same tick, exactly one of the two is taken, whichever comes first. */
    expect([app.ctx.updater.claim('restore', 'r2'), app.ctx.updater.claim('update', 'u2')]).toEqual([null, 'restore']);
    app.ctx.updater.free('u2');
    expect(app.ctx.updater.claimed()).toEqual({ kind: 'restore', id: 'r2' });
    app.ctx.updater.free('r2');
    expect([app.ctx.updater.claim('update', 'u3'), app.ctx.updater.claim('restore', 'r3')]).toEqual([null, 'update']);
    app.ctx.updater.free('u3');
    /* A request the updater has not taken yet holds it too. */
    expect((await update()).statusCode).toBe(202);
    expect(request(control)).not.toBeNull();
    expect(app.ctx.updater.claimed()).toBeNull();
    expect(await restore()).toBe('restore_busy');
    /* Taken and done, the updater is free again. */
    writeFileSync(join(control, 'status.json'), JSON.stringify({ id: request(control).id, version: '0.4.1', state: 'done', step: 'finished', log: '', at: '2026-10-30T01:00:00Z' }));
    expect(await restore()).toBe('free');
  });

  it('leaves out an image a build does not have, so the updater takes it by its tag', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } }, ['hornhoof-updater']);
    const { app, ceo, control } = await company(registry);
    updaterAlive(control);
    const res = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest' }, ...as(ceo) });
    expect(res.statusCode).toBe(202);
    expect(request(control)).toEqual({ ...asked(registry, res.json().id), updaterDigest: '' });
  });

  it('lets the nodes of a server go to its build without asking the registry about it', async () => {
    const registry = await fakeRegistry({ [SHA]: { commit: SHA, version: '0.4.1' } });
    const { app, ceo } = await company(registry, SHA);
    const made = (await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) })).json();
    const joined = (await app.inject({ method: 'POST', url: '/api/nodes/join', payload: { code: /--join (\S+)/.exec(made.command)![1], machineId: 'mac-0001-abcd', hostname: 'dev-mac', os: 'darwin', arch: 'arm64' } })).json();
    registry.fail(500);
    const res = await app.inject({ method: 'POST', url: '/api/nodes/update', headers: { authorization: `Bearer ${joined.nodes[0].key}` }, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ready: true });
  });

  it('asks the updater for nothing when the registry cannot say which images the build has', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, ceo, control } = await company(registry);
    updaterAlive(control);
    await app.inject({ method: 'POST', url: '/api/updates/check', ...as(ceo) });
    registry.fail(500);
    const res = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest' }, ...as(ceo) });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.reason).toBe('registry_unreachable');
    expect(request(control)).toBeNull();
  });

  it('refuses a version that is not published', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, ceo, control } = await company(registry);
    updaterAlive(control);
    const res = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: '9.9.9' }, ...as(ceo) });
    expect(res.statusCode).toBe(400);
    expect(request(control)).toBeNull();
  });

  it('waits for the agents before an update when asked', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, db, ceo, control } = await company(registry);
    updaterAlive(control);
    const [acme] = await db.select().from(companies);
    const [sub] = await db.select().from(subscriptions);
    const [orchestrator] = await db.select().from(agents);
    const [job] = await db
      .insert(jobs)
      .values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: orchestrator!.id, prompt: 'build', status: 'running', timeoutMs: 1000 })
      .returning();
    const res = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true }, ...as(ceo) });
    expect(res.statusCode).toBe(202);
    expect(request(control)).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater.waiting).toEqual(WAITS);
    await db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job!.id));
    await publishWorking(app.ctx, acme!.id);
    /* The request is written whole and then moved into place, so once it is there it is all there. */
    await until(() => request(control) !== null);
    expect(request(control)).toEqual(asked(registry, res.json().id));
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater.waiting).toBeNull();
  });

  it('waits for the agents by default, and sends the update at once when whenIdle is false', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, db, ceo, control } = await company(registry);
    updaterAlive(control);
    const [acme] = await db.select().from(companies);
    const [sub] = await db.select().from(subscriptions);
    const [orchestrator] = await db.select().from(agents);
    const [job] = await db
      .insert(jobs)
      .values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: orchestrator!.id, prompt: 'build', status: 'running', timeoutMs: 1000 })
      .returning();
    const res = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest' }, ...as(ceo) });
    expect(res.statusCode).toBe(202);
    expect(request(control)).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater.waiting).toEqual(WAITS);
    await db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job!.id));
    await publishWorking(app.ctx, acme!.id);
    /* The request is written whole and then moved into place, so once it is there it is all there. */
    await until(() => request(control) !== null);
    expect(request(control)).toEqual(asked(registry, res.json().id));

    await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: orchestrator!.id, prompt: 'build 2', status: 'running', timeoutMs: 1000 });
    const now = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: false }, ...as(ceo) });
    expect(now.statusCode).toBe(202);
    expect(request(control)).toEqual({ ...asked(registry, now.json().id), immediate: true });
  });

  it('counts interrupted turns before an immediate update and rechecks the confirmation', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, db, ceo, control } = await company(registry);
    updaterAlive(control);
    const [acme] = await db.select().from(companies);
    const [sub] = await db.select().from(subscriptions);
    const [agent] = await db.select().from(agents);
    const running = { companyId: acme!.id, subscriptionId: sub!.id, agentId: agent!.id, kind: 'conversation' as const, prompt: 'keep working', status: 'running' as const, timeoutMs: 900_000 };
    await db.insert(jobs).values(running);
    const update = (confirmTurns?: number) => app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: false, ...(confirmTurns === undefined ? {} : { confirmTurns }) }, ...as(ceo) });
    const first = await update();
    expect(first.statusCode).toBe(409);
    expect(first.json().error).toMatchObject({ code: 'conflict', reason: 'turns_would_stop', details: { turns: 1 } });
    expect(request(control)).toBeNull();
    await db.insert(jobs).values(running);
    const changed = await update(1);
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error.details).toEqual({ turns: 2 });
    expect(request(control)).toBeNull();
    expect((await update(2)).statusCode).toBe(202);
    expect(request(control)).toMatchObject({ immediate: true });
    expect((await db.select().from(jobs).where(eq(jobs.status, 'running')))).toHaveLength(2);
  });

  it('hands an urgent security update over at once: it asks nobody, as updates did before they waited', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, db, ceo, control } = await company(registry);
    updaterAlive(control);
    const [acme] = await db.select().from(companies);
    const [sub] = await db.select().from(subscriptions);
    const [agent] = await db.select().from(agents);
    await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: agent!.id, kind: 'conversation', prompt: 'keep working', status: 'running', timeoutMs: 900_000 });
    const res = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', urgent: true }, ...as(ceo) });
    expect(res.statusCode).toBe(202);
    expect(request(control)).toEqual({ ...asked(registry, res.json().id), urgent: true });
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater.waiting).toBeNull();
  });

  it('holds new turns of the company while its update waits for the agents, and lets them go when it is called off', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, db, ceo, control } = await company(registry);
    updaterAlive(control);
    const [acme] = await db.select().from(companies);
    const [sub] = await db.select().from(subscriptions);
    await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: (await db.select().from(agents))[0]!.id, prompt: 'x', status: 'running', timeoutMs: 1000 });
    expect(turnsHeld(app.ctx, acme!.id)).toBe(false);
    await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true }, ...as(ceo) });
    expect(turnsHeld(app.ctx, acme!.id)).toBe(true);
    expect((await app.inject({ method: 'DELETE', url: '/api/updates', ...as(ceo) })).statusCode).toBe(204);
    expect(turnsHeld(app.ctx, acme!.id)).toBe(false);
  });

  it('calls off an update that waits for the agents, and says so with the turns that ran and until when it waited', async () => {
    const { app, db, ceo, control, acme, orchestrator, job } = await companyAtWork();
    const res = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true }, ...as(ceo) });
    expect((await app.inject({ method: 'DELETE', url: '/api/updates', ...as(ceo) })).statusCode).toBe(204);
    const updater = (await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater;
    expect(updater.waiting).toBeNull();
    expect(updater.calledOff).toEqual({ version: '0.4.1', commit: SHA, at: expect.any(String), until: res.json().waiting.until, reason: 'cancelled', turns: [{ agent: 'Zed', task: null }] });
    await db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job.id));
    await publishWorking(app.ctx, acme.id);
    await settled();
    expect(request(control)).toBeNull();
    /* Whoever called it off knows it already. */
    expect(await db.select(only(jobs, 'prompt')).from(jobs).where(eq(jobs.agentId, orchestrator.id))).toEqual([]);
  });

  it('does not hand over an update called off while the agents were counted', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, db, ceo, control } = await company(registry);
    updaterAlive(control);
    const [acme] = await db.select().from(companies);
    const [sub] = await db.select().from(subscriptions);
    const [job] = await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: (await db.select().from(agents))[0]!.id, prompt: 'x', status: 'running', timeoutMs: 1000 }).returning();
    await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true }, ...as(ceo) });
    await db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job!.id));
    const hold = holdNextCount();
    await publishWorking(app.ctx, acme!.id);
    await hold.counted;
    expect((await app.inject({ method: 'DELETE', url: '/api/updates', ...as(ceo) })).statusCode).toBe(204);
    hold.resume();
    await settled();
    expect(request(control)).toBeNull();
  });

  it('keeps an update waiting while the updater cannot be told, and hands it over once it can', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, db, ceo, control } = await company(registry);
    updaterAlive(control);
    const [acme] = await db.select().from(companies);
    const [sub] = await db.select().from(subscriptions);
    const [job] = await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: (await db.select().from(agents))[0]!.id, prompt: 'x', status: 'running', timeoutMs: 1000 }).returning();
    const res = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true }, ...as(ceo) });
    /* A folder where the request file goes makes writing it fail. */
    mkdirSync(join(control, 'request.json.new'));
    await db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job!.id));
    const hold = holdNextCount();
    await publishWorking(app.ctx, acme!.id);
    await hold.counted;
    hold.resume();
    await settled();
    expect(request(control)).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater.waiting).toEqual(WAITS);

    rmdirSync(join(control, 'request.json.new'));
    await publishWorking(app.ctx, acme!.id);
    /* The request is written whole and then moved into place, so once it is there it is all there. */
    await until(() => request(control) !== null);
    expect(request(control)).toEqual(asked(registry, res.json().id));
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater.waiting).toBeNull();
  });

  /* 17.11: the keeper went silent for a moment, the app left lead and the waiting update was gone, neither handed over
     nor called off. */
  it('keeps an update waiting through a step-down: a machine that does not lead holds and hands over nothing, and the next lead picks the wait up again', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, db, ceo, control, acme, job, say, stepDown } = await leadingCompany(registry);
    const res = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true }, ...as(ceo) });
    expect(turnsHeld(app.ctx, acme.id)).toBe(true);
    await stepDown();
    expect(turnsHeld(app.ctx, acme.id)).toBe(false);
    const away = (await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater;
    expect(away.waiting).toEqual(WAITS);
    expect(away.calledOff).toBeNull();
    await db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job.id));
    await publishWorking(app.ctx, acme.id);
    await settled();
    expect(request(control)).toBeNull();

    say('lead');
    await app.ctx.mode.check();
    await until(() => request(control) !== null);
    expect(request(control)).toEqual(asked(registry, res.json().id));
    const back = (await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater;
    expect(back.waiting).toBeNull();
    expect(back.calledOff).toBeNull();
    /* Held for the restart, as after any hand-over. */
    expect(turnsHeld(app.ctx, acme.id)).toBe(true);
  });

  it('picks a waiting update up again after the server restarts, and hands it over once the agents finish', async () => {
    const { first, restart, ceo, control, registry, acme, job } = await restartingCompany();
    const res = await first.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true }, ...as(ceo) });
    expect(res.statusCode).toBe(202);
    const { app, db } = await restart();
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater.waiting).toEqual({ ...WAITS, turns: [{ agent: 'Zed', task: null }] });
    await until(() => turnsHeld(app.ctx, acme.id));
    expect(request(control)).toBeNull();
    await db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job.id));
    await publishWorking(app.ctx, acme.id);
    await until(() => request(control) !== null);
    expect(request(control)).toEqual(asked(registry, res.json().id));
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater).toMatchObject({ waiting: null, calledOff: null });
  });

  it('hands over nothing when the app leaves lead while the agents are counted', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, db, ceo, control, acme, job, stepDown } = await leadingCompany(registry);
    await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true }, ...as(ceo) });
    await db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job.id));
    const hold = holdNextCount();
    await publishWorking(app.ctx, acme.id);
    await hold.counted;
    await stepDown();
    hold.resume();
    await settled();
    expect(request(control)).toBeNull();
  });

  /* An update just handed over, with the turns still held, and the timeout that ends the hold, which the test may run
     without waiting its ten minutes. */
  async function handedOver() {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const made = await leadingCompany(registry);
    const { app, db, ceo, control, acme, job } = made;
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    onTestFinished(() => timeouts.mockRestore());
    await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true }, ...as(ceo) });
    await db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job.id));
    await publishWorking(app.ctx, acme.id);
    await expect.poll(() => request(control)).not.toBeNull();
    expect(turnsHeld(app.ctx, acme.id)).toBe(true);
    const at = timeouts.mock.calls.findIndex(([, ms]) => ms === HELD_AFTER_MS);
    /* The deadline of the wait, which the hand-over ended. */
    const deadline = timeouts.mock.calls.find(([, ms]) => ms === 30 * 60_000)?.[0] as (() => void) | undefined;
    return { ...made, holdEnds: timeouts.mock.calls[at]![0] as () => void, holdTimeout: timeouts.mock.results[at]!.value as NodeJS.Timeout, deadline };
  }

  it('lets the turns held after a hand-over go when its timeout ends', async () => {
    const { app, acme, holdEnds } = await handedOver();
    holdEnds();
    expect(turnsHeld(app.ctx, acme.id)).toBe(false);
  });

  it('keeps the turns held when the timeout of a hand-over ends and another update waits', async () => {
    const { app, db, ceo, acme, job, holdEnds } = await handedOver();
    await db.update(jobs).set({ status: 'running' }).where(eq(jobs.id, job.id));
    await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true }, ...as(ceo) });
    holdEnds();
    expect(turnsHeld(app.ctx, acme.id)).toBe(true);
  });

  it('lets the turns held after a hand-over go, and ends their timeout, when the app leaves lead', async () => {
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    onTestFinished(() => cleared.mockRestore());
    const { app, acme, stepDown, holdTimeout } = await handedOver();
    await stepDown();
    expect(turnsHeld(app.ctx, acme.id)).toBe(false);
    expect(cleared).toHaveBeenCalledWith(holdTimeout);
  });

  /* A company whose update may wait for its agents, with a turn of its worker Zed that runs since startedAt and, unless
     the test says otherwise, has no report of its program yet. */
  async function companyAtWork(startedAt = new Date()) {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const made = await company(registry);
    updaterAlive(made.control);
    const [acme] = await made.db.select().from(companies);
    const [sub] = await made.db.select().from(subscriptions);
    const [orchestrator] = await made.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
    const [zed] = await made.db.insert(agents).values({ companyId: acme!.id, kind: 'worker', name: 'Zed', model: '' }).returning();
    const [job] = await made.db
      .insert(jobs)
      .values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: zed!.id, prompt: 'x', kind: 'conversation', status: 'running', startedAt, timeoutMs: 1000 })
      .returning();
    return { ...made, registry, acme: acme!, sub: sub!, orchestrator: orchestrator!, zed: zed!, job: job! };
  }

  const LOST_AFTER_MS = SILENT_TURN_MS;
  const DEFAULT_WAIT_MS = 30 * 60_000;

  it('does not wait for a turn whose node said nothing of its program for ten minutes, since nothing tells when it ends', async () => {
    const { app, ceo, control, registry, acme } = await companyAtWork(new Date(Date.now() - LOST_AFTER_MS - 60_000));
    const res = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true }, ...as(ceo) });
    expect(res.statusCode).toBe(202);
    expect(request(control)).toEqual(asked(registry, res.json().id));
    /* Held now for the restart, as after any hand-over. */
    expect(turnsHeld(app.ctx, acme.id)).toBe(true);
  });

  it('waits for a long turn whose node still reports its program, and says for which turns and until when', async () => {
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    onTestFinished(() => timeouts.mockRestore());
    const { app, ceo, control, job } = await companyAtWork(new Date(Date.now() - 60 * 60_000));
    await recordJobProgram(app.ctx, { type: 'job.program', jobId: job.id, state: 'thinking', since: 0, screenAt: 0 }, new Date(Date.now() - 60_000), sql`true`);
    const res = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true }, ...as(ceo) });
    expect(res.statusCode).toBe(202);
    expect(request(control)).toBeNull();
    const waiting = { version: '0.4.1', commit: SHA, since: expect.any(String), until: expect.any(String), turns: [{ agent: 'Zed', task: null }], lost: [] };
    expect(res.json().waiting).toEqual(waiting);
    const shown = (await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater.waiting;
    expect(shown).toEqual(waiting);
    /* Thirty minutes unless the request says otherwise. */
    expect(Date.parse(shown.until) - Date.parse(shown.since)).toBe(DEFAULT_WAIT_MS);
    expect(timeouts.mock.calls.some(([, ms]) => ms === DEFAULT_WAIT_MS)).toBe(true);
  });

  it('names a lost turn apart from the turns it waits for', async () => {
    const { app, db, ceo, acme, sub, orchestrator } = await companyAtWork(new Date(Date.now() - LOST_AFTER_MS - 60_000));
    await db.insert(jobs).values({ companyId: acme.id, subscriptionId: sub.id, agentId: orchestrator.id, prompt: 'y', kind: 'conversation', status: 'running', startedAt: new Date(), timeoutMs: 1000 });
    const res = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true }, ...as(ceo) });
    expect(res.json().waiting).toMatchObject({ turns: [{ agent: orchestrator.name, task: null }], lost: [{ agent: 'Zed', task: null }] });
  });

  it('waits for a turn whose node reports no program but streams its work, as the node_silent alarm counts it alive', async () => {
    const { app, db, ceo, control, acme, zed, job } = await companyAtWork(new Date(Date.now() - LOST_AFTER_MS - 60_000));
    await db.insert(agentEvents).values({ companyId: acme.id, agentId: zed.id, jobId: job.id, kind: 'text', data: { text: 'Working.' }, createdAt: new Date(Date.now() - 60_000) });
    const res = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true }, ...as(ceo) });
    expect(res.statusCode).toBe(202);
    expect(request(control)).toBeNull();
    expect(res.json().waiting).toMatchObject({ turns: [{ agent: 'Zed', task: null }], lost: [] });
  });

  it('calls the update off at its deadline: it stops no running work, lets the held turns go, says why and tells the orchestrator', async () => {
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    onTestFinished(() => timeouts.mockRestore());
    const { app, db, ceo, control, acme, orchestrator, job } = await companyAtWork();
    const res = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true, idleWaitMinutes: 5 }, ...as(ceo) });
    expect(res.statusCode).toBe(202);
    const { since, until: deadline } = res.json().waiting;
    expect(Date.parse(deadline) - Date.parse(since)).toBe(5 * 60_000);
    const at = timeouts.mock.calls.findIndex(([, ms]) => ms === 5 * 60_000);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(turnsHeld(app.ctx, acme.id)).toBe(true);

    (timeouts.mock.calls[at]![0] as () => void)();
    await until(() => !turnsHeld(app.ctx, acme.id));
    expect(request(control)).toBeNull();
    const updater = (await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater;
    expect(updater.waiting).toBeNull();
    expect(updater.calledOff).toEqual({ version: '0.4.1', commit: SHA, at: expect.any(String), until: deadline, reason: 'deadline', turns: [{ agent: 'Zed', task: null }] });
    expect((await db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, job.id)))[0]!.status).toBe('running');
    const told = async () => (await db.select(only(jobs, 'prompt')).from(jobs).where(eq(jobs.agentId, orchestrator.id))).map(j => j.prompt);
    await until(async () => (await told()).length > 0);
    expect((await told())[0]).toMatch(/^Hornhoof called off the update to 0\.4\.1: the agents did not finish within 5 minutes\. No running work was stopped/);
    expect((await told())[0]).toContain('Check the affected turns and how they can resume');
    expect((await told())[0]).not.toContain('CEO');

    /* The next request starts afresh, and the called-off one is no longer shown. */
    await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true }, ...as(ceo) });
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater.calledOff).toBeNull();
  });

  it('keeps the turns held for the restart when the deadline of an update already handed over passes', async () => {
    const { app, ceo, acme, deadline } = await handedOver();
    expect(deadline).toBeDefined();
    deadline!();
    await settled();
    expect(turnsHeld(app.ctx, acme.id)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater.calledOff).toBeNull();
  });

  it('calls an update off when the server comes back after its deadline and the agents still work: it says why and tells the orchestrator', async () => {
    const { first, restart, ceo, control, acme, orchestrator, job } = await restartingCompany();
    /* Asked ten minutes ago for five minutes, by the clock of the server before the restart. */
    const askedAt = Date.now() - 10 * 60_000;
    first.ctx.clock = () => askedAt;
    expect((await first.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true, idleWaitMinutes: 5 }, ...as(ceo) })).statusCode).toBe(202);
    const { app, db } = await restart();
    const told = async () => (await db.select(only(jobs, 'prompt')).from(jobs).where(eq(jobs.agentId, orchestrator.id))).map(j => j.prompt);
    await until(async () => (await told()).length > 0);
    expect((await told())[0]).toMatch(/^Hornhoof called off the update to 0\.4\.1: the agents did not finish within 5 minutes\. No running work was stopped/);
    const updater = (await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater;
    expect(updater.waiting).toBeNull();
    expect(updater.calledOff).toEqual({ version: '0.4.1', commit: SHA, at: expect.any(String), until: new Date(askedAt + 5 * 60_000).toISOString(), reason: 'deadline', turns: [{ agent: 'Zed', task: null }] });
    expect(turnsHeld(app.ctx, acme.id)).toBe(false);
    expect(request(control)).toBeNull();
    expect((await db.select(only(jobs, 'status')).from(jobs).where(eq(jobs.id, job.id)))[0]!.status).toBe('running');
  });

  it('calls an update off as failed when the updater cannot be told by its deadline, and says why', async () => {
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    onTestFinished(() => timeouts.mockRestore());
    const { app, db, ceo, control, acme, orchestrator, job } = await companyAtWork();
    const res = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true, idleWaitMinutes: 5 }, ...as(ceo) });
    /* A folder where the request file goes makes writing it fail. */
    mkdirSync(join(control, 'request.json.new'));
    await db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job.id));
    const at = timeouts.mock.calls.findIndex(([, ms]) => ms === 5 * 60_000);
    expect(at).toBeGreaterThanOrEqual(0);
    (timeouts.mock.calls[at]![0] as () => void)();
    await until(() => !turnsHeld(app.ctx, acme.id));
    const updater = (await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater;
    expect(updater.waiting).toBeNull();
    expect(updater.calledOff).toEqual({ version: '0.4.1', commit: SHA, at: expect.any(String), until: res.json().waiting.until, reason: 'failed', turns: [], error: expect.stringContaining('request.json.new') });
    const told = async () => (await db.select(only(jobs, 'prompt')).from(jobs).where(eq(jobs.agentId, orchestrator.id))).map(j => j.prompt);
    await until(async () => (await told()).length > 0);
    expect((await told())[0]).toMatch(/^Hornhoof called off the update to 0\.4\.1: Hornhoof could not go on with it: .*request\.json\.new/);
  });

  it('takes a waiting update for handed over when the updater got it before the restart wrote that down', async () => {
    const { first, restart, ceo, control, registry, acme, orchestrator } = await restartingCompany();
    const res = await first.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true }, ...as(ceo) });
    /* The request went out as the server stopped, before the wait was written down as handed over. */
    writeFileSync(join(control, 'request.json'), JSON.stringify(asked(registry, res.json().id)));
    const { app, db } = await restart();
    const view = async () => (await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater;
    await until(async () => (await view()).waiting === null);
    expect((await view()).calledOff).toBeNull();
    expect(request(control)).toEqual(asked(registry, res.json().id));
    expect(turnsHeld(app.ctx, acme.id)).toBe(false);
    expect(await db.select(only(jobs, 'prompt')).from(jobs).where(eq(jobs.agentId, orchestrator.id))).toEqual([]);
  });

  it('calls a waiting update off as failed when another update holds the updater after the restart, and says why', async () => {
    const { first, restart, ceo, control, orchestrator } = await restartingCompany();
    const res = await first.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true }, ...as(ceo) });
    writeFileSync(join(control, 'status.json'), JSON.stringify({ id: 'another', version: '0.4.2', state: 'running', step: 'pull', log: '', at: new Date().toISOString() }));
    const { app, db } = await restart();
    const told = async () => (await db.select(only(jobs, 'prompt')).from(jobs).where(eq(jobs.agentId, orchestrator.id))).map(j => j.prompt);
    await until(async () => (await told()).length > 0);
    expect((await told())[0]).toMatch(/^Hornhoof called off the update to 0\.4\.1: Hornhoof could not go on with it: the updater cannot take it, as another update runs\./);
    const updater = (await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater;
    expect(updater.waiting).toBeNull();
    expect(updater.calledOff).toEqual({
      version: '0.4.1', commit: SHA, at: expect.any(String), until: res.json().waiting.until, reason: 'failed', turns: [{ agent: 'Zed', task: null }], error: 'the updater cannot take it, as another update runs.',
    });
  });

  it('refuses an update whose reading of the registry crossed a step-down', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, ceo, control, acme, say, stepDown } = await leadingCompany(registry);
    await app.inject({ method: 'POST', url: '/api/updates/check', ...as(ceo) });
    const read = app.ctx.updates.siblings.bind(app.ctx.updates);
    app.ctx.updates.siblings = async tag => {
      await stepDown();
      return read(tag);
    };
    for (const whenIdle of [true, false]) {
      const res = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle }, ...as(ceo) });
      expect(res.json().error?.reason).toBe('read_only');
      /* The next attempt crosses the same step-down, from lead again. */
      say('lead');
      await app.ctx.mode.check();
    }
    expect(request(control)).toBeNull();
    expect(turnsHeld(app.ctx, acme.id)).toBe(false);
  });

  it('says when no updater runs', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, ceo, control } = await company(registry);
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater).toEqual({ present: false, status: null, waiting: null, calledOff: null });
    const missing = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest' }, ...as(ceo) });
    expect(missing.statusCode).toBe(503);
    expect(missing.json().error.reason).toBe('updater_missing');
    updaterAlive(control, 31);
    expect((await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest' }, ...as(ceo) })).statusCode).toBe(503);
  });
});
