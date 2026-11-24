import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, link, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EnvironmentDigest, HarnessDone, HarnessFailed, HarnessUnit, type HarnessClaim, type HarnessSynced, type RepositoryScope, type Workspace } from '@hornhoof/protocol';
import { and, asc, desc, eq, exists as dbExists, gt, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { hashToken } from '../../crypto/tokens.js';
import { agents, departments, harnessBuilds, harnessProducts, machines, nodes, people, personAccess, subscriptions, type HarnessMachine, type HarnessProblem } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { enqueueTurn } from '../conversation/queue.js';
import { orchestratorOf } from '../conversation/turn-records.js';
import { quote } from '../conversation/prompt.js';
import { repoAt } from '../departments/repository.js';
import { keyOf as who, sameNode, type NodeIdentity } from '../nodes/hub.js';
import { liveNode } from '../nodes/nodes.js';
import { identify } from '../nodes/socket.js';
import { repositoryScope } from './describe.js';
import { harnessPlaces } from './load.js';
import { builtinLent, mayTake, placesOf, type Place } from './runs.js';

/* A product's test harness as one thing for all the company's machines. A unit is built once per architecture: the first
   machine to ask holds a lease and builds, the others wait and take its bundle through here. Each minute the head of the
   product's branch is read, and a machine is asked to get it ready when the head changed, when its last answer was a problem
   a while ago, or when it never answered, so a run on any of them finds it there. */

type Build = typeof harnessBuilds.$inferSelect;
type Department = typeof departments.$inferSelect;
type Repo = NonNullable<Workspace['repo']>;

/* How long a claim lasts without a word from its machine, which says it again every minute while it builds. */
const LEASE_MS = 3 * 60_000;
const WAIT_MS = 5_000;
/* A bundle travels in parts, each sent again by itself, as a whole one would not get through a slow link. */
const PART_BYTES = 32 * 1024 ** 2;
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

/* The row's UUID is the attempt fence. A new holder gets a new UUID, a heartbeat keeps it. No other table references it. */
const bundleFile = (dir: string, build: Pick<Build, 'companyId' | 'key' | 'id'>) => join(dir, build.companyId, `${build.key}.${build.id}.zst`);
const partsFolder = (dir: string, build: Pick<Build, 'companyId' | 'key' | 'id'>) => join(dir, build.companyId, `${build.key}.${build.id}.parts`);
const exists = (path: string) => access(path).then(() => true, () => false);
async function removeAttempt(dir: string, build: Build): Promise<void> {
  await Promise.all([rm(bundleFile(dir, build), { force: true }), rm(partsFolder(dir, build), { recursive: true, force: true })]);
}
/* An ID is never reused: only an attempt that no row can publish any more may clean up after its delayed work. */
async function discardSuperseded(ctx: Ctx, dir: string, build: Build): Promise<void> {
  const [current] = await ctx.db.select(idOnly(harnessBuilds)).from(harnessBuilds).where(eq(harnessBuilds.id, build.id)).limit(1);
  if (!current) await removeAttempt(dir, build);
}

/* What a machine asking for a unit does next, by the unit's row: the one decision of who builds. */
const stillFailed = (build: Build, now: Date): build is Build & { nextTryAt: Date } => build.status === 'failed' && !!build.nextTryAt && build.nextTryAt > now;
const builtElsewhere = (build: Build, me: string, now: Date): boolean => build.status === 'building' && build.builder !== me && !!build.leaseUntil && build.leaseUntil > now;
function decideClaim(build: Build, me: string, now: Date, stored: boolean): { answer: HarnessClaim; set?: Partial<Build> } {
  if (build.status === 'ready' && stored) return { answer: { state: 'ready', companyId: build.companyId, attempt: build.id, digest: build.digest!, size: build.size!, partBytes: PART_BYTES }, set: { usedAt: now } };
  if (stillFailed(build, now)) return { answer: { state: 'failed', error: build.error ?? '', afterMs: build.nextTryAt.getTime() - now.getTime() } };
  if (builtElsewhere(build, me, now)) return { answer: { state: 'wait', afterMs: WAIT_MS } };
  const id = build.status === 'building' && build.builder === me && build.leaseUntil && build.leaseUntil > now ? build.id : randomUUID();
  return { answer: { state: 'build', companyId: build.companyId, attempt: id, partBytes: PART_BYTES }, set: { id, status: 'building', builder: me, leaseUntil: new Date(now.getTime() + LEASE_MS), digest: null, size: null } };
}

/* A machine shares a product's harness when it may take the product's parts: it lends its time, and its owner reaches the
   department. What one builds the others run, and what they build holds the product's dependencies. A built-in node shares
   it while the computer it runs on lends itself. */
async function nodeAllowed(ctx: Ctx, node: NodeIdentity, department: Department) {
  if (node.kind === 'builtin') return builtinLent(ctx, department.companyId, node.machine);
  const reaches = dbExists(ctx.db.select(idOnly(personAccess)).from(personAccess).where(and(eq(personAccess.personId, people.id), or(eq(personAccess.departmentId, department.id), department.parentId ? eq(personAccess.departmentId, department.parentId) : undefined))));
  return dbExists(ctx.db.select(idOnly(nodes)).from(nodes)
    .innerJoin(machines, eq(machines.id, nodes.machineId)).innerJoin(people, eq(people.id, machines.personId))
    .leftJoin(subscriptions, eq(subscriptions.id, nodes.subscriptionId))
    .where(and(eq(nodes.id, node.nodeId), eq(nodes.companyId, department.companyId), node.keyHash ? eq(nodes.keyHash, node.keyHash) : liveNode,
      isNull(subscriptions.removedAt), isNull(machines.revokedAt), eq(machines.kind, 'computer'), eq(machines.lendsTests, true), eq(people.status, 'active'), or(eq(people.scopeKind, 'company'), reaches))));
}
async function nodeMayTake(ctx: Ctx, node: NodeIdentity, department: Department): Promise<boolean> {
  const [row] = await ctx.db.select(idOnly(departments)).from(departments).where(and(eq(departments.id, department.id), await nodeAllowed(ctx, node, department))).limit(1);
  return !!row;
}

async function departmentFor(ctx: Ctx, node: NodeIdentity, scope: RepositoryScope): Promise<Department> {
  const [department] = await ctx.db.select().from(departments).where(and(eq(departments.id, scope.repositoryOwnerId), eq(departments.companyId, scope.companyId)));
  if (!department?.repoUrl || hashToken(department.repoUrl) !== scope.repoUrlHash) throw new ApiError(404, 'not_found', 'This product has no such repository.');
  if (!await nodeMayTake(ctx, node, department)) throw new ApiError(403, 'forbidden', 'This machine takes no tests of this product.');
  return department;
}

const ofNode = (node: NodeIdentity, key: string, companyId: string) => {
  return and(eq(harnessBuilds.key, key), eq(harnessBuilds.companyId, companyId), node.kind === 'node' ? eq(harnessBuilds.companyId, sql`(select ${nodes.companyId} from ${nodes} where ${nodes.id} = ${node.nodeId})`) : undefined);
};

async function claimBuild(ctx: Ctx, node: NodeIdentity, unit: HarnessUnit, now = new Date()): Promise<HarnessClaim> {
  const department = await departmentFor(ctx, node, unit.repositoryScope), dir = ctx.config.harnessDir;
  if (!dir || unit.fencing !== 1) return { state: 'local' };
  const me = who(node);
  return ctx.db.transaction(async tx => {
    await tx.insert(harnessBuilds).values({ companyId: department.companyId, departmentId: department.id, key: unit.key, version: unit.version, unit: unit.unit, platform: unit.platform, commitSha: unit.commitSha, builder: me, leaseUntil: new Date(now.getTime() + LEASE_MS) }).onConflictDoNothing();
    const [build] = await tx.select().from(harnessBuilds).where(and(eq(harnessBuilds.companyId, department.companyId), eq(harnessBuilds.key, unit.key))).for('update');
    if (build!.departmentId !== department.id) throw new ApiError(409, 'conflict', 'This key belongs to another product.');
    const decided = decideClaim(build!, me, now, await exists(bundleFile(dir, build!)));
    const scoped = { ...ctx, db: tx };
    if (decided.set) {
      const changed = await tx.update(harnessBuilds).set(decided.set).where(and(eq(harnessBuilds.id, build!.id), await nodeAllowed(scoped, node, department))).returning();
      if (!changed.length) throw new ApiError(403, 'forbidden', 'This machine takes no tests of this product.');
      if (decided.set.id && decided.set.id !== build!.id) await removeAttempt(dir, build!);
    }
    return decided.answer;
  });
}

/* Puts the parts together, and keeps the result only when it is what the builder said it made. */
async function assemble(dir: string, build: Build, digest: string, size: number): Promise<void> {
  const file = bundleFile(dir, build), staging = `${file}.staging-${randomUUID()}`, hash = createHash('sha256');
  let total = 0;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const out = await open(staging, 'wx', 0o600);
  try {
    const names = (await readdir(partsFolder(dir, build)).catch(() => [])).filter(name => /^\d+$/.test(name)).sort((a, b) => Number(a) - Number(b));
    for (const name of names) {
      for await (const chunk of createReadStream(join(partsFolder(dir, build), name))) {
        hash.update(chunk as Buffer); total += (chunk as Buffer).length;
        await out.writeFile(chunk as Buffer);
      }
    }
    await out.close();
    if (total !== size || hash.digest('hex') !== digest) throw new ApiError(409, 'conflict', 'The bundle that came differs from what the machine said it made.');
    /* Immutable publication: even a second delayed done from this same attempt cannot replace an archive. */
    await link(staging, file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'EEXIST') throw new ApiError(409, 'conflict', 'This attempt already has an archive.'); throw error; });
  } finally { await out.close(); await rm(staging, { force: true }); }
}

/* The bundles used longest ago go when they take more than they may, and rows of what never came ready after a while. */
async function prune(ctx: Ctx, dir: string, keep: string, now: Date): Promise<void> {
  const ready = await ctx.db.select().from(harnessBuilds).where(eq(harnessBuilds.status, 'ready')).orderBy(asc(harnessBuilds.usedAt), asc(harnessBuilds.createdAt));
  let total = ready.reduce((sum, build) => sum + (build.size ?? 0), 0);
  for (const build of ready) {
    if (total <= ctx.config.harnessBytes) break;
    if (build.key === keep) continue;
    const removed = await ctx.db.delete(harnessBuilds).where(and(eq(harnessBuilds.id, build.id), eq(harnessBuilds.status, 'ready'))).returning();
    if (!removed.length) continue;
    await rm(bundleFile(dir, build), { force: true });
    total -= build.size ?? 0;
  }
  const old = await ctx.db.delete(harnessBuilds).where(and(ne(harnessBuilds.status, 'ready'), lt(harnessBuilds.createdAt, new Date(now.getTime() - OLD_ROWS_MS)), or(isNull(harnessBuilds.leaseUntil), lte(harnessBuilds.leaseUntil, now)))).returning();
  for (const build of old) await rm(partsFolder(dir, build), { recursive: true, force: true });
}

async function headOfProduct(ctx: Ctx, department: Department): Promise<string | null> {
  const [head] = await ctx.db.select(idOnly(agents)).from(agents).where(and(eq(agents.departmentId, department.parentId ?? department.id), eq(agents.kind, 'head'), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  return head?.id ?? (await orchestratorOf(ctx, department.companyId))?.id ?? null;
}

const productName = (department: Department) => department.name ?? department.templateKey ?? 'the product';

/* The head hears of a problem once, however many machines run into it, until the harness is good again. */
type ProblemNotice = { to: string; name: string; text: string };
async function noteProblem(ctx: Ctx, department: Department, problem: HarnessProblem, signature: string): Promise<ProblemNotice | null> {
  await ctx.db.insert(harnessProducts).values({ departmentId: department.id, companyId: department.companyId }).onConflictDoNothing();
  await ctx.db.update(harnessProducts).set({ problem, updatedAt: new Date() }).where(eq(harnessProducts.departmentId, department.id));
  const fresh = await ctx.db.update(harnessProducts).set({ told: signature }).where(and(eq(harnessProducts.departmentId, department.id), isNull(harnessProducts.told))).returning({ id: harnessProducts.departmentId });
  if (!fresh.length) return null;
  const to = await headOfProduct(ctx, department);
  if (!to) return null;
  const name = productName(department);
  const text = `The test harness of ${name} could not be updated at commit ${problem.commitSha} (${problem.code}). The last version that worked stays in use, so only runs on this commit are stopped. Machines try again by themselves. test_harness shows where it stands.\n\n${quote(problem.detail)}`;
  return { to, name, text };
}
async function tellProblem(ctx: Ctx, companyId: string, notice: ProblemNotice | null): Promise<void> {
  if (!notice) return;
  const { to, name, text } = notice;
  await enqueueTurn(ctx, { companyId, agentId: to, prompt: text, createdBy: null, message: { personId: null, text, notification: { source: 'machine', tasks: [], detail: { en: name, ru: name } } } });
}

/* The one who builds a unit is the only one who may send it. */
type Lease = { companyId: string; attempt: string };
const conflict = () => new ApiError(409, 'conflict', 'This machine does not hold an active attempt of this build.');
const activeAttempt = (node: NodeIdentity, build: Build) => and(eq(harnessBuilds.id, build.id), eq(harnessBuilds.status, 'building'), eq(harnessBuilds.builder, who(node)), gt(harnessBuilds.leaseUntil, sql`clock_timestamp()`));
async function heldBuild(ctx: Ctx, node: NodeIdentity, key: string, lease: Lease): Promise<Build> {
  const [build] = await ctx.db.select().from(harnessBuilds).where(and(ofNode(node, key, lease.companyId), eq(harnessBuilds.id, lease.attempt)));
  if (!build || build.status !== 'building' || build.builder !== who(node)) throw conflict();
  const [department] = await ctx.db.select().from(departments).where(eq(departments.id, build.departmentId));
  if (!department || !await nodeMayTake(ctx, node, department)) throw new ApiError(403, 'forbidden', 'This machine takes no tests of this product.');
  if (!build.leaseUntil || build.leaseUntil <= new Date()) throw conflict();
  return build;
}

/* The authorization subquery and attempt predicate are evaluated together by the write, after all filesystem awaits. */
async function changeBuild(ctx: Ctx, node: NodeIdentity, build: Build, patch: Partial<Build>): Promise<void> {
  const [department] = await ctx.db.select().from(departments).where(eq(departments.id, build.departmentId));
  if (!department || !await nodeMayTake(ctx, node, department)) throw new ApiError(403, 'forbidden', 'This machine takes no tests of this product.');
  const changed = await ctx.db.update(harnessBuilds).set(patch).where(and(activeAttempt(node, build), await nodeAllowed(ctx, node, department))).returning();
  if (!changed.length) {
    if (!await nodeMayTake(ctx, node, department)) throw new ApiError(403, 'forbidden', 'This machine takes no tests of this product.');
    throw conflict();
  }
}

const LeaseHeaders = z.object({ companyId: z.uuid(), attempt: z.uuid() });
const leaseOf = (req: FastifyRequest): Lease => LeaseHeaders.parse({ companyId: req.headers['x-harness-company'], attempt: req.headers['x-harness-attempt'] });

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

async function finishBuild(ctx: Ctx, node: NodeIdentity, key: string, body: unknown, lease: Lease): Promise<void> {
  const { digest, size } = HarnessDone.parse(body), dir = needDir(ctx), build = await heldBuild(ctx, node, key, lease);
  try {
    await assemble(dir, build, digest, size);
    await changeBuild(ctx, node, build, { status: 'ready', digest, size, error: null, failures: 0, nextTryAt: null, builder: null, leaseUntil: null, usedAt: new Date(), copies: [who(node)] });
  } finally { await discardSuperseded(ctx, dir, build); }
  await rm(partsFolder(dir, build), { recursive: true, force: true });
  await prune(ctx, dir, key, new Date());
  await spread(ctx, build, node);
}

async function failBuild(ctx: Ctx, node: NodeIdentity, key: string, body: unknown, lease: Lease): Promise<void> {
  const { error } = HarnessFailed.parse(body), build = await heldBuild(ctx, node, key, lease);
  if (error === null) {
    await changeBuild(ctx, node, build, { builder: null, leaseUntil: null });
    await rm(partsFolder(needDir(ctx), build), { recursive: true, force: true });
    return;
  }
  const failures = build.failures + 1, pause = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** (failures - 1));
  await changeBuild(ctx, node, build, { status: 'failed', error, failures, nextTryAt: new Date(Date.now() + pause), builder: null, leaseUntil: null });
  await rm(partsFolder(needDir(ctx), build), { recursive: true, force: true });
  const [department] = await ctx.db.select().from(departments).where(eq(departments.id, build.departmentId));
  if (department) await tellProblem(ctx, department.companyId, await noteProblem(ctx, department, { code: 'build_failed', detail: error, commitSha: build.commitSha }, `build:${build.key}`));
}

async function sendBundle(ctx: Ctx, node: NodeIdentity, ranged: string | undefined, key: string, lease: Lease) {
  const dir = needDir(ctx), [build] = await ctx.db.select().from(harnessBuilds).where(and(ofNode(node, key, lease.companyId), eq(harnessBuilds.id, lease.attempt)));
  if (!build || build.status !== 'ready') throw new ApiError(404, 'not_found', 'This bundle is not ready.');
  const [department] = await ctx.db.select().from(departments).where(eq(departments.id, build.departmentId));
  if (!department || !await nodeMayTake(ctx, node, department)) throw new ApiError(403, 'forbidden', 'This machine takes no tests of this product.');
  const file = bundleFile(dir, build);
  if (!await exists(file)) throw new ApiError(404, 'not_found', 'This bundle is not ready.');
  const { start, end } = range(ranged, build.size!);
  return { start, end, size: build.size!, stream: createReadStream(file, { start, end }) };
}

/* A machine's own routes, with its key: what it asks for, what it built, what failed, and the bundles it takes. */
export function harnessRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.post('/api/harness/claim', async req => claimBuild(ctx, await nodeOf(ctx, req), HarnessUnit.parse(req.body)));
  app.post('/api/harness/:key/done', async (req, reply) => { await finishBuild(ctx, await nodeOf(ctx, req), Key.parse(req.params).key, req.body, leaseOf(req)); return reply.code(204).send(); });
  app.post('/api/harness/:key/failed', async (req, reply) => { await failBuild(ctx, await nodeOf(ctx, req), Key.parse(req.params).key, req.body, leaseOf(req)); return reply.code(204).send(); });
  app.get('/api/harness/:key/bundle', async (req, reply) => {
    const { start, end, size, stream } = await sendBundle(ctx, await nodeOf(ctx, req), req.headers.range, Key.parse(req.params).key, leaseOf(req));
    return reply.code(206).header('content-type', 'application/octet-stream').header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1).send(stream);
  });
  void app.register(async scope => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: PART_BYTES }, (_req, body, done) => done(null, body));
    scope.put('/api/harness/:key/parts/:index', { bodyLimit: PART_BYTES }, async (req, reply) => {
      const { key, index } = PartPath.parse(req.params), node = await nodeOf(ctx, req), lease = leaseOf(req), dir = needDir(ctx), build = await heldBuild(ctx, node, key, lease);
      if (index * PART_BYTES >= ctx.config.harnessBytes) throw new ApiError(413, 'validation', 'This bundle takes more than this server may keep.');
      const file = join(partsFolder(dir, build), String(index));
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const staging = `${file}.${randomUUID()}`;
      await writeFile(staging, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), { mode: 0o600 });
      try {
        await ctx.db.transaction(async tx => {
          const scoped = { ...ctx, db: tx };
          const [current] = await tx.select().from(harnessBuilds).where(activeAttempt(node, build)).for('update');
          if (!current) throw conflict();
          await heldBuild(scoped, node, key, lease);
          await rename(staging, file);
          await changeBuild(scoped, node, build, { leaseUntil: new Date(Date.now() + LEASE_MS) });
        });
      } finally { await rm(staging, { force: true }); await discardSuperseded(ctx, dir, build); }
      return reply.code(204).send();
    });
  });
}

type Sync = { requestId: string; commitSha: string; at: number; answered: boolean; problem: boolean };
type Request = { commitSha: string; departmentId: string; node: NodeIdentity; name: string; head: boolean };
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
  requestsOf(ctx).set(requestId, { commitSha, departmentId: department.id, node: place.node, name: place.name, head });
  if (head) syncsOf(ctx).set(syncKey(department.id, place.node), { requestId, commitSha, at: now.getTime(), answered: false, problem: false });
}

/* A machine that was asked for a commit takes all of it: the other programs that come ready meanwhile need no word of their own. */
const asking = (ctx: Ctx, build: Build, node: NodeIdentity): boolean => [...requestsOf(ctx).values()].some(request => request.commitSha === build.commitSha && request.departmentId === build.departmentId && sameNode(request.node, node));

/* A changed lock file, on whichever branch, came ready on one machine: the others take it now, not at their first run. */
async function spread(ctx: Ctx, build: Build, builder: NodeIdentity): Promise<void> {
  if (!build.unit.startsWith('dependencies')) return;
  const found = await repoAt(ctx, [build.departmentId]);
  if (!found) return;
  const now = new Date(), places = await harnessPlaces(ctx, await placesOf(ctx, build.companyId));
  for (const place of places) {
    if (sameNode(place.node, builder) || !mayTake(place, { kind: 'tests' }, found.department)) continue;
    if (syncsOf(ctx).get(syncKey(build.departmentId, place.node))?.commitSha === build.commitSha || asking(ctx, build, place.node)) continue;
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

async function noteReady(ctx: Ctx, department: Department, request: Request, message: HarnessSynced, result: Extract<HarnessSynced['result'], { status: 'ready' }>, recovered: boolean): Promise<void> {
  if (result.keys.length) {
    await ctx.db.update(harnessBuilds).set({ copies: sql`(select coalesce(jsonb_agg(distinct value), '[]'::jsonb) from jsonb_array_elements(${harnessBuilds.copies} || ${JSON.stringify([who(request.node)])}::jsonb))` })
      .where(and(eq(harnessBuilds.companyId, department.companyId), eq(harnessBuilds.departmentId, department.id), inArray(harnessBuilds.key, result.keys)));
  }
  if (!request.head) return;
  const failed = dbExists(ctx.db.select(idOnly(harnessBuilds)).from(harnessBuilds).where(and(eq(harnessBuilds.departmentId, department.id), eq(harnessBuilds.commitSha, message.commitSha), eq(harnessBuilds.status, 'failed'))));
  await ctx.db.update(harnessProducts).set({ goodCommit: message.commitSha, version: result.version }).where(and(eq(harnessProducts.departmentId, department.id), eq(harnessProducts.headCommit, message.commitSha)));
  const machineProblem = sql`exists (select 1 from jsonb_each(${harnessProducts.machines}) as machine where machine.value->>'commitSha' = ${message.commitSha} and machine.value->>'problem' is not null)`;
  if (recovered) await ctx.db.update(harnessProducts).set({ problem: null, told: null }).where(and(eq(harnessProducts.departmentId, department.id), eq(harnessProducts.headCommit, message.commitSha), sql`not ${failed}`, sql`not ${machineProblem}`));
}

async function noteTrouble(ctx: Ctx, department: Department, message: HarnessSynced, problem: Extract<HarnessSynced['result'], { status: 'error' }>['problem']): Promise<ProblemNotice | null> {
  if (PASSING.includes(problem.code)) return null;
  /* A build that failed was told of when it failed, with its output, whichever machine built it. */
  if (problem.code === 'build_failed' && ctx.config.harnessDir) {
    const [reported] = await ctx.db.select(idOnly(harnessBuilds)).from(harnessBuilds).where(and(eq(harnessBuilds.departmentId, department.id), eq(harnessBuilds.commitSha, message.commitSha), eq(harnessBuilds.status, 'failed'))).limit(1);
    if (reported) return null;
  }
  const signature = problem.code === 'build_failed' ? `${problem.code}:${message.commitSha}` : `${problem.code}:${problem.detail}`;
  return noteProblem(ctx, department, { code: problem.code, detail: problem.detail, commitSha: message.commitSha }, signature);
}

/* A machine's answer: it has all of the commit's harness, or why not. */
export async function harnessSynced(ctx: Ctx, id: NodeIdentity, message: HarnessSynced): Promise<void> {
  const known = requestsOf(ctx), request = known.get(message.requestId);
  if (!request || !sameNode(request.node, id) || message.commitSha !== request.commitSha) return;
  known.delete(message.requestId);
  const sync = syncsOf(ctx).get(syncKey(request.departmentId, id));
  if (request.head && sync?.requestId !== message.requestId) return;
  if (sync?.requestId === message.requestId) syncsOf(ctx).set(syncKey(request.departmentId, id), { ...sync, answered: true, problem: message.result.status !== 'ready', at: Date.now() });
  const notice = await ctx.db.transaction(async tx => {
    const scoped = { ...ctx, db: tx };
    const [department] = await tx.select().from(departments).where(eq(departments.id, request.departmentId));
    if (!department) return null;
    const [product] = await tx.select().from(harnessProducts).where(eq(harnessProducts.departmentId, department.id)).for('update');
    if ((request.head && product?.headCommit !== request.commitSha) || (product?.headCommit && product.headCommit !== request.commitSha)) return null;
    await noteMachine(scoped, department, request, message);
    if (message.result.status === 'error') return { companyId: department.companyId, notice: await noteTrouble(scoped, department, message, message.result.problem) };
    const required = [...syncsOf(ctx)].filter(([key, state]) => key.startsWith(`${department.id}:`) && state.commitSha === message.commitSha);
    await noteReady(scoped, department, request, message, message.result, required.every(([, state]) => state.answered && !state.problem));
    return null;
  });
  /* Delivery uses the original context and its queue locks, after the transaction commits. */
  if (notice) await tellProblem(ctx, notice.companyId, notice.notice);
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
