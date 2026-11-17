import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, utimesSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agents, companies, departments, jobs, nodeCodes, subscriptions } from '../src/db/schema.js';
import { publishWorking } from '../src/modules/events/store.js';
import { as, connectNode, invitePerson, listen, sessionFrom, SETUP, setUpCompany, testApp, until } from './helpers.js';
import { turnsHeld } from '../src/modules/updates/drain.js';

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
      const index = JSON.stringify({ manifests: [{ digest: `sha256:m-${part}-${ref}`, platform: { os: 'linux', architecture: ARCH } }] });
      digests[`${part}:${ref}`] = `sha256:${createHash('sha256').update(index).digest('hex')}`;
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
    const index = JSON.stringify({
      manifests: [
        { digest: `sha256:m-${ref}-other`, platform: { os: 'linux', architecture: ARCH === 'amd64' ? 'arm64' : 'amd64' } },
        { digest: `sha256:m-${ref}`, platform: { os: 'linux', architecture: ARCH } },
        { digest: `sha256:m-${ref}-att`, platform: { os: 'unknown', architecture: 'unknown' } },
      ],
    }, null, 2);
    digests[ref] = `sha256:${createHash('sha256').update(index).digest('hex')}`;
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
  await reg.listen({ port: 0, host: '127.0.0.1' });
  onTestFinished(() => reg.close());
  return {
    base: `http://127.0.0.1:${(reg.server.address() as AddressInfo).port}`,
    set: (tag, build) => (tags[tag] = build),
    fail: status => (failing = status),
    calls,
    digests,
  };
}

async function company(registry: { base: string }, commit = 'aaa', control = mkdtempSync(join(tmpdir(), 'hh-control-')), env: NodeJS.ProcessEnv = {}) {
  const { app, db } = await testApp({
    HORNHOOF_IMAGE: 'ghcr.io/acme/hornhoof',
    REGISTRY_URL: registry.base,
    HORNHOOF_VERSION: '0.4.0',
    HORNHOOF_COMMIT: commit,
    HORNHOOF_CONTROL_DIR: control,
    ...env,
  });
  return { app, db, control, ceo: await setUpCompany(app) };
}

/* The updater is alive when it touched alive in the last 30 seconds. */
const updaterAlive = (control: string, ageSeconds = 0) => {
  writeFileSync(join(control, 'alive'), '');
  const when = Date.now() / 1000 - ageSeconds;
  utimesSync(join(control, 'alive'), when, when);
};
const request = (control: string) => (existsSync(join(control, 'request.json')) ? JSON.parse(readFileSync(join(control, 'request.json'), 'utf8')) : null);
const SHA = 'b'.repeat(40);
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
  const MACHINE = { machineId: 'mac-0001-abcd', hostname: 'ivan-mac', os: 'darwin', arch: 'arm64' };
  const LAPTOP = { ...MACHINE, machineId: 'laptop-0002-abcd', hostname: 'ivan-laptop' };
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
    const registry = await fakeRegistry({ latest: { commit: 'bbb', version: '0.4.1', title: 'Hire from the staff card', migrations: 6 } });
    const { app, ceo } = await company(registry);
    const res = await app.inject({ method: 'POST', url: '/api/updates/check', ...as(ceo) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.current).toMatchObject({ version: '0.4.0', commit: 'aaa' });
    expect(body.available).toBe(true);
    expect(body.latest).toMatchObject({ tag: 'latest', version: '0.4.1', commit: 'bbb', title: 'Hire from the staff card', migrations: 6, created: '2026-10-30T01:00:00Z' });
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
    const registry = await fakeRegistry({ latest: { commit: 'bbb', version: '0.4.1' } });
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
    expect(view.updater).toEqual({ present: true, status: expect.objectContaining({ state: 'running', step: 'pull' }), waiting: null });
    const again = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: '0.4.1' }, ...as(ceo) });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.reason).toBe('update_running');
  });

  it('leaves out an image a build does not have, so the updater takes it by its tag', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } }, ['hornhoof-updater']);
    const { app, ceo, control } = await company(registry);
    updaterAlive(control);
    const res = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest' }, ...as(ceo) });
    expect(res.statusCode).toBe(202);
    expect(request(control)).toEqual({ ...asked(registry, res.json().id), updaterDigest: '' });
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
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater.waiting).toEqual({ version: '0.4.1', commit: SHA });
    await db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job!.id));
    await publishWorking(app.ctx, acme!.id);
    await expect.poll(() => request(control)).toEqual(asked(registry, res.json().id));
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
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater.waiting).toEqual({ version: '0.4.1', commit: SHA });
    await db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job!.id));
    await publishWorking(app.ctx, acme!.id);
    await expect.poll(() => request(control)).toEqual(asked(registry, res.json().id));

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

  it('postpones a waiting server update at the deadline, releases new work and retries it', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, db, ceo, control } = await company(registry, 'aaa', undefined, { NODE_DRAIN_MS: '60', NODE_UPDATE_RETRY_MS: '150' });
    updaterAlive(control);
    const [acme] = await db.select().from(companies);
    const [sub] = await db.select().from(subscriptions);
    const [agent] = await db.select().from(agents);
    const [job] = await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: agent!.id, kind: 'conversation', prompt: 'keep working', status: 'running', timeoutMs: 900_000 }).returning();
    expect((await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest' }, ...as(ceo) })).statusCode).toBe(202);
    await until(async () => (await app.inject({ url: '/api/machines', ...as(ceo) })).json().builtin.drain?.state === 'postponed');
    expect(turnsHeld(app.ctx, acme!.id)).toBe(false);
    expect(request(control)).toBeNull();
    expect((await db.select().from(jobs).where(eq(jobs.id, job!.id)))[0]).toMatchObject({ status: 'running', error: null });
    await db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job!.id));
    await until(() => request(control) !== null);
  });

  it('counts again after reading images, so new turns cannot slip past an old confirmation', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, db, ceo, control } = await company(registry);
    updaterAlive(control);
    const [acme] = await db.select().from(companies);
    const [sub] = await db.select().from(subscriptions);
    const [agent] = await db.select().from(agents);
    const running = { companyId: acme!.id, subscriptionId: sub!.id, agentId: agent!.id, kind: 'conversation' as const, prompt: 'keep working', status: 'running' as const, timeoutMs: 900_000 };
    await db.insert(jobs).values(running);
    let release!: () => void;
    let reached = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    const siblings = app.ctx.updates.siblings.bind(app.ctx.updates);
    const spy = vi.spyOn(app.ctx.updates, 'siblings').mockImplementationOnce(async tag => {
      reached = true;
      await held;
      return siblings(tag);
    });
    onTestFinished(() => { release(); spy.mockRestore(); });
    const updating = app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: false, confirmTurns: 1 }, ...as(ceo) }).then(r => r);
    await until(() => reached);
    await db.insert(jobs).values(running);
    release();
    const response = await updating;
    expect(response.statusCode).toBe(409);
    expect(response.json().error.details).toEqual({ turns: 2 });
    expect(request(control)).toBeNull();
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

  it('calls off an update that waits for the agents', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, db, ceo, control } = await company(registry);
    updaterAlive(control);
    const [acme] = await db.select().from(companies);
    const [sub] = await db.select().from(subscriptions);
    const [job] = await db.insert(jobs).values({ companyId: acme!.id, subscriptionId: sub!.id, agentId: (await db.select().from(agents))[0]!.id, prompt: 'x', status: 'running', timeoutMs: 1000 }).returning();
    await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true }, ...as(ceo) });
    expect((await app.inject({ method: 'DELETE', url: '/api/updates', ...as(ceo) })).statusCode).toBe(204);
    await db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job!.id));
    await publishWorking(app.ctx, acme!.id);
    expect(request(control)).toBeNull();
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
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater.waiting).toEqual({ version: '0.4.1', commit: SHA });

    rmdirSync(join(control, 'request.json.new'));
    await publishWorking(app.ctx, acme!.id);
    await expect.poll(() => request(control)).toEqual(asked(registry, res.json().id));
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater.waiting).toBeNull();
  });

  it('says when no updater runs', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, ceo, control } = await company(registry);
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater).toEqual({ present: false, status: null, waiting: null });
    const missing = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest' }, ...as(ceo) });
    expect(missing.statusCode).toBe(503);
    expect(missing.json().error.reason).toBe('updater_missing');
    updaterAlive(control, 31);
    expect((await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest' }, ...as(ceo) })).statusCode).toBe(503);
  });
});
