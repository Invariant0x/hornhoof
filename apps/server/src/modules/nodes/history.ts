import type { NodeReconnect } from '@hornhoof/protocol';
import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { machines, nodeConnectionEvents, nodes, NODE_CONNECTION_ACTORS, NODE_CONNECTION_CAUSES } from '../../db/schema.js';
import type { NodeIdentity } from './hub.js';

export const NODE_HISTORY_DAYS = 14;
export const NODE_HISTORY_EVENTS_PER_MACHINE = 2000;

export type NodeConnectionActor = (typeof NODE_CONNECTION_ACTORS)[number];
export type NodeConnectionCause = (typeof NODE_CONNECTION_CAUSES)[number];
export type NodeConnectionEvent =
  | { kind: 'connected'; at: Date }
  | {
      kind: 'disconnected';
      at: Date;
      actor: NodeConnectionActor;
      cause: NodeConnectionCause;
      closeCode: number | null;
      closeReason: string | null;
      error: string | null;
    };

const between = (from: Date, to: Date): number => Math.max(0, to.getTime() - from.getTime());

function logConnection(ctx: Pick<Ctx, 'log'>, id: NodeIdentity, machine: string, event: NodeConnectionEvent): void {
  const disconnected = event.kind === 'disconnected';
  ctx.log.info(
    {
      machine,
      nodeId: id.kind === 'node' ? id.nodeId : 'builtin',
      actor: disconnected ? event.actor : null,
      cause: disconnected ? event.cause : null,
      closeCode: disconnected ? event.closeCode : null,
      closeReason: disconnected ? event.closeReason : null,
    },
    disconnected ? 'A node disconnected.' : 'A node connected.',
  );
}

type StoredNode = { companyId: string; machineId: string; nodeId: string };

async function recordConnected(tx: Db, stored: StoredNode, event: Extract<NodeConnectionEvent, { kind: 'connected' }>): Promise<void> {
  const [last] = await tx
    .select({ id: nodeConnectionEvents.id, happenedAt: nodeConnectionEvents.happenedAt })
    .from(nodeConnectionEvents)
    .where(and(eq(nodeConnectionEvents.nodeId, stored.nodeId), eq(nodeConnectionEvents.kind, 'disconnected'), lte(nodeConnectionEvents.happenedAt, event.at), isNull(nodeConnectionEvents.offlineMs)))
    .orderBy(desc(nodeConnectionEvents.happenedAt), desc(nodeConnectionEvents.id))
    .limit(1);
  const offlineMs = last ? between(last.happenedAt, event.at) : null;
  if (last) await tx.update(nodeConnectionEvents).set({ offlineMs }).where(eq(nodeConnectionEvents.id, last.id));
  await tx.insert(nodeConnectionEvents).values({ ...stored, kind: event.kind, happenedAt: event.at, offlineMs });
}

async function recordDisconnected(tx: Db, stored: StoredNode, event: Extract<NodeConnectionEvent, { kind: 'disconnected' }>): Promise<void> {
  const [next] = await tx
    .select({ id: nodeConnectionEvents.id, happenedAt: nodeConnectionEvents.happenedAt })
    .from(nodeConnectionEvents)
    .where(and(eq(nodeConnectionEvents.nodeId, stored.nodeId), eq(nodeConnectionEvents.kind, 'connected'), gte(nodeConnectionEvents.happenedAt, event.at)))
    .orderBy(asc(nodeConnectionEvents.happenedAt), asc(nodeConnectionEvents.id))
    .limit(1);
  const offlineMs = next ? between(event.at, next.happenedAt) : null;
  await tx.insert(nodeConnectionEvents).values({
    ...stored,
    kind: event.kind,
    happenedAt: event.at,
    actor: event.actor,
    cause: event.cause,
    closeCode: event.closeCode,
    closeReason: event.closeReason,
    error: event.error?.slice(0, 300) ?? null,
    offlineMs,
  });
  if (next) await tx.update(nodeConnectionEvents).set({ offlineMs }).where(eq(nodeConnectionEvents.id, next.id));
}

export async function recordNodeConnection(ctx: Pick<Ctx, 'db' | 'log'>, id: NodeIdentity, event: NodeConnectionEvent): Promise<void> {
  if (id.kind !== 'node') {
    logConnection(ctx, id, 'built-in', event);
    return;
  }
  const [row] = await ctx.db
    .select({ companyId: nodes.companyId, machineId: nodes.machineId, hostname: machines.hostname })
    .from(nodes)
    .innerJoin(machines, eq(machines.id, nodes.machineId))
    .where(eq(nodes.id, id.nodeId));
  if (!row) return;
  logConnection(ctx, id, row.hostname, event);

  const stored = { companyId: row.companyId, machineId: row.machineId, nodeId: id.nodeId };
  await ctx.db.transaction(async tx => {
    if (event.kind === 'connected') return recordConnected(tx, stored, event);
    return recordDisconnected(tx, stored, event);
  });
  await pruneNodeConnectionHistory(ctx.db, new Date());
}

export async function attachNodeReconnect(db: Db, id: NodeIdentity, report: NodeReconnect): Promise<void> {
  if (id.kind !== 'node') return;
  const [last] = await db
    .select({ id: nodeConnectionEvents.id })
    .from(nodeConnectionEvents)
    .where(and(eq(nodeConnectionEvents.nodeId, id.nodeId), eq(nodeConnectionEvents.kind, 'disconnected'), isNull(nodeConnectionEvents.nodeReport)))
    .orderBy(desc(nodeConnectionEvents.happenedAt), desc(nodeConnectionEvents.id))
    .limit(1);
  if (!last) return;
  await db.update(nodeConnectionEvents).set({ nodeReport: report }).where(and(eq(nodeConnectionEvents.id, last.id), isNull(nodeConnectionEvents.nodeReport)));
}

export async function pruneNodeConnectionHistory(db: Db, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - NODE_HISTORY_DAYS * 24 * 60 * 60 * 1000);
  await db.execute(sql`delete from node_connection_events
    where happened_at < ${cutoff}
      or id in (
        select id from (
          select id, row_number() over (partition by machine_id order by happened_at desc, id desc) as position
          from node_connection_events
        ) ranked
        where position > ${NODE_HISTORY_EVENTS_PER_MACHINE}
      )`);
}


type EventRow = typeof nodeConnectionEvents.$inferSelect;
type CauseCount = { count: number; latest: number };

const byCause = (a: [string, CauseCount], b: [string, CauseCount]): number => b[1].count - a[1].count || b[1].latest - a[1].latest;

function topCause(rows: EventRow[]): string | null {
  const causes = new Map<string, CauseCount>();
  for (const row of rows) {
    if (!row.cause) continue;
    const current = causes.get(row.cause);
    causes.set(row.cause, { count: (current?.count ?? 0) + 1, latest: Math.max(current?.latest ?? 0, row.happenedAt.getTime()) });
  }
  return [...causes.entries()].sort(byCause)[0]?.[0] ?? null;
}

function summary(rows: EventRow[], now: Date) {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const disconnected = rows.filter(row => row.kind === 'disconnected' && row.happenedAt >= since);
  const durations = disconnected.map(row => row.offlineMs ?? Math.max(0, now.getTime() - row.happenedAt.getTime()));
  return {
    since,
    disconnects: disconnected.length,
    averageOfflineMs: durations.length ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length) : null,
    topCause: topCause(disconnected),
  };
}

function eventView(row: EventRow) {
  return {
    id: row.id,
    nodeId: row.nodeId,
    kind: row.kind,
    happenedAt: row.happenedAt,
    actor: row.actor,
    cause: row.cause,
    closeCode: row.closeCode,
    closeReason: row.closeReason,
    error: row.error,
    offlineMs: row.offlineMs,
    nodeReport: row.nodeReport,
  };
}

export async function nodeConnectionHistory(db: Db, machineId: string, now = new Date()) {
  const rows = await db
    .select()
    .from(nodeConnectionEvents)
    .where(eq(nodeConnectionEvents.machineId, machineId))
    .orderBy(desc(nodeConnectionEvents.happenedAt), desc(nodeConnectionEvents.id));
  return { summary: summary(rows, now), events: rows.slice(0, 50).map(eventView) };
}
