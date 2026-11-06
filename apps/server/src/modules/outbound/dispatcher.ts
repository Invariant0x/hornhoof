import { timingSafeEqual } from 'node:crypto';
import { and, count, eq, gte, lt } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { outboundAccounts, outboundAttempts, outboundChannels, outboundEvents, outboundMessages } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { departmentOwner } from '../departments/approval-policy.js';
import { notificationMessage } from '../events/notifications.js';
import { signalRecipients } from '../model-checks/signal.js';
import type { Tx } from '../tasks/engine.js';
import { recordWaitNotice } from '../tasks/wait-notices.js';
import { currentSettings, markInvalid, settingsToSend, type AccountSettings, type SmtpSettings, type WebhookSettings } from './accounts.js';
import { beginDispatch, dueMessages, reserveDispatch, settleAttempt } from './core.js';
import { currentPolicy, stopChannel, type Channel, type StopReason } from './policies.js';
import type { DispatchAdmission, ReconcileOutcome, SendOutcome, TransportAdapter } from './ports.js';
import { smtpAdapter } from './smtp.js';
import { signature, webhookAdapter } from './webhook.js';

/* The one thing that sends. It runs on the server's own minute, whatever any agent does, with the settings only it reads, outside
   any transaction. An attempt whose end is not known stays that way until something knows: nothing here sends one again. */

export type Senders = { smtp: TransportAdapter<SmtpSettings>; webhook: TransportAdapter<WebhookSettings>; deadlineMs: number };
type Begun = Extract<DispatchAdmission, { kind: 'begun' }>;
type Account = typeof outboundAccounts.$inferSelect;
type Attempt = typeof outboundAttempts.$inferSelect;

/* Under the kernel's lease of five minutes, so an answer still counts as this worker's. */
const SEND_DEADLINE_MS = 240_000;
const LOOKED_AT = 100;
const LIVE: Senders = { smtp: smtpAdapter(), webhook: webhookAdapter(), deadlineMs: SEND_DEADLINE_MS };

/* All of it, and the first thing that went wrong at the end: one failure does not hold the others back. */
async function eachOf<T>(items: readonly T[], work: (item: T) => Promise<unknown>): Promise<void> {
  const failures: unknown[] = [];
  for (const item of items) await work(item).catch((err: unknown) => failures.push(err));
  if (failures.length) throw failures[0];
}

const sendWith = (senders: Senders, settings: AccountSettings, begun: Begun): Promise<SendOutcome> => {
  const attempt = { attemptId: begun.attemptId, sealedPayload: begun.sealedPayload };
  return settings.adapter === 'smtp' ? senders.smtp.send({ ...attempt, configuredAccount: settings.config }) : senders.webhook.send({ ...attempt, configuredAccount: settings.config });
};

/* Whatever goes wrong from here on may have happened after the message left. */
async function outcomeOf(senders: Senders, settings: AccountSettings, begun: Begun): Promise<SendOutcome> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<SendOutcome>(resolve => {
    timer = setTimeout(() => resolve({ kind: 'unknown', safeCode: 'timeout' }), senders.deadlineMs);
  });
  try {
    return await Promise.race([sendWith(senders, settings, begun), deadline]);
  } catch {
    return { kind: 'unknown', safeCode: 'connection_lost' };
  } finally {
    clearTimeout(timer);
  }
}

/* What the last look let through, and only that: settings that changed since end it before anything leaves. */
export async function sendBegun(ctx: Ctx, begun: Begun, senders: Senders = LIVE): Promise<void> {
  const settings = await settingsToSend(ctx, begun.accountId, begun.configGeneration);
  if (!settings) {
    await settleAttempt(ctx, begun.attemptId, { kind: 'definitely_not_accepted', safeCode: 'settings_changed' });
    await markInvalid(ctx, begun.accountId, begun.configGeneration);
    return;
  }
  const outcome = await outcomeOf(senders, settings, begun);
  await settleAttempt(ctx, begun.attemptId, outcome);
  if (outcome.kind === 'definitely_not_accepted' && outcome.safeCode === 'auth_refused') await markInvalid(ctx, begun.accountId, begun.configGeneration);
}

async function dispatchOne(ctx: Ctx, due: { messageId: string; revision: number }, now: Date, senders: Senders): Promise<void> {
  const reserved = await reserveDispatch(ctx, due.messageId, due.revision, now);
  if (reserved.kind !== 'reserved') return;
  const begun = await beginDispatch(ctx, due.messageId, due.revision, now);
  if (begun.kind === 'begun') await sendBegun(ctx, begun, senders);
}

export async function dispatchDue(ctx: Ctx, now = new Date(), senders: Senders = LIVE): Promise<void> {
  await eachOf(await dueMessages(ctx, now), due => dispatchOne(ctx, due, now, senders));
}

const askWith = (senders: Senders, settings: AccountSettings, attemptId: string): Promise<ReconcileOutcome> =>
  settings.adapter === 'smtp' ? senders.smtp.reconcile({ attemptId, configuredAccount: settings.config }) : senders.webhook.reconcile({ attemptId, configuredAccount: settings.config });

async function askAbout(ctx: Ctx, attempt: Pick<Attempt, 'id' | 'accountId'>, senders: Senders): Promise<void> {
  const settings = await currentSettings(ctx, attempt.accountId);
  if (!settings) return;
  const outcome = await askWith(senders, settings, attempt.id).catch((): ReconcileOutcome => ({ kind: 'pending' }));
  if (outcome.kind !== 'pending') await settleAttempt(ctx, attempt.id, outcome);
}

/* A worker gone past its lease may still be sending, so it becomes unknown and nothing else. Then each unknown one is asked about,
   by the one way of knowing its transport has. Neither touches who writes from the account. */
export async function reconcileOutbound(ctx: Ctx, now = new Date(), senders: Senders = LIVE): Promise<void> {
  const expired = await ctx.db.select({ id: outboundAttempts.id }).from(outboundAttempts).where(and(eq(outboundAttempts.status, 'sending'), lt(outboundAttempts.leaseUntil, now))).limit(LOOKED_AT);
  await eachOf(expired, attempt => settleAttempt(ctx, attempt.id, { kind: 'unknown', safeCode: 'timeout' }, now));
  const open = await ctx.db.select({ id: outboundAttempts.id, accountId: outboundAttempts.accountId }).from(outboundAttempts).where(eq(outboundAttempts.status, 'unknown')).limit(LOOKED_AT);
  await eachOf(open, attempt => askAbout(ctx, attempt, senders));
}

const STOP_FOR: readonly (readonly ['complaint' | 'refusal' | 'bounce', 'maxComplaints' | 'maxRefusals' | 'maxBounces', StopReason])[] = [
  ['complaint', 'maxComplaints', 'complaint_threshold'],
  ['refusal', 'maxRefusals', 'refusal_threshold'],
  ['bounce', 'maxBounces', 'bounce_threshold'],
];

/* Stops the channel when what came back within the policy's window is past its limits, once enough messages left to speak of. */
async function lookAtLimits(tx: Tx, channelId: string, now: Date): Promise<void> {
  const policy = await currentPolicy(tx, channelId);
  if (!policy) return;
  const { circuit } = policy.value;
  const since = new Date(now.getTime() - circuit.windowHours * 3_600_000);
  const onChannel = eq(outboundMessages.channelId, channelId);
  const [sample] = await tx.select({ n: count() }).from(outboundAttempts).innerJoin(outboundMessages, eq(outboundMessages.id, outboundAttempts.messageId)).where(and(onChannel, eq(outboundAttempts.status, 'accepted'), gte(outboundAttempts.endedAt, since)));
  if ((sample?.n ?? 0) < circuit.minimumSample) return;
  const rows = await tx.select({ kind: outboundEvents.kind, n: count() }).from(outboundEvents).innerJoin(outboundAttempts, eq(outboundAttempts.id, outboundEvents.attemptId)).innerJoin(outboundMessages, eq(outboundMessages.id, outboundAttempts.messageId)).where(and(onChannel, gte(outboundEvents.occurredAt, since))).groupBy(outboundEvents.kind);
  const seen = new Map(rows.map(row => [row.kind, row.n]));
  const over = STOP_FOR.find(([kind, limit]) => (seen.get(kind) ?? 0) > circuit[limit]);
  if (over) await stopChannel(tx, channelId, over[2], now);
}

const ReceiptEvent = z.strictObject({ attemptId: z.uuid(), kind: z.enum(['delivered', 'bounce', 'refusal', 'complaint']), providerEventId: z.string().min(1).max(200), occurredAt: z.iso.datetime() });
type ReceiptEvent = z.infer<typeof ReceiptEvent>;
const ReceiptBody = z.strictObject({ events: z.array(ReceiptEvent).max(100) });

async function recordOne(ctx: Ctx, account: Account, event: ReceiptEvent, now: Date): Promise<'recorded' | 'repeated' | 'ignored'> {
  const [attempt] = await ctx.db.select({ id: outboundAttempts.id }).from(outboundAttempts).where(and(eq(outboundAttempts.id, event.attemptId), eq(outboundAttempts.accountId, account.id)));
  if (!attempt) return 'ignored';
  return ctx.db.transaction(async tx => {
    await tx.select({ id: outboundChannels.id }).from(outboundChannels).where(eq(outboundChannels.id, account.channelId)).for('update');
    const values = { companyId: account.companyId, attemptId: attempt.id, kind: event.kind, source: `account:${account.id}`, providerEventId: event.providerEventId, occurredAt: new Date(event.occurredAt) };
    const inserted = await tx.insert(outboundEvents).values(values).onConflictDoNothing().returning({ id: outboundEvents.id });
    if (!inserted.length) return 'repeated';
    await lookAtLimits(tx, account.channelId, now);
    return 'recorded';
  });
}

/* What a provider says became of messages that left. An event counts once by its own id, and only about this account's attempts. */
export async function recordReceipts(ctx: Ctx, account: Account, events: readonly ReceiptEvent[], now = new Date()) {
  const said = { recorded: 0, repeated: 0, ignored: 0 };
  for (const event of events) said[await recordOne(ctx, account, event, now)] += 1;
  return said;
}

const STAMP_MS = 300_000;
const notSigned = () => new ApiError(401, 'unauthorized', 'This is not signed with a key this account has.', 'outbound_not_allowed');
const headerOf = (req: FastifyRequest, name: string): string => {
  const value = req.headers[name];
  return typeof value === 'string' ? value : '';
};

const sameText = (a: string, b: string): boolean => {
  const [left, right] = [Buffer.from(a), Buffer.from(b)];
  return left.length === right.length && timingSafeEqual(left, right);
};

function isSigned(req: FastifyRequest, key: string, body: string, now = Date.now()): boolean {
  const stamp = headerOf(req, 'x-hornhoof-timestamp');
  return Math.abs(now - Number(stamp) * 1000) <= STAMP_MS && sameText(headerOf(req, 'x-hornhoof-signature'), signature(key, stamp, body));
}

const receiptKey = (settings: AccountSettings | null): string | undefined => (settings?.adapter === 'webhook' ? settings.config.signingKey : settings?.config.eventKey);

/* The account a signed body is about. Every way of not being signed answers the same, so nothing is learned of an account by asking. */
async function openEventReceipts(ctx: Ctx, req: FastifyRequest, body: unknown): Promise<Account> {
  const id = z.object({ id: z.uuid() }).safeParse(req.params);
  const [account] = id.success ? await ctx.db.select().from(outboundAccounts).where(eq(outboundAccounts.id, id.data.id)) : [];
  const key = account ? receiptKey(await currentSettings(ctx, account.id)) : undefined;
  if (!account || !key || typeof body !== 'string' || !isSigned(req, key, body)) throw notSigned();
  return account;
}

const receiptsIn = (body: string): ReceiptEvent[] => {
  try {
    return ReceiptBody.parse(JSON.parse(body)).events;
  } catch {
    throw new ApiError(400, 'validation', 'This is not a list of events.', 'outbound_invalid');
  }
};

/* The body is signed as it came, so this route reads it before anything turns it into something else. */
export function receiptRoutes(app: FastifyInstance, ctx: Ctx): void {
  void app.register(async scope => {
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 256 * 1024 }, (_req, body, done) => done(null, body));
    scope.post('/api/outbound/accounts/:id/events', async req => {
      const account = await openEventReceipts(ctx, req, req.body);
      return recordReceipts(ctx, account, receiptsIn(String(req.body)));
    });
  });
}

const stopText = (channel: Channel, ownerName: string): string =>
  `Outbound channel ${channel.name} stopped (${channel.stoppedReason}). Nothing new leaves through it until a person reopens it. Tell the owner of its department, ${ownerName}.`;

/* Each stop is told once, by its generation, however many rounds pass and whatever stopped it. */
async function noticeOne(ctx: Ctx, channel: Channel): Promise<void> {
  const owner = await departmentOwner(ctx, channel.companyId, channel.departmentId);
  const message = await notificationMessage(ctx, channel.companyId, 'service', stopText(channel, owner?.name ?? 'the CEO'));
  for (const agent of await signalRecipients(ctx, channel)) {
    await recordWaitNotice(ctx.db, { companyId: channel.companyId, agentId: agent.id, dedupKey: `outbound-stop:${channel.id}:${channel.generation}:${agent.id}`, guard: { tasks: [] }, message });
  }
}

export async function noticeStops(ctx: Ctx): Promise<void> {
  await eachOf(await ctx.db.select().from(outboundChannels).where(eq(outboundChannels.status, 'stopped')), channel => noticeOne(ctx, channel));
}

const rounds = new WeakSet<object>();

/* One at a time, however long a transport takes: the server's minute goes on meanwhile. */
export async function outboundRound(ctx: Ctx, now: Date, senders: Senders = LIVE): Promise<void> {
  if (rounds.has(ctx)) return;
  rounds.add(ctx);
  try {
    await eachOf<() => Promise<void>>([() => noticeStops(ctx), () => reconcileOutbound(ctx, now, senders), () => dispatchDue(ctx, now, senders)], step => step());
  } finally {
    rounds.delete(ctx);
  }
}
