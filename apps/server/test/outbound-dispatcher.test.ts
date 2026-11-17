import { createHmac, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { encryptSecret } from '../src/crypto/secrets.js';
import { agents, modelChecks, outboundAccounts, outboundAttempts, outboundBindings, outboundCatalogRevisions, outboundChannels, outboundDailyUsage, outboundEvents, outboundMessageRevisions, outboundMessages, waitNotices } from '../src/db/schema.js';
import { idOnly } from '../src/db/selections.js';
import { minuteRound, startTimers } from '../src/modules/agents/timers.js';
import type { SmtpSettings } from '../src/modules/outbound/accounts.js';
import { beginDispatch, dueMessages, reserveDispatch, submitOutbound } from '../src/modules/outbound/core.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { dispatchDue, noticeStops, outboundRound, reconcileOutbound, recordReceipts, sendBegun, type Senders } from '../src/modules/outbound/dispatcher.js';
import type { ReconcileOutcome, SendOutcome } from '../src/modules/outbound/ports.js';
import { stopByPerson } from '../src/modules/outbound/policies.js';
import { PASSWORD } from './outbound-receivers.js';
import { QUIET, aCertifiedCheck, allowed, anAccountOf, dispatched, world, type World } from './outbound-world.js';
import { sha } from './outbound-fixture.js';
import { until } from './helpers.js';

/* The dispatcher against a transport that records what it was handed and says what a test tells it to. The real wire is in the
   adapters' tests and outbound-live.integration.test.ts. */
const SMTP: SmtpSettings = { host: 'smtp.acme.example', port: 465, security: 'tls', username: 'sender@acme.example', password: PASSWORD, from: 'sender@acme.example', eventKey: `${PASSWORD}-events-0123456789abcdef` };
const EVENT_KEY = SMTP.eventKey!;
const ACCEPTED: SendOutcome = { kind: 'accepted', providerReceipt: '250 ok', acceptedAt: new Date().toISOString() };
const later = () => new Date(Date.now() + 6 * 60_000);

type Sent = { attemptId: string; recipient: string; subject: string; text: string; settings: SmtpSettings };

/* The wait for a transport's answer runs out during a test only when the test moves a clock: by default it is the longest wait
   a timer takes. */
function senders(say: () => Promise<SendOutcome> = async () => ACCEPTED, ask: () => Promise<ReconcileOutcome> = async () => ({ kind: 'pending' }), deadlineMs = 2_147_483_647) {
  const sent: Sent[] = [];
  const asked: string[] = [];
  const smtp: Senders['smtp'] = {
    send: async ({ attemptId, sealedPayload, configuredAccount }) => {
      sent.push({ attemptId, ...sealedPayload, settings: configuredAccount });
      return say();
    },
    reconcile: async ({ attemptId }) => {
      asked.push(attemptId);
      return ask();
    },
  };
  const webhook = { send: async () => { throw new Error('This test sends over SMTP.'); }, reconcile: async () => ({ kind: 'pending' as const }) };
  return { sent, asked, use: { smtp, webhook, deadlineMs } satisfies Senders };
}

/* Sent by the dispatcher's own steps, so its end stands as the transport says. */
async function sendBegunOf(w: World, messageId: string, use: Senders): Promise<void> {
  const begun = await dispatched(w, messageId);
  if (begun.kind !== 'begun') throw new Error(`Expected it to begin, got ${begun.kind}`);
  await sendBegun(w.ctx, begun, use);
}

async function ready(policy = QUIET, over: Parameters<typeof world>[1] = {}): Promise<World> {
  const w = await world(policy, over);
  await w.c.db.update(outboundAccounts).set({ configEnc: encryptSecret(JSON.stringify(SMTP), w.ctx.config.secret) }).where(eq(outboundAccounts.id, w.account.id));
  return w;
}

const attemptsOf = (w: World, messageId: string) => w.c.db.select().from(outboundAttempts).where(eq(outboundAttempts.messageId, messageId));
const bucketOf = async (w: World) => (await w.c.db.select().from(outboundDailyUsage).where(and(eq(outboundDailyUsage.scope, 'account'), eq(outboundDailyUsage.scopeKey, w.account.id))))[0]!;
const channelOf = async (w: World) => (await w.c.db.select().from(outboundChannels).where(eq(outboundChannels.id, w.channel.id)))[0]!;

describe('sending what is due', () => {
  it('hands one transport the frozen words and the sealed settings, once, however many rounds come after', async () => {
    const w = await ready();
    const { messageId } = await w.submit();
    const { sent, use } = senders();
    await dispatchDue(w.ctx, new Date(), use);
    await dispatchDue(w.ctx, later(), use);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ recipient: 'ann@shop.example', subject: 'Hello', settings: SMTP });
    expect(sent[0]!.text).toContain('10.00');
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'sent' });
    expect(await attemptsOf(w, messageId)).toMatchObject([{ status: 'accepted', providerReceipt: '250 ok' }]);
    expect(await bucketOf(w)).toMatchObject({ reserved: 0, accepted: 1 });
  });

  it('sends once when two rounds run at the same time', async () => {
    const w = await ready();
    await w.submit();
    const { sent, use } = senders();
    await Promise.all([dispatchDue(w.ctx, new Date(), use), dispatchDue(w.ctx, new Date(), use)]);
    expect(sent).toHaveLength(1);
  });

  it('leaves what is not due yet', async () => {
    const w = await ready();
    const { messageId } = await w.submit({ scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
    const { sent, use } = senders();
    await dispatchDue(w.ctx, new Date(), use);
    expect(sent).toEqual([]);
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'scheduled' });
  });

  it('counts a sure failure as one and gives its place back, and the next message goes', async () => {
    const w = await ready();
    const first = await w.submit();
    const outcomes: SendOutcome[] = [{ kind: 'definitely_not_accepted', safeCode: 'recipient_refused' }, ACCEPTED];
    const { sent, use } = senders(async () => outcomes.shift()!);
    await dispatchDue(w.ctx, new Date(), use);
    expect(await w.messageOf(first.messageId)).toMatchObject({ status: 'definitely_failed' });
    expect(await bucketOf(w)).toMatchObject({ reserved: 0, definitelyFailed: 1 });
    const second = await w.submit();
    await dispatchDue(w.ctx, new Date(), use);
    expect(sent).toHaveLength(2);
    expect(await w.messageOf(second.messageId)).toMatchObject({ status: 'sent' });
  });

  it.each(['2026-11-08T12:00:00.000Z', '2026-11-08T23:58:00.000Z'])('never sends an unknown one again, and keeps its place and the next message of the account back, from %s', async clock => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(clock));
    onTestFinished(() => { vi.useRealTimers(); });
    const w = await ready();
    const first = await w.submit();
    const { sent, use } = senders(async () => ({ kind: 'unknown', safeCode: 'timeout' }));
    await dispatchDue(w.ctx, new Date(), use);
    const second = await w.submit();
    await dispatchDue(w.ctx, later(), use);
    await dispatchDue(w.ctx, later(), use);
    expect(sent.map(s => s.attemptId)).toEqual([(await attemptsOf(w, first.messageId))[0]!.id]);
    expect(await w.messageOf(first.messageId)).toMatchObject({ status: 'unknown', reasonCodes: ['delivery_unknown'] });
    expect(await w.messageOf(second.messageId)).toMatchObject({ status: 'reserved' });
    const buckets = await w.c.db.select().from(outboundDailyUsage).where(and(eq(outboundDailyUsage.scope, 'account'), eq(outboundDailyUsage.scopeKey, w.account.id)));
    /* The six-minute retry can cross midnight; both daily places still belong to this account. */
    expect(buckets.reduce((sum, bucket) => ({ unknown: sum.unknown + bucket.unknown, reserved: sum.reserved + bucket.reserved }), { unknown: 0, reserved: 0 })).toEqual({ unknown: 1, reserved: 1 });
  });

  it('takes a transport that throws for one that may have sent', async () => {
    const w = await ready();
    const { messageId } = await w.submit();
    const { sent, use } = senders(async () => { throw new Error(`refused ${PASSWORD}`); });
    await dispatchDue(w.ctx, new Date(), use);
    await dispatchDue(w.ctx, later(), use);
    expect(sent).toHaveLength(1);
    expect(await attemptsOf(w, messageId)).toMatchObject([{ status: 'unknown', safeCode: 'connection_lost' }]);
  });

  it('stops waiting for a transport that never answers, and calls that unknown', async () => {
    const w = await ready();
    const { messageId } = await w.submit();
    const { sent, use } = senders(() => new Promise(() => {}), undefined, 5000);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => { vi.useRealTimers(); });
    let ended = false;
    const round = dispatchDue(w.ctx, new Date(), use).then(() => { ended = true; });
    /* The transport has the message, so the wait for its answer has begun. */
    await until(() => sent.length === 1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(ended).toBe(false);
    expect(await attemptsOf(w, messageId)).toMatchObject([{ status: 'sending' }]);
    await vi.advanceTimersByTimeAsync(1);
    await round;
    expect(await attemptsOf(w, messageId)).toMatchObject([{ status: 'unknown', safeCode: 'timeout' }]);
  });

  it('stops an account whose sign-in was refused until someone gives it new settings', async () => {
    const w = await ready();
    const first = await w.submit();
    const second = await w.submit();
    const { sent, use } = senders(async () => ({ kind: 'definitely_not_accepted', safeCode: 'auth_refused' }));
    await dispatchDue(w.ctx, new Date(), use);
    expect(sent).toHaveLength(1);
    expect((await w.c.db.select().from(outboundAccounts).where(eq(outboundAccounts.id, w.account.id)))[0]!.status).toBe('invalid');
    expect(await w.messageOf(first.messageId)).toMatchObject({ status: 'definitely_failed' });
    expect(await w.messageOf(second.messageId)).toMatchObject({ status: 'cancelled', reasonCodes: ['stale_binding'] });
  });

  it('sends nothing with settings changed after the last look, and says it never left', async () => {
    const w = await ready();
    const { messageId } = await w.submit();
    const begun = await dispatched(w, messageId);
    if (begun.kind !== 'begun') throw new Error('It did not begin.');
    await w.c.db.update(outboundAccounts).set({ configGeneration: 2 }).where(eq(outboundAccounts.id, w.account.id));
    const { sent, use } = senders();
    await sendBegun(w.ctx, begun, use);
    expect(sent).toEqual([]);
    expect(await attemptsOf(w, messageId)).toMatchObject([{ status: 'definitely_not_accepted', safeCode: 'settings_changed' }]);
  });

  it('sends nothing with settings that no longer read as settings, and stops the account', async () => {
    const w = await ready();
    const { messageId } = await w.submit();
    await w.c.db.update(outboundAccounts).set({ configEnc: encryptSecret('{"host":"only"}', w.ctx.config.secret) }).where(eq(outboundAccounts.id, w.account.id));
    const { sent, use } = senders();
    await dispatchDue(w.ctx, new Date(), use);
    expect(sent).toEqual([]);
    expect(await attemptsOf(w, messageId)).toMatchObject([{ status: 'definitely_not_accepted', safeCode: 'settings_changed' }]);
    expect((await w.c.db.select().from(outboundAccounts).where(eq(outboundAccounts.id, w.account.id)))[0]!.status).toBe('invalid');
  });

  it('sends nothing through a stopped channel, and what waits stays', async () => {
    const w = await ready();
    const { messageId } = await w.submit();
    await stopByPerson(w.ctx, w.channel.id);
    const { sent, use } = senders();
    await dispatchDue(w.ctx, new Date(), use);
    expect(sent).toEqual([]);
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'scheduled', reasonCodes: ['channel_stopped'] });
  });

  it('goes on past a message that fails to take its turn, and says so at the end', async () => {
    const w = await ready();
    const first = await w.submit();
    const second = await w.submit();
    const { sent, use } = senders();
    let failing = true;
    const db = new Proxy(w.ctx.db, {
      get(target, key) {
        if (key === 'transaction' && failing) {
          failing = false;
          return () => Promise.reject(new Error('the database went away'));
        }
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(dispatchDue({ ...w.ctx, db }, new Date(), use)).rejects.toThrow('the database went away');
    expect(sent).toHaveLength(1);
    expect(await w.messageOf(first.messageId)).toMatchObject({ status: 'scheduled' });
    expect(await w.messageOf(second.messageId)).toMatchObject({ status: 'sent' });
  });

  it('looks at a part of every account\'s queue each round, so a long one holds no other back', async () => {
    const w = await ready();
    for (let i = 0; i < 3; i += 1) await w.submit();
    const other = await anAccountOf(w.c, w.channel.id, w.c.head.id, 'Other');
    const hers = (await createTask(w.ctx, { agentId: w.c.head.id }, { title: 'Hers', brief: '', body: '', departmentId: w.c.dev.id, assigneeAgentId: w.c.head.id, executor: true })).task;
    const last = await submitOutbound(w.ctx, { ...w.authority, agentId: w.c.head.id }, w.input({ task: hers.id, accountId: other.account.id, bindingGeneration: other.binding.generation }));
    const due = await dueMessages(w.ctx, new Date(), 1);
    expect(due).toHaveLength(2);
    expect(due.map(m => m.messageId)).toContain(last.messageId);
  });

  it('looks at what can go now however many older ones wait for a person or a limit', async () => {
    const w = await ready();
    const waiting = await w.submit();
    const limited = await w.submit();
    const free = await w.submit();
    await w.c.db.update(outboundMessages).set({ status: 'waiting_approval', reasonCodes: ['approval_required'] }).where(eq(outboundMessages.id, waiting.messageId));
    await w.c.db.update(outboundMessages).set({ reasonCodes: ['daily_limit_exceeded'] }).where(eq(outboundMessages.id, limited.messageId));
    expect((await dueMessages(w.ctx, new Date(), 1)).map(m => m.messageId)).toContain(free.messageId);
  });

  it('comes round to each one that is held, longest unseen first, however few it looks at', async () => {
    const w = await ready();
    const first = await w.submit();
    const second = await w.submit();
    await stopByPerson(w.ctx, w.channel.id);
    const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);
    await reserveDispatch(w.ctx, first.messageId, 1, at(1));
    await reserveDispatch(w.ctx, second.messageId, 1, at(2));
    expect((await dueMessages(w.ctx, at(3), 1)).map(m => m.messageId)).toEqual([first.messageId]);
    await reserveDispatch(w.ctx, first.messageId, 1, at(3));
    expect((await dueMessages(w.ctx, at(4), 1)).map(m => m.messageId)).toEqual([second.messageId]);
  });
});

describe('the time of a round that takes long', () => {
  afterEach(() => { vi.useRealTimers(); });

  const movingOn = (to: Date) => {
    const made = senders();
    const send = made.use.smtp.send;
    made.use.smtp.send = async args => {
      const said = await send(args);
      vi.setSystemTime(to);
      return said;
    };
    return made;
  };

  it('does not send on a template that ran out during the send before it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const w = await ready();
    const start = new Date();
    const [template] = await w.c.db.insert(outboundCatalogRevisions).values({ ...w.template, id: randomUUID(), entryId: randomUUID(), validUntil: new Date(start.getTime() + 1000) }).returning();
    const document = { ...w.document, templateId: template!.entryId };
    await w.submit({ document });
    await w.submit({ document });
    const { sent, use } = movingOn(new Date(start.getTime() + 2000));
    await dispatchDue(w.ctx, start, use);
    expect(sent).toHaveLength(1);
  });

  it('does not send on a certificate that ran out during the send before it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const w = await ready(QUIET, { status: 'new' });
    const certified = await aCertifiedCheck(w);
    const start = new Date();
    for (let i = 0; i < 2; i += 1) {
      const { messageId, contentDigest } = await w.submit();
      await allowed(w, messageId, contentDigest, certified);
    }
    await w.c.db.update(modelChecks).set({ validUntil: new Date(start.getTime() + 1000) }).where(eq(modelChecks.id, certified.check.id));
    const { sent, use } = movingOn(new Date(start.getTime() + 2000));
    await dispatchDue(w.ctx, start, use);
    expect(sent).toHaveLength(1);
  });

  it('counts a send past midnight in the new day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const w = await ready({ ...QUIET, timezone: 'UTC' });
    const midnight = new Date(Math.ceil(Date.now() / 86_400_000) * 86_400_000 + 86_400_000);
    const start = new Date(midnight.getTime() - 1000);
    vi.setSystemTime(start);
    await w.submit();
    await w.submit();
    const { sent, use } = movingOn(new Date(midnight.getTime() + 1000));
    await dispatchDue(w.ctx, start, use);
    expect(sent).toHaveLength(2);
    const buckets = await w.c.db.select().from(outboundDailyUsage).where(and(eq(outboundDailyUsage.scope, 'account'), eq(outboundDailyUsage.scopeKey, w.account.id)));
    expect(buckets.map(b => [b.day, b.accepted]).toSorted()).toEqual([[start.toISOString().slice(0, 10), 1], [midnight.toISOString().slice(0, 10), 1]]);
  });

  it('counts a round from when it began, not from when its first step ended', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const w = await ready();
    const start = new Date();
    const [template] = await w.c.db.insert(outboundCatalogRevisions).values({ ...w.template, id: randomUUID(), entryId: randomUUID(), validUntil: new Date(start.getTime() + 1000) }).returning();
    await w.submit({ document: { ...w.document, templateId: template!.entryId } });
    const reconciled = await w.submit();
    const { sent, use } = senders(async () => ({ kind: 'unknown', safeCode: 'timeout' }));
    await sendBegunOf(w, reconciled.messageId, use);
    use.smtp.reconcile = async () => {
      vi.setSystemTime(new Date(start.getTime() + 2000));
      return { kind: 'accepted', providerReceipt: '250 ok', acceptedAt: new Date().toISOString() };
    };
    sent.length = 0;
    await outboundRound(w.ctx, start, use);
    expect(sent).toEqual([]);
  });
});

describe('what no one knows the end of', () => {
  it('comes round to every one of them, and sends none of them again', async () => {
    const w = await ready();
    const { messageId } = await w.submit();
    const { sent, use } = senders(async () => ({ kind: 'unknown', safeCode: 'timeout' }));
    await dispatchDue(w.ctx, new Date(), use);
    expect(sent).toHaveLength(1);
    const [baseAttempt] = await attemptsOf(w, messageId);
    const [baseMessage] = await w.c.db.select().from(outboundMessages).where(eq(outboundMessages.id, messageId));
    const [baseRevision] = await w.c.db.select().from(outboundMessageRevisions).where(eq(outboundMessageRevisions.messageId, messageId));
    const [baseAgent] = await w.c.db.select().from(agents).where(eq(agents.id, w.c.worker.id));
    const [baseAccount] = await w.c.db.select().from(outboundAccounts).where(eq(outboundAccounts.id, w.account.id));
    const [baseBucket] = await w.c.db.select().from(outboundDailyUsage).where(eq(outboundDailyUsage.id, baseAttempt!.accountBucketId));
    await w.c.db.update(outboundDailyUsage).set({ unknown: 101 }).where(eq(outboundDailyUsage.id, baseAttempt!.domainBucketId));
    let lastInserted = '';
    for (let i = 1; i <= 100; i += 1) {
      const agentId = randomUUID(), accountId = randomUUID(), nextMessageId = randomUUID(), bucketId = randomUUID(), attemptId = randomUUID();
      await w.c.db.insert(agents).values({ ...baseAgent!, id: agentId, name: `Stuck author ${i}` });
      await w.c.db.insert(outboundAccounts).values({ ...baseAccount!, id: accountId, label: `Stuck account ${i}` });
      await w.c.db.insert(outboundBindings).values({ ...w.binding, id: randomUUID(), agentId, accountId });
      await w.c.db.insert(outboundDailyUsage).values({ ...baseBucket!, id: bucketId, scopeKey: accountId });
      await w.c.db.insert(outboundMessages).values({ ...baseMessage!, id: nextMessageId, authorAgentId: agentId, accountId, idempotencyKey: randomUUID() });
      await w.c.db.insert(outboundMessageRevisions).values({ ...baseRevision!, id: randomUUID(), messageId: nextMessageId });
      await w.c.db.insert(outboundAttempts).values({ ...baseAttempt!, id: attemptId, messageId: nextMessageId, accountId, accountBucketId: bucketId });
      lastInserted = attemptId;
    }
    const asked = new Set<string>();
    const everyAttempt = (await w.c.db.select(idOnly(outboundAttempts)).from(outboundAttempts)).map(a => a.id).toSorted();
    const lastOfAll = everyAttempt.at(-1)!;
    expect(everyAttempt).toContain(lastInserted);
    use.smtp.reconcile = async ({ attemptId }) => {
      asked.add(attemptId);
      return attemptId === lastOfAll ? { kind: 'accepted', providerReceipt: '250 ok', acceptedAt: new Date().toISOString() } : { kind: 'pending' };
    };
    await reconcileOutbound(w.ctx, new Date(), use);
    await reconcileOutbound(w.ctx, new Date(), use);
    expect(asked.size).toBe(101);
    expect((await w.c.db.select().from(outboundAttempts).where(eq(outboundAttempts.id, lastOfAll)))[0]!.status).toBe('accepted');
    await dispatchDue(w.ctx, new Date(), use);
    expect(sent).toHaveLength(1);
  });
});

describe('what waits for a check of its words', () => {
  it('stays until the check passes, and then goes once', async () => {
    const w = await ready(QUIET, { status: 'new' });
    const certified = await aCertifiedCheck(w);
    const { messageId, contentDigest, status } = await w.submit();
    expect(status).toBe('waiting_checks');
    const { sent, use } = senders();
    await dispatchDue(w.ctx, new Date(), use);
    expect(sent).toEqual([]);
    await allowed(w, messageId, contentDigest, certified);
    await dispatchDue(w.ctx, new Date(), use);
    await dispatchDue(w.ctx, later(), use);
    expect(sent).toHaveLength(1);
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'sent' });
  });

  it('asks the check again once it was certified anew, and then goes once', async () => {
    const w = await ready(QUIET, { status: 'new' });
    const certified = await aCertifiedCheck(w);
    const { messageId, contentDigest } = await w.submit();
    await allowed(w, messageId, contentDigest, certified);
    const bindingDigest = sha('certified anew');
    await w.c.db.update(modelChecks).set({ bindingDigest }).where(eq(modelChecks.id, certified.check.id));
    const { sent, use } = senders();
    await dispatchDue(w.ctx, new Date(), use);
    expect(sent).toEqual([]);
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'waiting_checks', reasonCodes: ['review_unavailable'] });
    await allowed(w, messageId, contentDigest, { check: certified.check, bindingDigest });
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'scheduled', reasonCodes: [] });
    await dispatchDue(w.ctx, new Date(), use);
    await dispatchDue(w.ctx, later(), use);
    expect(sent).toHaveLength(1);
  });

  it('ends with a failed check stopping everything after it, what had already passed included', async () => {
    const w = await ready(QUIET, { status: 'new' });
    const certified = await aCertifiedCheck(w);
    const passed = await w.submit();
    const failed = await w.submit();
    await allowed(w, passed.messageId, passed.contentDigest, certified);
    await allowed(w, failed.messageId, failed.contentDigest, certified, 'block');
    const { sent, use } = senders();
    await dispatchDue(w.ctx, new Date(), use);
    expect(sent).toEqual([]);
    expect(await channelOf(w)).toMatchObject({ status: 'stopped', stoppedReason: 'review_failed' });
    expect(await w.messageOf(failed.messageId)).toMatchObject({ status: 'rejected' });
    expect(await w.messageOf(passed.messageId)).toMatchObject({ status: 'scheduled', reasonCodes: ['channel_stopped'] });
  });
});

describe('finding out how an attempt ended', () => {
  /* Model a file that started over six minutes before these attempts, without waiting. */
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 7 * 60_000));
  });
  afterEach(() => { vi.useRealTimers(); });

  const stuck = async (w: World) => {
    const { messageId } = await w.submit();
    const begun = await dispatched(w, messageId);
    if (begun.kind !== 'begun') throw new Error('It did not begin.');
    return { messageId, attemptId: begun.attemptId };
  };

  it('leaves one whose lease still runs, and after it calls it unknown and never sends it again', async () => {
    const w = await ready();
    const { messageId, attemptId } = await stuck(w);
    const { sent, use } = senders();
    await reconcileOutbound(w.ctx, new Date(Date.now() + 60_000), use);
    expect(await attemptsOf(w, messageId)).toMatchObject([{ status: 'sending' }]);
    await reconcileOutbound(w.ctx, later(), use);
    expect(await attemptsOf(w, messageId)).toMatchObject([{ id: attemptId, status: 'unknown', safeCode: 'timeout' }]);
    await dispatchDue(w.ctx, later(), use);
    expect(sent).toEqual([]);
    expect(await attemptsOf(w, messageId)).toHaveLength(1);
  });

  it('does not let any round end who writes from the account', async () => {
    const w = await ready();
    await stuck(w);
    const { use } = senders();
    await reconcileOutbound(w.ctx, later(), use);
    await dispatchDue(w.ctx, later(), use);
    await reconcileOutbound(w.ctx, new Date(Date.now() + 30 * 86_400_000), use);
    expect(await w.c.db.select().from(outboundBindings).where(eq(outboundBindings.accountId, w.account.id))).toMatchObject([{ agentId: w.c.worker.id, generation: 1, status: 'active' }]);
  });

  it('takes the transport\'s word when it knows, and the account goes on', async () => {
    const w = await ready();
    const { messageId, attemptId } = await stuck(w);
    const { asked, use } = senders(undefined, async () => ACCEPTED);
    await reconcileOutbound(w.ctx, later(), use);
    await reconcileOutbound(w.ctx, later(), use);
    expect(asked).toContain(attemptId);
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'sent' });
    const next = await w.submit();
    await dispatchDue(w.ctx, later(), use);
    expect(await w.messageOf(next.messageId)).toMatchObject({ status: 'sent' });
  });

  it('counts a sure word against it as failed', async () => {
    const w = await ready();
    const { messageId } = await stuck(w);
    const { use } = senders(undefined, async () => ({ kind: 'definitely_not_accepted', safeCode: 'receiver_refused' }));
    await reconcileOutbound(w.ctx, later(), use);
    await reconcileOutbound(w.ctx, later(), use);
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'definitely_failed' });
  });

  it.each<[string, () => Promise<ReconcileOutcome>]>([
    ['has nothing yet', async () => ({ kind: 'pending' })],
    ['says it cannot tell', async () => ({ kind: 'unknown', safeCode: 'no_readback' })],
    ['throws', async () => { throw new Error('no answer'); }],
  ])('keeps it unknown when the transport %s', async (_name, ask) => {
    const w = await ready();
    const { messageId } = await stuck(w);
    const { use } = senders(undefined, ask);
    await reconcileOutbound(w.ctx, later(), use);
    await reconcileOutbound(w.ctx, later(), use);
    expect(await attemptsOf(w, messageId)).toMatchObject([{ status: 'unknown', safeCode: 'timeout' }]);
  });

  it('does not ask with settings that are gone', async () => {
    const w = await ready();
    const { messageId, attemptId } = await stuck(w);
    await w.c.db.update(outboundAccounts).set({ status: 'revoked', configEnc: encryptSecret('{}', w.ctx.config.secret) }).where(eq(outboundAccounts.id, w.account.id));
    const { asked, use } = senders(undefined, async () => ACCEPTED);
    await reconcileOutbound(w.ctx, later(), use);
    await reconcileOutbound(w.ctx, later(), use);
    expect(asked).not.toContain(attemptId);
    expect(await attemptsOf(w, messageId)).toMatchObject([{ status: 'unknown' }]);
  });

  it('believes a late answer of a worker past its lease, which neither sends again nor opens a stopped channel', async () => {
    const w = await ready();
    const { messageId } = await w.submit();
    let answer: (outcome: SendOutcome) => void = () => {};
    const { sent, use } = senders(() => new Promise(resolve => { answer = resolve; }));
    const worker = dispatchDue(w.ctx, new Date(), use);
    await until(() => sent.length === 1);
    await reconcileOutbound(w.ctx, later(), use);
    await stopByPerson(w.ctx, w.channel.id);
    answer(ACCEPTED);
    await worker;
    expect(await attemptsOf(w, messageId)).toMatchObject([{ status: 'accepted' }]);
    expect((await channelOf(w)).status).toBe('stopped');
    await dispatchDue(w.ctx, later(), use);
    expect(sent).toHaveLength(1);
  });
});

describe('what comes back after a message left', () => {
  const STRICT = { ...QUIET, circuit: { windowHours: 24, minimumSample: 2, maxComplaints: 1, maxRefusals: 2, maxBounces: 3 } };
  const event = (attemptId: string, kind: 'delivered' | 'bounce' | 'refusal' | 'complaint', providerEventId: string = randomUUID(), occurredAt = new Date().toISOString()) => ({ attemptId, kind, providerEventId, occurredAt });

  const sentMessages = async (w: World, count: number) => {
    const { use } = senders();
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const { messageId } = await w.submit();
      await dispatchDue(w.ctx, new Date(), use);
      ids.push((await attemptsOf(w, messageId))[0]!.id);
    }
    return ids;
  };
  const account = async (w: World) => (await w.c.db.select().from(outboundAccounts).where(eq(outboundAccounts.id, w.account.id)))[0]!;

  it('stops the channel at the policy\'s limit and at a higher generation, so what was reserved stays', async () => {
    const w = await ready(STRICT);
    const ids = await sentMessages(w, 2);
    const queued = await w.submit();
    await reserveDispatch(w.ctx, queued.messageId, 1);
    await recordReceipts(w.ctx, await account(w), [event(ids[0]!, 'complaint')]);
    expect((await channelOf(w)).status).toBe('active');
    await recordReceipts(w.ctx, await account(w), [event(ids[1]!, 'complaint')]);
    expect(await channelOf(w)).toMatchObject({ status: 'stopped', stoppedReason: 'complaint_threshold', generation: 2 });
    expect(await beginDispatch(w.ctx, queued.messageId, 1)).toEqual({ kind: 'refused', reasonCodes: ['channel_stopped'] });
    const { sent, use } = senders();
    await dispatchDue(w.ctx, new Date(), use);
    expect(sent).toEqual([]);
  });

  it('does not count a duplicated event twice', async () => {
    const w = await ready(STRICT);
    const ids = await sentMessages(w, 2);
    const same = event(ids[0]!, 'complaint', 'provider-event-1');
    const first = await recordReceipts(w.ctx, await account(w), [same]);
    const again = await recordReceipts(w.ctx, await account(w), [same, same]);
    expect(first).toEqual({ recorded: 1, repeated: 0, ignored: 0 });
    expect(again).toEqual({ recorded: 0, repeated: 2, ignored: 0 });
    expect(await w.c.db.select().from(outboundEvents)).toHaveLength(1);
    expect((await channelOf(w)).status).toBe('active');
  });

  it.each([
    ['refusals', 'refusal', 3, 'refusal_threshold'],
    ['bounces', 'bounce', 4, 'bounce_threshold'],
  ] as const)('stops for too many %s, each by its own limit', async (_name, kind, count, reason) => {
    const w = await ready(STRICT);
    const ids = await sentMessages(w, 2);
    for (let i = 0; i < count - 1; i += 1) await recordReceipts(w.ctx, await account(w), [event(ids[0]!, kind)]);
    expect((await channelOf(w)).status).toBe('active');
    await recordReceipts(w.ctx, await account(w), [event(ids[0]!, kind)]);
    expect(await channelOf(w)).toMatchObject({ status: 'stopped', stoppedReason: reason });
  });

  it('leaves the channel alone below the least number of messages the limits speak of', async () => {
    const w = await ready({ ...STRICT, circuit: { ...STRICT.circuit, minimumSample: 3 } });
    const ids = await sentMessages(w, 2);
    await recordReceipts(w.ctx, await account(w), [event(ids[0]!, 'complaint'), event(ids[1]!, 'complaint'), event(ids[1]!, 'complaint')]);
    expect((await channelOf(w)).status).toBe('active');
  });

  it('counts only what happened within the policy\'s window', async () => {
    const w = await ready(STRICT);
    const ids = await sentMessages(w, 2);
    const longAgo = new Date(Date.now() - 25 * 3_600_000).toISOString();
    await recordReceipts(w.ctx, await account(w), [event(ids[0]!, 'complaint', 'old-1', longAgo), event(ids[1]!, 'complaint', 'old-2', longAgo), event(ids[1]!, 'complaint')]);
    expect((await channelOf(w)).status).toBe('active');
  });

  it('never stops for a delivery, nor counts one of another account\'s attempts', async () => {
    const w = await ready(STRICT);
    const ids = await sentMessages(w, 2);
    const said = await recordReceipts(w.ctx, await account(w), [event(ids[0]!, 'delivered'), event(ids[1]!, 'delivered'), event(randomUUID(), 'complaint'), event(randomUUID(), 'complaint')]);
    expect(said).toEqual({ recorded: 2, repeated: 0, ignored: 2 });
    expect((await channelOf(w)).status).toBe('active');
  });

  it('tells the department\'s head and the orchestrator of a stop once, whatever stopped it', async () => {
    const w = await ready(STRICT);
    await stopByPerson(w.ctx, w.channel.id);
    await noticeStops(w.ctx);
    await noticeStops(w.ctx);
    const told = await w.c.db.select().from(waitNotices);
    expect(told.map(notice => notice.agentId).sort()).toEqual([w.c.head.id, w.c.orchestrator.id].sort());
    expect(JSON.stringify(told)).not.toContain(PASSWORD);
    expect(JSON.stringify(told)).toContain('Mail');
  });

  const signedPost = (w: World, key: string, payload: object, stamp = String(Math.floor(Date.now() / 1000)), signed?: string) => {
    const body = JSON.stringify(payload);
    const signature = `v1=${createHmac('sha256', key).update(`${stamp}.${signed ?? body}`).digest('hex')}`;
    return w.c.app.inject({ method: 'POST', url: `/api/outbound/accounts/${w.account.id}/events`, headers: { 'content-type': 'application/json', 'x-hornhoof-timestamp': stamp, 'x-hornhoof-signature': signature }, payload: body });
  };

  it('takes events only when signed with the account\'s key, recently', async () => {
    const w = await ready(STRICT);
    const ids = await sentMessages(w, 1);
    const payload = { events: [event(ids[0]!, 'complaint')] };
    const good = await signedPost(w, EVENT_KEY, payload);
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ recorded: 1, repeated: 0, ignored: 0 });
    expect((await signedPost(w, 'someone-elses-key-0123456789abcdef0123', payload)).statusCode).toBe(401);
    expect((await signedPost(w, EVENT_KEY, payload, String(Math.floor(Date.now() / 1000) - 3600))).statusCode).toBe(401);
    expect((await signedPost(w, EVENT_KEY, { events: [event(ids[0]!, 'complaint')] }, undefined, 'something else')).statusCode).toBe(401);
    const unsigned = await w.c.app.inject({ method: 'POST', url: `/api/outbound/accounts/${w.account.id}/events`, payload });
    expect(unsigned.statusCode).toBe(401);
    expect(await w.c.db.select().from(outboundEvents)).toHaveLength(1);
  });

  it('answers the same to a key it does not have and an account that is not there', async () => {
    const w = await ready(STRICT);
    await w.c.db.update(outboundAccounts).set({ configEnc: encryptSecret(JSON.stringify({ ...SMTP, eventKey: undefined }), w.ctx.config.secret) }).where(eq(outboundAccounts.id, w.account.id));
    const stamp = String(Math.floor(Date.now() / 1000));
    const headers = { 'content-type': 'application/json', 'x-hornhoof-timestamp': stamp, 'x-hornhoof-signature': 'v1=00' };
    const noKey = await w.c.app.inject({ method: 'POST', url: `/api/outbound/accounts/${w.account.id}/events`, headers, payload: '{"events":[]}' });
    const noAccount = await w.c.app.inject({ method: 'POST', url: `/api/outbound/accounts/${randomUUID()}/events`, headers, payload: '{"events":[]}' });
    expect(noKey.statusCode).toBe(401);
    expect(noAccount.statusCode).toBe(401);
    expect(noKey.body).toBe(noAccount.body);
  });

  it('refuses a signed body that is no list of events', async () => {
    const w = await ready(STRICT);
    expect((await signedPost(w, EVENT_KEY, { events: [{ kind: 'nothing' }] })).statusCode).toBe(400);
  });
});

describe('the server\'s minute', () => {
  it('runs the outbound round, and a broken account does not stop the rest of the minute', async () => {
    const w = await ready();
    const { messageId } = await w.submit();
    const failures: string[] = [];
    await w.c.db.update(outboundAccounts).set({ configEnc: encryptSecret('{"broken":true}', w.ctx.config.secret) }).where(eq(outboundAccounts.id, w.account.id));
    await minuteRound(w.ctx, new Date(), what => () => failures.push(what));
    expect(failures).toEqual([]);
    expect(await attemptsOf(w, messageId)).toMatchObject([{ status: 'definitely_not_accepted', safeCode: 'settings_changed' }]);
  });

  it('finds out on starting up what became of what was on its way', async () => {
    const w = await ready();
    const { messageId } = await w.submit();
    await dispatched(w, messageId, new Date(Date.now() - 10 * 60_000));
    const started = Fastify();
    startTimers(started, w.ctx);
    await started.ready();
    await until(async () => (await attemptsOf(w, messageId))[0]!.status === 'unknown');
    await started.close();
  });
});
