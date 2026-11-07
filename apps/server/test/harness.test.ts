import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessUnit, ServerMessage } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { encryptSecret } from '../src/crypto/secrets.js';
import { hashToken } from '../src/crypto/tokens.js';
import { departments, harnessBuilds, harnessProducts, jobs, machines } from '../src/db/schema.js';
import { harnessRound } from '../src/modules/testruns/harness.js';
import { nextOf, type FakeNode } from './helpers.js';
import { company, gets } from './test-runs-company.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const REPO = 'https://github.com/acme/shop.git', COMMIT = 'c'.repeat(40), NEXT = 'e'.repeat(40);
const KEY = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function shared(env: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hh-harness-')); folders.push(dir);
  const c = await company({ HARNESS_DIR: dir, ...env });
  const unit = (over: Partial<HarnessUnit> = {}): HarnessUnit => ({ repositoryScope: { companyId: c.dev.companyId, repositoryOwnerId: c.dev.id, repoUrlHash: hashToken(REPO) }, key: KEY, version: 'f'.repeat(64), unit: 'dependencies', commitSha: COMMIT, platform: 'linux-arm64', ...over });
  const as = (key: string) => ({ authorization: `Bearer ${key}` });
  const claim = (key: string, over: Partial<HarnessUnit> = {}) => c.app.inject({ method: 'POST', url: '/api/harness/claim', headers: as(key), payload: unit(over) });
  const part = (key: string, index: number, bytes: Buffer, build = KEY) => c.app.inject({ method: 'PUT', url: `/api/harness/${build}/parts/${index}`, headers: { ...as(key), 'content-type': 'application/octet-stream' }, payload: bytes });
  const finish = (key: string, bytes: Buffer, build = KEY) => c.app.inject({ method: 'POST', url: `/api/harness/${build}/done`, headers: as(key), payload: { digest: sha(bytes), size: bytes.length } });
  const failed = (key: string, error: string | null, build = KEY) => c.app.inject({ method: 'POST', url: `/api/harness/${build}/failed`, headers: as(key), payload: { error } });
  const bundle = (key: string, range: string, build = KEY) => c.app.inject({ method: 'GET', url: `/api/harness/${build}/bundle`, headers: { ...as(key), range } });
  const uploaded = async (key: string, bytes: Buffer, build = KEY) => { await part(key, 0, bytes, build); return finish(key, bytes, build); };
  return { ...c, dir, unit, claim, part, finish, failed, bundle, uploaded };
}
type Shared = Awaited<ReturnType<typeof shared>>;

const takesHarnesses = (node: FakeNode) => { node.send({ type: 'status', loggedIn: true, limits: null, testEnvironmentVersion: 1, testRuntimes: [], testHarness: 1 }); };
/* A machine that says it takes harnesses. */
async function capable(c: Shared, token: string, name: string) {
  const machine = await c.machine(token, name);
  takesHarnesses(machine.node);
  await new Promise(resolve => setTimeout(resolve, 50));
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
    expect(await readdir(join(c.dir, c.dev.companyId))).toEqual([`${KEY}.zst`]);
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
    await c.db.update(harnessBuilds).set({ leaseUntil: new Date(Date.now() + 1000) });
    expect((await c.claim(one.key)).json().state).toBe('build');
    expect((await c.db.select().from(harnessBuilds))[0]!.leaseUntil!.getTime()).toBeGreaterThan(Date.now() + 60_000);
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

  it('builds a unit again when its bundle is gone', async () => {
    const c = await shared(), one = await c.machine(c.ceo, 'one'), bytes = Buffer.from('a bundle');
    await c.claim(one.key); await c.uploaded(one.key, bytes);
    await rm(join(c.dir, c.dev.companyId, `${KEY}.zst`));
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
    expect(await readdir(join(c.dir, c.dev.companyId))).toEqual([`${OTHER}.zst`]);
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
});

describe('the harness reaching every machine', () => {
  it('asks every machine that takes harnesses for the head of the branch, once, and again when it moves', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'one'), two = await capable(c, c.ann, 'two'), old = await c.planless(c.ceo, 'old');
    atHead(c);
    await harnessRound(c.app.ctx);
    expect(await asked(one.node)).toMatchObject({ commitSha: COMMIT, repo: { url: REPO }, repositoryScope: { repositoryOwnerId: c.dev.id } });
    expect((await asked(two.node)).commitSha).toBe(COMMIT);
    expect(await gets(old.node, 'tests.harness')).toBe(false);
    await harnessRound(c.app.ctx);
    expect(await gets(one.node, 'tests.harness')).toBe(false);
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
    await expect.poll(async () => (await c.db.select().from(harnessProducts))[0]?.goodCommit).toBe(COMMIT);
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
    await expect.poll(async () => (await c.db.select().from(harnessProducts))[0]?.goodCommit).toBe(COMMIT);
    atHead(c, NEXT);
    await harnessRound(c.app.ctx);
    const problem = { status: 'error' as const, problem: { code: 'environment_unsupported' as const, detail: 'This repository needs a Go toolchain.' } };
    one.node.send(synced(await asked(one.node), { result: problem }));
    two.node.send(synced(await asked(two.node), { result: problem }));
    await expect.poll(async () => Object.values((await c.db.select().from(harnessProducts))[0]!.machines).filter(m => m.problem).length).toBe(2);
    const [product] = await c.db.select().from(harnessProducts);
    expect(product).toMatchObject({ goodCommit: COMMIT, problem: { code: 'environment_unsupported', commitSha: NEXT } });
    expect((await turnsOf(c, c.head.id)).filter(prompt => prompt.includes('Go toolchain'))).toHaveLength(1);
  });

  it('asks again later after a problem, and clears it once the commit is good', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'one');
    atHead(c);
    await harnessRound(c.app.ctx);
    one.node.send(synced(await asked(one.node), { result: { status: 'error', problem: { code: 'environment_unsupported', detail: 'Needs Go.' } } }));
    await expect.poll(async () => (await c.db.select().from(harnessProducts))[0]?.problem).toBeTruthy();
    await harnessRound(c.app.ctx);
    expect(await gets(one.node, 'tests.harness')).toBe(false);
    await harnessRound(c.app.ctx, new Date(Date.now() + 31 * 60_000));
    one.node.send(synced(await asked(one.node)));
    await expect.poll(async () => (await c.db.select().from(harnessProducts))[0]?.problem).toBeNull();
  });

  it('does not tell the head of a passing failure, and asks again', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'one');
    atHead(c);
    await harnessRound(c.app.ctx);
    one.node.send(synced(await asked(one.node), { result: { status: 'error', problem: { code: 'timeout', detail: 'Too slow.' } } }));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect((await turnsOf(c, c.head.id)).join('\n')).not.toContain('Too slow');
    await harnessRound(c.app.ctx, new Date(Date.now() + 31 * 60_000));
    expect((await asked(one.node)).commitSha).toBe(COMMIT);
  });

  it('sends a changed lock file built on any branch to the other machines', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'one'), two = await capable(c, c.ann, 'two');
    atHead(c);
    await c.claim(one.key, { commitSha: NEXT }); await c.uploaded(one.key, Buffer.from('new lock'));
    expect((await asked(two.node)).commitSha).toBe(NEXT);
    expect(await gets(one.node, 'tests.harness')).toBe(false);
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
    expect(await gets(two.node, 'tests.harness')).toBe(false);
    two.node.send(synced(first));
    await new Promise(resolve => setTimeout(resolve, 100));
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
    expect(await gets(two.node, 'tests.harness')).toBe(false);
  });

  it('spreads only what is shared by all: a unit built from a branch stays where it was asked for', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'one'), two = await capable(c, c.ann, 'two');
    await c.claim(one.key, { commitSha: NEXT, unit: 'runtime-build' }); await c.uploaded(one.key, Buffer.from('build'));
    expect(await gets(two.node, 'tests.harness')).toBe(false);
  });

  it('asks a machine again after it came back, as its folder may be new', async () => {
    const c = await shared(), one = await capable(c, c.ceo, 'one');
    atHead(c);
    await harnessRound(c.app.ctx);
    one.node.send(synced(await asked(one.node)));
    await expect.poll(async () => (await c.db.select().from(harnessProducts))[0]?.goodCommit).toBe(COMMIT);
    one.node.close();
    const back = await c.reconnect(one);
    takesHarnesses(back);
    await new Promise(resolve => setTimeout(resolve, 50));
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
    await expect.poll(async () => (await c.db.select().from(harnessProducts))[0]?.goodCommit).toBe(COMMIT);
    const state = JSON.parse((await call('test_harness')).text) as { goodCommit: string; machines: { name: string }[]; builds: { platform: string; status: string; error: string | null }[] };
    expect(state.goodCommit).toBe(COMMIT);
    expect(state.machines.map(m => m.name)).toEqual(['one']);
    expect(state.builds.map(b => [b.platform, b.status]).sort()).toEqual([['linux-arm64', 'ready'], ['linux-x64', 'failed']]);
    expect(state.builds.find(b => b.status === 'failed')!.error).toBe('no such version');
  });
});
