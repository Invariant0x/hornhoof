import { randomUUID } from 'node:crypto';
import type { OutboundPolicyValue } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import * as schema from '../../src/db/schema.js';
import { encryptSecret } from '../../src/crypto/secrets.js';
import { bindAccount, releaseAccount } from '../../src/modules/outbound/accounts.js';
import { unsubscribe, unsubscribeToken } from '../../src/modules/outbound/contacts.js';
import { beginDispatch, reserveDispatch, submitOutbound, type Authority } from '../../src/modules/outbound/core.js';
import { dispatchDue, type Senders } from '../../src/modules/outbound/dispatcher.js';
import { stopByPerson } from '../../src/modules/outbound/policies.js';
import { aChannelOf, aContactOf, anAccountOf, aPermissionOf, aPolicyOf, documentOf, partsOf, QUIET, type Base } from '../outbound-world.js';
import { backendPid, privatePostgres, runFixture, type Actor, type PostgresFixture } from './helpers.js';

/* Two apps on their own connections to one PostgreSQL, doing what PGlite's one connection cannot show: nothing here is
   mocked but the transport, which no test of this file reaches. Everything is synthetic. */

const LIMITED = (accountDailyLimit: number, domainDailyLimit: number) => ({ ...QUIET, accountDailyLimit, domainDailyLimit });

/* A way out for one author: its own channel, as what a sender domain counts crosses channels, and no channel lock helps there. */
async function aWay(c: Base, actor: Actor, name: string, limits: OutboundPolicyValue) {
  const channel = await aChannelOf(c, { name });
  await aPolicyOf(c, channel.id, limits);
  const { account } = await anAccountOf(c, channel.id, actor.job.agentId, name);
  const parts = await partsOf(c, channel.id);
  return { channel, account, segmentId: parts.segment.entryId, document: documentOf(parts) };
}

async function gateway(pg: PostgresFixture, limits: OutboundPolicyValue = QUIET) {
  const { companyId, departmentId, actors } = await runFixture(pg, { env: { PUBLIC_URL: 'https://hornhoof.example' } });
  const [first, second] = actors;
  const [owner] = await pg.db.select().from(schema.people);
  const c: Base = { db: first.ctx.db, companyId, dev: { id: departmentId }, ids: { ceo: owner!.id }, app: { ctx: first.ctx } };
  for (const channel of ['message', 'price'] as const) await pg.db.insert(schema.approvalPolicies).values({ companyId, departmentId, channel, mode: 'within_limits', limitAmount: 100, limitUnit: 'USD', updatedBy: owner!.id });
  const one = await aWay(c, first, 'One', limits);
  const two = await aWay(c, second, 'Two', limits);
  const wayOf = (actor: Actor) => (actor === first ? one : two);
  const send = (actor: Actor, contactId: string, idempotencyKey: string = randomUUID()) => {
    const { channel, account, segmentId, document } = wayOf(actor);
    const authority: Authority = { companyId, agentId: actor.job.agentId, departmentId, jobId: actor.job.id };
    return submitOutbound(actor.ctx, authority, { task: actor.task.id, idempotencyKey, channelId: channel.id, accountId: account.id, bindingGeneration: 1, target: { kind: 'contact', contactId }, segmentId, document, scheduledAt: '2026-01-02T00:00:00.000Z' });
  };
  const someone = async (address: string, actor: Actor = first) => {
    const contact = await aContactOf(c, address);
    await aPermissionOf(c, contact.id, wayOf(actor).channel.id);
    return contact;
  };
  const usage = () => pg.db.select().from(schema.outboundDailyUsage);
  const messageOf = async (id: string) => (await pg.db.select().from(schema.outboundMessages).where(eq(schema.outboundMessages.id, id)))[0]!;
  return { c, companyId, first, second, one, two, channel: one.channel, send, someone, usage, messageOf };
}

const reservedAt = (buckets: { reserved: number }[]) => buckets.map(b => b.reserved);

it('gives the same answer to one key sent twice at once, and makes one message', { timeout: 120000 }, async () => {
  const pg = await privatePostgres();
  const g = await gateway(pg);
  const contact = await g.someone('ann@shop.example');
  const key = randomUUID();
  const [a, b] = await Promise.all([g.send(g.first, contact.id, key), g.send(g.first, contact.id, key)]);
  expect(a).toEqual(b);
  expect(a.status).toBe('scheduled');
  expect(await pg.db.select().from(schema.outboundMessages)).toHaveLength(1);
});

it('never reserves past an account\'s limit, however many dispatchers ask at once', { timeout: 120000 }, async () => {
  const pg = await privatePostgres();
  const g = await gateway(pg, LIMITED(3, 100));
  const pids = await Promise.all([backendPid(g.first.pool), backendPid(g.second.pool)]);
  expect(new Set(pids).size).toBe(2);
  const messages = [];
  for (let i = 0; i < 8; i++) messages.push(await g.send(g.first, (await g.someone(`one${i}@shop.example`)).id));
  const asked = await Promise.all(messages.map((m, i) => reserveDispatch((i % 2 ? g.first : g.second).ctx, m.messageId, 1)));
  expect(asked.filter(a => a.kind === 'reserved')).toHaveLength(3);
  expect(asked.filter(a => a.kind === 'refused').every(a => a.kind === 'refused' && a.reasonCodes.includes('daily_limit_exceeded'))).toBe(true);
  expect(reservedAt(await g.usage())).toEqual([3, 3]);
  expect(await pg.db.select().from(schema.outboundAttempts)).toHaveLength(3);
});

it('counts a sender domain across its channels, whichever comes first', { timeout: 120000 }, async () => {
  const pg = await privatePostgres();
  const g = await gateway(pg, LIMITED(100, 3));
  const messages = [];
  for (let i = 0; i < 16; i++) {
    const actor = i % 2 ? g.first : g.second;
    messages.push(await g.send(actor, (await g.someone(`both${i}@shop.example`, actor)).id));
  }
  const asked = await Promise.all(messages.map((m, i) => reserveDispatch((i % 2 ? g.first : g.second).ctx, m.messageId, 1)));
  expect(asked.filter(a => a.kind === 'reserved')).toHaveLength(3);
  const domain = (await g.usage()).filter(b => b.scope === 'domain');
  expect(reservedAt(domain)).toEqual([3]);
});

/* Something held on one connection until someone is seen waiting for it, then changed and let go. */
async function holding<T>(pg: PostgresFixture, hold: [string, unknown[]], work: () => Promise<T>, change?: [string, unknown[]]): Promise<T> {
  const locker = await pg.pool('locker').connect();
  try {
    await locker.query('BEGIN');
    await locker.query(...hold);
    const lockerPid = (await locker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const pending = work();
    void pending.catch(() => {});
    await expect.poll(async () => (await pg.admin.query<{ waits: boolean }>('SELECT count(*) > 0 AS waits FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [lockerPid])).rows[0]!.waits, { timeout: 5000, interval: 10 }).toBe(true);
    if (change) await locker.query(...change);
    await locker.query('COMMIT');
    return await pending;
  } finally {
    await locker.query('ROLLBACK').catch(() => {});
    locker.release(true);
  }
}

const rowHeld = (table: string, id: string): [string, unknown[]] => [`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`, [id]];

it('takes the places of one sender domain one at a time, across channels', { timeout: 120000 }, async () => {
  const pg = await privatePostgres();
  const g = await gateway(pg);
  const { messageId } = await g.send(g.second, (await g.someone('wait@shop.example', g.second)).id);
  const asked = await holding(pg, ['SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`outbound:${g.companyId}:acme.example`]], () => reserveDispatch(g.second.ctx, messageId, 1));
  expect(asked.kind).toBe('reserved');
});

it('a stop that commits first wins over a dispatch that waited for it', { timeout: 120000 }, async () => {
  const pg = await privatePostgres();
  const g = await gateway(pg);
  const { messageId } = await g.send(g.first, (await g.someone('stop@shop.example')).id);
  expect((await reserveDispatch(g.first.ctx, messageId, 1)).kind).toBe('reserved');
  const begun = await holding(pg, rowHeld('outbound_channels', g.channel.id), () => beginDispatch(g.second.ctx, messageId, 1), ["UPDATE outbound_channels SET status = 'stopped', stopped_reason = 'channel_stopped', stopped_at = now(), generation = generation + 1 WHERE id = $1", [g.channel.id]]);
  expect(begun).toEqual({ kind: 'refused', reasonCodes: ['channel_stopped'] });
  expect((await g.messageOf(messageId)).status).not.toBe('sending');
  expect((await pg.db.select().from(schema.outboundAttempts))[0]!.status).not.toBe('sending');
  expect(reservedAt(await g.usage())).toEqual([0, 0]);
});

it('a refusal that commits first wins over a dispatch that waited for it, and gives its place back', { timeout: 120000 }, async () => {
  const pg = await privatePostgres();
  const g = await gateway(pg);
  const contact = await g.someone('no@shop.example');
  const { messageId } = await g.send(g.first, contact.id);
  expect((await reserveDispatch(g.first.ctx, messageId, 1)).kind).toBe('reserved');
  const begun = await holding(pg, rowHeld('outbound_contacts', contact.id), () => beginDispatch(g.second.ctx, messageId, 1), ['UPDATE outbound_contacts SET do_not_contact = true, suppressed_at = now() WHERE id = $1', [contact.id]]);
  expect(begun).toEqual({ kind: 'refused', reasonCodes: ['contact_suppressed'] });
  expect((await g.messageOf(messageId)).status).toBe('cancelled');
  expect(reservedAt(await g.usage())).toEqual([0, 0]);
});

/* The real paths at once, with no lock of the test's: either order is fine, a deadlock or a half of each is not. */
it('runs unsubscribes and dispatches at once with no deadlock, each message wholly one way or the other', { timeout: 180000 }, async () => {
  const pg = await privatePostgres();
  const g = await gateway(pg, LIMITED(100, 100));
  const pairs = [];
  for (let i = 0; i < 12; i++) {
    const contact = await g.someone(`race${i}@shop.example`);
    const { messageId } = await g.send(g.first, contact.id);
    expect((await reserveDispatch(g.first.ctx, messageId, 1)).kind).toBe('reserved');
    pairs.push({ contact, messageId, token: unsubscribeToken(g.first.ctx.config.secret, { companyId: g.companyId, contactId: contact.id, channelId: g.channel.id, purpose: 'first_contact' }) });
  }
  const outcomes = await Promise.all(pairs.map(async (p, i) => {
    const [one, other] = i % 2 ? [g.first, g.second] : [g.second, g.first];
    const [begun, stopped] = await Promise.all([beginDispatch(one.ctx, p.messageId, 1), unsubscribe(other.ctx, p.token)]);
    return { begun, stopped };
  }));
  expect(outcomes.every(o => o.stopped === true)).toBe(true);
  for (const [i, o] of outcomes.entries()) {
    const message = await g.messageOf(pairs[i]!.messageId);
    const [attempt] = await pg.db.select().from(schema.outboundAttempts).where(eq(schema.outboundAttempts.messageId, message.id));
    if (o.begun.kind === 'begun') {
      expect(message.status).toBe('sending');
      expect(attempt!.status).toBe('sending');
    } else {
      expect(message.status).toBe('cancelled');
      expect(attempt!.status).toBe('definitely_not_accepted');
    }
  }
  const going = outcomes.filter(o => o.begun.kind === 'begun').length;
  const sending = await pg.db.select().from(schema.outboundAttempts).where(eq(schema.outboundAttempts.status, 'sending'));
  expect(sending).toHaveLength(going);
  expect(reservedAt(await g.usage())).toEqual([going, going]);
});

it('takes a stop and a burst of dispatches at once with no deadlock, and nothing starts after the stop', { timeout: 180000 }, async () => {
  const pg = await privatePostgres();
  const g = await gateway(pg, LIMITED(100, 100));
  const messages = [];
  for (let i = 0; i < 10; i++) {
    const { messageId } = await g.send(g.first, (await g.someone(`burst${i}@shop.example`)).id);
    expect((await reserveDispatch(g.first.ctx, messageId, 1)).kind).toBe('reserved');
    messages.push(messageId);
  }
  const begins = messages.map((id, i) => beginDispatch((i % 2 ? g.first : g.second).ctx, id, 1));
  const stopped = await stopByPerson(g.second.ctx, g.channel.id);
  const outcomes = await Promise.all(begins);
  expect(stopped.status).toBe('stopped');
  expect(outcomes.every(o => o.kind === 'begun' || (o.kind === 'refused' && o.reasonCodes.includes('channel_stopped')))).toBe(true);
  for (const id of messages) expect((await beginDispatch(g.first.ctx, id, 1)).kind).not.toBe('begun');
});

const activeBindings = (pg: PostgresFixture) => pg.db.select().from(schema.outboundBindings).where(eq(schema.outboundBindings.status, 'active'));
const SMTP = { host: 'smtp.acme.example', port: 465, security: 'tls', username: 'sender@acme.example', password: 'synthetic-transport-secret-5f3c', from: 'sender@acme.example' };

it('lets an author take one account, whichever two ask for it at once', { timeout: 120000 }, async () => {
  const pg = await privatePostgres();
  const g = await gateway(pg);
  const author = g.first.job.agentId;
  await releaseAccount(g.first.ctx, g.one.account);
  const [spare] = await pg.db.insert(schema.outboundAccounts).values({ companyId: g.companyId, departmentId: g.channel.departmentId, channelId: g.channel.id, senderDomain: 'acme.example', label: 'Spare', configEnc: encryptSecret('{}', g.first.ctx.config.secret), createdBy: g.c.ids.ceo }).returning();
  const asked = await Promise.allSettled([bindAccount(g.first.ctx, g.one.account, { agentId: author, createdBy: g.c.ids.ceo }), bindAccount(g.second.ctx, spare!, { agentId: author, createdBy: g.c.ids.ceo })]);
  expect(asked.map(a => a.status).sort()).toEqual(['fulfilled', 'rejected']);
  const refused = asked.find(a => a.status === 'rejected') as PromiseRejectedResult;
  expect(refused.reason).toMatchObject({ status: 409, details: { reasonCodes: ['account_bound_elsewhere'] } });
  expect((await activeBindings(pg)).filter(b => b.agentId === author)).toHaveLength(1);
});

it('gives an account one author at a time, each at its own generation, whichever two ask at once', { timeout: 120000 }, async () => {
  const pg = await privatePostgres();
  const g = await gateway(pg);
  await releaseAccount(g.first.ctx, g.one.account);
  await releaseAccount(g.second.ctx, g.two.account);
  await Promise.all([bindAccount(g.first.ctx, g.one.account, { agentId: g.first.job.agentId, createdBy: g.c.ids.ceo }), bindAccount(g.second.ctx, g.one.account, { agentId: g.second.job.agentId, createdBy: g.c.ids.ceo })]);
  expect((await activeBindings(pg)).filter(b => b.accountId === g.one.account.id)).toHaveLength(1);
  const generations = (await pg.db.select().from(schema.outboundBindings).where(eq(schema.outboundBindings.accountId, g.one.account.id))).map(b => b.generation).sort();
  expect(generations).toEqual([1, 2, 3]);
});

it('never lets an account change hands under a reservation made at the same moment', { timeout: 120000 }, async () => {
  const pg = await privatePostgres();
  const g = await gateway(pg);
  const contact = await g.someone('ann@shop.example');
  const { messageId } = await g.send(g.first, contact.id);
  await releaseAccount(g.second.ctx, g.two.account);
  const [reserved, bound] = await Promise.allSettled([reserveDispatch(g.first.ctx, messageId, 1), bindAccount(g.second.ctx, g.one.account, { agentId: g.second.job.agentId, createdBy: g.c.ids.ceo })]);
  const attempts = await pg.db.select().from(schema.outboundAttempts);
  if (bound.status === 'fulfilled') {
    expect(attempts).toEqual([]);
    expect(reserved).toMatchObject({ status: 'fulfilled', value: { kind: 'refused', reasonCodes: ['stale_binding'] } });
  } else {
    expect(attempts).toHaveLength(1);
    expect(bound.reason).toMatchObject({ status: 409, details: { reasonCodes: ['delivery_unknown'] } });
  }
});

it('sends once when two servers run their round at the same moment', { timeout: 120000 }, async () => {
  const pg = await privatePostgres();
  const g = await gateway(pg);
  await pg.db.update(schema.outboundAccounts).set({ configEnc: encryptSecret(JSON.stringify(SMTP), g.first.ctx.config.secret) }).where(eq(schema.outboundAccounts.id, g.one.account.id));
  const contact = await g.someone('ann@shop.example');
  const { messageId } = await g.send(g.first, contact.id);
  const sent: string[] = [];
  const senders: Senders = {
    smtp: {
      send: async ({ attemptId }) => {
        sent.push(attemptId);
        return { kind: 'accepted', providerReceipt: '250 ok', acceptedAt: new Date().toISOString() };
      },
      reconcile: async () => ({ kind: 'pending' }),
    },
    webhook: { send: async () => ({ kind: 'unknown', safeCode: 'timeout' }), reconcile: async () => ({ kind: 'pending' }) },
    deadlineMs: 5000,
  };
  await Promise.all([dispatchDue(g.first.ctx, new Date(), senders), dispatchDue(g.second.ctx, new Date(), senders)]);
  expect(sent).toHaveLength(1);
  expect(await g.messageOf(messageId)).toMatchObject({ status: 'sent' });
});
