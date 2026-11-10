import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { jobs, machines, nodes, testParts } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import { FULL_SHA } from '../updates/registry.js';

/* The server's own build, as a worker installs it: the image of the server's commit and the node and updater images of
   the same commit, each by its digest. */
export type LeaderBuild = { version: string; tag: string; digest: string; nodeDigest: string; updaterDigest: string; commit: string };
/* The server's word that a worker may install now. until: when the word ends, in ISO. */
export type Go = { commit: string; until: string };

/* How long a worker has to install once it was told to, and how long after a try that failed or ran out it is told again. */
export const FOLLOW_TURN_MS = 15 * 60_000;
export const FOLLOW_RETRY_MS = 6 * 3_600_000;
/* The pg_advisory_xact_lock key of the grants, used for nothing else: one grant is decided at a time. */
export const FOLLOW_LOCK = 0x68686677;

const BUILD_KEPT_MS = 10 * 60_000;
const FAILURE_KEPT_MS = 60_000;

type Kept = { build: LeaderBuild | null; until: number };
const kept = new WeakMap<Ctx, Kept>();

/* The build this server runs, when the registry has its commit's images. A server built by hand names no commit, and
   its workers stay where they are. The registry is asked now and then, and after a failure a little sooner. */
export async function leaderBuild(ctx: Ctx): Promise<LeaderBuild | null> {
  const { commit } = ctx.config;
  if (!FULL_SHA.test(commit)) return null;
  const known = kept.get(ctx);
  if (known && Date.now() < known.until) return known.build;
  const build = await readBuild(ctx, commit).catch((err: unknown) => {
    ctx.log.warn({ error: loggable(err) }, "Could not read this server's own build from the registry, so the other machines stay on theirs.");
    return null;
  });
  kept.set(ctx, { build, until: Date.now() + (build ? BUILD_KEPT_MS : FAILURE_KEPT_MS) });
  return build;
}

async function readBuild(ctx: Ctx, commit: string): Promise<LeaderBuild | null> {
  const [found, siblings] = await Promise.all([ctx.updates.find(commit), ctx.updates.siblings(commit)]);
  if (!found || !siblings.node || !siblings.updater) return null;
  return { version: found.version || found.tag, tag: commit, digest: found.digest, nodeDigest: siblings.node, updaterDigest: siblings.updater, commit };
}

type Granted = Pick<typeof machines.$inferSelect, 'commit' | 'goCommit' | 'goAt' | 'failedCommit' | 'failedAt'>;

/* Whether the machine may install now: it was told to within the last quarter of an hour, has not reported the build
   since, and has not reported that the install failed. */
export function goodGrant(row: Granted, now: Date): boolean {
  if (!row.goCommit || !row.goAt) return false;
  if (now.getTime() - row.goAt.getTime() >= FOLLOW_TURN_MS || row.commit === row.goCommit) return false;
  return !(row.failedCommit === row.goCommit && row.failedAt && row.failedAt >= row.goAt);
}

const within = (at: Date | null, ms: number, now: Date): boolean => at !== null && now.getTime() - at.getTime() < ms;

/* Tells the machine to install the build, when it may: it downloaded the build, no other worker installs now, its last
   try at this build is long enough ago, and nothing runs on it. One decision at a time for the whole company, with the
   machine's row held, so no turn and no test part starts there while it is decided. */
export async function tryGrant(tx: Db, machineId: string, build: LeaderBuild, now: Date): Promise<boolean> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${FOLLOW_LOCK}::bigint)`);
  const [row] = await tx.select().from(machines).where(eq(machines.id, machineId)).for('update');
  if (!row || row.revokedAt || row.role !== 'worker') return false;
  if (row.updateCommit !== build.commit || row.updateState !== 'ready') return false;
  /* A grant that ran out counts as a try that failed. */
  if (row.goCommit === build.commit && within(row.goAt, FOLLOW_RETRY_MS, now)) return false;
  if (row.failedCommit === build.commit && within(row.failedAt, FOLLOW_RETRY_MS, now)) return false;
  const others = await tx.select().from(machines).where(and(isNull(machines.revokedAt), eq(machines.role, 'worker'), isNotNull(machines.goCommit)));
  if (others.some(other => goodGrant(other, now))) return false;
  const [turn] = await tx.select({ id: jobs.id }).from(jobs).innerJoin(nodes, eq(nodes.id, jobs.nodeId)).where(and(eq(nodes.machineId, machineId), eq(jobs.status, 'running'))).limit(1);
  const [part] = await tx.select({ id: testParts.id }).from(testParts).where(and(eq(testParts.machineId, machineId), eq(testParts.status, 'running'))).limit(1);
  if (turn || part) return false;
  await tx.update(machines).set({ goCommit: build.commit, goAt: now }).where(eq(machines.id, machineId));
  return true;
}

const goOf = (row: Granted): Go => ({ commit: row.goCommit!, until: new Date(row.goAt!.getTime() + FOLLOW_TURN_MS).toISOString() });

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
  const build = await leaderBuild(ctx);
  const [row] = build ? await ctx.db.select().from(machines).where(and(eq(machines.id, machineId), isNull(machines.revokedAt), eq(machines.role, 'worker'))) : [];
  if (!build || !row || row.commit === build.commit) return { build: null, go: null };
  if (row.goCommit === build.commit && goodGrant(row, now)) return { build, go: goOf(row) };
  /* Only a server that leads and does not install an update itself lets a worker begin. */
  if (ctx.mode.current() !== 'lead' || ctx.updater.status()?.state === 'running') return { build, go: null };
  const granted = await ctx.db.transaction(tx => tryGrant(tx, machineId, build, now));
  if (!granted) return { build, go: null };
  pumpAfter(ctx, FOLLOW_TURN_MS);
  return { build, go: goOf({ ...row, goCommit: build.commit, goAt: now }) };
}

/* Whether the node's machine installs now, so that no work starts there. The machine's row is held for sharing until the
   transaction ends: a grant, which takes the row for itself, and a claim of work never cross. A node of no machine, as
   the server's own, is never held. */
export async function holdsMachine(tx: Pick<Db, 'select'>, nodeId: string | null | undefined, now = new Date()): Promise<boolean> {
  if (!nodeId) return false;
  const [node] = await tx.select({ machineId: nodes.machineId }).from(nodes).where(eq(nodes.id, nodeId));
  if (!node?.machineId) return false;
  const [row] = await tx.select().from(machines).where(eq(machines.id, node.machineId)).for('share');
  return Boolean(row) && goodGrant(row!, now);
}
