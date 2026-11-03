import type { AgentEvent } from '@hornhoof/protocol';
import { and, asc, countDistinct, desc, eq, gt, inArray, isNotNull, isNull, notInArray, or, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { agentSpot } from '../../auth/access.js';
import { agentEvents, agents, jobs, people, type AgentEventKind } from '../../db/schema.js';
import { agentParty, incomingEnvelope, messageData, readMessage, type MessageEnvelope, type MessageParty } from './parties.js';

export type EventView = { seq: number; kind: AgentEventKind; data: unknown; message?: MessageEnvelope; jobId: string | null; person: { id: string; name: string } | null; at: string };

type NewEvent = { companyId: string; agentId: string; jobId?: string | null; kind: AgentEventKind; data: unknown; message?: MessageEnvelope; personId?: string | null };

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type EventValues = typeof agentEvents.$inferInsert;
/* What must be kept with the event or not at all, in the transaction that stores it. */
export type WithEvent = (tx: Tx, stored: { seq: number; createdAt: Date }) => Promise<void>;

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

/* A machine command's code stays with the person it was made for: a conversation keeps the command with its code hidden. */
const JOIN_CODE = /--join [A-Za-z0-9_-]+/g;
function hideCodes(data: unknown): unknown {
  const text = JSON.stringify(data);
  return text?.includes('--join ') ? JSON.parse(text.replace(JOIN_CODE, '--join [hidden]')) : data;
}

const view = (r: Row): EventView => ({
  seq: r.seq,
  kind: r.kind,
  ...(r.kind === 'message' ? readMessage(r.data) : { data: r.data }),
  jobId: r.jobId,
  person: r.personId ? { id: r.personId, name: r.personName ?? '' } : null,
  at: r.createdAt.toISOString(),
});

/* Stores the event, with what goes along with it, then tells everyone watching. */
export async function appendEvent(ctx: Pick<Ctx, 'db' | 'bus' | 'templates'>, e: NewEvent, also?: WithEvent): Promise<EventView> {
  const message = e.kind === 'message' ? e.message ?? await incomingEnvelope(ctx, e.companyId, e.agentId, e.personId, e.data) : undefined;
  const data = message ? messageData(e.data, message) : e.data;
  const values = { companyId: e.companyId, agentId: e.agentId, jobId: e.jobId ?? null, kind: e.kind, data: hideCodes(data), personId: e.personId ?? null };
  const outgoing = await outgoingLetter(ctx.db, e, message);
  const rows = await storeEvents(ctx.db, values, outgoing, also);
  const event = await publishEvent(ctx, e.companyId, e.agentId, rows[0]!.id);
  if (outgoing) await publishEvent(ctx, e.companyId, outgoing.agentId, rows[1]!.id);
  return event;
}

/* Serialize a stream write with Stop and completion on the same job row, before publishing it. */
export async function appendTurnEvent(ctx: Pick<Ctx, 'db' | 'bus'>, jobId: string, event: AgentEvent, scope: SQL): Promise<void> {
  const stored = await ctx.db.transaction(async tx => {
    const [job] = await tx.select({ companyId: jobs.companyId, agentId: jobs.agentId }).from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running'), eq(jobs.kind, 'conversation'), isNull(jobs.error), scope)).for('update');
    if (!job?.agentId) return null;
    const [row] = await tx.insert(agentEvents).values({ companyId: job.companyId, agentId: job.agentId, jobId, kind: event.kind, data: hideCodes(event), personId: null }).returning({ id: agentEvents.id });
    return { id: row!.id, companyId: job.companyId, agentId: job.agentId };
  });
  if (stored) await publishEvent(ctx, stored.companyId, stored.agentId, stored.id);
}

/* Only the receiving copy carries by, which the per-turn send quota counts after a restart. */
async function outgoingLetter(db: Db, e: NewEvent, message?: MessageEnvelope): Promise<EventValues | null> {
  if (!message || message.direction !== 'in' || message.from.kind !== 'agent' || !message.from.id || message.from.id === e.agentId) return null;
  const senderId = message.from.id;
  const [senderJob] = await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.agentId, senderId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'))).limit(1);
  return {
    companyId: e.companyId, agentId: senderId, jobId: senderJob?.id ?? null, kind: 'message',
    data: hideCodes(messageData({ text: (e.data as { text?: unknown }).text }, { ...message, direction: 'out' })), personId: null,
  };
}

async function storeEvents(db: Db, values: EventValues, outgoing: EventValues | null, also?: WithEvent) {
  const returning = { id: agentEvents.id, seq: agentEvents.seq, createdAt: agentEvents.createdAt };
  return also || outgoing
    ? db.transaction(async tx => {
        const stored = await tx.insert(agentEvents).values(values).returning(returning);
        if (also) await also(tx, stored[0]!);
        if (outgoing) stored.push(...await tx.insert(agentEvents).values(outgoing).returning(returning));
        return stored;
      })
    : db.insert(agentEvents).values(values).returning(returning);
}

async function publishEvent(ctx: Pick<Ctx, 'db' | 'bus'>, companyId: string, agentId: string, id: string): Promise<EventView> {
  const [stored] = await ctx.db.select(columns).from(agentEvents).leftJoin(people, eq(people.id, agentEvents.personId)).where(eq(agentEvents.id, id));
  const event = view(stored!);
  const [agent] = await ctx.db.select({ departmentId: agents.departmentId, productId: agents.productId, teamId: agents.teamId }).from(agents).where(eq(agents.id, agentId));
  ctx.bus.publish(companyId, { type: 'agent_event', agentId, event, spot: agent ? await agentSpot(ctx.db, agent) : { departmentId: null } });
  return event;
}

/* Questions to people have no receiving agent lane to create their outgoing entry. */
export async function appendOutgoing(ctx: Pick<Ctx, 'db' | 'bus' | 'templates'>, e: { companyId: string; agentId: string; jobId: string; text: string; to: MessageParty }): Promise<void> {
  await appendEvent(ctx, { ...e, kind: 'message', data: { text: e.text }, message: { direction: 'out', from: await agentParty(ctx, e.companyId, e.agentId), to: e.to } });
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

/* A queued turn's sender snapshot, with trusted legacy ids for turns queued before message envelopes existed. */
export async function messageForJob(ctx: Pick<Ctx, 'db' | 'templates'>, job: { id: string; companyId: string; agentId: string }): Promise<MessageEnvelope> {
  const [row] = await ctx.db.select({ data: agentEvents.data, personId: agentEvents.personId }).from(agentEvents)
    .where(and(eq(agentEvents.jobId, job.id), eq(agentEvents.kind, 'message'))).orderBy(asc(agentEvents.seq)).limit(1);
  const saved = row && readMessage(row.data).message;
  return saved ?? incomingEnvelope(ctx, job.companyId, job.agentId, row?.personId, row?.data);
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
