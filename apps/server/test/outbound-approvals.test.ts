import { randomUUID } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { modelChecks, outboundAccounts, outboundApprovals, outboundBindings, outboundChannels, requests, tasks } from '../src/db/schema.js';
import { approvalNeed, authorityFingerprint } from '../src/modules/outbound/approvals.js';
import { recordReview, reserveDispatch } from '../src/modules/outbound/core.js';
import { ask } from '../src/modules/tasks/engine.js';
import { as } from './helpers.js';
import { binding as checkBinding } from './model-check-fixture.js';
import { sha } from './outbound-fixture.js';
import { aPolicyOf, dispatched, published, QUIET, world, type World } from './outbound-world.js';

const NOON = new Date('2026-11-06T12:00:00.000Z');
const APPROVAL_REQUIRED = { kind: 'refused', reasonCodes: ['approval_required'] };
const answerAs = (w: World, token: string, id: string, approve: boolean) => w.c.app.inject({ method: 'POST', url: `/api/requests/${id}`, payload: { approve }, ...as(token) });
const openRequests = (w: World) => w.c.db.select().from(requests).where(eq(requests.status, 'open'));
const bindingsOf = (w: World) => w.c.db.select().from(outboundApprovals);
const statusOf = async (w: World, id: string) => (await w.messageOf(id)).status;
const requestOf = async (w: World) => (await openRequests(w))[0]!;

/* A department that asks each time, as every department does until its owner says otherwise. */
async function everyWorld() {
  const w = await world();
  await w.c.setRule(w.c.ceoToken, w.c.dev.id, 'message', { mode: 'every' });
  return w;
}
async function newKindsWorld() {
  const w = await world();
  await w.c.setRule(w.c.ceoToken, w.c.dev.id, 'message', { mode: 'new_kinds' });
  await w.c.setRule(w.c.ceoToken, w.c.dev.id, 'price', { mode: 'new_kinds' });
  return w;
}
/* A message under "every" that the CEO approved. */
async function approved(w: World) {
  const { messageId } = await w.submit();
  const request = await requestOf(w);
  expect((await answerAs(w, w.c.ceoToken, request.id, true)).statusCode).toBe(200);
  return { messageId, request };
}

describe('what a person must approve', () => {
  const work = { audience: 'direct', money: [{ minor: 1000n, currency: 'USD', scale: 2 }], escalated: false, hasSegment: true } as const;
  const every = { mode: 'every' } as const;
  const newKinds = { mode: 'new_kinds' } as const;
  const within = (limit: number, unit?: string) => ({ mode: 'within_limits', limit, ...(unit ? { unit } : {}) }) as const;

  it('every asks for this very message', () => {
    expect(approvalNeed({ sending: every, price: within(100, 'USD') }, work)).toBe('message');
    expect(approvalNeed({ sending: within(100, 'USD'), price: every }, work)).toBe('message');
  });
  it('a new kind asks once, for the approach', () => {
    expect(approvalNeed({ sending: newKinds, price: newKinds }, work)).toBe('approach');
    expect(approvalNeed({ sending: newKinds, price: within(100, 'USD') }, work)).toBe('approach');
  });
  it('a limit lets exact money go, up to and including it, in its own unit', () => {
    expect(approvalNeed({ sending: within(10, 'USD'), price: within(10, 'USD') }, work)).toBe('none');
    expect(approvalNeed({ sending: within(9.99, 'USD'), price: within(10, 'USD') }, work)).toBe('message');
    expect(approvalNeed({ sending: within(100, 'EUR'), price: within(100, 'USD') }, work)).toBe('message');
    expect(approvalNeed({ sending: within(100), price: within(100, 'USD') }, work)).toBe('message');
  });
  it('a message with no money is not within any limit, and the price channel has no say in it', () => {
    const none = { ...work, money: [] };
    expect(approvalNeed({ sending: within(100, 'USD'), price: within(100, 'USD') }, none)).toBe('message');
    expect(approvalNeed({ sending: newKinds, price: every }, none)).toBe('approach');
  });
  it('public, escalated, or with no approach to name: always this very message, whatever the rule', () => {
    const lenient = { sending: within(100, 'USD'), price: within(100, 'USD') };
    expect(approvalNeed(lenient, { ...work, audience: 'public' })).toBe('message');
    expect(approvalNeed(lenient, { ...work, escalated: true })).toBe('message');
    expect(approvalNeed({ sending: newKinds, price: newKinds }, { ...work, hasSegment: false })).toBe('message');
  });
});

describe('the authority behind an approval', () => {
  const parts = { companyId: randomUUID(), departmentId: randomUUID(), productId: null, decider: randomUUID(), channelGeneration: 1, accountId: randomUUID(), bindingGeneration: 1, configGeneration: 1 };

  it.each<[string, Partial<typeof parts>]>([
    ['another person decides', { decider: randomUUID() }],
    ['the channel stopped or reopened', { channelGeneration: 2 }],
    ['the account changed hands', { bindingGeneration: 2 }],
    ['the account\'s settings changed', { configGeneration: 2 }],
    ['it is another account', { accountId: randomUUID() }],
  ])('is another when %s', (_name, change) => {
    expect(authorityFingerprint({ ...parts, ...change })).not.toBe(authorityFingerprint(parts));
    expect(authorityFingerprint({ ...parts })).toBe(authorityFingerprint(parts));
  });
});

describe('an exact approval', () => {
  it('is asked for with its binding kept in the same step, and the task waits', async () => {
    const w = await everyWorld();
    const { messageId, status, reasonCodes, contentDigest } = await w.submit();
    expect({ status, reasonCodes }).toEqual({ status: 'waiting_approval', reasonCodes: ['approval_required'] });
    const request = await requestOf(w);
    expect(request).toMatchObject({ kind: 'approval', taskId: w.c.task.id, agentId: w.c.worker.id, approvalChannel: 'message', decisionTopic: 'task' });
    expect(await bindingsOf(w)).toMatchObject([{ requestId: request.id, kind: 'message', messageId, messageRevision: 1, contentDigest, accountId: w.account.id, bindingGeneration: 1, policyDigest: w.policy.digest }]);
    expect((await w.c.db.select().from(tasks).where(eq(tasks.id, w.c.task.id)))[0]!.status).toBe('waiting');
  });

  it('shows people the exact words, without the address and without the way to unsubscribe someone', async () => {
    const w = await everyWorld();
    await w.submit();
    const { text } = await requestOf(w);
    expect(text).toContain('Hello from One. $10.00 https://shop.example/pricing To stop these letters:');
    expect(text).not.toContain('ann@shop.example');
    expect(text).not.toContain('/unsubscribe/');
  });

  it('holds the message until a person approves, and then lets it go', async () => {
    const w = await everyWorld();
    const { messageId } = await w.submit();
    expect(await dispatched(w, messageId, NOON)).toEqual(APPROVAL_REQUIRED);
    expect(await statusOf(w, messageId)).toBe('waiting_approval');
    expect(await openRequests(w)).toHaveLength(1);
    expect((await answerAs(w, w.c.ceoToken, (await requestOf(w)).id, true)).statusCode).toBe(200);
    expect((await dispatched(w, messageId, NOON)).kind).toBe('begun');
  });

  it('a decline ends the message for good', async () => {
    const w = await everyWorld();
    const { messageId } = await w.submit();
    expect((await answerAs(w, w.c.ceoToken, (await requestOf(w)).id, false)).statusCode).toBe(200);
    expect(await dispatched(w, messageId, NOON)).toEqual(APPROVAL_REQUIRED);
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'cancelled', reasonCodes: ['approval_required'] });
  });

  it('only its department\'s owner, the CEO or the delegate may give it', async () => {
    const w = await everyWorld();
    const { messageId } = await w.submit();
    const { id } = await requestOf(w);
    for (const token of [w.c.samToken, w.c.danaToken, w.c.wholeToken]) expect((await answerAs(w, token, id, true)).statusCode).toBe(403);
    expect(await dispatched(w, messageId, NOON)).toEqual(APPROVAL_REQUIRED);
  });

  it('a named owner gives it', async () => {
    const w = await everyWorld();
    await w.c.setOwner(w.c.ceoToken, w.c.dev.id, w.c.ids.dana);
    const { messageId } = await w.submit();
    expect((await answerAs(w, w.c.danaToken, (await requestOf(w)).id, true)).statusCode).toBe(200);
    expect((await dispatched(w, messageId, NOON)).kind).toBe('begun');
  });

  it('an owner replaced afterwards voids it, and the new one is asked', async () => {
    const w = await everyWorld();
    await w.c.setOwner(w.c.ceoToken, w.c.dev.id, w.c.ids.dana);
    const { messageId } = await w.submit();
    const first = await requestOf(w);
    await answerAs(w, w.c.danaToken, first.id, true);
    await w.c.setOwner(w.c.ceoToken, w.c.dev.id, w.c.ids.wes);
    expect(await dispatched(w, messageId, NOON)).toEqual(APPROVAL_REQUIRED);
    const asked = await requestOf(w);
    expect(asked.id).not.toBe(first.id);
    expect(await bindingsOf(w)).toHaveLength(2);
    expect((await answerAs(w, w.c.danaToken, asked.id, true)).statusCode).toBe(403);
    expect((await answerAs(w, w.c.wholeToken, asked.id, true)).statusCode).toBe(200);
    expect((await dispatched(w, messageId, NOON)).kind).toBe('begun');
  });

  it('asks once while nobody has answered, however often the dispatcher looks', async () => {
    const w = await everyWorld();
    const { messageId } = await w.submit();
    await reserveDispatch(w.ctx, messageId, 1, NOON);
    await reserveDispatch(w.ctx, messageId, 1, NOON);
    expect(await openRequests(w)).toHaveLength(1);
  });

  it('cancels the message when nobody can be asked any more', async () => {
    const w = await everyWorld();
    await w.c.setOwner(w.c.ceoToken, w.c.dev.id, w.c.ids.dana);
    const { messageId } = await w.submit();
    await answerAs(w, w.c.danaToken, (await requestOf(w)).id, true);
    await w.c.setOwner(w.c.ceoToken, w.c.dev.id, w.c.ids.wes);
    await w.c.db.update(tasks).set({ assigneeAgentId: w.c.head.id }).where(eq(tasks.id, w.c.task.id));
    expect(await reserveDispatch(w.ctx, messageId, 1, NOON)).toEqual(APPROVAL_REQUIRED);
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'cancelled', reasonCodes: ['stale_binding'] });
  });
});

describe('what is no approval', () => {
  it('a plain approved request of the same kind', async () => {
    const w = await everyWorld();
    const { messageId } = await w.submit();
    const { kind, approvalChannel, approvalKind, text, taskId, agentId, companyId } = await requestOf(w);
    await w.c.db.insert(requests).values({ companyId, taskId, agentId, kind, approvalChannel, approvalKind, text, status: 'approved', answeredAt: new Date() });
    expect(await dispatched(w, messageId, NOON)).toEqual(APPROVAL_REQUIRED);
  });

  it('what request_approval got from a person', async () => {
    const w = await everyWorld();
    const { messageId } = await w.submit();
    const first = await requestOf(w);
    const tools: Client = await w.c.tools(w.c.worker);
    const said = await tools.callTool({ name: 'request_approval', arguments: { task: w.c.task.id, channel: 'message', kind: first.approvalKind!, text: 'Send it?' } });
    expect((said as { isError?: boolean }).isError).toBeFalsy();
    const plain = (await openRequests(w)).find(r => r.id !== first.id)!;
    await answerAs(w, w.c.ceoToken, plain.id, true);
    expect(await bindingsOf(w)).toHaveLength(1);
    expect(await dispatched(w, messageId, NOON)).toEqual(APPROVAL_REQUIRED);
  });

  it('request_approval has no way to name a binding', async () => {
    const w = await everyWorld();
    const tools: Client = await w.c.tools(w.c.worker);
    await tools.callTool({ name: 'request_approval', arguments: { task: w.c.task.id, channel: 'message', kind: 'welcome', text: 'Send it?', onCreated: 'x', binding: { messageId: randomUUID() } } });
    expect(await bindingsOf(w)).toEqual([]);
  });

  it('an approval of another message, though it reads the same', async () => {
    const w = await everyWorld();
    const { messageId } = await approved(w);
    const other = await w.submit();
    expect(other.messageId).not.toBe(messageId);
    expect(await dispatched(w, other.messageId, NOON)).toEqual(APPROVAL_REQUIRED);
  });

  it('an approved binding whose digest is not of these bytes', async () => {
    const w = await everyWorld();
    const { messageId } = await w.submit();
    const [made] = await bindingsOf(w);
    const request = await w.c.db.insert(requests).values({ companyId: w.c.companyId, taskId: w.c.task.id, agentId: w.c.worker.id, kind: 'approval', text: 'Forged', status: 'approved', answeredAt: new Date() }).returning();
    await w.c.db.insert(outboundApprovals).values({ ...made!, id: randomUUID(), requestId: request[0]!.id, contentDigest: sha('other bytes') });
    expect(await dispatched(w, messageId, NOON)).toEqual(APPROVAL_REQUIRED);
  });

  it('an approval that came before a new policy', async () => {
    const w = await everyWorld();
    const { messageId } = await approved(w);
    await aPolicyOf(w.c, w.channel.id, { ...QUIET, accountDailyLimit: 49 }, 2);
    expect(await dispatched(w, messageId, NOON)).toEqual(APPROVAL_REQUIRED);
  });

  it('an approval under older settings of the account', async () => {
    const w = await everyWorld();
    const { messageId } = await approved(w);
    await w.c.db.update(outboundAccounts).set({ configGeneration: 2 }).where(eq(outboundAccounts.id, w.account.id));
    expect(await dispatched(w, messageId, NOON)).toEqual(APPROVAL_REQUIRED);
  });

  it('an approval from before a stop and a reopening', async () => {
    const w = await everyWorld();
    const { messageId } = await approved(w);
    await w.c.db.update(outboundChannels).set({ generation: 3 }).where(eq(outboundChannels.id, w.channel.id));
    expect(await dispatched(w, messageId, NOON)).toEqual(APPROVAL_REQUIRED);
  });

  it('an approval, once the account went to another author: the message is gone', async () => {
    const w = await everyWorld();
    const { messageId } = await approved(w);
    await w.c.db.update(outboundBindings).set({ status: 'released', releasedAt: new Date() }).where(eq(outboundBindings.id, w.binding.id));
    await w.c.db.insert(outboundBindings).values({ companyId: w.c.companyId, accountId: w.account.id, agentId: w.c.head.id, generation: 2, createdBy: w.c.ids.ceo });
    expect(await dispatched(w, messageId, NOON)).toEqual({ kind: 'refused', reasonCodes: ['stale_binding'] });
    expect((await w.messageOf(messageId)).status).toBe('cancelled');
  });

  it.each<[string, (w: World) => Promise<unknown>]>([
    ['was cancelled', w => w.c.db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, w.c.task.id))],
    ['went to someone else', w => w.c.db.update(tasks).set({ executorAgentId: w.c.head.id, assigneeAgentId: w.c.head.id }).where(eq(tasks.id, w.c.task.id))],
  ])('an approval, once its task %s: the message is gone', async (_name, change) => {
    const w = await everyWorld();
    const { messageId } = await approved(w);
    await change(w);
    expect(await dispatched(w, messageId, NOON)).toEqual({ kind: 'refused', reasonCodes: ['stale_binding'] });
    expect((await w.messageOf(messageId)).status).toBe('cancelled');
  });

  it('an approval, once something the price rests on changed: the message is gone', async () => {
    const w = await everyWorld();
    const discount = await published(w.c, { kind: 'discount', off: { kind: 'percent', value: '10' } });
    const price = await published(w.c, { kind: 'price', amount: '10.00', currency: 'USD', scale: 2, rounding: 'half_up', discountId: discount.entryId, termsId: null, validFrom: '2026-01-01T00:00:00.000Z', validUntil: null });
    const blocks = w.document.blocks.map(b => (b.kind === 'price' ? { ...b, id: price.entryId } : b));
    const { messageId } = await w.submit({ document: { ...w.document, blocks } });
    await answerAs(w, w.c.ceoToken, (await requestOf(w)).id, true);
    await published(w.c, { kind: 'discount', off: { kind: 'percent', value: '50' } }, {}, discount.entryId, 2);
    expect(await dispatched(w, messageId, NOON)).toEqual({ kind: 'refused', reasonCodes: ['stale_binding'] });
    expect((await w.messageOf(messageId)).status).toBe('cancelled');
  });
});

describe('an approved approach', () => {
  it('is asked once for a template, segment and language, not for a kind in words', async () => {
    const w = await newKindsWorld();
    const first = await w.submit();
    expect(first).toMatchObject({ status: 'waiting_approval', reasonCodes: ['approval_required'] });
    expect(await bindingsOf(w)).toMatchObject([{ kind: 'approach', channelId: w.channel.id, templateId: w.template.entryId, templateRevision: 1, segmentId: w.segment.entryId, locale: 'en', messageId: null }]);
  });

  it('does not ask again while its answer is awaited', async () => {
    const w = await newKindsWorld();
    await w.submit();
    expect((await w.submit()).status).toBe('waiting_approval');
    expect(await openRequests(w)).toHaveLength(1);
  });

  it('lets the same approach go without a person once approved, the waiting one included', async () => {
    const w = await newKindsWorld();
    const first = await w.submit();
    await answerAs(w, w.c.ceoToken, (await requestOf(w)).id, true);
    expect(await w.submit()).toMatchObject({ status: 'scheduled', reasonCodes: [] });
    expect((await dispatched(w, first.messageId, NOON)).kind).toBe('begun');
    expect(await openRequests(w)).toEqual([]);
  });

  it('asks again for another segment', async () => {
    const w = await newKindsWorld();
    await w.submit();
    await answerAs(w, w.c.ceoToken, (await requestOf(w)).id, true);
    const other = await published(w.c, { kind: 'segment', name: 'Cafes' });
    expect((await w.submit({ segmentId: other.entryId })).status).toBe('waiting_approval');
  });

  it('asks again when anything it rests on has a new revision', async () => {
    const w = await newKindsWorld();
    await w.submit();
    await answerAs(w, w.c.ceoToken, (await requestOf(w)).id, true);
    await published(w.c, w.price.value, {}, w.price.entryId, 2);
    const blocks = w.document.blocks.map(b => (b.kind === 'price' ? { ...b, revision: 2 } : b));
    expect((await w.submit({ document: { ...w.document, blocks } })).status).toBe('waiting_approval');
  });

  it('asks again under a new policy', async () => {
    const w = await newKindsWorld();
    const first = await w.submit();
    await answerAs(w, w.c.ceoToken, (await requestOf(w)).id, true);
    await aPolicyOf(w.c, w.channel.id, { ...QUIET, accountDailyLimit: 49 }, 2);
    expect((await w.submit()).status).toBe('waiting_approval');
    expect(await dispatched(w, first.messageId, NOON)).toEqual(APPROVAL_REQUIRED);
  });

  it('a declined approach refuses what comes after', async () => {
    const w = await newKindsWorld();
    await w.submit();
    await answerAs(w, w.c.ceoToken, (await requestOf(w)).id, false);
    expect(await w.submit()).toMatchObject({ status: 'rejected', reasonCodes: ['approval_required'] });
  });

  it('is never enough for a public post', async () => {
    const w = await world(QUIET, { audience: 'public' });
    await w.c.setRule(w.c.ceoToken, w.c.dev.id, 'publication', { mode: 'new_kinds' });
    const audience = await published(w.c, { kind: 'audience', name: 'Blog', destination: 'https://blog.example/' });
    const template = await published(w.c, { kind: 'template', locale: 'en', subject: 'News', parts: [{ kind: 'text', text: 'News.' }] });
    const post = { target: { kind: 'audience', audienceId: audience.entryId }, document: { locale: 'en', templateId: template.entryId, templateRevision: 1, blocks: [], variables: [] } } as const;
    const { messageId } = await w.submit(post);
    expect(await bindingsOf(w)).toMatchObject([{ kind: 'message', messageId }]);
    expect((await requestOf(w)).approvalChannel).toBe('publication');
    await answerAs(w, w.c.ceoToken, (await requestOf(w)).id, true);
    expect((await w.submit(post)).status).toBe('waiting_approval');
  });
});

describe('a person after a review', () => {
  it('is asked when the check wants a person, whatever the rule says, and the answer lets it go', async () => {
    const w = await world({ ...QUIET, sampling: { ...QUIET.sampling, everyNth: 1 } });
    const bindingDigest = sha('this binding');
    const [check] = await w.c.db.insert(modelChecks).values({ companyId: w.c.companyId, departmentId: w.c.dev.id, kind: 'outbound_review', status: 'on', bindingDigest, validUntil: new Date('2036-01-01T00:00:00.000Z'), thresholds: {} as never, thresholdsBy: w.c.ids.ceo }).returning();
    const { messageId, contentDigest, status } = await w.submit();
    expect(status).toBe('waiting_checks');
    await recordReview(w.ctx, { messageId, revision: 1, checkId: check!.id, bindingDigest, subjectDigest: contentDigest, reviewer: checkBinding().model, result: { kind: 'review', decision: 'escalate', reasonCodes: [] } });
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'waiting_approval', reasonCodes: ['approval_required'] });
    await answerAs(w, w.c.ceoToken, (await requestOf(w)).id, true);
    expect((await dispatched(w, messageId, NOON)).kind).toBe('begun');
  });
});

describe('the hook on asking', () => {
  it('fails the whole request when its binding cannot be kept', async () => {
    const w = await world();
    const before = (await w.c.db.select().from(tasks).where(eq(tasks.id, w.c.task.id)))[0]!;
    await expect(ask(w.ctx, w.c.worker.id, w.c.task.id, { kind: 'approval', text: 'Send?', approval: { channel: 'message', kind: 'x', amount: null }, onCreated: async () => { throw new Error('No binding.'); } })).rejects.toThrow('No binding.');
    expect(await w.c.db.select().from(requests).where(and(eq(requests.taskId, w.c.task.id), eq(requests.kind, 'approval')))).toEqual([]);
    expect((await w.c.db.select().from(tasks).where(eq(tasks.id, w.c.task.id)))[0]).toMatchObject({ status: before.status, version: before.version });
  });

  it('hands over the request it made, inside the same step', async () => {
    const w = await world();
    let seen = '';
    const moved = await ask(w.ctx, w.c.worker.id, w.c.task.id, { kind: 'approval', text: 'Send?', approval: { channel: 'message', kind: 'x', amount: null }, onCreated: async (_tx, request) => { seen = request.id; } });
    expect(seen).toBe(moved.request.id);
  });
});
