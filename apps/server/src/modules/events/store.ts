import { and, asc, countDistinct, desc, eq, gt, inArray, isNotNull, isNull, notInArray, or } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { agentEvents, jobs, people, type AgentEventKind } from '../../db/schema.js';

export type EventView = { seq: number; kind: AgentEventKind; data: unknown; jobId: string | null; person: { id: string; name: string } | null; at: string };

type NewEvent = { companyId: string; agentId: string; jobId?: string | null; kind: AgentEventKind; data: unknown; personId?: string | null };

const columns = {
  seq: agentEvents.seq,
  kind: agentEvents.kind,
  data: agentEvents.data,
  jobId: agentEvents.jobId,
  personId: agentEvents.personId,
  personName: people.name,
  createdAt: agentEvents.createdAt,
};

type Row = { seq: number; kind: AgentEventKind; data: unknown; jobId: string | null; personId: string | null; personName: string | null; createdAt: Date };

const view = (r: Row): EventView => ({
  seq: r.seq,
  kind: r.kind,
  data: r.data,
  jobId: r.jobId,
  person: r.personId ? { id: r.personId, name: r.personName ?? '' } : null,
  at: r.createdAt.toISOString(),
});

/* Stores the event, then tells everyone watching. */
export async function appendEvent(ctx: Pick<Ctx, 'db' | 'bus'>, e: NewEvent): Promise<EventView> {
  const [row] = await ctx.db
    .insert(agentEvents)
    .values({ companyId: e.companyId, agentId: e.agentId, jobId: e.jobId ?? null, kind: e.kind, data: e.data, personId: e.personId ?? null })
    .returning({ id: agentEvents.id });
  const [stored] = await ctx.db.select(columns).from(agentEvents).leftJoin(people, eq(people.id, agentEvents.personId)).where(eq(agentEvents.id, row!.id));
  const event = view(stored!);
  ctx.bus.publish(e.companyId, { type: 'agent_event', agentId: e.agentId, event });
  return event;
}

/* An agent's events after seq, oldest first. */
export async function listEvents(db: Db, agentId: string, after: number, limit = 500): Promise<EventView[]> {
  const rows = await db
    .select(columns)
    .from(agentEvents)
    .leftJoin(people, eq(people.id, agentEvents.personId))
    .where(and(eq(agentEvents.agentId, agentId), gt(agentEvents.seq, after)))
    .orderBy(asc(agentEvents.seq))
    .limit(limit);
  return rows.map(view);
}

/* Agents with a job running right now. */
export async function workingCount(db: Db, companyId: string): Promise<number> {
  const [row] = await db
    .select({ n: countDistinct(jobs.agentId) })
    .from(jobs)
    .where(and(eq(jobs.companyId, companyId), eq(jobs.status, 'running'), isNotNull(jobs.agentId)));
  return Number(row?.n ?? 0);
}

/* The last people's messages and his answers from turns that are over, oldest first, for a new session to catch up. */
export async function earlierTalk(db: Db, agentId: string, limit = 20): Promise<EventView[]> {
  const open = db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.agentId, agentId), inArray(jobs.status, ['queued', 'running'])));
  const rows = await db
    .select(columns)
    .from(agentEvents)
    .leftJoin(people, eq(people.id, agentEvents.personId))
    .where(and(eq(agentEvents.agentId, agentId), inArray(agentEvents.kind, ['message', 'text']), or(isNull(agentEvents.jobId), notInArray(agentEvents.jobId, open))))
    .orderBy(desc(agentEvents.seq))
    .limit(limit);
  return rows.reverse().map(view);
}

/* How many agents work right now, for the map's counter. */
export async function publishWorking(ctx: Pick<Ctx, 'db' | 'bus'>, companyId: string): Promise<void> {
  ctx.bus.publish(companyId, { type: 'working', working: await workingCount(ctx.db, companyId) });
}
