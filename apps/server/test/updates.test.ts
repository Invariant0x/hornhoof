import Fastify, { type FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, utimesSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { agents, companies, departments, jobs, subscriptions } from '../src/db/schema.js';
import { publishWorking } from '../src/modules/events/store.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';
import { writeKeeperState, type Mode } from '../src/modules/keeper/state.js';
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

const updatableApp = (registry: { base: string }, commit: string, control: string, env: NodeJS.ProcessEnv = {}) =>
  testApp({
    HORNHOOF_IMAGE: 'ghcr.io/acme/hornhoof',
    REGISTRY_URL: registry.base,
    HORNHOOF_VERSION: '0.4.0',
    HORNHOOF_COMMIT: commit,
    HORNHOOF_CONTROL_DIR: control,
    ...env,
  });

async function company(registry: { base: string }, commit = 'aaa', control = mkdtempSync(join(tmpdir(), 'hh-control-'))) {
  const { app, db } = await updatableApp(registry, commit, control);
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

/* The updater is alive when it touched alive in the last 30 seconds. */
const updaterAlive = (control: string, ageSeconds = 0) => {
  writeFileSync(join(control, 'alive'), '');
  const when = Date.now() / 1000 - ageSeconds;
  utimesSync(join(control, 'alive'), when, when);
};
const request = (control: string) => (existsSync(join(control, 'request.json')) ? JSON.parse(readFileSync(join(control, 'request.json'), 'utf8')) : null);
const SHA = 'b'.repeat(40);
const HELD_AFTER_MS = 10 * 60_000;
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
    expect(request(control)).toEqual(asked(registry, now.json().id));
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

  it('stops waiting when the app leaves lead, and starts no updater on a machine that no longer leads', async () => {
    const registry = await fakeRegistry({ latest: { commit: SHA, version: '0.4.1' } });
    const { app, db, ceo, control, acme, job, stepDown } = await leadingCompany(registry);
    await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest', whenIdle: true }, ...as(ceo) });
    expect(turnsHeld(app.ctx, acme.id)).toBe(true);
    await stepDown();
    expect(turnsHeld(app.ctx, acme.id)).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater.waiting).toBeNull();
    await db.update(jobs).set({ status: 'done' }).where(eq(jobs.id, job.id));
    await publishWorking(app.ctx, acme.id);
    await settled();
    expect(request(control)).toBeNull();
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
    return { ...made, holdEnds: timeouts.mock.calls[at]![0] as () => void, holdTimeout: timeouts.mock.results[at]!.value as NodeJS.Timeout };
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
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json().updater).toEqual({ present: false, status: null, waiting: null });
    const missing = await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest' }, ...as(ceo) });
    expect(missing.statusCode).toBe(503);
    expect(missing.json().error.reason).toBe('updater_missing');
    updaterAlive(control, 31);
    expect((await app.inject({ method: 'POST', url: '/api/updates', payload: { version: 'latest' }, ...as(ceo) })).statusCode).toBe(503);
  });
});
