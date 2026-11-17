import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { decryptSecret } from '../src/crypto/secrets.js';
import { agents, outboundAccounts, outboundAttempts, outboundBindings, outboundDailyUsage } from '../src/db/schema.js';
import { beginDispatch, reserveDispatch, settleAttempt } from '../src/modules/outbound/core.js';
import { as } from './helpers.js';
import { PASSWORD } from './outbound-receivers.js';
import { aChannelOf, aPolicyOf, dispatched, world, type World } from './outbound-world.js';

/* The sending accounts as their owner meets them: over the protected routes, with a synthetic secret that must never come back. */
const SMTP = { host: 'smtp.acme.example', port: 465, security: 'tls', username: 'sender@acme.example', password: PASSWORD, from: 'Sender@Acme.Example' };
const HOOK = { endpoint: 'https://Hook.Acme.Example/in', signingKey: `${PASSWORD}-signing-0123456789abcdef` };

type Answer = { statusCode: number; body: string; json(): { error?: { reason?: string; details?: { reasonCodes?: string[] } } } & Record<string, unknown> };
const post = (w: World, url: string, payload: object, token = w.c.ceoToken): Promise<Answer> => w.c.app.inject({ method: 'POST', url, payload, ...as(token) });
const setup = (w: World, channelId: string, config: object = SMTP, label = 'Sales', token = w.c.ceoToken) => post(w, '/api/outbound/accounts', { channelId, label, config }, token);
const bind = (w: World, accountId: string, agentId: string, token = w.c.ceoToken) => post(w, `/api/outbound/accounts/${accountId}/bind`, { agentId }, token);
const rotate = (w: World, accountId: string, config: object = SMTP) => post(w, `/api/outbound/accounts/${accountId}/rotate`, { config });
const release = (w: World, accountId: string) => post(w, `/api/outbound/accounts/${accountId}/release`, {});
const revoke = (w: World, accountId: string) => post(w, `/api/outbound/accounts/${accountId}/revoke`, {});
const settle = (w: World, attemptId: string, outcome: string, token = w.c.ceoToken) => post(w, `/api/outbound/attempts/${attemptId}/settle`, { outcome, evidence: 'I looked in the sent folder.' }, token);
const accountsOf = (w: World, channelId: string, token = w.c.ceoToken): Promise<Answer> => w.c.app.inject({ method: 'GET', url: `/api/outbound/channels/${channelId}/accounts`, ...as(token) });
const rowOf = async (w: World, id: string) => (await w.c.db.select().from(outboundAccounts).where(eq(outboundAccounts.id, id)))[0]!;
const bindingsOf = (w: World, accountId: string) => w.c.db.select().from(outboundBindings).where(eq(outboundBindings.accountId, accountId)).orderBy(outboundBindings.generation);
const attemptOf = async (w: World, id: string) => (await w.c.db.select().from(outboundAttempts).where(eq(outboundAttempts.id, id)))[0]!;
const reasonCodes = (answer: Answer) => answer.json().error?.details?.reasonCodes;

const aWebhookChannel = (w: World) => aChannelOf(w.c, { name: 'Hook', adapter: 'webhook' });

/* A second way out of the department with an account of its own, bound to nobody. */
async function aFreeAccount(w: World, label = 'Second') {
  const channel = await aChannelOf(w.c, { name: label });
  await aPolicyOf(w.c, channel.id);
  const made = await setup(w, channel.id, SMTP, label);
  return { channel, accountId: made.json()['accountId'] as string };
}

describe('setting an account up', () => {
  it('keeps what it is given sealed and gives back only its name and state', async () => {
    const w = await world();
    const made = await setup(w, w.channel.id);
    expect(made.statusCode).toBe(200);
    expect(made.json()).toEqual({ accountId: expect.any(String), channelId: w.channel.id, label: 'Sales', senderDomain: 'acme.example', status: 'active', configGeneration: 1, binding: null });
    expect(made.body).not.toContain(PASSWORD);
    const row = await rowOf(w, made.json()['accountId'] as string);
    expect(row.configEnc).not.toContain(PASSWORD);
    expect(JSON.parse(decryptSecret(row.configEnc, w.ctx.config.secret))).toEqual({ ...SMTP, from: 'Sender@Acme.Example' });
  });

  it('reads the sender domain from where the channel really sends from, not from anything said about it', async () => {
    const w = await world();
    const channel = await aWebhookChannel(w);
    const made = await setup(w, channel.id, HOOK, 'Hook');
    expect(made.statusCode).toBe(200);
    expect(made.json()['senderDomain']).toBe('hook.acme.example');
    expect((await setup(w, w.channel.id, { ...SMTP, senderDomain: 'other.example' })).statusCode).toBe(400);
  });

  it('lists its accounts to who may run them, with no setting in the list', async () => {
    const w = await world();
    await setup(w, w.channel.id);
    const list = await accountsOf(w, w.channel.id);
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(PASSWORD);
    expect(list.body).not.toContain('smtp.acme.example');
    expect(list.body).not.toContain('configEnc');
    expect(list.json()['accounts']).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Sales', status: 'active', binding: null }), expect.objectContaining({ accountId: w.account.id, binding: { agentId: w.c.worker.id, generation: 1 } })]));
    expect((await accountsOf(w, w.channel.id, w.c.samToken)).statusCode).toBe(403);
  });

  it.each([
    ['a proxy', { ...SMTP, proxy: 'http://proxy.example' }],
    ['headers of its own', { ...SMTP, headers: { bcc: 'a@b.example' } }],
    ['no password', { ...SMTP, password: undefined }],
    ['a port that is none', { ...SMTP, port: 70000 }],
    ['a security nobody offers', { ...SMTP, security: 'none' }],
    ['two addresses in one', { ...SMTP, from: 'a@b.example, c@d.example' }],
    ['the settings of the other kind of channel', HOOK],
  ])('refuses %s, and does not repeat what it was given', async (_name, config) => {
    const w = await world();
    const refused = await setup(w, w.channel.id, config);
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error?.reason).toBe('outbound_invalid');
    expect(refused.body).not.toContain(PASSWORD);
    expect(await w.c.db.select().from(outboundAccounts).where(eq(outboundAccounts.label, 'Sales'))).toEqual([]);
  });

  it.each([
    ['plain http', { ...HOOK, endpoint: 'http://hook.acme.example/in' }],
    ['a password in the address', { ...HOOK, endpoint: 'https://a:b@hook.acme.example/in' }],
    ['a short key', { ...HOOK, signingKey: 'short' }],
    ['a redirect it may follow', { ...HOOK, followRedirects: true }],
  ])('refuses a webhook with %s', async (_name, config) => {
    const w = await world();
    const channel = await aWebhookChannel(w);
    expect((await setup(w, channel.id, config, 'Hook')).statusCode).toBe(400);
  });

  it('takes one account of a name per channel', async () => {
    const w = await world();
    await setup(w, w.channel.id);
    const again = await setup(w, w.channel.id);
    expect(again.statusCode).toBe(409);
    expect(again.json().error?.reason).toBe('outbound_conflict');
  });

  it('answers only the department\'s owner, the CEO or their delegate', async () => {
    const w = await world();
    expect((await setup(w, w.channel.id, SMTP, 'Sales', w.c.samToken)).statusCode).toBe(403);
    expect((await w.c.app.inject({ method: 'POST', url: '/api/outbound/accounts', payload: { channelId: w.channel.id, label: 'Sales', config: SMTP } })).statusCode).toBe(401);
    expect((await setup(w, randomUUID())).statusCode).toBe(404);
  });

  it.each([
    ['setting up', '/api/outbound/accounts', (w: World) => ({ channelId: w.channel.id, label: 'Sales', config: SMTP }), 200],
    ['rotating', (w: World) => `/api/outbound/accounts/${w.account.id}/rotate`, () => ({ config: SMTP }), 200],
    ['settling', () => `/api/outbound/attempts/${randomUUID()}/settle`, () => ({ outcome: 'accepted', evidence: 'It left.' }), 404],
  ])('takes %s with settings from the orchestrator acting for the CEO, as from the CEO', async (_name, url, payload, status) => {
    const w = await world();
    const target = typeof url === 'string' ? url : url(w);
    const taken = await w.c.app.inject({ method: 'POST', url: target, payload: payload(w), headers: orchestratorHeaders(w.c.ids.ceo, w.c.orchestrator.id) });
    expect(taken.statusCode, taken.body).toBe(status);
  });

  it('sets one up with the settings of another account, from the orchestrator too, with its own address and no setting in the answer', async () => {
    const w = await world();
    const settingsOf = async (id: string) => JSON.parse(decryptSecret((await rowOf(w, id)).configEnc, w.ctx.config.secret)) as Record<string, unknown>;
    const asOrchestrator = (payload: object) => w.c.app.inject({ method: 'POST', url: '/api/outbound/accounts', payload, headers: orchestratorHeaders(w.c.ids.ceo, w.c.orchestrator.id) });
    const { channel, accountId: hello } = await aFreeAccount(w);
    const made = await asOrchestrator({ channelId: channel.id, label: 'Kate', sameAs: hello, from: 'kate@acme.example' });
    expect(made.statusCode, made.body).toBe(200);
    expect(made.json()).toMatchObject({ label: 'Kate', senderDomain: 'acme.example', binding: null });
    expect(made.body).not.toContain(PASSWORD);
    expect(await settingsOf(made.json()['accountId'] as string)).toEqual({ ...SMTP, from: 'kate@acme.example' });
    expect((await asOrchestrator({ channelId: channel.id, label: 'Both', sameAs: hello, config: SMTP })).statusCode).toBe(400);
    expect((await asOrchestrator({ channelId: (await aWebhookChannel(w)).id, label: 'Hook', sameAs: hello })).statusCode).toBe(400);
    expect((await post(w, '/api/outbound/accounts', { channelId: channel.id, label: 'Sam', sameAs: hello }, w.c.samToken)).statusCode).toBe(403);
  });

  it('takes who writes from an account from the orchestrator', async () => {
    const w = await world();
    const { accountId } = await aFreeAccount(w);
    const bound = await w.c.app.inject({ method: 'POST', url: `/api/outbound/accounts/${accountId}/bind`, payload: { agentId: w.c.head.id }, headers: orchestratorHeaders(w.c.ids.ceo, w.c.orchestrator.id) });
    expect(bound.statusCode, bound.body).toBe(200);
    expect(await bindingsOf(w, accountId)).toHaveLength(1);
  });
});

describe('who writes from an account', () => {
  it('is one author, and an author has one account', async () => {
    const w = await world();
    const { accountId } = await aFreeAccount(w);
    const taken = await bind(w, accountId, w.c.worker.id);
    expect(taken.statusCode).toBe(409);
    expect(reasonCodes(taken)).toEqual(['account_bound_elsewhere']);
    expect(await bindingsOf(w, accountId)).toEqual([]);
    const bound = await bind(w, accountId, w.c.head.id);
    expect(bound.statusCode).toBe(200);
    expect(bound.json()['binding']).toEqual({ agentId: w.c.head.id, generation: 1 });
  });

  it('passes on with a new generation, and what the last author queued does not move with it', async () => {
    const w = await world();
    const queued = await w.submit();
    const moved = await bind(w, w.account.id, w.c.head.id);
    expect(moved.statusCode).toBe(200);
    expect(moved.json()['binding']).toEqual({ agentId: w.c.head.id, generation: 2 });
    expect(await bindingsOf(w, w.account.id)).toMatchObject([{ agentId: w.c.worker.id, generation: 1, status: 'released' }, { agentId: w.c.head.id, generation: 2, status: 'active' }]);
    expect(await reserveDispatch(w.ctx, queued.messageId, 1)).toEqual({ kind: 'refused', reasonCodes: ['stale_binding'] });
    expect(await w.messageOf(queued.messageId)).toMatchObject({ status: 'cancelled', authorAgentId: w.c.worker.id });
  });

  it('stays as it is when asked for the author it already has', async () => {
    const w = await world();
    const same = await bind(w, w.account.id, w.c.worker.id);
    expect(same.statusCode).toBe(200);
    expect(same.json()['binding']).toEqual({ agentId: w.c.worker.id, generation: 1 });
    expect(await bindingsOf(w, w.account.id)).toHaveLength(1);
  });

  it.each(['reserved', 'sending', 'unknown'] as const)('does not change hands or end while an attempt is %s', async state => {
    const w = await world();
    const { messageId } = await w.submit();
    const reserved = await reserveDispatch(w.ctx, messageId, 1);
    if (reserved.kind !== 'reserved') throw new Error('It was not reserved.');
    if (state !== 'reserved') await beginDispatch(w.ctx, messageId, 1);
    if (state === 'unknown') await settleAttempt(w.ctx, reserved.attemptId, { kind: 'unknown', safeCode: 'timeout' });
    for (const refused of [await bind(w, w.account.id, w.c.head.id), await release(w, w.account.id)]) {
      expect(refused.statusCode).toBe(409);
      expect(reasonCodes(refused)).toEqual(['delivery_unknown']);
    }
    expect(await bindingsOf(w, w.account.id)).toMatchObject([{ agentId: w.c.worker.id, status: 'active' }]);
  });

  it('ends only by a person, after which it can be taken again at a higher generation', async () => {
    const w = await world();
    const ended = await release(w, w.account.id);
    expect(ended.statusCode).toBe(200);
    expect(ended.json()['binding']).toBeNull();
    const refused = await w.submit().then(() => null, (err: { details?: { reasonCodes?: string[] } }) => err);
    expect(refused?.details?.reasonCodes).toEqual(['stale_binding']);
    const again = await bind(w, w.account.id, w.c.worker.id);
    expect(again.json()['binding']).toEqual({ agentId: w.c.worker.id, generation: 2 });
  });

  it('takes only an author of the account\'s department who is still here', async () => {
    const w = await world();
    const { accountId } = await aFreeAccount(w);
    expect((await bind(w, accountId, w.c.seller.id)).statusCode).toBe(404);
    expect((await bind(w, accountId, randomUUID())).statusCode).toBe(404);
    await w.c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, w.c.head.id));
    expect((await bind(w, accountId, w.c.head.id)).statusCode).toBe(404);
    expect(await bindingsOf(w, accountId)).toEqual([]);
  });

  it('answers only who may run the account', async () => {
    const w = await world();
    expect((await bind(w, w.account.id, w.c.head.id, w.c.samToken)).statusCode).toBe(403);
    expect((await bind(w, randomUUID(), w.c.head.id)).statusCode).toBe(404);
    expect(await bindingsOf(w, w.account.id)).toHaveLength(1);
  });
});

describe('changing an account\'s settings', () => {
  it('raises its generation, opens an invalid one again and returns no setting', async () => {
    const w = await world();
    await w.c.db.update(outboundAccounts).set({ status: 'invalid' }).where(eq(outboundAccounts.id, w.account.id));
    const rotated = await rotate(w, w.account.id, { ...SMTP, password: `${PASSWORD}-next` });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json()).toMatchObject({ accountId: w.account.id, status: 'active', configGeneration: 2 });
    expect(rotated.body).not.toContain(PASSWORD);
    const row = await rowOf(w, w.account.id);
    expect(JSON.parse(decryptSecret(row.configEnc, w.ctx.config.secret))).toMatchObject({ password: `${PASSWORD}-next` });
  });

  it('keeps its sender domain, which its counts go by', async () => {
    const w = await world();
    const moved = await rotate(w, w.account.id, { ...SMTP, from: 'sender@other.example', username: 'sender@other.example' });
    expect(moved.statusCode).toBe(400);
    expect((await rowOf(w, w.account.id)).configGeneration).toBe(1);
  });

  it('ends what was reserved under the old settings and gives its place back, and the next one goes by the new', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    await reserveDispatch(w.ctx, messageId, 1);
    await rotate(w, w.account.id);
    expect(await beginDispatch(w.ctx, messageId, 1)).toEqual({ kind: 'refused', reasonCodes: ['stale_binding'] });
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'cancelled' });
    const usage = await w.c.db.select().from(outboundDailyUsage).where(and(eq(outboundDailyUsage.scope, 'account'), eq(outboundDailyUsage.scopeKey, w.account.id)));
    expect(usage[0]).toMatchObject({ reserved: 0 });
    const next = await w.submit();
    expect(await dispatched(w, next.messageId)).toMatchObject({ kind: 'begun', configGeneration: 2 });
  });

  it('leaves what is on its way as it is: only reconciling or a person settles it', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    const begun = await dispatched(w, messageId);
    if (begun.kind !== 'begun') throw new Error('It did not begin.');
    expect((await rotate(w, w.account.id)).statusCode).toBe(200);
    expect(await attemptOf(w, begun.attemptId)).toMatchObject({ status: 'sending', configGeneration: 1 });
  });

  it('after a revocation takes nothing new, ends what waits and cannot be opened again', async () => {
    const w = await world();
    const queued = await w.submit();
    const revoked = await revoke(w, w.account.id);
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ status: 'revoked', configGeneration: 2 });
    expect(JSON.parse(decryptSecret((await rowOf(w, w.account.id)).configEnc, w.ctx.config.secret))).toEqual({});
    await expect(w.submit()).rejects.toMatchObject({ status: 503 });
    expect(await reserveDispatch(w.ctx, queued.messageId, 1)).toEqual({ kind: 'refused', reasonCodes: ['stale_binding'] });
    const reopened = await rotate(w, w.account.id);
    expect(reopened.statusCode).toBe(409);
    expect(reopened.json().error?.reason).toBe('outbound_conflict');
  });

  it('answers only who may run the account', async () => {
    const w = await world();
    const token = w.c.samToken;
    expect((await w.c.app.inject({ method: 'POST', url: `/api/outbound/accounts/${w.account.id}/rotate`, payload: { config: SMTP }, ...as(token) })).statusCode).toBe(403);
    expect((await w.c.app.inject({ method: 'POST', url: `/api/outbound/accounts/${w.account.id}/revoke`, payload: {}, ...as(token) })).statusCode).toBe(403);
    expect((await w.c.app.inject({ method: 'POST', url: `/api/outbound/accounts/${w.account.id}/release`, payload: {}, ...as(token) })).statusCode).toBe(403);
    expect((await rowOf(w, w.account.id)).configGeneration).toBe(1);
  });
});

describe('a person settling an attempt nobody can', () => {
  const unknownAttempt = async (w: World) => {
    const { messageId } = await w.submit();
    const begun = await dispatched(w, messageId);
    if (begun.kind !== 'begun') throw new Error('It did not begin.');
    await settleAttempt(w.ctx, begun.attemptId, { kind: 'unknown', safeCode: 'timeout' });
    return { messageId, attemptId: begun.attemptId };
  };

  it('counts it as sent, keeping how they know as a digest only', async () => {
    const w = await world();
    const { messageId, attemptId } = await unknownAttempt(w);
    const said = await settle(w, attemptId, 'accepted');
    expect(said.statusCode).toBe(200);
    expect(said.json()).toEqual({ attemptId, status: 'accepted' });
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'sent' });
    const attempt = await attemptOf(w, attemptId);
    expect(attempt.providerReceipt).toMatch(/^person:[0-9a-f]{64}$/);
  });

  it('counts it as never left, which gives its place back and opens the account', async () => {
    const w = await world();
    const { messageId, attemptId } = await unknownAttempt(w);
    expect((await settle(w, attemptId, 'definitely_not_accepted')).statusCode).toBe(200);
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'definitely_failed' });
    expect(await attemptOf(w, attemptId)).toMatchObject({ status: 'definitely_not_accepted', safeCode: 'person_confirmed' });
    expect((await bind(w, w.account.id, w.c.head.id)).statusCode).toBe(200);
  });

  it('is only for what is unknown: not what is still on its way, not what is settled', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    const begun = await dispatched(w, messageId);
    if (begun.kind !== 'begun') throw new Error('It did not begin.');
    const live = await settle(w, begun.attemptId, 'definitely_not_accepted');
    expect(live.statusCode).toBe(409);
    expect((await attemptOf(w, begun.attemptId)).status).toBe('sending');
    await settleAttempt(w.ctx, begun.attemptId, { kind: 'accepted', providerReceipt: 'r', acceptedAt: new Date().toISOString() });
    expect((await settle(w, begun.attemptId, 'definitely_not_accepted')).statusCode).toBe(409);
  });

  it('answers only who may run the account, and knows only its own company\'s attempts', async () => {
    const w = await world();
    const { attemptId } = await unknownAttempt(w);
    expect((await settle(w, attemptId, 'accepted', w.c.samToken)).statusCode).toBe(403);
    expect((await settle(w, randomUUID(), 'accepted')).statusCode).toBe(404);
    expect((await post(w, `/api/outbound/attempts/${attemptId}/settle`, { outcome: 'unknown', evidence: 'x' })).statusCode).toBe(400);
    expect((await attemptOf(w, attemptId)).status).toBe('unknown');
  });
});
