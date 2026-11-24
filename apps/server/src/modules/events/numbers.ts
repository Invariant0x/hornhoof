import { and, asc, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { agentEvents, jobs, people, tasks, type AgentEventKind } from '../../db/schema.js';
import { agentParty, incomingEnvelope, PartySchema, readMessage, type MessageEnvelope, type MessageParty } from './parties.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type SqlExecutor = Db | Tx;

const TaskRefSchema = z.object({ id: z.string(), number: z.number().int().positive() });
export type EventTaskRef = z.infer<typeof TaskRefSchema>;

export const ReplyQuoteSchema = z.object({
  number: z.number().int().positive(),
  seq: z.number().int().positive(),
  sender: PartySchema,
  excerpt: z.string(),
  task: TaskRefSchema.optional(),
  requestId: z.string().optional(),
});
export type ReplyQuote = z.infer<typeof ReplyQuoteSchema>;

const EXCERPT_MAX = 200;

const prop = (data: unknown, key: string): unknown =>
  data && typeof data === 'object' && key in data ? (data as Record<string, unknown>)[key] : undefined;

const textField = (data: unknown): string => {
  const raw = prop(data, 'text');
  return typeof raw === 'string' ? raw : '';
};

const pictureNames = (data: unknown): string[] => {
  const pics = prop(data, 'pictures');
  if (!Array.isArray(pics)) return [];
  return pics.flatMap(p => (p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string' ? [(p as { name: string }).name] : []));
};

/* Every message or agent answer shown in the conversation gets a sequential number; internal turn plumbing and tool steps do not. */
export function isNumberedChatEvent(kind: AgentEventKind, data: unknown): boolean {
  if (kind === 'message') return !prop(data, 'operatorEvidenceId') && prop(data, 'turnFact') !== true && prop(data, 'inputShadow') !== true;
  if (kind === 'text') return textField(data).trim().length > 0 || pictureNames(data).length > 0;
  return false;
}

export const numberedChatRow = or(
  and(
    eq(agentEvents.kind, 'message'),
    sql`${agentEvents.data}->>'operatorEvidenceId' is null`,
    sql`coalesce(${agentEvents.data}->>'turnFact', 'false') <> 'true'`,
    sql`coalesce(${agentEvents.data}->>'inputShadow', 'false') <> 'true'`,
  ),
  and(
    eq(agentEvents.kind, 'text'),
    sql`(length(btrim(coalesce(${agentEvents.data}->>'text', ''))) > 0 or jsonb_array_length(case when jsonb_typeof(${agentEvents.data}->'pictures') = 'array' then ${agentEvents.data}->'pictures' else '[]'::jsonb end) > 0)`,
  ),
)!;

export function readChatNumber(data: unknown): number | undefined {
  const raw = prop(data, '_number');
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

export function readReplyQuote(data: unknown): ReplyQuote | undefined {
  const parsed = ReplyQuoteSchema.safeParse(prop(data, 'replyTo'));
  return parsed.success ? parsed.data : undefined;
}

/* Internal bookkeeping keys live in agent_events.data; EventView exposes their clean fields at the top level instead. */
export function stripChatInternal(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const copy = { ...(data as Record<string, unknown>) };
  delete copy._number;
  delete copy._telegramSent;
  delete copy._telegramBridge;
  delete copy.replyTo;
  return copy;
}

export async function lockAgentChatNumbers(tx: SqlExecutor, agentId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent_chat_number:${agentId}`}))`);
}

async function maxAssignedNumber(tx: SqlExecutor, agentId: string): Promise<number> {
  const res = await tx.execute<{ n: number }>(
    sql`select coalesce(max((${agentEvents.data}->>'_number')::int), 0)::int as n from ${agentEvents} where ${agentEvents.agentId} = ${agentId} and ${agentEvents.data} ? '_number'`,
  );
  return Number(res.rows[0]?.n ?? 0);
}

/* Assigns stable sequential numbers to any older unnumbered chat rows of this agent, in seq order, inside a locked transaction. */
export async function backfillAgentNumbersInTx(tx: SqlExecutor, agentId: string): Promise<number> {
  let next = await maxAssignedNumber(tx, agentId);
  const missing = await tx
    .select({ id: agentEvents.id })
    .from(agentEvents)
    .where(and(eq(agentEvents.agentId, agentId), numberedChatRow, sql`not (${agentEvents.data} ? '_number')`))
    .orderBy(asc(agentEvents.seq));
  for (const row of missing) {
    next += 1;
    await tx.execute(sql`update ${agentEvents} set data = jsonb_set(${agentEvents.data}, '{_number}', to_jsonb(${next}::int)) where ${agentEvents.id} = ${row.id}`);
  }
  return next;
}

/* Assign-on-read for pre-existing messages: a fast check does nothing once all chat rows of the agent hold their numbers. */
export async function ensureChatNumbers(db: Db, agentId: string): Promise<void> {
  const [unnumbered] = await db
    .select({ id: agentEvents.id })
    .from(agentEvents)
    .where(and(eq(agentEvents.agentId, agentId), numberedChatRow, sql`not (${agentEvents.data} ? '_number')`))
    .limit(1);
  if (!unnumbered) return;
  await db.transaction(async tx => {
    await lockAgentChatNumbers(tx, agentId);
    await backfillAgentNumbersInTx(tx, agentId);
  });
}

export async function assignEventDataNumber(tx: SqlExecutor, agentId: string, kind: AgentEventKind, data: unknown): Promise<unknown> {
  if (!isNumberedChatEvent(kind, data) || readChatNumber(data) !== undefined) return data;
  await lockAgentChatNumbers(tx, agentId);
  const next = (await backfillAgentNumbersInTx(tx, agentId)) + 1;
  return { ...(data as Record<string, unknown>), _number: next };
}

function cutSafe(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return `${text.slice(0, end).trimEnd()}…`;
}

export function excerptOfEvent(data: unknown): string {
  const flat = textField(data).replace(/\s+/g, ' ').trim();
  if (flat) return cutSafe(flat, EXCERPT_MAX);
  return cutSafe(pictureNames(data).join(', '), EXCERPT_MAX);
}

export function taskRefOfEvent(data: unknown, message?: MessageEnvelope, jobTask?: EventTaskRef | null): EventTaskRef | undefined {
  const direct = TaskRefSchema.safeParse(prop(data, 'task'));
  if (direct.success) return direct.data;
  const noticed = message?.notification?.tasks;
  if (noticed?.length === 1 && noticed[0]?.id) return { id: noticed[0].id, number: noticed[0].number };
  return jobTask ?? undefined;
}

async function senderOfStoredRow(
  ctx: Pick<Ctx, 'db' | 'templates'>,
  companyId: string,
  agentId: string,
  row: { kind: AgentEventKind; data: unknown; personId: string | null },
): Promise<MessageParty> {
  if (row.kind === 'text') return agentParty(ctx, companyId, agentId);
  const saved = readMessage(row.data).message;
  const envelope = saved ?? (await incomingEnvelope(ctx, companyId, agentId, row.personId, row.data));
  return envelope.from;
}

export async function findReplyQuote(
  ctx: Pick<Ctx, 'db' | 'templates'>,
  companyId: string,
  agentId: string,
  number: number,
): Promise<ReplyQuote | null> {
  await ensureChatNumbers(ctx.db, agentId);
  const [row] = await ctx.db
    .select({
      seq: agentEvents.seq,
      kind: agentEvents.kind,
      data: agentEvents.data,
      personId: agentEvents.personId,
      personName: people.name,
      jobTaskId: tasks.id,
      jobTaskNumber: tasks.number,
    })
    .from(agentEvents)
    .leftJoin(people, eq(people.id, agentEvents.personId))
    .leftJoin(jobs, eq(jobs.id, agentEvents.jobId))
    .leftJoin(tasks, eq(tasks.id, jobs.taskId))
    .where(and(eq(agentEvents.companyId, companyId), eq(agentEvents.agentId, agentId), sql`(${agentEvents.data}->>'_number')::int = ${number}`))
    .limit(1);
  if (!row) return null;
  const sender = await senderOfStoredRow(ctx, companyId, agentId, row);
  const jobTask = row.jobTaskId && row.jobTaskNumber !== null ? { id: row.jobTaskId, number: row.jobTaskNumber } : null;
  const task = taskRefOfEvent(row.data, readMessage(row.data).message, jobTask);
  const rawReq = prop(row.data, 'requestId');
  const requestId = typeof rawReq === 'string' && rawReq.length > 0 ? rawReq : undefined;
  return {
    number,
    seq: row.seq,
    sender,
    excerpt: excerptOfEvent(row.data),
    ...(task ? { task } : {}),
    ...(requestId ? { requestId } : {}),
  };
}
