import { and, asc, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, jobs } from '../../db/schema.js';
import { incomingEnvelope, messageData, readMessage, type MessageEnvelope, type MessageParty } from '../events/parties.js';
import { publishEvent, type WithEvent } from '../events/store.js';
import type { Tx } from '../tasks/state.js';
import type { TurnMessage } from './queue.js';
import { quote } from './prompt.js';
import type { deliverLockedInput } from './decision-context.js';

/* Persisted queued turns form the window, including across a server restart. */
export const REPORT_WINDOW_MS = 10_000;
type Delivery = { send: typeof deliverLockedInput };
type ReportTurn = { companyId: string; agentId: string; message?: TurnMessage; withMessage?: WithEvent };
type Stored = { event: typeof agentEvents.$inferSelect; job: typeof jobs.$inferSelect };
type Group = { data: Record<string, unknown>; message: MessageEnvelope; text: string; prompt: string };

export function reportDelay(message?: TurnMessage): Date | null {
  return message?.report?.trim() ? new Date(Date.now() + REPORT_WINDOW_MS) : null;
}

const uniqueParties = (parties: MessageParty[]) => [...new Map(parties.map(p => [`${p.kind}:${p.id}`, p])).values()];
const uniqueTasks = (tasks: NonNullable<MessageEnvelope['notification']>['tasks']) => [...new Map(tasks.map(t => [t.id, t])).values()];

function contexts(data: Record<string, unknown>): string[] {
  if (Array.isArray(data.reportContexts)) return data.reportContexts.filter((v): v is string => typeof v === 'string');
  return typeof data.reportContext === 'string' ? [data.reportContext] : [];
}

function groupSenders(before: MessageEnvelope, incoming: MessageEnvelope): MessageParty[] {
  return uniqueParties([...(before.senders ?? [before.from]), ...(incoming.senders ?? [incoming.from])]);
}

function groupTasks(before: MessageEnvelope, incoming: MessageEnvelope, input: TurnMessage) {
  return uniqueTasks([...(before.notification?.tasks ?? []), ...(incoming.notification?.tasks ?? []), ...(input.task ? [input.task] : [])]);
}

function jobFields(text: string, input: TurnMessage, into?: string) {
  if (into) return { status: 'done' as const, finishedAt: new Date() };
  return { prompt: text, ...(!input.report ? { notBefore: null } : {}) };
}

function reportText(input?: TurnMessage): string | null {
  if (!input || (!input.report && input.from !== 'agent')) return null;
  return (input.report ?? input.text).trim() || null;
}

function queuedWords(row: Stored, data: Record<string, unknown>, reportContexts: string[], text: string) {
  const preserve = data.reportPromptPreserved === true || typeof data.report !== 'string';
  if (!preserve) return { prompt: text, reportPromptPreserved: false };
  const previous = contexts(data);
  const added = reportContexts.filter(context => !previous.includes(context));
  return { prompt: [row.job.prompt, ...added].join('\n\n'), reportPromptPreserved: true };
}

function mergeGroup(row: Stored, input: TurnMessage, incoming: MessageEnvelope, report: string): Group | null {
  const before = readMessage(row.event.data);
  const envelope = before.message;
  const origin = envelope?.notification ?? incoming.notification;
  if (!envelope || !origin) return null;
  const senders = groupSenders(envelope, incoming);
  const tasks = groupTasks(envelope, incoming, input);
  const notification = { ...origin, tasks };
  const reportContexts = [...new Set([...contexts(before.data as Record<string, unknown>), ...contexts(input)])];
  const text = [...reportContexts, quote(report)].join('\n\n');
  const message = { ...envelope, notification, senders, revision: (envelope.revision ?? 0) + 1, originSeq: envelope.originSeq ?? row.event.seq };
  const words = queuedWords(row, before.data as Record<string, unknown>, reportContexts, text);
  return { text, prompt: words.prompt, message, data: { ...before.data as object, text, notification, report, reportContexts, reportPromptPreserved: words.reportPromptPreserved, actor: message.from, senders } };
}

function matchingReport(input: TurnMessage, report: string) {
  const direct = input.report ? sql`${agentEvents.data}->>'from' = 'agent' and ${agentEvents.data}->>'text' = ${report}` : sql`false`;
  return or(sql`${agentEvents.data}->>'report' = ${report}`, direct);
}

function taskNumbers(text: string, message?: MessageEnvelope): number[] {
  const numbers = [...text.matchAll(/#([1-9]\d*)\b/g)].map(match => Number(match[1]));
  return [...new Set([...numbers, ...(message?.notification?.tasks.map(task => task.number) ?? [])])];
}

function deliveredTasks(row: Stored): number[] {
  const data = readMessage(row.event.data);
  const saved = (data.data as Record<string, unknown>).deliveredTasks;
  if (Array.isArray(saved)) return saved.filter((n): n is number => typeof n === 'number' && Number.isInteger(n));
  return taskNumbers(String((data.data as Record<string, unknown>).text ?? ''), data.message);
}

function coversTasks(row: Stored, input: TurnMessage, incoming: MessageEnvelope): boolean {
  const known = new Set(deliveredTasks(row));
  const refs = [...(incoming.notification?.tasks ?? []), ...(input.task ? [input.task] : [])];
  return refs.every(task => known.has(task.number));
}

async function freezeInput(tx: Tx, row: Stored): Promise<void> {
  if ((row.event.data as Record<string, unknown>).inputShadow === true) return;
  await tx.insert(agentEvents).values({ companyId: row.event.companyId, agentId: row.event.agentId, jobId: row.event.jobId,
    kind: 'typed', seq: row.event.seq, personId: row.event.personId, createdAt: row.event.createdAt,
    data: { ...row.event.data as object, inputShadow: false } });
}

async function updateDelivered(ctx: Ctx, row: Stored, input: TurnMessage, incoming: MessageEnvelope, report: string): Promise<boolean> {
  const changed = await ctx.db.transaction(async tx => {
    const [current] = await tx.select({ event: agentEvents, job: jobs }).from(agentEvents).innerJoin(jobs, eq(jobs.id, agentEvents.jobId))
      .where(and(eq(agentEvents.id, row.event.id), inArray(jobs.status, ['running', 'done']))).for('no key update');
    if (!current || !coversTasks(current, input, incoming)) return false;
    const group = mergeGroup(current, input, incoming, report);
    if (!group) return false;
    const data = { ...group.data, inputShadow: true, deliveredTasks: deliveredTasks(current) };
    await tx.update(agentEvents).set({ seq: sql`nextval(pg_get_serial_sequence('agent_events', 'seq'))`, data: messageData(data, group.message) }).where(eq(agentEvents.id, current.event.id));
    await freezeInput(tx, current);
    return true;
  });
  if (changed) await publishEvent(ctx, row.event.companyId, row.event.agentId, row.event.id);
  return changed;
}

async function deliveredCandidate(ctx: Ctx, turn: ReportTurn, input: TurnMessage, incoming: MessageEnvelope, report: string): Promise<string | null> {
  const rows = await ctx.db.select({ event: agentEvents, job: jobs }).from(agentEvents).innerJoin(jobs, eq(jobs.id, agentEvents.jobId))
    .where(and(eq(agentEvents.agentId, turn.agentId), eq(agentEvents.kind, 'message'), inArray(jobs.status, ['running', 'done']),
      gte(sql`greatest(${agentEvents.createdAt}, ${jobs.startedAt})`, new Date(Date.now() - REPORT_WINDOW_MS)), matchingReport(input, report))).orderBy(desc(agentEvents.seq));
  for (const row of rows) {
    if (coversTasks(row, input, incoming) && await updateDelivered(ctx, row, input, incoming, report)) return row.job.id;
  }
  return null;
}

async function candidate(ctx: Ctx, turn: ReportTurn, report: string): Promise<Stored | undefined> {
  const rows = await ctx.db.select({ event: agentEvents, job: jobs }).from(agentEvents).innerJoin(jobs, eq(jobs.id, agentEvents.jobId))
    .where(and(eq(agentEvents.agentId, turn.agentId), eq(agentEvents.kind, 'message'), eq(jobs.status, 'queued'),
      gte(agentEvents.createdAt, new Date(Date.now() - REPORT_WINDOW_MS)), matchingReport(turn.message!, report))).orderBy(asc(agentEvents.seq)).limit(1);
  return rows[0];
}

async function storeGroupInput(tx: Tx, turn: ReportTurn, row: Stored, group: Group, into?: string) {
  /* A fresh stream sequence also makes live input newer than any earlier personal instruction. */
  const [record] = await tx.update(agentEvents).set({ seq: sql`nextval(pg_get_serial_sequence('agent_events', 'seq'))`, data: messageData({ ...group.data, ...(into ? { inputShadow: true } : {}) }, group.message), ...(into ? { jobId: into } : {}) }).where(eq(agentEvents.id, row.event.id)).returning({ seq: agentEvents.seq, createdAt: agentEvents.createdAt });
  const receipt = into ? (await tx.insert(agentEvents).values({ companyId: turn.companyId, agentId: turn.agentId, jobId: into, kind: 'typed', personId: null, data: messageData({ ...group.data, inputShadow: false, text: group.prompt }, group.message) }).returning({ seq: agentEvents.seq, createdAt: agentEvents.createdAt }))[0]! : record!;
  return receipt;
}

async function keepReceipts(tx: Tx, receipt: Parameters<WithEvent>[1], ...callbacks: (WithEvent | undefined)[]): Promise<void> {
  for (const keep of callbacks) await keep?.(tx, receipt);
}

async function saveGroup(ctx: Ctx, turn: ReportTurn, row: Stored, input: TurnMessage, incoming: MessageEnvelope, report: string, into?: string, kept?: WithEvent): Promise<boolean> {
  const stored = await ctx.db.transaction(async tx => {
    const [current] = await tx.select({ event: agentEvents, job: jobs }).from(agentEvents).innerJoin(jobs, eq(jobs.id, agentEvents.jobId))
      .where(and(eq(agentEvents.id, row.event.id), eq(jobs.status, 'queued'))).for('no key update');
    if (!current) return false;
    const group = mergeGroup(current, input, incoming, report);
    if (!group) return false;
    const set = jobFields(group.prompt, input, into);
    await tx.update(jobs).set(set).where(eq(jobs.id, current.job.id));
    const receipt = await storeGroupInput(tx, turn, current, group, into);
    await keepReceipts(tx, receipt, kept, turn.withMessage);
    return true;
  });
  if (stored) await publishEvent(ctx, turn.companyId, turn.agentId, row.event.id);
  return stored;
}

async function deliverCopy(ctx: Ctx, turn: ReportTurn, row: Stored, input: TurnMessage, incoming: MessageEnvelope, report: string, delivery: Delivery): Promise<string | null> {
  const group = mergeGroup(row, input, incoming, report);
  if (!group) return null;
  return delivery.send(ctx, turn.agentId, group.prompt, { source: { data: group.data } }, async (id, kept) => {
    if (!await saveGroup(ctx, turn, row, input, incoming, report, id, kept)) throw new Error('The report left its queue while its copy was delivered.');
  });
}

/* Exact report text only; similar but different reports must never disappear. */
export async function combineReport(ctx: Ctx, turn: ReportTurn, delivery?: Delivery): Promise<string | null> {
  const input = turn.message;
  const report = reportText(input);
  if (!input || !report) return null;
  const incoming = await incomingEnvelope(ctx, turn.companyId, turn.agentId, input.personId, input);
  const row = await candidate(ctx, turn, report);
  if (!row) return deliveredCandidate(ctx, turn, input, incoming, report);
  if (delivery) {
    const into = await deliverCopy(ctx, turn, row, input, incoming, report, delivery);
    if (into) return into;
  }
  return await saveGroup(ctx, turn, row, input, incoming, report) ? row.job.id : null;
}
