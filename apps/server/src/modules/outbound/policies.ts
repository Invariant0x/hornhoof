import { OutboundPolicyValue, type GateCode } from '@hornhoof/protocol';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { modelChecks, outboundAttempts, outboundCatalogRevisions, outboundChannels, outboundDailyUsage, outboundMessages, outboundPolicies, supportTickets, type StopReason } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { isOn } from '../model-checks/lifecycle.js';
import type { Tx } from '../tasks/engine.js';
import { digestOf } from './checks.js';

/* What a channel's owner decides, and what follows from it: the day a limit counts, the numbers sampling goes by, whether a
   channel takes anything at all, and how a queued message gives back what it held. */

type Sampling = OutboundPolicyValue['sampling'];
type Attempt = typeof outboundAttempts.$inferSelect;
type Message = typeof outboundMessages.$inferSelect;
export type Channel = typeof outboundChannels.$inferSelect;
export type { StopReason };

const DAY_MS = 86_400_000;

const partsAt = (at: Date, timezone: string): Record<string, string> =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map(p => [p.type, p.value]),
  );

/* The date in a time zone: a limit's day is its policy's, never the server's. */
export function dayOf(at: Date, timezone: string): string {
  const { year, month, day } = partsAt(at, timezone);
  return `${year}-${month}-${day}`;
}

/* How far ahead of UTC a zone is at a moment. */
function offsetAt(at: number, timezone: string): number {
  const p = partsAt(new Date(at), timezone);
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(at / 1000) * 1000;
}

/* The first moment of a local date. Where clocks jump over midnight, that is the moment of the jump. */
function firstMoment(day: string, timezone: string): number {
  const utc = Date.parse(`${day}T00:00:00.000Z`);
  const guess = utc - offsetAt(utc, timezone);
  const settled = utc - offsetAt(guess, timezone);
  return dayOf(new Date(settled), timezone) === day ? settled : guess;
}

const dayAfter = (day: string): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);

/* A local date as moments: 23 or 25 hours long when the clocks change. */
export const dayWindow = (day: string, timezone: string) => ({ from: firstMoment(day, timezone), to: firstMoment(dayAfter(day), timezone) });

type Bucket = Pick<typeof outboundDailyUsage.$inferSelect, 'day' | 'timezone' | 'reserved' | 'accepted' | 'unknown' | 'definitelyFailed'>;
const mayHaveLeft = (b: Bucket): number => b.reserved + b.accepted + b.unknown;

/* All that may have left within a day, in whatever day and zone it was counted: a changed time zone or limit counts what
   overlaps, so that a change of policy is never a second allowance. */
export function usedWithin(buckets: readonly Bucket[], today: { day: string; timezone: string }): number {
  const { from, to } = dayWindow(today.day, today.timezone);
  const overlapping = buckets.filter(b => {
    const theirs = dayWindow(b.day, b.timezone);
    return theirs.from < to && from < theirs.to;
  });
  return overlapping.reduce((sum, b) => sum + mayHaveLeft(b), 0);
}

export type Numbers = { status: Channel['status']; segment: number | null; author: number; channel: number; owed: boolean };

/* Whether this message's numbers call for a review. A new channel reviews everything. A chosen message that was cancelled
   before it passed is still owed, so that cancelling never fishes for a number nobody looks at. */
export function selectedForReview(sampling: Sampling, n: Numbers): boolean {
  if (n.status === 'new' || n.owed) return true;
  if (n.author <= sampling.firstPerAuthor) return true;
  if (n.segment !== null && n.segment <= sampling.firstPerSegment) return true;
  return n.channel % sampling.everyNth === 0;
}

export type CurrentPolicy = { id: string; revision: number; digest: string; value: OutboundPolicyValue };

/* The newest revision of a channel's policy that can be read; none means no allowance. */
export async function currentPolicy(db: Pick<Db, 'select'>, channelId: string): Promise<CurrentPolicy | null> {
  const [row] = await db.select().from(outboundPolicies).where(eq(outboundPolicies.channelId, channelId)).orderBy(desc(outboundPolicies.revision)).limit(1);
  const value = OutboundPolicyValue.safeParse(row?.value);
  return row && value.success ? { id: row.id, revision: row.revision, digest: row.digest, value: value.data } : null;
}

/* Nothing new is admitted after this commits. What already left cannot be called back. The caller holds the channel. */
export async function stopChannel(tx: Tx, channelId: string, reason: StopReason, now: Date): Promise<void> {
  await tx.update(outboundChannels).set({ status: 'stopped', stoppedReason: reason, stoppedAt: now, generation: sql`${outboundChannels.generation} + 1` }).where(and(eq(outboundChannels.id, channelId), inArray(outboundChannels.status, ['new', 'active'])));
}

type CheckPlace = Pick<Channel, 'companyId' | 'departmentId' | 'productId'>;

/* The check a channel's messages go through, whether or not it is certified. */
export async function reviewCheck(db: Pick<Db, 'select'>, place: CheckPlace, kind: 'outbound_review' | 'support_reply_review') {
  const product = place.productId === null ? isNull(modelChecks.productId) : eq(modelChecks.productId, place.productId);
  const [check] = await db.select().from(modelChecks).where(and(eq(modelChecks.companyId, place.companyId), eq(modelChecks.departmentId, place.departmentId), product, eq(modelChecks.kind, kind)));
  return check ?? null;
}

const refused = (status: number, code: 'not_found' | 'conflict', message: string) => new ApiError(status, code, message, code === 'not_found' ? 'outbound_unknown' : 'outbound_conflict');

/* Only a person's decision opens a stopped channel, and only with its check holding. It starts as new, every message
   reviewed again, under the next generation, so that nothing admitted before the stop counts. */
export async function reopenChannel(ctx: Pick<Ctx, 'db'>, at: { companyId: string; channelId: string }, now = new Date()): Promise<Channel> {
  return ctx.db.transaction(async tx => {
    const [channel] = await tx.select().from(outboundChannels).where(and(eq(outboundChannels.id, at.channelId), eq(outboundChannels.companyId, at.companyId))).for('update');
    if (!channel) throw refused(404, 'not_found', 'There is no such channel.');
    if (channel.status !== 'stopped') throw refused(409, 'conflict', 'This channel is not stopped.');
    const check = await reviewCheck(tx, channel, 'outbound_review');
    if (!check || !isOn(check, now)) throw refused(409, 'conflict', 'This channel\'s check is not certified. It reopens once its check passes.');
    const [row] = await tx.update(outboundChannels).set({ status: 'new', stoppedReason: null, stoppedAt: null, generation: channel.generation + 1 }).where(eq(outboundChannels.id, channel.id)).returning();
    return row!;
  });
}

export type NewChannel = Pick<typeof outboundChannels.$inferInsert, 'companyId' | 'departmentId' | 'productId' | 'name' | 'adapter' | 'purpose' | 'audience' | 'createdBy'>;

/* A new channel takes nothing it does not review, and has no allowance until its owner gives it a policy. */
export async function createChannel(db: Pick<Db, 'insert'>, channel: NewChannel): Promise<Channel> {
  const [row] = await db.insert(outboundChannels).values(channel).onConflictDoNothing().returning();
  if (!row) throw refused(409, 'conflict', 'This place already has a channel of this name.');
  return row;
}

export const channelIn = async (db: Pick<Db, 'select'>, companyId: string, channelId: string): Promise<Channel> => {
  const [channel] = await db.select().from(outboundChannels).where(and(eq(outboundChannels.id, channelId), eq(outboundChannels.companyId, companyId)));
  if (!channel) throw refused(404, 'not_found', 'There is no such channel.');
  return channel;
};

/* The next revision of a channel's limits. A message admitted before answers to the revision that counts at its last look. */
export async function addPolicy(ctx: Pick<Ctx, 'db'>, at: { companyId: string; channelId: string; createdBy: string }, value: OutboundPolicyValue) {
  const digest = digestOf(value);
  return ctx.db.transaction(async tx => {
    await tx.select(idOnly(outboundChannels)).from(outboundChannels).where(eq(outboundChannels.id, at.channelId)).for('update');
    const [newest] = await tx.select(only(outboundPolicies, 'revision')).from(outboundPolicies).where(eq(outboundPolicies.channelId, at.channelId)).orderBy(desc(outboundPolicies.revision)).limit(1);
    const [row] = await tx.insert(outboundPolicies).values({ ...at, revision: (newest?.revision ?? 0) + 1, digest, value }).returning();
    return { id: row!.id, revision: row!.revision, digest };
  });
}

/* A person's stop. Nothing new is admitted after it commits, and stopping what is stopped changes nothing. */
export async function stopByPerson(ctx: Pick<Ctx, 'db'>, channelId: string, now = new Date()): Promise<Channel> {
  return ctx.db.transaction(async tx => {
    await tx.select(idOnly(outboundChannels)).from(outboundChannels).where(eq(outboundChannels.id, channelId)).for('update');
    await stopChannel(tx, channelId, 'channel_stopped', now);
    const [row] = await tx.select().from(outboundChannels).where(eq(outboundChannels.id, channelId));
    return row!;
  });
}

const RECORD_TABLES = [outboundChannels, outboundCatalogRevisions, supportTickets];

/* Why a department cannot go: what it sent and said stays on record, and these records name it. A channel answers for the
   accounts and messages it holds. */
export async function outboundRecordsOf(db: Pick<Db, 'select'>, inside: string[], name: string): Promise<string | null> {
  for (const table of RECORD_TABLES) {
    const rows = await db.select(idOnly(table)).from(table).where(or(inArray(table.departmentId, inside), inArray(table.productId, inside))).limit(1);
    if (rows.length) return `${name} has outbound channels, catalog or tickets on record, and cannot be removed.`;
  }
  return null;
}

const bucketsIn = (a: Pick<Attempt, 'accountBucketId' | 'domainBucketId'>) => [a.accountBucketId, a.domainBucketId];

/* The buckets of attempts, one way round, before what they count is changed. */
export async function lockBuckets(tx: Tx, attempts: readonly Pick<Attempt, 'accountBucketId' | 'domainBucketId'>[]): Promise<void> {
  const ids = [...new Set(attempts.flatMap(bucketsIn))].sort();
  if (ids.length) await tx.select(idOnly(outboundDailyUsage)).from(outboundDailyUsage).where(inArray(outboundDailyUsage.id, ids)).orderBy(outboundDailyUsage.id).for('update');
}

/* A reservation given back: nothing was handed to any transport, so its place is free again. */
export async function releaseAttempt(tx: Tx, attempt: Attempt, now: Date): Promise<void> {
  await tx.update(outboundAttempts).set({ status: 'definitely_not_accepted', safeCode: 'not_sent', endedAt: now }).where(and(eq(outboundAttempts.id, attempt.id), eq(outboundAttempts.status, 'reserved')));
  await tx.update(outboundDailyUsage).set({ reserved: sql`${outboundDailyUsage.reserved} - 1` }).where(inArray(outboundDailyUsage.id, bucketsIn(attempt)));
}

/* What has not left yet: it can still be cancelled. */
const QUEUED: readonly Message['status'][] = ['scheduled', 'waiting_checks', 'waiting_approval', 'reserved'];

async function reservationsOf(tx: Tx, messageIds: readonly string[]): Promise<Attempt[]> {
  return messageIds.length ? tx.select().from(outboundAttempts).where(and(inArray(outboundAttempts.messageId, [...messageIds]), eq(outboundAttempts.status, 'reserved'))) : [];
}

/* Cancels the queued messages to a contact, giving back what they had reserved. Its numbers stay with each. The caller
   holds the contact, and buckets come before messages, as in every other path. */
export async function cancelQueuedTo(tx: Tx, contactId: string, code: GateCode, now: Date): Promise<void> {
  const queued = await tx.select(idOnly(outboundMessages)).from(outboundMessages).where(and(eq(outboundMessages.contactId, contactId), inArray(outboundMessages.status, [...QUEUED])));
  const ids = queued.map(m => m.id).sort();
  await lockBuckets(tx, await reservationsOf(tx, ids));
  for (const id of ids) await cancelOne(tx, id, code, now);
}

async function cancelOne(tx: Tx, messageId: string, code: GateCode, now: Date): Promise<void> {
  const [message] = await tx.select().from(outboundMessages).where(and(eq(outboundMessages.id, messageId), inArray(outboundMessages.status, [...QUEUED]))).for('update');
  if (!message) return;
  for (const attempt of await reservationsOf(tx, [messageId])) await releaseAttempt(tx, attempt, now);
  await tx.update(outboundMessages).set({ status: 'cancelled', reasonCodes: [code], updatedAt: now }).where(eq(outboundMessages.id, messageId));
}
