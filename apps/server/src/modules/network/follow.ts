import { and, eq, isNotNull, isNull, notInArray, notLike, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { agents, jobs, machines, nodes, testParts } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { loggable } from '../../errors.js';
import { ON_NODE } from '../jobs/dispatch.js';
import { SERVER_KEY } from '../nodes/nodes.js';
import { FULL_SHA } from '../updates/registry.js';
import { FOLLOW_RETRY_MS, FOLLOW_TURN_MS, type Go, type LeaderBuild } from './build.js';

export { FOLLOW_RETRY_MS, FOLLOW_TURN_MS, type Go, type LeaderBuild } from './build.js';

/* The pg_advisory_xact_lock key of the grants, used for nothing else: one grant is decided at a time. */
export const FOLLOW_LOCK = 0x68686677;

const BUILD_KEPT_MS = 10 * 60_000;
const FAILURE_KEPT_MS = 60_000;
/* A machine that said it installs and has reported since this long ago is taken to be at it still. */
const INSTALLING_SAID_MS = 2 * 60_000;

type Kept = { build: LeaderBuild | null; until: number; reading: Promise<void> | null };
const kept = new WeakMap<Ctx, Kept>();

async function readBuild(ctx: Ctx, commit: string): Promise<LeaderBuild | null> {
  const [found, siblings] = await Promise.all([ctx.updates.find(commit), ctx.updates.siblings(commit)]);
  if (!found || !siblings.node || !siblings.updater) return null;
  return { version: found.version || found.tag, tag: commit, digest: found.digest, nodeDigest: siblings.node, updaterDigest: siblings.updater, commit };
}

/* Asks the registry for this server's own build, one ask at a time. What it learns is kept for a while, and a failure a
   little shorter. */
export function refreshBuild(ctx: Ctx): Promise<void> {
  const { commit } = ctx.config;
  if (!FULL_SHA.test(commit)) return Promise.resolve();
  const known = kept.get(ctx) ?? { build: null, until: 0, reading: null };
  kept.set(ctx, known);
  known.reading ??= readBuild(ctx, commit)
    .then(
      build => Object.assign(known, { build, until: Date.now() + (build ? BUILD_KEPT_MS : FAILURE_KEPT_MS) }),
      (err: unknown) => {
        ctx.log.warn({ error: loggable(err) }, "Could not read this server's own build from the registry, so the other machines stay on theirs.");
        Object.assign(known, { until: Date.now() + FAILURE_KEPT_MS });
      },
    )
    .then(() => void (known.reading = null));
  return known.reading;
}

/* The build this server runs, when the registry has its commit's images: what was last learned of it. It never waits
   for the registry, which may take long to answer: a view that asks while nothing is known yet hears of no build, and
   the next one does. A server built by hand names no commit, and its workers stay where they are. */
export function leaderBuild(ctx: Ctx): LeaderBuild | null {
  if (!FULL_SHA.test(ctx.config.commit)) return null;
  const known = kept.get(ctx);
  if (!known || Date.now() >= known.until) void refreshBuild(ctx);
  return known?.build ?? null;
}

/* How long a join waits for the registry when the server knows no build of its own: well under the half minute its
   installer gives the whole join. */
export const JOIN_BUILD_WAIT_MS = 10_000;

/* The server's own build for a join, which names it to a machine once and so asks the registry when nothing is known,
   but only for a moment: a registry that is slow must not cost the machine its one-time command. */
export async function buildSoon(ctx: Ctx, waitMs = JOIN_BUILD_WAIT_MS): Promise<LeaderBuild | null> {
  const known = leaderBuild(ctx);
  if (known) return known;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([refreshBuild(ctx), new Promise<void>(resolve => (timer = setTimeout(resolve, waitMs)))]);
  clearTimeout(timer);
  return leaderBuild(ctx);
}

type Granted = Pick<typeof machines.$inferSelect, 'commit' | 'goCommit' | 'goAt' | 'failedCommit' | 'failedAt'>;
type Reported = Granted & Pick<typeof machines.$inferSelect, 'updateState' | 'reportAt'>;

/* Whether the machine may install now: it was told to within the last quarter of an hour, has not reported the build
   since, and has not reported that the install failed. */
export function goodGrant(row: Granted, now: Date): boolean {
  if (!row.goCommit || !row.goAt) return false;
  if (now.getTime() - row.goAt.getTime() >= FOLLOW_TURN_MS || row.commit === row.goCommit) return false;
  return !(row.failedCommit === row.goCommit && row.failedAt && row.failedAt >= row.goAt);
}

/* Whether the machine is taken up by an install: it may install now, or it says it is at it and was heard from a moment
   ago. An install that takes longer than its turn still has the machine: nothing starts there, and no other machine
   begins, until it reports the build or that it failed, or falls silent. */
export function installs(row: Reported, now: Date): boolean {
  if (goodGrant(row, now)) return true;
  return row.updateState === 'installing' && row.reportAt !== null && now.getTime() - row.reportAt.getTime() < INSTALLING_SAID_MS;
}

/* A machine of the company follows the server's build, whichever it is now, unless it is the machine this server
   itself runs on: a worker, one that keeps a copy of the data, whose schema is the server's and which installs as a
   worker does, and the machine the company was installed on once the server runs on another. This server's own row
   is told by the id its machine goes by; an install with no such id tells it by the key its install gave it. */
type Own = { machineId: string | null };
const follows = (own: Own) =>
  and(isNotNull(machines.role), own.machineId ? sql<boolean>`${machines.networkId} IS DISTINCT FROM ${own.machineId}` : notLike(machines.machineKey, `${SERVER_KEY}%`));
const isFollower = (own: Own, row: { role: string | null; machineKey: string; networkId: string | null }): boolean =>
  row.role !== null && (own.machineId ? row.networkId !== own.machineId : !row.machineKey.startsWith(SERVER_KEY));

const within = (at: Date | null, ms: number, now: Date): boolean => at !== null && now.getTime() - at.getTime() < ms;

/* Whether the machine may have its turn at this build: it downloaded it, and its last try at it is long enough ago. A grant
   that ran out counts as a try that failed. */
const mayTry = (row: typeof machines.$inferSelect, build: LeaderBuild, now: Date): boolean =>
  row.updateCommit === build.commit && row.updateState === 'ready' &&
  !(row.goCommit === build.commit && within(row.goAt, FOLLOW_RETRY_MS, now)) && !(row.failedCommit === build.commit && within(row.failedAt, FOLLOW_RETRY_MS, now));

/* The machines that install or were told to, and with a build those that have it: what a grant and the next to install
   are decided by. */
const installRows = (db: Pick<Db, 'select'>, own: Own, build: LeaderBuild | null = null) =>
  db.select().from(machines).where(and(isNull(machines.revokedAt), follows(own), or(isNotNull(machines.goCommit), eq(machines.updateState, 'installing'), build ? and(eq(machines.updateCommit, build.commit), eq(machines.updateState, 'ready')) : undefined)));

const LEADERS = ['orchestrator', 'head'] as const;

/* Whether work runs on the machine: a turn or a check on its nodes or on its own built-in node, which runs the work of the
   company's keys, or a part of a test run. Without leaders, the turns of the orchestrator and the heads count for none. */
async function runsWork(db: Pick<Db, 'select'>, row: { id: string; networkId: string | null }, leaders = true): Promise<boolean> {
  const counted = leaders ? undefined : or(isNull(jobs.agentId), notInArray(agents.kind, [...LEADERS]));
  const [turn] = await db.select(idOnly(jobs)).from(jobs).leftJoin(nodes, eq(nodes.id, jobs.nodeId)).leftJoin(agents, eq(agents.id, jobs.agentId))
    .where(and(row.networkId ? or(eq(nodes.machineId, row.id), eq(jobs.builtinMachine, row.networkId)) : eq(nodes.machineId, row.id), ON_NODE, counted)).limit(1);
  if (turn) return true;
  const [part] = await db.select(idOnly(testParts)).from(testParts)
    .where(and(row.networkId ? or(eq(testParts.machineId, row.id), eq(testParts.builtinMachine, row.networkId)) : eq(testParts.machineId, row.id), eq(testParts.status, 'running'))).limit(1);
  return part !== undefined;
}

/* Tells the machine to install the build, when it may: it downloaded the build, no other worker installs now, its last
   try at this build is long enough ago, and nothing runs on it. One decision at a time for the whole company, with the
   machine's row held, so no turn and no test part starts there while it is decided. */
export async function tryGrant(tx: Db, own: Own, machineId: string, build: LeaderBuild, now: Date): Promise<boolean> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${FOLLOW_LOCK}::bigint)`);
  const [row] = await tx.select().from(machines).where(eq(machines.id, machineId)).for('update');
  if (!row || row.revokedAt || !isFollower(own, row) || !mayTry(row, build, now)) return false;
  if ((await installRows(tx, own)).some(other => installs(other, now))) return false;
  if (await runsWork(tx, row)) return false;
  await tx.update(machines).set({ goCommit: build.commit, goAt: now }).where(eq(machines.id, machineId));
  return true;
}

export type NextToInstall = { id: string; networkId: string | null; since: number };
const lines = new WeakMap<Ctx['config'], { machine: string; commit: string; since: number }>();

/* The machine next to install the server's build, and since when it is: while none installs, of the machines that have
   the build, said so a moment ago and may try it, the one that joined first. Only the work that runs there keeps it from
   its turn, so new work keeps off it, one machine at a time, and the others work on meanwhile. */
export async function nextToInstall(ctx: Ctx, now = new Date()): Promise<NextToInstall | null> {
  const build = buildToBegin(ctx);
  if (!build) return null;
  const rows = await installRows(ctx.db, ctx.config, build);
  if (rows.some(row => installs(row, now))) return null;
  const [next] = rows.filter(row => waitsInLine(row, build, now)).sort(joinedFirst);
  return next ? { id: next.id, networkId: next.networkId, since: nextSince(ctx, next.id, build.commit, now) } : null;
}

/* The server's build, while it lets a worker begin: only a server that leads and does not install an update itself does. */
function buildToBegin(ctx: Ctx): LeaderBuild | null {
  const build = leaderBuild(ctx);
  return build && ctx.mode.current() === 'lead' && ctx.updater.status()?.state !== 'running' ? build : null;
}

/* Whether the machine waits for its turn: it runs another build, may try this one, and said so a moment ago. */
const waitsInLine = (row: typeof machines.$inferSelect, build: LeaderBuild, now: Date): boolean =>
  row.commit !== build.commit && mayTry(row, build, now) && within(row.reportAt, INSTALLING_SAID_MS, now);

const joinedFirst = (a: typeof machines.$inferSelect, b: typeof machines.$inferSelect): number =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1);

/* From when the machine was first found next. Nothing else starts the turns of the orchestrator and the heads that waited
   for it when their limit comes, so the queue is woken then. */
function nextSince(ctx: Ctx, machine: string, commit: string, now: Date): number {
  const line = lines.get(ctx.config);
  if (line?.machine === machine && line.commit === commit) return line.since;
  lines.set(ctx.config, { machine, commit, since: now.getTime() });
  pumpAfter(ctx, ctx.config.nodeLeaderHoldMs);
  return now.getTime();
}

/* Whether a new turn stays off the node, as its machine is next to install. The orchestrator's and a head's (leader) go
   in past their limit while other work still runs there, which the machine waits for either way, as on a node that waits
   for an update. Once only their own turns are left, theirs wait too, so they never keep the machine from its turn. */
export async function nextToInstallHolds(ctx: Ctx, nodeId: string | null | undefined, leader: boolean, now = new Date()): Promise<boolean> {
  const row = await machineOfNode(ctx.db, nodeId, false);
  const next = row && (await nextToInstall(ctx, now));
  if (!next || next.id !== row?.id) return false;
  if (!leader || now.getTime() - next.since < ctx.config.nodeLeaderHoldMs) return true;
  return !(await runsWork(ctx.db, next, false));
}

const goOf = (row: Granted, now: Date): Go => {
  const until = row.goAt!.getTime() + FOLLOW_TURN_MS;
  return { commit: row.goCommit!, until: new Date(until).toISOString(), leftMs: Math.max(0, until - now.getTime()) };
};

/* What waits for a machine that installs goes on by itself when its turn ends, whatever the machine then says. */
function pumpAfter(ctx: Ctx, ms: number): void {
  setTimeout(() => void releaseHeld(ctx), ms).unref();
}

/* Turns and test parts that waited for a machine that installed. The queue and the test runs read this module, so they
   are loaded here only when called. */
export async function releaseHeld(ctx: Ctx): Promise<void> {
  try {
    const [{ pumpWaiting }, { pumpTests }] = await Promise.all([import('../conversation/queue.js'), import('../testruns/runs.js')]);
    await pumpWaiting(ctx);
    await pumpTests(ctx);
  } catch (err) {
    ctx.log.error({ error: loggable(err) }, 'Work that waited for a machine to install its build could not go on.');
  }
}

/* What a worker is told of the server's build: nothing while it runs that build or the server knows none; else the
   build, to download at once, and the word to install when it is this machine's turn. The word keeps its end from the
   moment it was given and is never made longer. */
export async function followOf(ctx: Ctx, machineId: string, now = new Date()): Promise<{ build: LeaderBuild | null; go: Go | null }> {
  const build = leaderBuild(ctx);
  const [row] = build ? await ctx.db.select().from(machines).where(and(eq(machines.id, machineId), isNull(machines.revokedAt), follows(ctx.config))) : [];
  if (!build || !row || row.commit === build.commit) return { build: null, go: null };
  if (row.goCommit === build.commit && goodGrant(row, now)) return { build, go: goOf(row, now) };
  /* Only a server that leads and does not install an update itself lets a worker begin. */
  if (ctx.mode.current() !== 'lead' || ctx.updater.status()?.state === 'running') return { build, go: null };
  const granted = await ctx.db.transaction(tx => tryGrant(tx, ctx.config, machineId, build, now));
  if (!granted) return { build, go: null };
  pumpAfter(ctx, FOLLOW_TURN_MS);
  return { build, go: goOf({ ...row, goCommit: build.commit, goAt: now }, now) };
}

async function machineOfNode(tx: Pick<Db, 'select'>, nodeId: string | null | undefined, lock: boolean): Promise<typeof machines.$inferSelect | null> {
  if (!nodeId) return null;
  const [node] = await tx.select(only(nodes, 'machineId')).from(nodes).where(eq(nodes.id, nodeId));
  if (!node?.machineId) return null;
  const rows = tx.select().from(machines).where(eq(machines.id, node.machineId));
  const [row] = lock ? await rows.for('share') : await rows;
  return row ?? null;
}

/* Whether the node's machine installs now, so that no work starts there. The machine's row is held for sharing until the
   transaction ends: a grant, which takes the row for itself, and a claim of work never cross. A node of no machine, as
   the server's own, is never held. */
export async function holdsMachine(tx: Pick<Db, 'select'>, nodeId: string | null | undefined, now = new Date()): Promise<boolean> {
  const row = await machineOfNode(tx, nodeId, true);
  return row !== null && installs(row, now);
}

/* The same for the built-in node of the machine with this network id, with that machine's row held the same way. The
   machine this server runs on follows nobody, and is never held. */
export async function holdsBuiltin(tx: Pick<Db, 'select'>, own: Own, machine: string | null | undefined, now = new Date()): Promise<boolean> {
  if (!machine) return false;
  const [row] = await tx.select().from(machines).where(and(eq(machines.networkId, machine), isNull(machines.revokedAt), follows(own))).for('share');
  return row !== undefined && installs(row, now);
}

/* The same for a caller that only looks, before it does work that a held machine would make useless. */
export async function machineInstalls(db: Pick<Db, 'select'>, nodeId: string | null | undefined, now = new Date()): Promise<boolean> {
  const row = await machineOfNode(db, nodeId, false);
  return row !== null && installs(row, now);
}

/* The network ids of the machines that install now, for whoever picks a built-in node. */
export async function installingBuiltins(db: Pick<Db, 'select'>, own: Own, now = new Date()): Promise<Set<string>> {
  const rows = await installRows(db, own);
  return new Set(rows.filter(row => row.networkId !== null && installs(row, now)).map(row => row.networkId!));
}

/* The machines that install now, for whoever places work: none of it is offered to them. */
export async function installingMachines(db: Pick<Db, 'select'>, own: Own, now = new Date()): Promise<Set<string>> {
  const rows = await installRows(db, own);
  return new Set(rows.filter(row => installs(row, now)).map(row => row.id));
}

/* The built-in nodes that take no new work, for whoever picks one: those of the machines that install now, and of the
   one next to install, so that what the company's keys run goes to another machine meanwhile. */
export async function heldBuiltins(ctx: Ctx, db: Pick<Db, 'select'> = ctx.db): Promise<Set<string>> {
  const held = await installingBuiltins(db, ctx.config);
  const next = await nextToInstall(ctx);
  return next?.networkId ? held.add(next.networkId) : held;
}

/* The machines that take no new work, for whoever places it: those that install now, and the one next to install, whose
   work ends so that it has its turn. */
export async function heldMachines(ctx: Ctx): Promise<Set<string>> {
  const held = await installingMachines(ctx.db, ctx.config);
  const next = await nextToInstall(ctx);
  return next ? held.add(next.id) : held;
}
