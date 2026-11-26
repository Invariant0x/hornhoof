import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessUnit, ServerMessage } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ pause: null as null | ((operation: string, path: string) => Promise<void>) }));
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => { await fs.writeFile(...args); await io.pause?.('write', String(args[0])); },
    link: async (...args: Parameters<typeof fs.link>) => { await io.pause?.('rename', String(args[0])); return fs.link(...args); },
    rename: async (...args: Parameters<typeof fs.rename>) => { await io.pause?.('rename', String(args[0])); return fs.rename(...args); },
  };
});
import { encryptSecret } from '../src/crypto/secrets.js';
import { hashToken } from '../src/crypto/tokens.js';
import { departments, harnessBuilds, harnessProducts, jobs, machines, personAccess, subscriptions } from '../src/db/schema.js';
import { harnessGreeted, harnessRound, harnessSynced } from '../src/modules/testruns/harness.js';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { hostIdOf } from '../src/modules/network/join.js';
import { nextOf, until, type FakeNode } from './helpers.js';
import { company, gets, NODE_KEY } from './test-runs-company.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const REPO = 'https://github.com/acme/shop.git', COMMIT = 'c'.repeat(40), NEXT = 'e'.repeat(40);
const KEY = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function shared(env: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hh-harness-')); folders.push(dir);
  const c = await company({ HARNESS_DIR: dir, ...env });
  const unit = (over: Partial<HarnessUnit> = {}): HarnessUnit => ({ fencing: 1, repositoryScope: { companyId: c.dev.companyId, repositoryOwnerId: c.dev.id, repoUrlHash: hashToken(REPO) }, key: KEY, version: 'f'.repeat(64), unit: 'dependencies', commitSha: COMMIT, platform: 'linux-arm64', ...over });
  const leases = new Map<string, { companyId: string; attempt: string }>();
  const as = (key: string, build = KEY) => {
    const lease = leases.get(key + ':' + build) ?? leases.get(build);
    return { authorization: 'Bearer ' + key, 'x-harness-company': c.dev.companyId, 'x-harness-attempt': lease?.attempt ?? '11111111-1111-4111-8111-111111111111' };
  };
  const claim = async (key: string, over: Partial<HarnessUnit> = {}) => {
    const response = await c.app.inject({ method: 'POST', url: '/api/harness/claim', headers: as(key), payload: unit(over) });
    const lease = response.json() as { companyId?: string; attempt?: string };
    if (lease.companyId && lease.attempt) {
      const value = { companyId: lease.companyId, attempt: lease.attempt }, build = over.key ?? KEY;
      leases.set(key + ':' + build, value); leases.set(build, value);
    }
    return response;
  };
  const part = (key: string, index: number, bytes: Buffer, build = KEY) => c.app.inject({ method: 'PUT', url: '/api/harness/' + build + '/parts/' + index, headers: { ...as(key, build), 'content-type': 'application/octet-stream' }, payload: bytes });
  const finish = (key: string, bytes: Buffer, build = KEY) => c.app.inject({ method: 'POST', url: '/api/harness/' + build + '/done', headers: as(key, build), payload: { digest: sha(bytes), size: bytes.length } });
  const failed = (key: string, error: string | null, build = KEY) => c.app.inject({ method: 'POST', url: '/api/harness/' + build + '/failed', headers: as(key, build), payload: { error } });
  const bundle = (key: string, range: string, build = KEY) => c.app.inject({ method: 'GET', url: '/api/harness/' + build + '/bundle', headers: { ...as(key, build), range } });
  const uploaded = async (key: string, bytes: Buffer, build = KEY) => { await part(key, 0, bytes, build); return finish(key, bytes, build); };
  return { ...c, dir, unit, claim, part, finish, failed, bundle, uploaded };
}
type Shared = Awaited<ReturnType<typeof shared>>;

function pauseIO(operation: string) {
  const deferred = () => {
    let finish = () => {};
    const promise = new Promise<void>(resolve => { finish = resolve; });
    return { promise, resolve: () => finish() };
  };
  const entered = deferred(), resume = deferred();
  io.pause = async (kind, path) => {
    if (kind !== operation || !path.includes('.parts') && !path.includes('.staging-')) return;
    io.pause = null; entered.resolve(); await resume.promise;
  };
  return { entered: entered.promise, resume: () => resume.resolve() };
}
afterEach(() => { io.pause = null; });

describe('harness access and attempt fences', () => {
  it('lets an old node build locally without giving it an unfenced shared claim', async () => {
    const c = await shared(), one = await c.machine(c.ceo, 'old');
    const response = await c.app.inject({ method: 'POST', url: '/api/harness/claim', headers: { authorization: 'Bearer ' + one.key }, payload: c.unit({ fencing: undefined }) });
    expect(response.json()).toEqual({ state: 'local' });
    expect(await c.db.select().from(harnessBuilds)).toEqual([]);
  });

  it.each(['subscription', 'access', 'lending', 'machine'])('rejects every write after revoking %s, without publication or a head wake', async revoked => {
    const c = await shared(), one = await c.machine(c.ann, 'builder'), bytes = Buffer.from('private');
    await c.claim(one.key); await c.part(one.key, 0, bytes);
    if (revoked === 'subscription') await c.db.update(subscriptions).set({ removedAt: new Date() }).where(eq(subscriptions.id, one.subscriptionId));
    if (revoked === 'lending') await c.db.update(machines).set({ lendsTests: false }).where(eq(machines.id, one.machineId));
    if (revoked === 'machine') await c.db.update(machines).set({ revokedAt: new Date() }).where(eq(machines.id, one.machineId));
    if (revoked === 'access') {
      const [machine] = await c.db.select().from(machines).where(eq(machines.id, one.machineId));
      await c.db.delete(personAccess).where(eq(personAccess.personId, machine!.personId));
    }
    expect((await c.part(one.key, 1, bytes)).statusCode).toBe(403);
    expect((await c.finish(one.key, bytes)).statusCode).toBe(403);
    expect((await c.failed(one.key, 'untrusted failure')).statusCode).toBe(403);
    expect((await c.db.select().from(harnessBuilds))[0]).toMatchObject({ status: 'building', error: null });
    expect((await turnsOf(c, c.head.id)).join('\n')).not.toContain('untrusted failure');
    expect((await c.claim(one.key)).statusCode).toBe(403);
  });

  it('rejects writes after lease expiry even before another builder claims it', async () => {
    const c = await shared(), one = await c.machine(c.ceo, 'builder'), bytes = Buffer.from('private');
    await c.claim(one.key); await c.part(one.key, 0, bytes);
    await c.db.update(harnessBuilds).set({ leaseUntil: new Date(Date.now() - 1000) });
    expect((await c.part(one.key, 1, bytes)).statusCode).toBe(409);
    expect((await c.finish(one.key, bytes)).statusCode).toBe(409);
    expect((await c.failed(one.key, 'expired')).statusCode).toBe(409);
  });

  it('renews the same attempt, and replaces it after expiry even for the same builder', async () => {
    const c = await shared(), one = await c.machine(c.ceo, 'builder');
    await c.claim(one.key); const [first] = await c.db.select().from(harnessBuilds);
    await c.claim(one.key); expect((await c.db.select().from(harnessBuilds))[0]!.id).toBe(first!.id);
    await c.db.update(harnessBuilds).set({ leaseUntil: new Date(Date.now() - 1000) });
    await c.claim(one.key); expect((await c.db.select().from(harnessBuilds))[0]!.id).not.toBe(first!.id);
    const headers = { authorization: 'Bearer ' + one.key, 'x-harness-company': c.dev.companyId, 'x-harness-attempt': first!.id };
    for (const route of ['parts/0', 'done', 'failed']) {
      const response = await c.app.inject({ method: route === 'parts/0' ? 'PUT' : 'POST', url: '/api/harness/' + KEY + '/' + route, headers: { ...headers, 'content-type': route === 'parts/0' ? 'application/octet-stream' : 'application/json' }, payload: route === 'parts/0' ? Buffer.from('stale') : route === 'done' ? { digest: sha(Buffer.from('stale')), size: 5 } : { error: 'stale failure' } });
      expect(response.statusCode).toBe(409);
    }
    expect((await turnsOf(c, c.head.id)).join('\n')).not.toContain('stale failure');
  });

  it('refuses private bundles and claims from a removed subscription', async () => {
    const c = await shared(), one = await c.machine(c.ann, 'one');
    await c.claim(one.key); await c.uploaded(one.key, Buffer.from('private'));
    await c.db.update(subscriptions).set({ removedAt: new Date() }).where(eq(subscriptions.id, one.subscriptionId));
    expect((await c.bundle(one.key, 'all')).statusCode).toBe(403);
    expect((await c.claim(one.key)).statusCode).toBe(403);
  });

  it.each(['write', 'rename'])('fences a delayed %s after another builder has published', async operation => {
    const c = await shared(), one = await c.machine(c.ceo, 'one'), two = await c.machine(c.ann, 'two');
    const old = Buffer.from('old bundle'), current = Buffer.from('current bundle');
    await c.claim(one.key); await c.part(one.key, 0, old);
    const gate = pauseIO(operation);
    const pending = (operation === 'write' ? c.part(one.key, 0, old) : c.finish(one.key, old)).then(response => response.statusCode);
    await gate.entered;
    try {
      await c.db.update(harnessBuilds).set({ leaseUntil: new Date(Date.now() - 1000) });
      await c.claim(two.key); expect((await c.uploaded(two.key, current)).statusCode).toBe(204);
    } finally { gate.resume(); }
    expect(await pending).toBe(409);
    expect((await c.bundle(two.key, 'all')).rawPayload).toEqual(current);
    expect((await c.db.select().from(harnessBuilds))[0]).toMatchObject({ status: 'ready', digest: sha(current) });
    expect(await readdir(join(c.dir, c.dev.companyId))).toEqual([KEY + '.' + (await c.db.select().from(harnessBuilds))[0]!.id + '.zst']);
  });

  it('rechecks authorization after assembling a bundle', async () => {
    const c = await shared(), one = await c.machine(c.ann, 'one'), bytes = Buffer.from('bundle');
    await c.claim(one.key); await c.part(one.key, 0, bytes);
    const gate = pauseIO('rename'), pending = c.finish(one.key, bytes).then(response => response.statusCode);
    await gate.entered;
    try { await c.db.update(machines).set({ lendsTests: false }).where(eq(machines.id, one.machineId)); }
    finally { gate.resume(); }
    expect(await pending).toBe(403);
    expect((await c.db.select().from(harnessBuilds))[0]!.status).toBe('building');
    expect((await c.db.select().from(harnessProducts))).toEqual([]);
  });

  it('never overwrites a published archive with another delayed done from the same attempt', async () => {
    const c = await shared(), one = await c.machine(c.ceo, 'one');
    const old = Buffer.from('old'), current = Buffer.from('current');
    await c.claim(one.key); await c.part(one.key, 0, old);
    const gate = pauseIO('rename'), pending = c.finish(one.key, old).then(response => response.statusCode);
    await gate.entered;
    try { expect((await c.uploaded(one.key, current)).statusCode).toBe(204); }
    finally { gate.resume(); }
    expect(await pending).toBe(409);
    expect((await c.bundle(one.key, 'all')).rawPayload).toEqual(current);
  });

  it('keeps an old row whose reclaimed lease is still live when pruning', async () => {
    const c = await shared(), one = await c.machine(c.ceo, 'one');
    await c.claim(one.key);
    await c.db.update(harnessBuilds).set({ createdAt: new Date(Date.now() - 31 * 86400_000) });
    await c.claim(one.key, { key: OTHER }); await c.uploaded(one.key, Buffer.from('other'), OTHER);
    expect((await c.db.select().from(harnessBuilds)).map(build => build.key)).toContain(KEY);
  });

  it('scopes builtin bundle reads to the explicitly named company', async () => {
    const c = await shared(); await c.builtin();
    await c.claim('builtin-node-key-0123456789abcdef');
    const bytes = Buffer.from('company one'); await c.uploaded('builtin-node-key-0123456789abcdef', bytes);
    const response = await c.app.inject({ method: 'GET', url: '/api/harness/' + KEY + '/bundle', headers: { authorization: 'Bearer builtin-node-key-0123456789abcdef', 'x-harness-company': '33333333-3333-4333-8333-333333333333', 'x-harness-attempt': (await c.db.select().from(harnessBuilds))[0]!.id } });
    expect(response.statusCode).toBe(404);
  });
});

/* What the node said so far is handled: a mark it sends comes back after it, as the server handles a node's messages one
   after another. */
async function handled(node: FakeNode): Promise<void> {
  const jobId = randomUUID();
  node.send({ type: 'job.done', jobId, ok: true, sessionId: 'mark', result: '', tail: '', error: null });
  await until(() => node.acks.includes(jobId));
}
const takesHarnesses = (node: FakeNode) => { node.send({ type: 'status', loggedIn: true, limits: null, testEnvironmentVersion: 1, testRuntimes: [], testHarness: 1 }); };
/* A machine that says it takes harnesses. */
async function capable(c: Shared, token: string, name: string) {
  const machine = await c.machine(token, name);
  takesHarnesses(machine.node);
  await handled(machine.node);
  return machine;
}
const atHead = (c: Shared, commitSha = COMMIT) => { c.app.ctx.readCommit = async (_repo, want) => ({ branch: 'branch' in want ? want.branch : 'main', commitSha }); };
const asked = (node: FakeNode) => nextOf(node, 'tests.harness');
const synced = (message: Extract<ServerMessage, { type: 'tests.harness' }>, over: object = {}) => ({ type: 'tests.harness.done' as const, requestId: message.requestId, commitSha: message.commitSha, result: { status: 'ready' as const, version: 'f'.repeat(64), keys: [KEY] }, ...over });
const turnsOf = async (c: Shared, agentId: string) => (await c.db.select().from(jobs).where(eq(jobs.agentId, agentId))).map(job => job.prompt);

describe('one build of a harness unit for all machines', () => {
  it('lets the first machine build, keeps the next one waiting, and hands the bundle to it', async () => {
    const c = await shared(), one = await c.machine(c.ceo, 'one'), two = await c.machine(c.ann, 'two');
    expect((await c.claim(one.key)).json()).toMatchObject({ state: 'build' });
    expect((await c.claim(two.key)).json()).toMatchObject({ state: 'wait' });
    const bytes = Buffer.from('a bundle of a harness unit');
    expect((await c.part(one.key, 0, bytes.subarray(0, 10))).statusCode).toBe(204);
    expect((await c.part(one.key, 1, bytes.subarray(10))).statusCode).toBe(204);
    expect((await c.finish(one.key, bytes)).statusCode).toBe(204);
    expect((await c.claim(two.key)).json()).toMatchObject({ state: 'ready', digest: sha(bytes), size: bytes.length });
    const first = await c.bundle(two.key, 'bytes=0-9'), rest = await c.bundle(two.key, `bytes=10-${bytes.length - 1}`);
    expect(first.statusCode).toBe(206);
    expect(Buffer.concat([first.rawPayload, rest.rawPayload]).equals(bytes)).toBe(true);
    expect(await readdir(join(c.dir, c.dev.companyId))).toEqual([KEY + '.' + (await c.db.select().from(harnessBuilds))[0]!.id + '.zst']);
  });

  it('says no to a machine that says it is done before anything came', async () => {
    const c = await shared(), one = await c.machine(c.ceo, 'one');
    await c.claim(one.key);
    expect((await c.finish(one.key, Buffer.from('nothing of this came'))).statusCode).toBe(409);
  });

  it('starts from nothing when a build passes to another machine, so what the last one sent makes no part of it', async () => {
    const c = await shared(), one = await c.machine(c.ceo, 'one'), two = await c.machine(c.ann, 'two');
    await c.claim(one.key);
    await c.part(one.key, 0, Buffer.from('a longer bundle'));
    await c.part(one.key, 1, Buffer.from(' than the next'));
    await c.failed(one.key, null);
    await c.claim(two.key);
    const bytes = Buffer.from('a shorter one');
    expect((await c.uploaded(two.key, bytes)).statusCode).toBe(204);
    expect((await c.claim(one.key)).json()).toMatchObject({ state: 'ready', digest: sha(bytes), size: bytes.length });
  });

  it('takes a range open to the end, one running past the end and none at all, and refuses one past the end', async () => {
    const c = await shared(), one = await c.machine(c.ceo, 'one'), bytes = Buffer.from('a bundle of a harness unit');
    await c.claim(one.key); await c.uploaded(one.key, bytes);
    expect((await c.bundle(one.key, 'bytes=10-')).rawPayload.equals(bytes.subarray(10))).toBe(true);
    expect((await c.bundle(one.key, 'bytes=10-100000')).rawPayload.equals(bytes.subarray(10))).toBe(true);
    expect((await c.bundle(one.key, 'all of it')).rawPayload.equals(bytes)).toBe(true);
    expect((await c.bundle(one.key, `bytes=${bytes.length}-`)).statusCode).toBe(416);
  });

  it('gives a machine of another architecture a build of its own', async () => {
    const c = await shared(), one = await c.machine(c.ceo, 'one'), two = await c.machine(c.ann, 'two');
    expect((await c.claim(one.key)).json().state).toBe('build');
    expect((await c.claim(two.key, { key: OTHER, platform: 'linux-x64' })).json().state).toBe('build');
    const rows = await c.db.select().from(harnessBuilds);
    expect(rows.map(row => row.version)).toEqual(['f'.repeat(64), 'f'.repeat(64)]);
    expect(rows.map(row => row.platform).sort()).toEqual(['linux-arm64', 'linux-x64']);
  });

  it('refuses a bundle other than the one the builder said it made, and a bundle of a machine that does not hold the build', async () => {
    const c = await shared(), one = await c.machine(c.ceo, 'one'), two = await c.machine(c.ann, 'two');
    await c.claim(one.key);
    expect((await c.part(two.key, 0, Buffer.from('other'))).statusCode).toBe(409);
    await c.part(one.key, 0, Buffer.from('truncated'));
    expect((await c.finish(one.key, Buffer.from('not what came'))).statusCode).toBe(409);
    expect((await c.db.select().from(harnessBuilds))[0]).toMatchObject({ status: 'building' });
    expect((await c.bundle(two.key, 'bytes=0-1')).statusCode).toBe(404);
  });

  it('passes the build on when the machine that held it stopped answering', async () => {
    const c = await shared(), one = await c.machine(c.ceo, 'one'), two = await c.machine(c.ann, 'two');
    await c.claim(one.key);
    await c.db.update(harnessBuilds).set({ leaseUntil: new Date(Date.now() - 1000) });
    expect((await c.claim(two.key)).json().state).toBe('build');
    expect((await c.part(one.key, 0, Buffer.from('late'))).statusCode).toBe(409);
  });

  it('keeps the claim of a machine that says it still builds', async () => {
    const c = await shared(), one = await c.machine(c.ceo, 'one');
    await c.claim(one.key);
    /* Live for a minute more, longer than a test may take: the claim renews it for the build's whole lease past that. */
    const live = new Date(Date.now() + 60_000);
    await c.db.update(harnessBuilds).set({ leaseUntil: live });
    expect((await c.claim(one.key)).json().state).toBe('build');
    expect((await c.db.select().from(harnessBuilds))[0]!.leaseUntil!.getTime()).toBeGreaterThan(live.getTime());
  });

  it('gives a stopped build to the next machine without calling it failed', async () => {
    const c = await shared(), one = await c.machine(c.ceo, 'one'), two = await c.machine(c.ann, 'two');
    await c.claim(one.key);
    expect((await c.failed(one.key, null)).statusCode).toBe(204);
    expect((await c.claim(two.key)).json().state).toBe('build');
    expect((await c.db.select().from(harnessBuilds))[0]).toMatchObject({ failures: 0, error: null });
  });

  it('says why a unit failed, tells the head once, and lets it be built again only after a pause', async () => {
    const c = await shared(), one = await c.machine(c.ceo, 'one'), two = await c.machine(c.ann, 'two');
    await c.claim(one.key);
    await c.failed(one.key, 'npm ci failed: no such version');
    expect((await c.claim(two.key)).json()).toMatchObject({ state: 'failed', error: 'npm ci failed: no such version' });
    expect((await turnsOf(c, c.head.id)).join('\n')).toContain('npm ci failed: no such version');
    expect((await c.db.select().from(harnessProducts))[0]!.problem).toMatchObject({ code: 'build_failed', commitSha: COMMIT });
    await c.db.update(harnessBuilds).set({ nextTryAt: new Date(Date.now() - 1000) });
    expect((await c.claim(two.key)).json().state).toBe('build');
    await c.failed(two.key, 'npm ci failed: no such version');
    expect((await c.db.select().from(harnessBuilds))[0]).toMatchObject({ failures: 2 });
    expect((await turnsOf(c, c.head.id)).filter(prompt => prompt.includes('no such version'))).toHaveLength(1);
  });

  it('builds a unit again when its bundle is gone, and answers 404 before streaming if asked for the missing bundle', async () => {
    const c = await shared(), one = await c.machine(c.ceo, 'one'), bytes = Buffer.from('a bundle');
    await c.claim(one.key); await c.uploaded(one.key, bytes);
    await rm(join(c.dir, c.dev.companyId, KEY + '.' + (await c.db.select().from(harnessBuilds))[0]!.id + '.zst'));
    expect((await c.bundle(one.key, 'bytes=0-3')).statusCode).toBe(404);
    expect((await c.claim(one.key)).json().state).toBe('build');
  });

  it('asks each machine to build for itself when the server keeps no bundles', async () => {
    const c = await company(), one = await c.machine(c.ceo, 'one');
    const res = await c.app.inject({ method: 'POST', url: '/api/harness/claim', headers: { authorization: `Bearer ${one.key}` }, payload: { repositoryScope: { companyId: c.dev.companyId, repositoryOwnerId: c.dev.id, repoUrlHash: hashToken(REPO) }, key: KEY, version: 'f'.repeat(64), unit: 'dependencies', commitSha: COMMIT, platform: 'linux-arm64' } });
    expect(res.json()).toEqual({ state: 'local' });
  });

  it('removes the bundles used longest ago when they take more than they may', async () => {
    const c = await shared({ HARNESS_MB: '1' }), one = await c.machine(c.ceo, 'one'), big = Buffer.alloc(700 * 1024, 1);
    await c.claim(one.key); await c.uploaded(one.key, big);
    await c.claim(one.key, { key: OTHER }); await c.uploaded(one.key, big, OTHER);
    expect((await c.db.select().from(harnessBuilds)).map(row => row.key)).toEqual([OTHER]);
    expect(await readdir(join(c.dir, c.dev.companyId))).toEqual([OTHER + '.' + (await c.db.select().from(harnessBuilds))[0]!.id + '.zst']);
  });
});

describe('who may share a build', () => {
  it('refuses a machine whose owner does not reach the product, and one that lends nothing', async () => {
    const c = await shared(), stranger = await c.machine(c.bob, 'stranger'), lender = await c.machine(c.ann, 'lender');
    expect((await c.claim(stranger.key)).statusCode).toBe(403);
    await c.db.update(machines).set({ lendsTests: false }).where(eq(machines.id, lender.machineId));
    expect((await c.claim(lender.key)).statusCode).toBe(403);
  });

  it('refuses another repository under the name of this product, and an unknown key', async () => {
    const c = await shared(), one = await c.machine(c.ceo, 'one');
    expect((await c.claim(one.key, { repositoryScope: { companyId: c.dev.companyId, repositoryOwnerId: c.dev.id, repoUrlHash: 'd'.repeat(64) } })).statusCode).toBe(404);
    expect((await c.claim('no-such-key')).statusCode).toBe(401);
  });

  it('never hands a bundle to a machine that may not take the product', async () => {
    const c = await shared(), one = await c.machine(c.ceo, 'one'), stranger = await c.machine(c.bob, 'stranger');
    await c.claim(one.key); await c.uploaded(one.key, Buffer.from('private'));
    expect((await c.bundle(stranger.key, 'bytes=0-1')).statusCode).toBe(403);
  });

  /* A built-in node runs on a computer of the company too. That computer taken off checks, the node neither takes a build
     nor hands in one it began: its claim ends with its lease, the build passes to a machine that may take it, and once the
     computer lends itself again the node builds and hands in again (#1118). The key a built-in node of the server's own
     computer or of another one says; the computer it runs on. */
  const builtinOn: Record<string, (c: Shared) => Promise<{ key: string; computer: string }>> = {
    'the server’s own': async c => {
      await c.builtin();
      return { key: NODE_KEY, computer: (await c.machine(c.ceo, 'home-box')).machineId };
    },
    'another machine’s': async c => {
      const MACHINE = 'd0'.repeat(16);
      const [row] = await c.db.select({ companyId: machines.companyId, personId: machines.personId }).from(machines).limit(1);
      const [box] = await c.db.insert(machines).values({ ...row!, machineKey: 'mac-box-0001', hostname: 'mac-box', role: 'worker', networkId: MACHINE }).returning();
      return { key: `builtin.${MACHINE}.${createHmac('sha256', NODE_KEY).update(`hornhoof builtin node ${MACHINE}`).digest('hex')}`, computer: box!.id };
    },
  };
  it.each(Object.keys(builtinOn))('takes no build back from %s built-in node once its computer is taken off checks', async whose => {
    const c = await shared({ HORNHOOF_HOST_ID: hostIdOf('home-box-0001-abcd') }), lender = await c.machine(c.ann, 'lender');
    const { key, computer } = await builtinOn[whose]!(c), lends = (lendsTests: boolean) => c.db.update(machines).set({ lendsTests }).where(eq(machines.id, computer));
    const begun = Buffer.from('begun on the built-in node'), done = Buffer.from('built by the lender');
    expect((await c.claim(key)).json()).toMatchObject({ state: 'build' });
    expect((await c.part(key, 0, begun)).statusCode).toBe(204);
    await lends(false);
    expect((await c.finish(key, begun)).statusCode).toBe(403);
    expect((await c.part(key, 1, begun)).statusCode).toBe(403);
    expect((await c.failed(key, 'untrusted failure')).statusCode).toBe(403);
    expect((await c.claim(key)).statusCode).toBe(403);
    expect((await c.db.select().from(harnessBuilds))[0]).toMatchObject({ status: 'building', error: null, digest: null });
    expect((await c.claim(lender.key)).json().state).toBe('wait');
    await c.db.update(harnessBuilds).set({ leaseUntil: new Date(Date.now() - 1000) });
    expect((await c.claim(lender.key)).json().state).toBe('build');
    expect((await c.uploaded(lender.key, done)).statusCode).toBe(204);
    await lends(true);
    expect((await c.claim(key)).json()).toMatchObject({ state: 'ready', digest: sha(done) });
    expect((await c.claim(key, { key: OTHER })).json()).toMatchObject({ state: 'build' });
    expect((await c.uploaded(key, begun, OTHER)).statusCode).toBe(204);
  });
});

describe('the harness reaching every machine', () => {
  it('reports a local build failure when no registry attempt could report it', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'legacy-local');
    atHead(c); await harnessRound(c.app.ctx);
    await harnessSynced(c.app.ctx, nodeIdentity(one.nodeId), synced(await asked(one.node), { result: { status: 'error', problem: { code: 'build_failed', detail: 'local preparation broke' } } }));
    expect((await c.db.select().from(harnessProducts))[0]!.problem).toMatchObject({ code: 'build_failed', detail: 'local preparation broke' });
    expect((await turnsOf(c, c.head.id)).join('\n')).toContain('local preparation broke');
  });

  it('ignores a forged commit without consuming the matching active request', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'one');
    atHead(c); await harnessRound(c.app.ctx); const request = await asked(one.node);
    await harnessSynced(c.app.ctx, nodeIdentity(one.nodeId), synced(request, { commitSha: NEXT }));
    expect((await c.db.select().from(harnessProducts))[0]!.goodCommit).toBeNull();
    await harnessSynced(c.app.ctx, nodeIdentity(one.nodeId), synced(request));
    expect((await c.db.select().from(harnessProducts))[0]!.goodCommit).toBe(COMMIT);
  });

  it('does not let a slow old ready overwrite a newer head problem', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'one');
    atHead(c); await harnessRound(c.app.ctx); const old = await asked(one.node);
    atHead(c, NEXT); await harnessRound(c.app.ctx); const current = await asked(one.node);
    await harnessSynced(c.app.ctx, nodeIdentity(one.nodeId), synced(current, { result: { status: 'error', problem: { code: 'environment_unsupported', detail: 'current head broken' } } }));
    const [before] = await c.db.select().from(harnessProducts);
    await harnessSynced(c.app.ctx, nodeIdentity(one.nodeId), synced(old));
    const [after] = await c.db.select().from(harnessProducts);
    expect(after).toMatchObject({ goodCommit: before!.goodCommit, problem: before!.problem, told: before!.told });
    expect(after!.machines).toEqual(before!.machines);
  });

  it('keeps another machine problem and one notification through a healthy reconnect until all recover', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'healthy-arm'), two = await capable(c, c.ann, 'broken-x64');
    atHead(c); await harnessRound(c.app.ctx);
    const healthy = await asked(one.node), broken = await asked(two.node);
    const fail = (request: typeof broken, detail: string) => harnessSynced(c.app.ctx, nodeIdentity(two.nodeId), synced(request, { result: { status: 'error', problem: { code: 'environment_unsupported', detail } } }));
    await fail(broken, 'x64 broken');
    await harnessSynced(c.app.ctx, nodeIdentity(one.nodeId), synced(healthy));
    expect((await c.db.select().from(harnessProducts))[0]!.problem).toBeTruthy();
    harnessGreeted(c.app.ctx, nodeIdentity(one.nodeId)); await harnessRound(c.app.ctx);
    await harnessSynced(c.app.ctx, nodeIdentity(one.nodeId), synced(await asked(one.node)));
    await harnessRound(c.app.ctx, new Date(Date.now() + 31 * 60_000));
    await fail(await asked(two.node), 'x64 still broken');
    expect((await turnsOf(c, c.head.id)).filter(prompt => prompt.includes('x64'))).toHaveLength(1);
    await harnessRound(c.app.ctx, new Date(Date.now() + 62 * 60_000));
    await harnessSynced(c.app.ctx, nodeIdentity(two.nodeId), synced(await asked(two.node)));
    expect((await c.db.select().from(harnessProducts))[0]).toMatchObject({ problem: null, told: null, goodCommit: COMMIT });
  });

  it('asks every machine that takes harnesses for the head of the branch, once, and again when it moves', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'one'), two = await capable(c, c.ann, 'two'), old = await c.planless(c.ceo, 'old');
    atHead(c);
    await harnessRound(c.app.ctx);
    expect(await asked(one.node)).toMatchObject({ commitSha: COMMIT, repo: { url: REPO }, repositoryScope: { repositoryOwnerId: c.dev.id } });
    expect((await asked(two.node)).commitSha).toBe(COMMIT);
    expect(await gets(c.app.ctx, old.node, 'tests.harness')).toBe(false);
    await harnessRound(c.app.ctx);
    expect(await gets(c.app.ctx, one.node, 'tests.harness')).toBe(false);
    atHead(c, NEXT);
    await harnessRound(c.app.ctx);
    expect((await asked(one.node)).commitSha).toBe(NEXT);
  });

  it('reads no repository while no machine could take its harness', async () => {
    const c = await shared();
    c.app.ctx.readCommit = () => Promise.reject(new Error('asked'));
    await expect(harnessRound(c.app.ctx)).resolves.toBeUndefined();
  });

  it('records what each machine has, and which commit is good', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'one');
    atHead(c);
    await c.claim(one.key); await c.uploaded(one.key, Buffer.from('bundle'));
    await harnessRound(c.app.ctx);
    one.node.send(synced(await asked(one.node)));
    await handled(one.node);
    expect((await c.db.select().from(harnessProducts))[0]?.goodCommit).toBe(COMMIT);
    const [product] = await c.db.select().from(harnessProducts), [build] = await c.db.select().from(harnessBuilds);
    expect(Object.values(product!.machines)).toMatchObject([{ name: 'one', commitSha: COMMIT, problem: null }]);
    expect(build!.copies).toEqual([one.nodeId]);
  });

  it('keeps the last good commit when an update breaks, and tells the head once however many machines report it', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'one'), two = await capable(c, c.ann, 'two');
    atHead(c);
    await harnessRound(c.app.ctx);
    one.node.send(synced(await asked(one.node)));
    two.node.send(synced(await asked(two.node)));
    await handled(one.node); await handled(two.node);
    expect((await c.db.select().from(harnessProducts))[0]?.goodCommit).toBe(COMMIT);
    atHead(c, NEXT);
    await harnessRound(c.app.ctx);
    const problem = { status: 'error' as const, problem: { code: 'environment_unsupported' as const, detail: 'This repository needs a Go toolchain.' } };
    one.node.send(synced(await asked(one.node), { result: problem }));
    two.node.send(synced(await asked(two.node), { result: problem }));
    await handled(one.node); await handled(two.node);
    expect(Object.values((await c.db.select().from(harnessProducts))[0]!.machines).filter(m => m.problem).length).toBe(2);
    const [product] = await c.db.select().from(harnessProducts);
    expect(product).toMatchObject({ goodCommit: COMMIT, problem: { code: 'environment_unsupported', commitSha: NEXT } });
    expect((await turnsOf(c, c.head.id)).filter(prompt => prompt.includes('Go toolchain'))).toHaveLength(1);
  });

  it('asks again later after a problem, and clears it once the commit is good', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'one');
    atHead(c);
    await harnessRound(c.app.ctx);
    one.node.send(synced(await asked(one.node), { result: { status: 'error', problem: { code: 'environment_unsupported', detail: 'Needs Go.' } } }));
    await handled(one.node);
    expect((await c.db.select().from(harnessProducts))[0]?.problem).toBeTruthy();
    await harnessRound(c.app.ctx);
    expect(await gets(c.app.ctx, one.node, 'tests.harness')).toBe(false);
    await harnessRound(c.app.ctx, new Date(Date.now() + 31 * 60_000));
    one.node.send(synced(await asked(one.node)));
    await handled(one.node);
    expect((await c.db.select().from(harnessProducts))[0]?.problem).toBeNull();
  });

  it('does not tell the head of a passing failure, and asks again', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'one');
    atHead(c);
    await harnessRound(c.app.ctx);
    one.node.send(synced(await asked(one.node), { result: { status: 'error', problem: { code: 'timeout', detail: 'Too slow.' } } }));
    await handled(one.node);
    expect((await turnsOf(c, c.head.id)).join('\n')).not.toContain('Too slow');
    await harnessRound(c.app.ctx, new Date(Date.now() + 31 * 60_000));
    expect((await asked(one.node)).commitSha).toBe(COMMIT);
  });

  it('sends a changed lock file built on any branch to the other machines', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'one'), two = await capable(c, c.ann, 'two');
    atHead(c);
    await c.claim(one.key, { commitSha: NEXT }); await c.uploaded(one.key, Buffer.from('new lock'));
    expect((await asked(two.node)).commitSha).toBe(NEXT);
    expect(await gets(c.app.ctx, one.node, 'tests.harness')).toBe(false);
  });

  it('sends the changed lock file of one program of several to the other machines', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'one'), two = await capable(c, c.ann, 'two');
    atHead(c);
    await c.claim(one.key, { commitSha: NEXT, unit: 'dependencies-go-api' }); await c.uploaded(one.key, Buffer.from('new lock'));
    expect((await asked(two.node)).commitSha).toBe(NEXT);
  });

  it('asks a machine once while it is at it, however many programs came ready', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'one'), two = await capable(c, c.ann, 'two');
    atHead(c);
    await c.claim(one.key, { commitSha: NEXT, unit: 'dependencies-go-api' }); await c.uploaded(one.key, Buffer.from('new lock'));
    const first = await asked(two.node);
    await c.claim(one.key, { commitSha: NEXT, unit: 'dependencies-python-ml', key: OTHER }); await c.uploaded(one.key, Buffer.from('another lock'), OTHER);
    expect(await gets(c.app.ctx, two.node, 'tests.harness')).toBe(false);
    two.node.send(synced(first));
    await handled(two.node);
    const third = 'd'.repeat(64);
    await c.claim(one.key, { commitSha: NEXT, unit: 'dependencies-web', key: third }); await c.uploaded(one.key, Buffer.from('a third lock'), third);
    expect((await asked(two.node)).commitSha).toBe(NEXT);
  });

  it('keeps a harness per program of a company, each on every machine that takes it', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'one'), two = await capable(c, c.ann, 'two');
    atHead(c);
    const others = await c.db.insert(departments).values(['api', 'site'].map((name, n) => ({ companyId: c.dev.companyId, templateKey: 'development' as const, roleCode: `D${n}`, position: 10 + n, repoUrl: `https://github.com/acme/${name}.git`, repoTokenEnc: encryptSecret('ghp_0123456789', c.app.ctx.config.secret), repoTokenLast4: '6789' }))).returning();
    await harnessRound(c.app.ctx);
    const seen = [await asked(one.node), await asked(one.node), await asked(one.node)].map(message => message.repo.url).sort();
    expect(seen).toEqual([REPO, ...others.map(other => other.repoUrl!)].sort());
    expect((await asked(two.node)).repo.url).toBe(REPO);
    expect(await gets(c.app.ctx, two.node, 'tests.harness')).toBe(false);
  });

  it('spreads only what is shared by all: a unit built from a branch stays where it was asked for', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'one'), two = await capable(c, c.ann, 'two');
    await c.claim(one.key, { commitSha: NEXT, unit: 'runtime-build' }); await c.uploaded(one.key, Buffer.from('build'));
    expect(await gets(c.app.ctx, two.node, 'tests.harness')).toBe(false);
  });

  it('asks a machine again after it came back, as its folder may be new', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'one');
    atHead(c);
    await harnessRound(c.app.ctx);
    one.node.send(synced(await asked(one.node)));
    await handled(one.node);
    expect((await c.db.select().from(harnessProducts))[0]?.goodCommit).toBe(COMMIT);
    one.node.close();
    const back = await c.reconnect(one);
    takesHarnesses(back);
    await handled(back);
    await harnessRound(c.app.ctx);
    expect((await asked(back)).commitSha).toBe(COMMIT);
  });
});

describe('what a person or a head sees of a harness', () => {
  it('shows the version, each architecture, the machines and what is wrong', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'one'), { call } = await c.turn(c.bruno);
    atHead(c);
    await c.claim(one.key); await c.uploaded(one.key, Buffer.from('bundle'));
    await c.claim(one.key, { key: OTHER, platform: 'linux-x64' }); await c.failed(one.key, 'no such version', OTHER);
    await harnessRound(c.app.ctx);
    one.node.send(synced(await asked(one.node)));
    await handled(one.node);
    expect((await c.db.select().from(harnessProducts))[0]?.goodCommit).toBe(COMMIT);
    const state = JSON.parse((await call('test_harness')).text) as { goodCommit: string; machines: { name: string }[]; builds: { platform: string; status: string; error: string | null }[] };
    expect(state.goodCommit).toBe(COMMIT);
    expect(state.machines.map(m => m.name)).toEqual(['one']);
    expect(state.builds.map(b => [b.platform, b.status]).sort()).toEqual([['linux-arm64', 'ready'], ['linux-x64', 'failed']]);
    expect(state.builds.find(b => b.status === 'failed')!.error).toBe('no such version');
  });
});
