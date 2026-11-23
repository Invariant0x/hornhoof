import { DISK_KEPT_MAX, type DiskReport } from '@hornhoof/protocol';
import { and, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { knowsAgentId, viewerOf } from '../../auth/agent-view.js';
import type { Person } from '../../auth/session.js';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { agents, jobs, machines, nodes, testParts } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { clearNodeWords, pump } from '../conversation/queue.js';
import { afterLeave, cutReplication, holdsSecrets } from '../copies/scope.js';
import { ApiError } from '../../errors.js';
import { revokeMachineRows, visitorKeyOf } from '../network/join.js';
import { findThisMachine } from '../network/store.js';
import { builtinOf, nodeIdentity, type NodeIdentity, type SaidLoad } from './hub.js';
import { loseParts } from '../testruns/runs.js';
import { failOpenJobs } from './job-failures.js';
import { isServerInstall, liveNode, settlePlans } from './nodes.js';

/* The machine that leads does not leave the company: the server moves to another machine first. Asked where a person
   takes machines out, before anything is changed. */
export async function refuseLeader(db: Db, config: Config, machineIds: string[]): Promise<void> {
  const leader = machineIds.length > 0 ? await findThisMachine(db, config) : null;
  if (!leader || !machineIds.includes(leader.id)) return;
  const [row] = await db.select(only(machines, 'hostname')).from(machines).where(eq(machines.id, leader.id));
  throw new ApiError(409, 'conflict', `${row?.hostname || 'This machine'} runs the company server. Move the server to another machine first.`, 'leader', { host: row?.hostname ?? '' });
}

type CopyHolder = Pick<typeof machines.$inferSelect, 'role' | 'copyState' | 'copyAt' | 'machineKey'>;

/* A machine that may hold a company database copy: a ready or completed replica, or an old server install that still has
   role data. */
const holdsCopy = (row: CopyHolder): boolean =>
  row.role === 'data' && (row.copyState === 'ready' || row.copyAt !== null || isServerInstall(row.machineKey));

/* Another machine that holds an active or completed replica: neither an unreplicated former server nor a stopped replica
   counts as a live spare copy. */
const hasSpareReplica = (row: CopyHolder): boolean =>
  row.role === 'data' && (row.copyState === 'ready' || (row.copyAt !== null && row.copyState !== 'stopped'));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type KeptWorkWarning = {
  agent: string | null;
  agentName: string | null;
  path: string | null;
  task: number | null;
  bytes: number;
  why: 'uncommitted' | 'unpushed' | 'ignored';
  ignored?: string[];
};

type RawKept = NonNullable<DiskReport['kept']>[number];
type KeptLoad = SaidLoad & { disk: DiskReport & { kept: NonNullable<DiskReport['kept']> } };

const canonicalAgent = (id: string): string => (UUID.test(id) ? id.toLowerCase() : id);
const hasKept = (load: SaidLoad | null | undefined): load is KeptLoad => Boolean(load?.disk?.kept);

async function keptAgentNames(
  db: Db,
  companyId: string,
  viewer: Awaited<ReturnType<typeof viewerOf>>,
  raw: RawKept[],
): Promise<Map<string, string>> {
  const uuidIds = [...new Set(raw.map(entry => canonicalAgent(entry.agent)))].filter(id => UUID.test(id) && knowsAgentId(viewer, id));
  if (!uuidIds.length) return new Map();
  const rows = await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, uuidIds)));
  return new Map(rows.map(row => [row.id, row.name]));
}

function toKeptWarning(entry: RawKept, apart: ReadonlySet<string>, names: Map<string, string>): KeptWorkWarning {
  const key = canonicalAgent(entry.agent);
  if (apart.has(key)) return { agent: null, agentName: null, path: null, task: null, bytes: entry.bytes, why: entry.why };
  return {
    agent: entry.agent,
    agentName: names.get(key) ?? null,
    path: entry.path,
    task: entry.task,
    bytes: entry.bytes,
    why: entry.why,
    ...(entry.ignored?.length ? { ignored: entry.ignored } : {}),
  };
}

async function keptWarnings(
  ctx: Pick<Ctx, 'db' | 'hub'>,
  me: Person,
  machine: Pick<typeof machines.$inferSelect, 'id' | 'companyId' | 'networkId'>,
): Promise<{ kept: KeptWorkWarning[] | null; keptAt: string | null }> {
  const nodeRows = await ctx.db.select(only(nodes, 'id')).from(nodes).where(and(eq(nodes.machineId, machine.id), liveNode));
  const identities: NodeIdentity[] = [...nodeRows.map(n => nodeIdentity(n.id)), ...(machine.networkId ? [builtinOf(machine.networkId)] : [])];
  const withKept = identities.map(id => ctx.hub.loadOf(id)).filter(hasKept);
  if (withKept.length === 0) return { kept: null, keptAt: null };
  const keptAt = new Date(Math.max(...withKept.map(load => load.at))).toISOString();
  const raw = withKept.flatMap(load => load.disk.kept).toSorted((a, b) => b.bytes - a.bytes).slice(0, DISK_KEPT_MAX);
  const viewer = await viewerOf(ctx.db, me);
  const names = await keptAgentNames(ctx.db, machine.companyId, viewer, raw);
  return { kept: raw.map(entry => toKeptWarning(entry, viewer.apart, names)), keptAt };
}

export async function removalWarnings(ctx: Pick<Ctx, 'db' | 'config' | 'hub'>, me: Person, machine: typeof machines.$inferSelect) {
  const { networkId, role, copyState, copyAt, machineKey, heldBackups } = machines;
  const [others, kept] = await Promise.all([
    ctx.db.select({ networkId, role, copyState, copyAt, machineKey, heldBackups }).from(machines)
      .where(and(eq(machines.companyId, machine.companyId), isNull(machines.revokedAt), ne(machines.id, machine.id))),
    keptWarnings(ctx, me, machine),
  ]);
  const otherBackups = new Set(others.flatMap(row => row.heldBackups));
  return {
    lastReplica: holdsCopy(machine) && !others.some(row => row.networkId !== ctx.config.machineId && hasSpareReplica(row)),
    onlyBackup: machine.heldBackups.some(id => !otherBackups.has(id)),
    uncollectedData: machine.uploadState === 'waiting',
    ...kept,
  };
}

/* Stops these machines' nodes: open jobs fail, the parts of test runs they ran wait for another machine, sockets close,
   the agents on them pick another machine of their plan at their next turn, and a plan left with no machine waits for
   one again. A turn that waited for one of these machines goes out on another one now. A machine of the network is cut
   off for good: its certificates, tickets and commands end in the same transaction that marks its row. One that held the
   company's data, or still owes what it held, is cut from the server's changes first, and leaves holding nothing that
   opens the company's link: the link's key changes too. */
export async function disconnectMachines(ctx: Ctx, machineIds: string[]): Promise<void> {
  if (machineIds.length === 0) return;
  const copies = await ctx.db.select({ id: machines.id, networkId: machines.networkId }).from(machines).where(and(inArray(machines.id, machineIds), holdsSecrets, isNull(machines.revokedAt)));
  await cutReplication(ctx.replication, copies);
  const { ids, moved, cored } = await ctx.db.transaction(async tx => {
    const now = new Date();
    await tx.update(machines).set({ revokedAt: now }).where(inArray(machines.id, machineIds));
    if (copies.length > 0) {
      await tx.update(machines).set({ dataLeftAt: now, serverOrder: null, serverWhy: null }).where(inArray(machines.id, copies.map(copy => copy.id)));
      await ctx.links.startKey(tx);
    }
    const cored = await revokeMachineRows(tx, machineIds, now);
    const gone = await tx
      .update(nodes)
      .set({ keyHash: null, status: 'needs_login' })
      .where(and(inArray(nodes.machineId, machineIds), liveNode))
      .returning({ id: nodes.id, subscriptionId: nodes.subscriptionId });
    await settlePlans(tx, gone.map(n => n.subscriptionId));
    const moved = gone.length ? await tx.update(agents).set({ nodeId: null }).where(inArray(agents.nodeId, gone.map(n => n.id))).returning({ id: agents.id }) : [];
    return { ids: gone.map(n => n.id), moved: moved.map(a => a.id), cored };
  });
  /* A machine that had the core holds the link's visitor key. The relay ends it when it gives a new one, so that is
     asked for now and not waited for; a relay that does not answer is asked again with the next view a keeper reads. */
  if (copies.length > 0) void afterLeave(ctx);
  else if (cored) void visitorKeyOf(ctx, { force: true });
  await finishDisconnect(ctx, machineIds, ids);
  for (const id of moved) await pump(ctx, id);
}

async function finishDisconnect(ctx: Ctx, machineIds: string[], ids: string[]): Promise<void> {
  /* The nodes lose their keys first, so the turns that end here send no next turn to the leaving ones. */
  for (const id of ids) { clearNodeWords(ctx, nodeIdentity(id)); ctx.hub.close(id, 4001); }
  if (ids.length) await failOpenJobs(ctx, inArray(jobs.nodeId, ids), 'machine_disconnected');
  await loseParts(ctx, inArray(testParts.machineId, machineIds), 'machine_disconnected');
}

/* Finish work left after the machine and its nodes had already lost access. */
export async function finishDisconnectedMachines(ctx: Ctx, machineIds: string[]): Promise<void> {
  const known = await ctx.db.select(only(nodes, 'id')).from(nodes).where(inArray(nodes.machineId, machineIds));
  await finishDisconnect(ctx, machineIds, known.map(node => node.id));
}
