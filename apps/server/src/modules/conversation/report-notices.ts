import { and, asc, eq, gte, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentEvents, jobs } from '../../db/schema.js';
import { incomingEnvelope, messageData, readMessage, type MessageEnvelope, type MessageParty } from '../events/parties.js';
import { publishEvent, type WithEvent } from '../events/store.js';
import type { TurnMessage } from './queue.js';
import { quote } from './prompt.js';
import type { deliverLockedInput } from './decision-context.js';

/* Persisted queued turns form the window, including across a server restart. */
export const REPORT_WINDOW_MS = 10_000;
type Delivery = { send: typeof deliverLockedInput; required?: boolean };
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

async function candidate(ctx: Ctx, turn: ReportTurn, report: string): Promise<Stored | undefined> {
  const direct = turn.message?.report ? sql`${agentEvents.data}->>'from' = 'agent' and ${agentEvents.data}->>'text' = ${report}` : sql`false`;
  const rows = await ctx.db.select({ event: agentEvents, job: jobs }).from(agentEvents).innerJoin(jobs, eq(jobs.id, agentEvents.jobId))
    .where(and(eq(agentEvents.agentId, turn.agentId), eq(agentEvents.kind, 'message'), eq(jobs.status, 'queued'),
      gte(agentEvents.createdAt, new Date(Date.now() - REPORT_WINDOW_MS)), or(sql`${agentEvents.data}->>'report' = ${report}`, direct))).orderBy(asc(agentEvents.seq)).limit(1);
  return rows[0];
}

async function saveGroup(ctx: Ctx, turn: ReportTurn, row: Stored, input: TurnMessage, incoming: MessageEnvelope, report: string, into?: string, kept?: WithEvent): Promise<boolean> {
  const stored = await ctx.db.transaction(async tx => {
    const [current] = await tx.select({ event: agentEvents, job: jobs }).from(agentEvents).innerJoin(jobs, eq(jobs.id, agentEvents.jobId))
      .where(and(eq(agentEvents.id, row.event.id), eq(jobs.status, 'queued'))).for('update');
    if (!current) return false;
    const group = mergeGroup(current, input, incoming, report);
    if (!group) return false;
    const set = jobFields(group.prompt, input, into);
    await tx.update(jobs).set(set).where(eq(jobs.id, current.job.id));
    /* A fresh stream sequence also makes live input newer than any earlier personal instruction. */
    const [record] = await tx.update(agentEvents).set({ seq: sql`nextval(pg_get_serial_sequence('agent_events', 'seq'))`, data: messageData({ ...group.data, ...(into ? { inputShadow: true } : {}) }, group.message), ...(into ? { jobId: into } : {}) }).where(eq(agentEvents.id, row.event.id)).returning({ seq: agentEvents.seq, createdAt: agentEvents.createdAt });
    const receipt = into ? (await tx.insert(agentEvents).values({ companyId: turn.companyId, agentId: turn.agentId, jobId: into, kind: 'typed', personId: null, data: messageData({ ...group.data, inputShadow: false, text: group.prompt }, group.message) }).returning({ seq: agentEvents.seq, createdAt: agentEvents.createdAt }))[0]! : record!;
    await kept?.(tx, receipt);
    await turn.withMessage?.(tx, receipt);
    return true;
  });
  if (stored) await publishEvent(ctx, turn.companyId, turn.agentId, row.event.id);
  return stored;
}

async function deliverCopy(ctx: Ctx, turn: ReportTurn, row: Stored, input: TurnMessage, incoming: MessageEnvelope, report: string, delivery: Delivery): Promise<string | null> {
  const group = mergeGroup(row, input, incoming, report);
  if (!group) return null;
  return delivery.send(ctx, turn.agentId, group.prompt, { source: { data: group.data }, required: delivery.required }, async (id, kept) => {
    if (!await saveGroup(ctx, turn, row, input, incoming, report, id, kept)) throw new Error('The report left its queue while its copy was delivered.');
  });
}

/* Exact report text only; similar but different reports must never disappear. */
export async function combineReport(ctx: Ctx, turn: ReportTurn, delivery?: Delivery): Promise<string | null> {
  const input = turn.message;
  const report = reportText(input);
  if (!input || !report) return null;
  const row = await candidate(ctx, turn, report);
  if (!row) return null;
  const incoming = await incomingEnvelope(ctx, turn.companyId, turn.agentId, input.personId, input);
  if (delivery) {
    const into = await deliverCopy(ctx, turn, row, input, incoming, report, delivery);
    if (into) return into;
  }
  return await saveGroup(ctx, turn, row, input, incoming, report) ? row.job.id : null;
}
