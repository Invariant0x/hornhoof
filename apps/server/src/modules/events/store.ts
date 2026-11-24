import { ToolPrivacy, type AgentEvent } from '@hornhoof/protocol';
import { hideCredentialsIn, hideJoinCodes } from '@hornhoof/protocol/redaction';
import { and, asc, countDistinct, desc, eq, gt, inArray, isNotNull, isNull, lt, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { agentSpot } from '../../auth/access.js';
import { agentEvents, agents, jobs, people, tasks, type AgentEventKind } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import {
  assignEventDataNumber,
  ensureChatNumbers,
  isNumberedChatEvent,
  lockAgentChatNumbers,
  readChatNumber,
  readReplyQuote,
  stripChatInternal,
  taskRefOfEvent,
  type EventTaskRef,
  type ReplyQuote,
} from './numbers.js';
import { HORNHOOF, agentParty, incomingEnvelope, messageData, readMessage, type MessageEnvelope, type MessageParty } from './parties.js';
import { notStep } from '../tools/steps.js';
import { privateTurn } from '../tools/private-turns.js';
import { saying } from '../../locales/index.js';

export type { EventTaskRef, ReplyQuote };
export type EventView = {
  seq: number;
  number?: number;
  kind: AgentEventKind;
  data: unknown;
  message?: MessageEnvelope;
  task?: EventTaskRef;
  replyTo?: ReplyQuote;
  jobId: string | null;
  person: { id: string; name: string } | null;
  at: string;
};

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
  jobTaskId: tasks.id,
  jobTaskNumber: tasks.number,
  createdAt: agentEvents.createdAt,
};

type Row = {
  seq: number;
  kind: AgentEventKind;
  data: unknown;
  jobId: string | null;
  personId: string | null;
  personName: string | null;
  jobTaskId: string | null;
  jobTaskNumber: number | null;
  createdAt: Date;
};

/* Conversation events keep their older join-code guard as well as the shared prose mask. The join code goes first: a
   password label in front of it would otherwise take the flag alone and leave the code open. */
function hideEventSecrets(data: unknown): unknown {
  const text = JSON.stringify(data);
  return hideCredentialsIn(text?.includes('--join ') ? JSON.parse(hideJoinCodes(text)) : data);
}

function view(r: Row): EventView {
  const number = readChatNumber(r.data);
  const replyTo = readReplyQuote(r.data);
  const unpacked = r.kind === 'message' ? readMessage(r.data) : { data: r.data };
  const jobTask = r.jobTaskId && r.jobTaskNumber !== null ? { id: r.jobTaskId, number: r.jobTaskNumber } : null;
  const task = number !== undefined ? taskRefOfEvent(r.data, unpacked.message, jobTask) : undefined;
  return {
    seq: r.seq,
    ...(number !== undefined ? { number } : {}),
    kind: r.kind,
    data: stripChatInternal(unpacked.data),
    ...(unpacked.message ? { message: unpacked.message } : {}),
    ...(task ? { task } : {}),
    ...(replyTo ? { replyTo } : {}),
    jobId: r.jobId,
    person: r.personId ? { id: r.personId, name: r.personName ?? '' } : null,
    at: r.createdAt.toISOString(),
  };
}

/* Stores the event, with what goes along with it, then tells everyone watching. */
export async function appendEvent(ctx: Pick<Ctx, 'db' | 'bus' | 'templates'>, e: NewEvent, also?: WithEvent): Promise<EventView> {
  const message = e.kind === 'message' ? e.message ?? await incomingEnvelope(ctx, e.companyId, e.agentId, e.personId, e.data) : undefined;
  const data = message ? messageData(e.data, message) : e.data;
  const values = { companyId: e.companyId, agentId: e.agentId, jobId: e.jobId ?? null, kind: e.kind, data: hideEventSecrets(data), personId: e.personId ?? null };
  const outgoing = await outgoingLetter(ctx.db, e, message);
  const rows = await storeEvents(ctx.db, values, outgoing, also);
  const event = await publishEvent(ctx, e.companyId, e.agentId, rows[0]!.id);
  if (outgoing) await publishEvent(ctx, e.companyId, outgoing.agentId, rows[1]!.id);
  return event;
}

/* Serialize a stream write with Stop and completion on the same job row, before publishing it. Whether it was stored: only
   for a turn of the node's own that runs. */
export async function appendTurnEvent(ctx: Pick<Ctx, 'db' | 'bus'>, jobId: string, event: AgentEvent, scope: SQL): Promise<boolean> {
  const stored = await ctx.db.transaction(async tx => {
    const [job] = await tx.select({ companyId: jobs.companyId, agentId: jobs.agentId }).from(jobs)
      .where(and(eq(jobs.id, jobId), eq(jobs.status, 'running'), eq(jobs.kind, 'conversation'), isNull(jobs.error), scope)).for('no key update');
    if (!job?.agentId) return null;
    const state = privateTurn(ctx.db, jobId);
    event = new ToolPrivacy().event(event);
    if (state) event = state.values.hide(event);
    const numbered = await assignEventDataNumber(tx, job.agentId, event.kind, cleanTurnEvent(event));
    const [row] = await tx.insert(agentEvents).values({ companyId: job.companyId, agentId: job.agentId, jobId, kind: event.kind, data: numbered, personId: null }).returning({ id: agentEvents.id });
    return { id: row!.id, companyId: job.companyId, agentId: job.agentId };
  });
  if (stored) await publishEvent(ctx, stored.companyId, stored.agentId, stored.id);
  return stored !== null;
}

export function cleanTurnEvent(event: AgentEvent): AgentEvent {
  if (event.kind === 'tool') return { ...event, input: cleanToolText(event.input) };
  if (event.kind === 'tool_result') return { ...event, summary: cleanToolText(event.summary) };
  return hideEventSecrets(event) as AgentEvent;
}

function cleanToolText(text: string): string {
  try { return JSON.stringify(hideEventSecrets(JSON.parse(text))); }
  catch { return hideEventSecrets(text) as string; }
}

/* The durable marker records issuance without retaining any value. */
export async function sensitiveTurn(db: Db, jobId: string, issued = false): Promise<boolean> {
  const [row] = await db.select({ id: agentEvents.id }).from(agentEvents)
    .where(and(eq(agentEvents.jobId, jobId), eq(agentEvents.kind, 'tool'), sql`${agentEvents.data}->>'sensitive' = 'true'`, issued ? sql`${agentEvents.data}->>'issued' = 'true'` : undefined)).limit(1);
  return row !== undefined;
}

/* Only the receiving copy carries by, which the per-turn send quota counts after a restart. */
async function outgoingLetter(db: Db, e: NewEvent, message?: MessageEnvelope): Promise<EventValues | null> {
  if (!message || message.direction !== 'in' || message.notification || message.from.kind !== 'agent' || !message.from.id || message.from.id === e.agentId) return null;
  const senderId = message.from.id;
  const [senderJob] = await db.select(idOnly(jobs)).from(jobs).where(and(eq(jobs.agentId, senderId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'running'))).limit(1);
  return {
    companyId: e.companyId, agentId: senderId, jobId: senderJob?.id ?? null, kind: 'message',
    data: hideEventSecrets(messageData({ text: (e.data as { text?: unknown }).text }, { ...message, direction: 'out' })), personId: null,
  };
}

async function storeEvents(db: Db, values: EventValues, outgoing: EventValues | null, also?: WithEvent) {
  const returning = { id: agentEvents.id, seq: agentEvents.seq, createdAt: agentEvents.createdAt };
  const numbered = isNumberedChatEvent(values.kind, values.data);
  if (!also && !outgoing && !numbered) return db.insert(agentEvents).values(values).returning(returning);
  return db.transaction(async tx => {
    const lockedIds = [...new Set([values.agentId, ...(outgoing ? [outgoing.agentId] : [])])].sort();
    if (numbered || outgoing) {
      for (const id of lockedIds) await lockAgentChatNumbers(tx, id);
    }
    const primaryData = await assignEventDataNumber(tx, values.agentId, values.kind, values.data);
    const stored = await tx.insert(agentEvents).values({ ...values, data: primaryData }).returning(returning);
    if (also) await also(tx, stored[0]!);
    if (outgoing) {
      const outData = await assignEventDataNumber(tx, outgoing.agentId, outgoing.kind, outgoing.data);
      stored.push(...(await tx.insert(agentEvents).values({ ...outgoing, data: outData }).returning(returning)));
    }
    return stored;
  });
}

function selectEventRows(db: Db) {
  return db
    .select(columns)
    .from(agentEvents)
    .leftJoin(people, eq(people.id, agentEvents.personId))
    .leftJoin(jobs, eq(jobs.id, agentEvents.jobId))
    .leftJoin(tasks, eq(tasks.id, jobs.taskId));
}

export async function publishEvent(ctx: Pick<Ctx, 'db' | 'bus'>, companyId: string, agentId: string, id: string): Promise<EventView> {
  const [stored] = await selectEventRows(ctx.db).where(eq(agentEvents.id, id));
  const event = view(stored!);
  const [agent] = await ctx.db.select({ departmentId: agents.departmentId, productId: agents.productId, teamId: agents.teamId }).from(agents).where(eq(agents.id, agentId));
  ctx.bus.publish(companyId, { type: 'agent_event', agentId, event, spot: agent ? await agentSpot(ctx.db, agent) : { departmentId: null } });
  return event;
}

/* Questions to people have no receiving agent lane to create their outgoing entry. */
export async function appendOutgoing(
  ctx: Pick<Ctx, 'db' | 'bus' | 'templates'>,
  e: {
    companyId: string;
    agentId: string;
    jobId: string;
    text: string;
    to: MessageParty;
    task?: EventTaskRef;
    requestId?: string;
    replyTo?: ReplyQuote;
    _telegramBridge?: { bot: string; chat: number; replyToMessageId: number };
  },
): Promise<EventView> {
  const extra = {
    ...(e.task ? { task: e.task } : {}),
    ...(e.requestId ? { requestId: e.requestId } : {}),
    ...(e.replyTo ? { replyTo: e.replyTo } : {}),
    ...(e._telegramBridge ? { _telegramBridge: e._telegramBridge } : {}),
  };
  return appendEvent(ctx, {
    companyId: e.companyId,
    agentId: e.agentId,
    jobId: e.jobId,
    kind: 'message',
    data: { text: e.text, ...extra },
    message: { direction: 'out', from: await agentParty(ctx, e.companyId, e.agentId), to: e.to },
  });
}

/* An agent's events after seq, oldest first. A program's evidence is the operator's record, said to nobody. */
export async function listEvents(db: Db, agentId: string, after: number, limit = 500): Promise<EventView[]> {
  await ensureChatNumbers(db, agentId);
  const rows = await selectEventRows(db)
    .where(and(eq(agentEvents.agentId, agentId), gt(agentEvents.seq, after), sql`${agentEvents.data}->>'operatorEvidenceId' is null`))
    .orderBy(asc(agentEvents.seq))
    .limit(limit);
  return rows.map(view);
}

/* An agent's newest events, or the newest before seq, oldest first: a window keeps only its last ones and reads further back
   when asked. */
export async function lastEvents(db: Db, agentId: string, last: number, before?: number): Promise<EventView[]> {
  await ensureChatNumbers(db, agentId);
  const rows = await selectEventRows(db)
    .where(and(eq(agentEvents.agentId, agentId), before === undefined ? undefined : lt(agentEvents.seq, before), sql`${agentEvents.data}->>'operatorEvidenceId' is null`))
    .orderBy(desc(agentEvents.seq))
    .limit(last);
  return rows.reverse().map(view);
}

/* A queued turn's sender snapshot, with trusted legacy ids for turns queued before message envelopes existed. */
export async function messageForJob(ctx: Pick<Ctx, 'db' | 'templates'>, job: { id: string; companyId: string; agentId: string; retryOf?: string | null; continueOf?: string | null }): Promise<MessageEnvelope> {
  const [row] = await ctx.db.select({ data: agentEvents.data, personId: agentEvents.personId }).from(agentEvents)
    .where(and(eq(agentEvents.jobId, job.id), or(eq(agentEvents.kind, 'message'), and(eq(agentEvents.kind, 'typed'), sql`${agentEvents.data}->'_message' is not null`)))).orderBy(asc(agentEvents.seq)).limit(1);
  const saved = row && readMessage(row.data).message;
  const message = saved ?? await incomingEnvelope(ctx, job.companyId, job.agentId, row?.personId, row?.data);
  return automaticMessage(message, job);
}

/* Agents with a job running right now, of these only when named. employees: of the company's employees alone, as the
   screens count them; an assistant's own agent works for its owner, not for the company. apart: jobs left out. */
export async function workingCount(db: Db, companyId: string, among?: string[], employees = false, apart: string[] = []): Promise<number> {
  if (among?.length === 0) return 0;
  const assistantsOwn = db.select(idOnly(agents)).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.kind, 'assistant')));
  const [row] = await db
    .select({ n: countDistinct(jobs.agentId) })
    .from(jobs)
    .where(and(eq(jobs.companyId, companyId), eq(jobs.status, 'running'), isNotNull(jobs.agentId), notStep, among ? inArray(jobs.agentId, among) : undefined, employees ? notInArray(jobs.agentId, assistantsOwn) : undefined, apart.length ? notInArray(jobs.id, apart) : undefined));
  return Number(row?.n ?? 0);
}

/* The last people's messages and his answers from turns that are over, oldest first, for a new session to catch up. */
export async function earlierTalk(db: Db, agentId: string, limit = 20): Promise<EventView[]> {
  await ensureChatNumbers(db, agentId);
  /* Unsent task wakes stay in the log: a new session must not receive them as catch-up instructions. */
  const unspoken = db.select(idOnly(jobs)).from(jobs).where(and(eq(jobs.agentId, agentId), or(inArray(jobs.status, ['queued', 'running']), inArray(jobs.error, ['stale', 'waiting']))));
  const rows = await selectEventRows(db)
    .where(and(eq(agentEvents.agentId, agentId), inArray(agentEvents.kind, ['message', 'text']), sql`coalesce(${agentEvents.data}->>'turnFact', 'false') <> 'true'`, or(isNull(agentEvents.jobId), notInArray(agentEvents.jobId, unspoken))))
    .orderBy(desc(agentEvents.seq))
    .limit(limit);
  return rows.reverse().map(view);
}

/* How many agents work right now, for the map's counter. */
export async function publishWorking(ctx: Pick<Ctx, 'db' | 'bus'>, companyId: string): Promise<void> {
  ctx.bus.publish(companyId, { type: 'working', working: await workingCount(ctx.db, companyId, undefined, true) });
}

function automaticMessage(message: MessageEnvelope, job: { retryOf?: string | null; continueOf?: string | null }): MessageEnvelope {
  const original = job.retryOf ?? job.continueOf;
  if (!original) return message;
  return { direction: 'in', from: HORNHOOF, to: message.to, notification: { source: job.retryOf ? 'machine' : 'go_on', tasks: message.notification?.tasks ?? [], detail: saying(words => words.notices.afterTurn(original)) } };
}
