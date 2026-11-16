import type { CheckQueueRequest, NodeMessage } from '@hornhoof/protocol';
import { and, desc, eq, isNull, like, or, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { jobs, nodes, machines, testParts } from '../../db/schema.js';
import { identityOfKey, keyOf, ownBuiltin, ownMachine, type NodeIdentity } from '../nodes/hub.js';
import { z } from 'zod';
import { hashToken } from '../../crypto/tokens.js';
import { CheckCoordinator } from './check-slots-queue.js';

const queues = new WeakMap<Ctx, CheckCoordinator>();

function queueFor(ctx: Ctx): CheckCoordinator {
  let queue = queues.get(ctx);
  if (!queue) {
    const node = (key: string) => identityOfKey(key, ownBuiltin(ctx.config));
    queue = new CheckCoordinator({ send: (key, reply) => { ctx.hub.send(node(key), reply); }, heard: key => ctx.hub.lastSeenAt(node(key)) });
    queues.set(ctx, queue);
  }
  return queue;
}

export async function checkQueueLoad(ctx: Ctx, id: NodeIdentity): Promise<void> {
  const load = ctx.hub.loadOf(id);
  if (!load) return;
  const fallback = await machineKey(ctx, id);
  if (!fallback) return;
  const host = load.host && /^[0-9a-f]{64}$/.test(load.host) ? `host:${load.host}` : fallback;
  queueFor(ctx).node(keyOf(id), host, { cpus: load.cpus, load: load.hostLoad ?? load.load, at: load.at });
}

/* The computer a node's checks share their slots on. A built-in node of another machine than this server's is on that
   machine, whose id its keeper and its node go by. */
async function machineKey(ctx: Ctx, id: NodeIdentity): Promise<string | null> {
  if (id.kind === 'builtin') return id.machine === ownMachine(ctx.config) ? `host:${ctx.config.hostId ?? 'builtin'}` : `host:${id.machine}`;
  const [row] = await ctx.db.select({ key: machines.machineKey }).from(nodes).innerJoin(machines, eq(machines.id, nodes.machineId)).where(eq(nodes.id, id.nodeId));
  return row ? `host:${hashToken(`hornhoof-host:${row.key}`)}` : null;
}

export async function receiveCheckRequest(ctx: Ctx, id: NodeIdentity, request: CheckQueueRequest, scope: SQL): Promise<void> {
  const queue = queueFor(ctx), key = keyOf(id);
  if (request.type === 'check.release') { queue.release(key, request.id); return; }
  let actor = request;
  if (request.agentId || request.jobId) {
    const [job] = await ctx.db.select({ id: jobs.id, agentId: jobs.agentId }).from(jobs).where(and(scope, eq(jobs.status, 'running'),
      request.agentId ? eq(jobs.agentId, request.agentId) : undefined,
      request.jobId ? eq(jobs.id, request.jobId) : undefined)).orderBy(desc(jobs.createdAt)).limit(1);
    if (!job) { ctx.hub.send(id, { type: 'check.state', id: request.id, state: 'ended', position: 0 }); return; }
    actor = { ...request, jobId: job.id };
  }
  await checkQueueLoad(ctx, id);
  queue.acquire(key, actor);
}

export function nodeCheckQueueLost(ctx: Ctx, id: NodeIdentity): void { queues.get(ctx)?.lost(keyOf(id)); }
export function jobCheckQueued(ctx: Ctx, jobId: string, now?: number): boolean { return queues.get(ctx)?.waiting(jobId, now) ?? false; }
export function jobCheckLastEnd(ctx: Ctx, jobId: string, now: number): number | null { return queues.get(ctx)?.lastEnd(jobId, now) ?? null; }
export function closeCheckQueue(ctx: Ctx): void { queues.get(ctx)?.close(); queues.delete(ctx); }

/* Assigned parts are running in the pool, but their execution clock begins only on tests.started. */
export async function recordPartQueueWait(ctx: Ctx, id: NodeIdentity, frame: Extract<NodeMessage, { type: 'tests.waiting' }>): Promise<void> {
  await updateCheckPart(ctx, id, frame.partId, { startedAt: null, tail: `Waiting for a machine check slot. Position ${frame.position}.` });
}

async function updateCheckPart(ctx: Ctx, id: NodeIdentity, partId: string, values: { tail: string; startedAt?: null }, waitingOnly = false): Promise<void> {
  if (!z.uuid().safeParse(partId).success) return;
  /* A part with no machine named is of this server's own built-in node, as all were before machines had theirs. */
  const onBuiltin = (machine: string) => (machine === ownMachine(ctx.config) ? or(eq(testParts.builtinMachine, machine), isNull(testParts.builtinMachine)) : eq(testParts.builtinMachine, machine));
  const owner = id.kind === 'builtin' ? and(eq(testParts.builtin, true), onBuiltin(id.machine)) : eq(testParts.nodeId, id.nodeId);
  await ctx.db.update(testParts).set(values).where(and(eq(testParts.id, partId), eq(testParts.status, 'running'), owner,
    waitingOnly ? like(testParts.tail, 'Waiting for a machine check slot.%') : undefined));
}

export async function routeCheckMessage(ctx: Ctx, id: NodeIdentity, frame: NodeMessage, scope: SQL): Promise<void> {
  if (frame.type === 'check.acquire' || frame.type === 'check.release') return receiveCheckRequest(ctx, id, frame, scope);
  if (frame.type === 'tests.waiting') return recordPartQueueWait(ctx, id, frame);
  if (frame.type === 'tests.started') return updateCheckPart(ctx, id, frame.partId, { tail: '' }, true);
}
