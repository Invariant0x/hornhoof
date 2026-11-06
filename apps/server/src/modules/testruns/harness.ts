import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { access, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { EnvironmentDigest, HarnessDone, HarnessFailed, HarnessUnit, type HarnessClaim, type HarnessSynced, type RepositoryScope, type Workspace } from '@hornhoof/protocol';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf } from '../../auth/access.js';
import { hashToken } from '../../crypto/tokens.js';
import { agents, departments, harnessBuilds, harnessProducts, machines, nodes, people, type HarnessMachine, type HarnessProblem } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { enqueueTurn, orchestratorOf } from '../conversation/queue.js';
import { quote } from '../conversation/prompt.js';
import { repoAt } from '../departments/repository.js';
import { sameNode, type NodeIdentity } from '../nodes/hub.js';
import { liveNode } from '../nodes/nodes.js';
import { identify } from '../nodes/socket.js';
import { repositoryScope } from './describe.js';
import { harnessPlaces } from './load.js';
import { mayTake, placesOf, type Place } from './runs.js';

/* A product's test harness as one thing for all the company's machines. A unit is built once per architecture: the first
   machine to ask holds a lease and builds, the others wait and take its bundle through here. Every minute the machines are
   asked to get the head of the product's branch ready, so a run on any of them finds it there. */

type Build = typeof harnessBuilds.$inferSelect;
type Department = typeof departments.$inferSelect;
type Repo = NonNullable<Workspace['repo']>;

/* How long a claim lasts without a word from its machine, which says it again every minute while it builds. */
const LEASE_MS = 3 * 60_000;
const WAIT_MS = 5_000;
/* A bundle travels in parts, each sent again by itself, as a whole one would not get through a slow link. */
export const PART_BYTES = 32 * 1024 ** 2;
/* A build that failed is tried again after this long, twice that after the next failure, and at most this long apart. */
const RETRY_MS = 5 * 60_000;
const RETRY_MAX_MS = 60 * 60_000;
/* A machine with a problem, or one that never answered, is asked again after these. */
const ASK_AGAIN_MS = 30 * 60_000;
const NO_ANSWER_MS = 2 * 60 * 60_000;
const READ_HEAD_MS = 10_000;
const OLD_ROWS_MS = 30 * 24 * 60 * 60_000;
/* These pass by themselves and say nothing of the product. */
const PASSING: string[] = ['cancelled', 'timeout', 'commit_unavailable'];

const who = (node: NodeIdentity): string => (node.kind === 'builtin' ? 'builtin' : node.nodeId);
const bundleFile = (dir: string, build: Pick<Build, 'companyId' | 'key'>) => join(dir, build.companyId, `${build.key}.zst`);
const partsFolder = (dir: string, build: Pick<Build, 'companyId' | 'key'>) => join(dir, build.companyId, `${build.key}.parts`);
const exists = (path: string) => access(path).then(() => true, () => false);

/* What a machine asking for a unit does next, by the unit's row: the one decision of who builds. */
const stillFailed = (build: Build, now: Date): build is Build & { nextTryAt: Date } => build.status === 'failed' && !!build.nextTryAt && build.nextTryAt > now;
const builtElsewhere = (build: Build, me: string, now: Date): boolean => build.status === 'building' && build.builder !== me && !!build.leaseUntil && build.leaseUntil > now;
export function decideClaim(build: Build, me: string, now: Date, stored: boolean): { answer: HarnessClaim; set?: Partial<Build> } {
  if (build.status === 'ready' && stored) return { answer: { state: 'ready', digest: build.digest!, size: build.size!, partBytes: PART_BYTES }, set: { usedAt: now } };
  if (stillFailed(build, now)) return { answer: { state: 'failed', error: build.error ?? '', afterMs: build.nextTryAt.getTime() - now.getTime() } };
  if (builtElsewhere(build, me, now)) return { answer: { state: 'wait', afterMs: WAIT_MS } };
  return { answer: { state: 'build', partBytes: PART_BYTES }, set: { status: 'building', builder: me, leaseUntil: new Date(now.getTime() + LEASE_MS), digest: null, size: null } };
}

/* A machine shares a product's harness when it may take the product's parts: it lends its time, and its owner reaches the
   department. What one builds the others run, and what they build holds the product's dependencies. */
async function nodeMayTake(ctx: Ctx, node: NodeIdentity, department: Department): Promise<boolean> {
  if (node.kind === 'builtin') return true;
  const [found] = await ctx.db.select({ machine: machines, owner: people }).from(nodes)
    .innerJoin(machines, eq(machines.id, nodes.machineId)).innerJoin(people, eq(people.id, machines.personId))
    .where(and(eq(nodes.id, node.nodeId), eq(nodes.companyId, department.companyId), liveNode, isNull(machines.revokedAt), eq(machines.kind, 'computer')));
  if (!found) return false;
  return mayTake({ lent: found.machine.lendsTests, access: await accessOf(ctx.db, found.owner), works: true }, { kind: 'tests' }, department);
}

async function departmentFor(ctx: Ctx, node: NodeIdentity, scope: RepositoryScope): Promise<Department> {
  const [department] = await ctx.db.select().from(departments).where(and(eq(departments.id, scope.repositoryOwnerId), eq(departments.companyId, scope.companyId)));
  if (!department?.repoUrl || hashToken(department.repoUrl) !== scope.repoUrlHash) throw new ApiError(404, 'not_found', 'This product has no such repository.');
  if (!await nodeMayTake(ctx, node, department)) throw new ApiError(403, 'forbidden', 'This machine takes no tests of this product.');
  return department;
}

const ofNode = (node: NodeIdentity, key: string) => {
  if (node.kind === 'builtin') return eq(harnessBuilds.key, key);
  return and(eq(harnessBuilds.key, key), eq(harnessBuilds.companyId, sql`(select ${nodes.companyId} from ${nodes} where ${nodes.id} = ${node.nodeId})`));
};

export async function claimBuild(ctx: Ctx, node: NodeIdentity, unit: HarnessUnit, now = new Date()): Promise<HarnessClaim> {
  const department = await departmentFor(ctx, node, unit.repositoryScope), dir = ctx.config.harnessDir;
  if (!dir) return { state: 'local' };
  const me = who(node);
  return ctx.db.transaction(async tx => {
    await tx.insert(harnessBuilds).values({ companyId: department.companyId, departmentId: department.id, key: unit.key, version: unit.version, unit: unit.unit, platform: unit.platform, commitSha: unit.commitSha, builder: me, leaseUntil: new Date(now.getTime() + LEASE_MS) }).onConflictDoNothing();
    const [build] = await tx.select().from(harnessBuilds).where(and(eq(harnessBuilds.companyId, department.companyId), eq(harnessBuilds.key, unit.key))).for('update');
    if (build!.departmentId !== department.id) throw new ApiError(409, 'conflict', 'This key belongs to another product.');
    const decided = decideClaim(build!, me, now, await exists(bundleFile(dir, build!)));
    if (decided.set) await tx.update(harnessBuilds).set(decided.set).where(eq(harnessBuilds.id, build!.id));
    return decided.answer;
  });
}

/* Puts the parts together, and keeps the result only when it is what the builder said it made. */
async function assemble(dir: string, build: Build, digest: string, size: number): Promise<void> {
  const file = bundleFile(dir, build), staging = `${file}.staging-${randomUUID()}`, hash = createHash('sha256');
  let total = 0;
  const out: WriteStream = createWriteStream(staging, { flags: 'wx', mode: 0o600 });
  try {
    const names = (await readdir(partsFolder(dir, build)).catch(() => [])).filter(name => /^\d+$/.test(name)).sort((a, b) => Number(a) - Number(b));
    for (const name of names) {
      for await (const chunk of createReadStream(join(partsFolder(dir, build), name))) {
        hash.update(chunk as Buffer); total += (chunk as Buffer).length;
        if (!out.write(chunk)) await once(out, 'drain');
      }
    }
    await new Promise<void>(resolve => { out.end(() => { resolve(); }); });
    if (total !== size || hash.digest('hex') !== digest) throw new ApiError(409, 'conflict', 'The bundle that came differs from what the machine said it made.');
    await rename(staging, file);
    await rm(partsFolder(dir, build), { recursive: true, force: true });
  } finally { out.destroy(); await rm(staging, { force: true }); }
}

/* The bundles used longest ago go when they take more than they may, and rows of what never came ready after a while. */
async function prune(ctx: Ctx, dir: string, keep: string, now: Date): Promise<void> {
  const ready = await ctx.db.select().from(harnessBuilds).where(eq(harnessBuilds.status, 'ready')).orderBy(asc(harnessBuilds.usedAt), asc(harnessBuilds.createdAt));
  let total = ready.reduce((sum, build) => sum + (build.size ?? 0), 0);
  for (const build of ready) {
    if (total <= ctx.config.harnessBytes) break;
    if (build.key === keep) continue;
    await rm(bundleFile(dir, build), { force: true });
    await ctx.db.delete(harnessBuilds).where(eq(harnessBuilds.id, build.id));
    total -= build.size ?? 0;
  }
  const old = await ctx.db.delete(harnessBuilds).where(and(ne(harnessBuilds.status, 'ready'), lt(harnessBuilds.createdAt, new Date(now.getTime() - OLD_ROWS_MS)))).returning();
  for (const build of old) await rm(partsFolder(dir, build), { recursive: true, force: true });
}

async function headOfProduct(ctx: Ctx, department: Department): Promise<string | null> {
  const [head] = await ctx.db.select({ id: agents.id }).from(agents).where(and(eq(agents.departmentId, department.parentId ?? department.id), eq(agents.kind, 'head'), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  return head?.id ?? (await orchestratorOf(ctx, department.companyId))?.id ?? null;
}

const productName = (department: Department) => department.name ?? department.templateKey ?? 'the product';

/* The head hears of a problem once, however many machines run into it, until the harness is good again. */
async function noteProblem(ctx: Ctx, department: Department, problem: HarnessProblem, signature: string): Promise<void> {
  await ctx.db.insert(harnessProducts).values({ departmentId: department.id, companyId: department.companyId }).onConflictDoNothing();
  await ctx.db.update(harnessProducts).set({ problem, updatedAt: new Date() }).where(eq(harnessProducts.departmentId, department.id));
  const fresh = await ctx.db.update(harnessProducts).set({ told: signature }).where(and(eq(harnessProducts.departmentId, department.id), sql`${harnessProducts.told} is distinct from ${signature}`)).returning({ id: harnessProducts.departmentId });
  if (!fresh.length) return;
  const to = await headOfProduct(ctx, department);
  if (!to) return;
  const name = productName(department);
  const text = `The test harness of ${name} could not be updated at commit ${problem.commitSha} (${problem.code}). The last version that worked stays in use, so only runs on this commit are stopped. Machines try again by themselves. test_harness shows where it stands.\n\n${quote(problem.detail)}`;
  await enqueueTurn(ctx, { companyId: department.companyId, agentId: to, prompt: text, createdBy: null, message: { personId: null, text, notification: { source: 'machine', tasks: [], detail: { en: name, ru: name } } } });
}

/* The one who builds a unit is the only one who may send it. */
async function heldBuild(ctx: Ctx, node: NodeIdentity, key: string): Promise<Build> {
  const [build] = await ctx.db.select().from(harnessBuilds).where(ofNode(node, key));
  if (!build || build.status !== 'building' || build.builder !== who(node)) throw new ApiError(409, 'conflict', 'This machine does not hold this build.');
  return build;
}

const Key = z.object({ key: EnvironmentDigest });
const PartPath = Key.extend({ index: z.coerce.number().int().nonnegative() });
const range = (header: string | undefined, size: number): { start: number; end: number } => {
  const found = /^bytes=(\d+)-(\d*)$/.exec(header ?? '');
  const start = found ? Number(found[1]) : 0, end = found?.[2] ? Math.min(Number(found[2]), size - 1) : size - 1;
  if (start > end) throw new ApiError(416, 'validation', 'This part lies past the end of the bundle.');
  return { start, end };
};

async function nodeOf(ctx: Ctx, req: FastifyRequest): Promise<NodeIdentity> {
  const node = await identify(ctx, req);
  if (!node) throw new ApiError(401, 'unauthorized', 'Unknown node key.');
  return node;
}

function needDir(ctx: Ctx): string {
  if (!ctx.config.harnessDir) throw new ApiError(404, 'not_found', 'This server keeps no harness bundles.');
  return ctx.config.harnessDir;
}

async function finishBuild(ctx: Ctx, node: NodeIdentity, key: string, body: unknown): Promise<void> {
  const { digest, size } = HarnessDone.parse(body), dir = needDir(ctx), build = await heldBuild(ctx, node, key), now = new Date();
  await assemble(dir, build, digest, size);
  await ctx.db.update(harnessBuilds).set({ status: 'ready', digest, size, error: null, failures: 0, nextTryAt: null, builder: null, leaseUntil: null, usedAt: now, copies: [who(node)] }).where(eq(harnessBuilds.id, build.id));
  await prune(ctx, dir, key, now);
  await spread(ctx, build, node);
}

async function failBuild(ctx: Ctx, node: NodeIdentity, key: string, body: unknown): Promise<void> {
  const { error } = HarnessFailed.parse(body), [build] = await ctx.db.select().from(harnessBuilds).where(ofNode(node, key));
  if (!build || build.status !== 'building' || build.builder !== who(node)) return;
  if (error === null) {
    await ctx.db.update(harnessBuilds).set({ builder: null, leaseUntil: null }).where(eq(harnessBuilds.id, build.id));
    return;
  }
  const failures = build.failures + 1, pause = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (failures - 1));
  await ctx.db.update(harnessBuilds).set({ status: 'failed', error, failures, nextTryAt: new Date(Date.now() + pause), builder: null, leaseUntil: null }).where(eq(harnessBuilds.id, build.id));
  const [department] = await ctx.db.select().from(departments).where(eq(departments.id, build.departmentId));
  if (department) await noteProblem(ctx, department, { code: 'build_failed', detail: error, commitSha: build.commitSha }, `build:${build.key}`);
}

async function sendBundle(ctx: Ctx, req: FastifyRequest, key: string) {
  const node = await nodeOf(ctx, req), dir = needDir(ctx), [build] = await ctx.db.select().from(harnessBuilds).where(ofNode(node, key));
  if (!build || build.status !== 'ready') throw new ApiError(404, 'not_found', 'This bundle is not ready.');
  const [department] = await ctx.db.select().from(departments).where(eq(departments.id, build.departmentId));
  if (!department || !await nodeMayTake(ctx, node, department)) throw new ApiError(403, 'forbidden', 'This machine takes no tests of this product.');
  const { start, end } = range(req.headers.range, build.size!);
  return { start, end, size: build.size!, stream: createReadStream(bundleFile(dir, build), { start, end }) };
}

/* A machine's own routes, with its key: what it asks for, what it built, what failed, and the bundles it takes. */
export function harnessRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.post('/api/harness/claim', async req => claimBuild(ctx, await nodeOf(ctx, req), HarnessUnit.parse(req.body)));
  app.post('/api/harness/:key/done', async (req, reply) => { await finishBuild(ctx, await nodeOf(ctx, req), Key.parse(req.params).key, req.body); return reply.code(204).send(); });
  app.post('/api/harness/:key/failed', async (req, reply) => { await failBuild(ctx, await nodeOf(ctx, req), Key.parse(req.params).key, req.body); return reply.code(204).send(); });
  app.get('/api/harness/:key/bundle', async (req, reply) => {
    const { start, end, size, stream } = await sendBundle(ctx, req, Key.parse(req.params).key);
    return reply.code(206).header('content-type', 'application/octet-stream').header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1).send(stream);
  });
  void app.register(async scope => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: PART_BYTES }, (_req, body, done) => done(null, body));
    scope.put('/api/harness/:key/parts/:index', { bodyLimit: PART_BYTES }, async (req, reply) => {
      const { key, index } = PartPath.parse(req.params), node = await nodeOf(ctx, req), dir = needDir(ctx), build = await heldBuild(ctx, node, key);
      if (index * PART_BYTES >= ctx.config.harnessBytes) throw new ApiError(413, 'validation', 'This bundle takes more than this server may keep.');
      const file = join(partsFolder(dir, build), String(index));
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const staging = `${file}.${randomUUID()}`;
      await writeFile(staging, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), { mode: 0o600 });
      await rename(staging, file);
      return reply.code(204).send();
    });
  });
}

type Sync = { requestId: string; commitSha: string; at: number; answered: boolean; problem: boolean };
type Request = { departmentId: string; node: NodeIdentity; name: string; head: boolean };
const syncs = new WeakMap<Ctx, Map<string, Sync>>(), requests = new WeakMap<Ctx, Map<string, Request>>(), rounds = new WeakMap<Ctx, Promise<void>>();
const syncsOf = (ctx: Ctx) => { const known = syncs.get(ctx) ?? new Map<string, Sync>(); syncs.set(ctx, known); return known; };
const requestsOf = (ctx: Ctx) => { const known = requests.get(ctx) ?? new Map<string, Request>(); requests.set(ctx, known); return known; };
const syncKey = (departmentId: string, node: NodeIdentity) => `${departmentId}:${who(node)}`;
function mustAsk(sync: Sync | undefined, commitSha: string, now: Date): boolean {
  if (sync?.commitSha !== commitSha) return true;
  if (sync.answered) return sync.problem && now.getTime() - sync.at > ASK_AGAIN_MS;
  return now.getTime() - sync.at > NO_ANSWER_MS;
}

function ask(ctx: Ctx, place: Place, department: Department, repo: Repo, commitSha: string, head: boolean, now: Date): void {
  const requestId = randomUUID();
  const sent = ctx.hub.send(place.node, { type: 'tests.harness', requestId, repositoryScope: repositoryScope(department.companyId, department.id, repo.url), repo: { url: repo.url, token: repo.token }, commitSha });
  if (!sent) return;
  requestsOf(ctx).set(requestId, { departmentId: department.id, node: place.node, name: place.name, head });
  if (head) syncsOf(ctx).set(syncKey(department.id, place.node), { requestId, commitSha, at: now.getTime(), answered: false, problem: false });
}

/* A changed lock file, on whichever branch, came ready on one machine: the others take it now, not at their first run. */
async function spread(ctx: Ctx, build: Build, builder: NodeIdentity): Promise<void> {
  if (build.unit !== 'dependencies') return;
  const found = await repoAt(ctx, [build.departmentId]);
  if (!found) return;
  const now = new Date(), places = await harnessPlaces(ctx, await placesOf(ctx, build.companyId));
  for (const place of places) {
    if (sameNode(place.node, builder) || !mayTake(place, { kind: 'tests' }, found.department)) continue;
    if (syncsOf(ctx).get(syncKey(build.departmentId, place.node))?.commitSha === build.commitSha) continue;
    ask(ctx, place, found.department, found.repo, build.commitSha, false, now);
  }
}

async function syncProduct(ctx: Ctx, department: Department, places: Place[], now: Date): Promise<void> {
  const open = places.filter(place => mayTake(place, { kind: 'tests' }, department));
  const found = open.length ? await repoAt(ctx, [department.id]) : null;
  if (!found) return;
  const at = await ctx.readCommit(found.repo, { branch: found.repo.branch }, READ_HEAD_MS);
  if ('problem' in at) return;
  await ctx.db.insert(harnessProducts).values({ departmentId: department.id, companyId: department.companyId, headCommit: at.commitSha }).onConflictDoUpdate({ target: harnessProducts.departmentId, set: { headCommit: at.commitSha } });
  for (const place of open) {
    if (mustAsk(syncsOf(ctx).get(syncKey(department.id, place.node)), at.commitSha, now)) ask(ctx, place, found.department, found.repo, at.commitSha, true, now);
  }
}

async function round(ctx: Ctx, now: Date): Promise<void> {
  const products = await ctx.db.select().from(departments).where(isNotNull(departments.repoUrl));
  const places = new Map<string, Place[]>();
  for (const companyId of new Set(products.map(product => product.companyId))) places.set(companyId, await harnessPlaces(ctx, await placesOf(ctx, companyId)));
  for (const product of products) {
    await syncProduct(ctx, product, places.get(product.companyId)!, now).catch((error: unknown) => { ctx.log.warn({ error: String(error), departmentId: product.id }, 'The harness of a product could not be synced.'); });
  }
}

/* One round at a time: a repository that answers slowly must not pile rounds up. */
export function harnessRound(ctx: Ctx, now = new Date()): Promise<void> {
  const running = rounds.get(ctx);
  if (running) return running;
  const next = round(ctx, now).finally(() => { rounds.delete(ctx); });
  rounds.set(ctx, next);
  return next;
}

/* A machine that came back may have lost its folder, or what it was doing: it is asked again. */
export function harnessGreeted(ctx: Ctx, node: NodeIdentity): void {
  const known = syncsOf(ctx);
  for (const key of known.keys()) if (key.endsWith(`:${who(node)}`)) known.delete(key);
}

function machineWord(request: Request, message: HarnessSynced): HarnessMachine {
  const ready = message.result.status === 'ready';
  return { name: request.name, commitSha: message.commitSha, version: ready ? (message.result as { version: string }).version : null, problem: ready ? null : (message.result as { problem: { detail: string } }).problem.detail, at: new Date().toISOString() };
}

async function noteMachine(ctx: Ctx, department: Department, request: Request, message: HarnessSynced): Promise<void> {
  await ctx.db.insert(harnessProducts).values({ departmentId: department.id, companyId: department.companyId }).onConflictDoNothing();
  const patch = JSON.stringify({ [who(request.node)]: machineWord(request, message) });
  await ctx.db.update(harnessProducts).set({ machines: sql`${harnessProducts.machines} || ${patch}::jsonb`, updatedAt: new Date() }).where(eq(harnessProducts.departmentId, department.id));
}

async function noteReady(ctx: Ctx, department: Department, request: Request, message: HarnessSynced, result: Extract<HarnessSynced['result'], { status: 'ready' }>): Promise<void> {
  if (result.keys.length) {
    await ctx.db.update(harnessBuilds).set({ copies: sql`(select coalesce(jsonb_agg(distinct value), '[]'::jsonb) from jsonb_array_elements(${harnessBuilds.copies} || ${JSON.stringify([who(request.node)])}::jsonb))` })
      .where(and(eq(harnessBuilds.companyId, department.companyId), inArray(harnessBuilds.key, result.keys)));
  }
  if (!request.head) return;
  await ctx.db.update(harnessProducts).set({ goodCommit: message.commitSha, version: result.version, problem: null, told: null }).where(eq(harnessProducts.departmentId, department.id));
}

async function noteTrouble(ctx: Ctx, department: Department, message: HarnessSynced, problem: Extract<HarnessSynced['result'], { status: 'error' }>['problem']): Promise<void> {
  if (PASSING.includes(problem.code)) return;
  /* A build that failed was told of when it failed, with its output, whichever machine built it. */
  if (problem.code === 'build_failed' && ctx.config.harnessDir) return;
  const signature = problem.code === 'build_failed' ? `${problem.code}:${message.commitSha}` : `${problem.code}:${problem.detail}`;
  await noteProblem(ctx, department, { code: problem.code, detail: problem.detail, commitSha: message.commitSha }, signature);
}

/* A machine's answer: it has all of the commit's harness, or why not. */
export async function harnessSynced(ctx: Ctx, id: NodeIdentity, message: HarnessSynced): Promise<void> {
  const known = requestsOf(ctx), request = known.get(message.requestId);
  if (!request || !sameNode(request.node, id)) return;
  known.delete(message.requestId);
  const sync = syncsOf(ctx).get(syncKey(request.departmentId, id));
  if (sync?.requestId === message.requestId) syncsOf(ctx).set(syncKey(request.departmentId, id), { ...sync, answered: true, problem: message.result.status !== 'ready', at: Date.now() });
  const [department] = await ctx.db.select().from(departments).where(eq(departments.id, request.departmentId));
  if (!department) return;
  await noteMachine(ctx, department, request, message);
  if (message.result.status === 'ready') await noteReady(ctx, department, request, message, message.result);
  else await noteTrouble(ctx, department, message, message.result.problem);
}

const SHOWN_BUILDS = 20;
const NOTHING_YET = { headCommit: null, goodCommit: null, version: null, problem: null, machines: {} };
/* Where a product's harness stands, for its head and whoever works on it. */
export async function harnessState(ctx: Ctx, department: Department): Promise<object> {
  const [product = NOTHING_YET] = await ctx.db.select().from(harnessProducts).where(eq(harnessProducts.departmentId, department.id));
  const builds = await ctx.db.select().from(harnessBuilds).where(eq(harnessBuilds.departmentId, department.id)).orderBy(desc(harnessBuilds.createdAt)).limit(SHOWN_BUILDS);
  return {
    headCommit: product.headCommit, goodCommit: product.goodCommit, version: product.version, problem: product.problem,
    machines: Object.values(product.machines),
    builds: builds.map(build => ({ unit: build.unit, platform: build.platform, version: build.version, commit: build.commitSha, status: build.status, bytes: build.size, copies: build.copies.length, error: build.error })),
    bundles: ctx.config.harnessDir ? 'shared through Hornhoof' : 'each machine builds its own: this server keeps no bundles',
  };
}
