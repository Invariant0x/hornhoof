import { randomUUID } from 'node:crypto';
import { SubmitResult } from '@hornhoof/protocol';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/crypto/secrets.js';
import { companies, agents, modelChecks, outboundAccounts, outboundAttempts, outboundBindings, outboundCatalogRevisions, outboundChannels, outboundContactEvents, outboundContacts, outboundDailyUsage, outboundMessageRevisions, outboundMessages, outboundPermissions, outboundSamplingCounters, tasks } from '../src/db/schema.js';
import { addContact, readUnsubscribeToken, recipientDigest, revokePermission, suppressContact, unsubscribe, unsubscribeToken } from '../src/modules/outbound/contacts.js';
import { beginDispatch, dueMessages, outboundStatus, recordReview, reserveDispatch, settleAttempt, submitOutbound, type Review } from '../src/modules/outbound/core.js';
import { dayOf, dayWindow, reopenChannel, selectedForReview, stopChannel, usedWithin } from '../src/modules/outbound/policies.js';
import { frozenDigest } from '../src/modules/outbound/render.js';
import { binding as checkBinding } from './model-check-fixture.js';
import { sha } from './outbound-fixture.js';
import { aChannelOf, aContactOf, anAccountOf, aPermissionOf, aPolicyOf, dispatched, partsOf, published, QUIET, world, type World } from './outbound-world.js';

const NOON = new Date('2026-11-06T12:00:00.000Z');
const refusal = async (work: Promise<unknown>) => (await work.then(() => { throw new Error('It was not refused.'); }, (err: unknown) => err)) as { status: number; details?: { reasonCodes?: string[] } };
const statusOf = async (work: Promise<unknown>) => (await refusal(work)).status;
const reasonsOf = async (work: Promise<unknown>) => (await refusal(work)).details?.reasonCodes;
const countMessages = async (w: World) => (await w.c.db.select().from(outboundMessages)).length;
const bucketsOf = (w: World) => w.c.db.select().from(outboundDailyUsage);
const attemptsOf = (w: World, messageId: string) => w.c.db.select().from(outboundAttempts).where(eq(outboundAttempts.messageId, messageId));
const withLimits = (accountDailyLimit: number, domainDailyLimit: number) => ({ ...QUIET, accountDailyLimit, domainDailyLimit });
const sampling = (over: Partial<typeof QUIET.sampling>) => ({ ...QUIET, sampling: { ...QUIET.sampling, ...over } });

describe('a message that may go', () => {
  it('is frozen to exact bytes and scheduled, with nothing of its contact in the result', async () => {
    const w = await world();
    const result = await w.submit();
    expect(SubmitResult.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ status: 'scheduled', revision: 1, reasonCodes: [] });
    expect(JSON.stringify(result)).not.toContain('ann@shop.example');

    const [revision] = await w.c.db.select().from(outboundMessageRevisions).where(eq(outboundMessageRevisions.messageId, result.messageId));
    const sealed = JSON.parse(decryptSecret(revision!.sealedEnc, w.ctx.config.secret));
    expect(sealed.recipient).toBe('ann@shop.example');
    expect(sealed.subject).toBe('Hello');
    expect(sealed.text).toMatch(/^Hello from One\. \$10\.00 https:\/\/shop\.example\/pricing To stop these letters: https:\/\/hornhoof\.example\/api\/outbound\/unsubscribe\/\S+$/);
    expect(revision!.contentDigest).toBe(result.contentDigest);
    expect(result.contentDigest).toBe(frozenDigest({
      subject: sealed.subject, text: sealed.text, recipientDigest: recipientDigest('ann@shop.example'), accountId: w.account.id, channelId: w.channel.id, purpose: 'first_contact', locale: 'en',
      segmentId: w.segment.entryId, scheduledAt: '2026-01-02T00:00:00.000Z', sourceRevisionsDigest: revision!.sourceRevisionsDigest, bindingGeneration: 1,
    }));
  });

  it('records who wrote it and for which task, from the server and not from its input', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    expect(await w.messageOf(messageId)).toMatchObject({ companyId: w.c.companyId, departmentId: w.c.dev.id, taskId: w.c.task.id, authorAgentId: w.c.worker.id, accountId: w.account.id, bindingGeneration: 1 });
  });

  it('says only the safe things when read back, and never moves it', async () => {
    const w = await world();
    const { messageId, contentDigest } = await w.submit();
    const view = await outboundStatus(w.ctx, w.authority, messageId);
    expect(view).toMatchObject({ messageId, status: 'scheduled', contentDigest, channelId: w.channel.id, accountId: w.account.id });
    expect(Object.keys(view).sort()).toEqual(['accountId', 'channelId', 'contentDigest', 'messageId', 'reasonCodes', 'revision', 'scheduledAt', 'status', 'updatedAt']);
    expect((await w.messageOf(messageId)).status).toBe('scheduled');
  });

  it('is not shown to someone else, or to another company', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    expect(await statusOf(outboundStatus(w.ctx, { ...w.authority, agentId: w.c.seller.id, departmentId: w.c.sales.id }, messageId))).toBe(404);
    expect(await statusOf(outboundStatus(w.ctx, { ...w.authority, companyId: randomUUID() }, messageId))).toBe(404);
    expect(await statusOf(outboundStatus(w.ctx, w.authority, randomUUID()))).toBe(404);
  });

  it('is read by its department\'s head and by the orchestrator too', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    expect((await outboundStatus(w.ctx, { ...w.authority, agentId: w.c.head.id }, messageId)).messageId).toBe(messageId);
    expect((await outboundStatus(w.ctx, { ...w.authority, agentId: w.c.orchestrator.id, departmentId: null }, messageId)).messageId).toBe(messageId);
    expect(await statusOf(outboundStatus(w.ctx, { ...w.authority, agentId: w.c.salesHead.id, departmentId: w.c.sales.id }, messageId))).toBe(404);
  });
});

describe('the same request again', () => {
  it('returns the same result and makes nothing new, by any name of its task', async () => {
    const w = await world();
    const key = randomUUID();
    const first = await w.submit({ idempotencyKey: key });
    expect(await w.submit({ idempotencyKey: key })).toEqual(first);
    expect(await w.submit({ idempotencyKey: key, task: w.c.task.number })).toEqual(first);
    expect(await w.submit({ idempotencyKey: key, task: `#${w.c.task.number}` })).toEqual(first);
    expect(await countMessages(w)).toBe(1);
  });

  it('is refused as a conflict when anything else about it changed', async () => {
    const w = await world();
    const key = randomUUID();
    await w.submit({ idempotencyKey: key });
    expect(await statusOf(w.submit({ idempotencyKey: key, scheduledAt: '2026-01-03T00:00:00.000Z' }))).toBe(409);
    expect(await statusOf(w.submit({ idempotencyKey: key, document: { ...w.document, blocks: [] } }))).toBe(409);
    expect(await countMessages(w)).toBe(1);
  });

  it('holds when sent twice at once', async () => {
    const w = await world();
    const key = randomUUID();
    const [one, two] = await Promise.all([w.submit({ idempotencyKey: key }), w.submit({ idempotencyKey: key })]);
    expect(one).toEqual(two);
    expect(await countMessages(w)).toBe(1);
  });

  it('keeps a refusal as it was, even after what caused it was mended', async () => {
    const w = await world();
    await revokePermission(w.ctx, { companyId: w.c.companyId, permissionId: w.permission.id });
    const key = randomUUID();
    const first = await w.submit({ idempotencyKey: key });
    expect(first).toMatchObject({ status: 'rejected', reasonCodes: ['consent_missing'] });
    await aPermissionOf(w.c, w.contact.id, w.channel.id);
    expect(await w.submit({ idempotencyKey: key })).toEqual(first);
    expect(await w.submit()).toMatchObject({ status: 'scheduled' });
  });

  it('still answers after the task moved on', async () => {
    const w = await world();
    const key = randomUUID();
    const first = await w.submit({ idempotencyKey: key });
    await w.c.db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, w.c.task.id));
    expect(await w.submit({ idempotencyKey: key })).toEqual(first);
  });
});

describe('who may submit, to whom and from where', () => {
  it('nothing it cannot name', async () => {
    const w = await world();
    expect(await statusOf(w.submit({ channelId: randomUUID() }))).toBe(404);
    expect(await statusOf(w.submit({ accountId: randomUUID() }))).toBe(404);
    expect(await statusOf(w.submit({ target: { kind: 'contact', contactId: randomUUID() } }))).toBe(404);
    expect(await statusOf(w.submit({ task: randomUUID() }))).toBe(404);
    expect(await statusOf(w.submit({ task: 9999 }))).toBe(404);
    expect(await countMessages(w)).toBe(0);
  });

  it('a company\'s own ids do not work from another company\'s authority', async () => {
    const w = await world();
    const [other] = await w.c.db.insert(companies).values({ name: 'Other', singleton: false }).returning();
    const stranger = { ...w.authority, companyId: other!.id };
    expect(await statusOf(submitOutbound(w.ctx, stranger, w.input()))).toBe(404);
    expect(await countMessages(w)).toBe(0);
  });

  it('an account of another channel of the company', async () => {
    const w = await world();
    const channel = await aChannelOf(w.c, { name: 'Second' });
    const { account } = await anAccountOf(w.c, channel.id, w.c.head.id, 'Two');
    expect(await statusOf(w.submit({ accountId: account.id }))).toBe(404);
  });

  it('a task someone else holds', async () => {
    const w = await world();
    expect(await statusOf(w.submit({ task: w.c.salesTask.id }))).toBe(403);
  });

  it('a task that is closed', async () => {
    const w = await world();
    await w.c.db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, w.c.task.id));
    expect(await statusOf(w.submit())).toBe(409);
  });

  it('a task of another department, though this author holds it', async () => {
    const w = await world();
    await w.c.db.update(tasks).set({ departmentId: w.c.sales.id }).where(eq(tasks.id, w.c.task.id));
    expect(await statusOf(w.submit())).toBe(403);
  });

  it('a task outside the channel\'s product', async () => {
    const w = await world();
    await w.c.db.update(outboundChannels).set({ productId: w.c.product.id }).where(eq(outboundChannels.id, w.channel.id));
    expect(await statusOf(w.submit())).toBe(403);
    await w.c.db.update(tasks).set({ productId: w.c.product.id }).where(eq(tasks.id, w.c.task.id));
    expect((await w.submit()).status).toBe('scheduled');
  });

  it('an author outside the channel\'s department', async () => {
    const w = await world();
    expect(await statusOf(submitOutbound(w.ctx, { ...w.authority, departmentId: w.c.sales.id }, w.input()))).toBe(403);
  });

  it('an account bound to someone else', async () => {
    const w = await world();
    await w.c.db.update(outboundBindings).set({ status: 'released', releasedAt: new Date() }).where(eq(outboundBindings.id, w.binding.id));
    await w.c.db.insert(outboundBindings).values({ companyId: w.c.companyId, accountId: w.account.id, agentId: w.c.head.id, generation: 2, createdBy: w.c.ids.ceo });
    expect(await statusOf(w.submit())).toBe(409);
    expect(await reasonsOf(w.submit())).toEqual(['account_bound_elsewhere']);
    expect(await countMessages(w)).toBe(0);
  });

  it('an account bound to nobody', async () => {
    const w = await world();
    await w.c.db.update(outboundBindings).set({ status: 'released', releasedAt: new Date() }).where(eq(outboundBindings.id, w.binding.id));
    expect(await reasonsOf(w.submit())).toEqual(['stale_binding']);
  });

  it('a binding generation that is not the current one', async () => {
    const w = await world();
    expect(await statusOf(w.submit({ bindingGeneration: 2 }))).toBe(409);
    expect(await reasonsOf(w.submit({ bindingGeneration: 2 }))).toEqual(['stale_binding']);
  });

  it('an account whose settings no longer work', async () => {
    const w = await world();
    await w.c.db.update(outboundAccounts).set({ status: 'invalid' }).where(eq(outboundAccounts.id, w.account.id));
    expect(await statusOf(w.submit())).toBe(503);
  });

  it('a contact on a public channel, and an audience on a direct one', async () => {
    const w = await world();
    const audience = await published(w.c, { kind: 'audience', name: 'Blog', destination: 'https://blog.example/' });
    expect(await statusOf(w.submit({ target: { kind: 'audience', audienceId: audience.entryId } }))).toBe(400);
    const pub = await world(QUIET, { audience: 'public' });
    expect(await statusOf(pub.submit())).toBe(400);
  });

  it('a segment that is not published here', async () => {
    const w = await world();
    expect(await w.submit({ segmentId: randomUUID() })).toMatchObject({ status: 'rejected', reasonCodes: ['template_unapproved'] });
    const second = await aChannelOf(w.c, { name: 'Second' });
    const elsewhere = await published(w.c, { kind: 'segment', name: 'Their shops' }, { channelId: second.id });
    expect(await w.submit({ segmentId: elsewhere.entryId })).toMatchObject({ status: 'rejected', reasonCodes: ['template_unapproved'] });
  });

  it('a channel with no policy has no allowance at all', async () => {
    const w = await world();
    const channel = await aChannelOf(w.c, { name: 'No policy' });
    const { account } = await anAccountOf(w.c, channel.id, w.c.head.id, 'Two');
    await w.c.db.update(tasks).set({ assigneeAgentId: w.c.head.id, executorAgentId: w.c.head.id }).where(eq(tasks.id, w.c.task.id));
    const refused = await submitOutbound(w.ctx, { ...w.authority, agentId: w.c.head.id }, w.input({ channelId: channel.id, accountId: account.id }));
    expect(refused).toMatchObject({ status: 'rejected', reasonCodes: ['daily_limit_exceeded'] });
  });

  it('a stopped channel takes nothing', async () => {
    const w = await world();
    await w.c.db.update(outboundChannels).set({ status: 'stopped', stoppedReason: 'review_failed', stoppedAt: new Date(), generation: 2 }).where(eq(outboundChannels.id, w.channel.id));
    expect(await w.submit()).toMatchObject({ status: 'rejected', reasonCodes: ['channel_stopped'] });
  });

  it('every content failure comes together, and is kept as a refusal', async () => {
    const w = await world();
    const blocks = w.document.blocks.map(b => ({ ...b, id: randomUUID() }));
    const result = await w.submit({ document: { ...w.document, blocks } });
    expect(result).toMatchObject({ status: 'rejected' });
    expect(result.reasonCodes.sort()).toEqual(['link_unapproved', 'price_unapproved']);
    expect(await w.c.db.select().from(outboundMessageRevisions)).toEqual([]);
  });
});

describe('a contact\'s word', () => {
  it('do not contact refuses', async () => {
    const w = await world();
    await suppressContact(w.ctx, { companyId: w.c.companyId, contactId: w.contact.id, evidenceDigest: sha('asked by phone') });
    expect(await w.submit()).toMatchObject({ status: 'rejected', reasonCodes: ['contact_suppressed'] });
  });

  it('no permission refuses', async () => {
    const w = await world();
    const stranger = await aContactOf(w.c, 'bob@shop.example');
    expect(await w.submit({ target: { kind: 'contact', contactId: stranger.id } })).toMatchObject({ status: 'rejected', reasonCodes: ['consent_missing'] });
  });

  it('a permission taken back refuses', async () => {
    const w = await world();
    await revokePermission(w.ctx, { companyId: w.c.companyId, permissionId: w.permission.id });
    expect(await w.submit()).toMatchObject({ status: 'rejected', reasonCodes: ['consent_missing'] });
  });

  it('a permission for another channel or another purpose does not count', async () => {
    const w = await world();
    const stranger = await aContactOf(w.c, 'bob@shop.example');
    const second = await aChannelOf(w.c, { name: 'Second' });
    await aPermissionOf(w.c, stranger.id, second.id);
    await aPermissionOf(w.c, stranger.id, w.channel.id, 'follow_up');
    expect(await w.submit({ target: { kind: 'contact', contactId: stranger.id } })).toMatchObject({ status: 'rejected', reasonCodes: ['consent_missing'] });
  });

  it('a contact is added once, with its address sealed, and agrees for this channel\'s purpose', async () => {
    const w = await world();
    const added = await addContact(w.ctx, { companyId: w.c.companyId, kind: 'email', address: ' Bob@Shop.Example ', channel: w.channel, source: 'form', evidence: 'form 12' });
    const again = await addContact(w.ctx, { companyId: w.c.companyId, kind: 'email', address: 'bob@shop.example', channel: w.channel, source: 'form', evidence: 'form 12' });
    expect(again.contactId).toBe(added.contactId);
    const [row] = await w.c.db.select().from(outboundContacts).where(eq(outboundContacts.id, added.contactId));
    expect(row!.addressEnc).not.toContain('bob');
    expect(decryptSecret(row!.addressEnc, w.ctx.config.secret)).toBe('bob@shop.example');
    expect(row!.addressHash).toBe(recipientDigest('bob@shop.example'));
    expect(await w.c.db.select().from(outboundPermissions).where(eq(outboundPermissions.contactId, added.contactId))).toHaveLength(1);
    expect(await w.c.db.select().from(outboundContactEvents).where(eq(outboundContactEvents.contactId, added.contactId))).toHaveLength(1);
    expect((await w.submit({ target: { kind: 'contact', contactId: added.contactId } })).status).toBe('scheduled');
  });

  it.each(['not an address', 'a@b.example, c@d.example', 'a@b.example\nBcc: c@d.example', ''])('an address that is not one address: %j', async address => {
    const w = await world();
    expect(await statusOf(addContact(w.ctx, { companyId: w.c.companyId, kind: 'email', address, channel: w.channel, source: 'form', evidence: 'form 12' }))).toBe(400);
  });
});

describe('unsubscribing', () => {
  const tokenOf = (w: World) => unsubscribeToken(w.ctx.config.secret, { companyId: w.c.companyId, contactId: w.contact.id, channelId: w.channel.id, purpose: 'first_contact' });

  it('the address in a message is signed for this contact and carries no address of theirs', async () => {
    const w = await world();
    const token = tokenOf(w);
    expect(readUnsubscribeToken(w.ctx.config.secret, token)).toEqual({ companyId: w.c.companyId, contactId: w.contact.id, channelId: w.channel.id, purpose: 'first_contact' });
    expect(Buffer.from(token.split('.')[0]!, 'base64url').toString()).not.toContain('ann@');
    const { messageId } = await w.submit();
    const [revision] = await w.c.db.select().from(outboundMessageRevisions).where(eq(outboundMessageRevisions.messageId, messageId));
    expect(JSON.parse(decryptSecret(revision!.sealedEnc, w.ctx.config.secret)).text).toContain(`/api/outbound/unsubscribe/${token}`);
  });

  it('a forged or edited token grants nothing', async () => {
    const w = await world();
    const [payload, mac] = tokenOf(w).split('.');
    const forged = `${Buffer.from(JSON.stringify({ c: w.c.companyId, k: randomUUID(), h: w.channel.id, p: 'first_contact' })).toString('base64url')}.${mac}`;
    expect(readUnsubscribeToken(w.ctx.config.secret, forged)).toBeNull();
    expect(readUnsubscribeToken(w.ctx.config.secret, `${payload}.${'0'.repeat(mac!.length)}`)).toBeNull();
    expect(readUnsubscribeToken(w.ctx.config.secret, `${payload}`)).toBeNull();
    expect(readUnsubscribeToken(Buffer.alloc(32, 9), tokenOf(w))).toBeNull();
    expect(readUnsubscribeToken(w.ctx.config.secret, 'garbage.garbage')).toBeNull();
    expect(await unsubscribe(w.ctx, forged)).toBe(false);
    expect((await w.c.db.select().from(outboundContacts).where(eq(outboundContacts.id, w.contact.id)))[0]!.doNotContact).toBe(false);
  });

  it('wins all later admissions, for good, and takes away every permission', async () => {
    const w = await world();
    expect(await unsubscribe(w.ctx, tokenOf(w))).toBe(true);
    expect(await w.submit()).toMatchObject({ status: 'rejected', reasonCodes: ['contact_suppressed'] });
    const [permission] = await w.c.db.select().from(outboundPermissions).where(eq(outboundPermissions.id, w.permission.id));
    expect(permission!.status).toBe('revoked');
    expect(await w.c.db.select().from(outboundContactEvents).where(and(eq(outboundContactEvents.contactId, w.contact.id), eq(outboundContactEvents.kind, 'unsubscribed')))).toHaveLength(1);
  });

  it('counts once however often it is followed', async () => {
    const w = await world();
    expect(await unsubscribe(w.ctx, tokenOf(w))).toBe(true);
    expect(await unsubscribe(w.ctx, tokenOf(w))).toBe(true);
    expect(await w.c.db.select().from(outboundContactEvents).where(and(eq(outboundContactEvents.contactId, w.contact.id), eq(outboundContactEvents.kind, 'unsubscribed')))).toHaveLength(1);
  });

  it('cannot be imported over', async () => {
    const w = await world();
    await unsubscribe(w.ctx, tokenOf(w));
    expect(await statusOf(addContact(w.ctx, { companyId: w.c.companyId, kind: 'email', address: 'ann@shop.example', channel: w.channel, source: 'import', evidence: 'list 3' }))).toBe(409);
    expect(await w.c.db.select().from(outboundPermissions).where(and(eq(outboundPermissions.contactId, w.contact.id), eq(outboundPermissions.status, 'granted')))).toEqual([]);
    expect(await w.submit()).toMatchObject({ status: 'rejected', reasonCodes: ['contact_suppressed'] });
  });

  it('cancels what waits for this contact, and gives back what it had reserved', async () => {
    const w = await world();
    const waiting = await w.submit();
    const held = await w.submit();
    await reserveDispatch(w.ctx, held.messageId, 1, NOON);
    expect((await bucketsOf(w)).find(b => b.scope === 'account')!.reserved).toBe(1);
    await unsubscribe(w.ctx, tokenOf(w));
    for (const id of [waiting.messageId, held.messageId]) expect(await w.messageOf(id)).toMatchObject({ status: 'cancelled', reasonCodes: ['contact_suppressed'] });
    expect((await bucketsOf(w)).find(b => b.scope === 'account')!.reserved).toBe(0);
    expect((await attemptsOf(w, held.messageId))[0]).toMatchObject({ status: 'definitely_not_accepted' });
  });

  it('does not touch what waits for another contact', async () => {
    const w = await world();
    const other = await aContactOf(w.c, 'bob@shop.example');
    await aPermissionOf(w.c, other.id, w.channel.id);
    const { messageId } = await w.submit({ target: { kind: 'contact', contactId: other.id } });
    await unsubscribe(w.ctx, tokenOf(w));
    expect((await w.messageOf(messageId)).status).toBe('scheduled');
  });

  it('coming first, it stops the last look', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    await reserveDispatch(w.ctx, messageId, 1, NOON);
    await unsubscribe(w.ctx, tokenOf(w));
    expect(await beginDispatch(w.ctx, messageId, 1, NOON)).toEqual({ kind: 'refused', reasonCodes: [] });
    expect(await attemptsOf(w, messageId)).toMatchObject([{ status: 'definitely_not_accepted' }]);
  });

  it('coming after the last look, it stops all that follows, though what left cannot be called back', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    const begun = await dispatched(w, messageId, NOON);
    await unsubscribe(w.ctx, tokenOf(w));
    expect(begun.kind).toBe('begun');
    expect((await w.messageOf(messageId)).status).toBe('sending');
    expect(await w.submit()).toMatchObject({ status: 'rejected', reasonCodes: ['contact_suppressed'] });
  });

  it('racing the last look, either way one of the two holds', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    await reserveDispatch(w.ctx, messageId, 1, NOON);
    const [begun] = await Promise.all([beginDispatch(w.ctx, messageId, 1, NOON), unsubscribe(w.ctx, tokenOf(w))]);
    const status = (await w.messageOf(messageId)).status;
    expect(begun.kind === 'begun' ? status : 'cancelled').toBe(status);
    expect(await w.submit()).toMatchObject({ status: 'rejected', reasonCodes: ['contact_suppressed'] });
  });

  it('a permission taken back before the last look cancels the message', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    await revokePermission(w.ctx, { companyId: w.c.companyId, permissionId: w.permission.id });
    expect(await dispatched(w, messageId, NOON)).toEqual({ kind: 'refused', reasonCodes: ['consent_missing'] });
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'cancelled', reasonCodes: ['consent_missing'] });
  });
});

describe('the day of a limit', () => {
  it('is the policy\'s own day, not the server\'s', () => {
    const at = new Date('2026-11-06T23:30:00.000Z');
    expect(dayOf(at, 'UTC')).toBe('2026-11-06');
    expect(dayOf(at, 'Asia/Tokyo')).toBe('2026-11-07');
    expect(dayOf(new Date('2026-11-06T04:00:00.000Z'), 'America/New_York')).toBe('2026-11-05');
  });

  it.each([
    ['UTC', '2026-11-06', 24],
    ['Europe/Lisbon', '2026-10-25', 25],
    ['Europe/Lisbon', '2026-03-29', 23],
    ['America/Havana', '2026-03-08', 23],
    ['America/Havana', '2026-11-01', 25],
    ['Asia/Kolkata', '2026-11-06', 24],
  ])('in %s, %s is %i hours long from its first instant', (timezone, day, hours) => {
    const { from, to } = dayWindow(day, timezone);
    expect(to - from).toBe(hours * 3_600_000);
    expect(dayOf(new Date(from), timezone)).toBe(day);
    expect(dayOf(new Date(from - 1), timezone)).not.toBe(day);
    expect(dayOf(new Date(to - 1), timezone)).toBe(day);
    expect(dayOf(new Date(to), timezone)).not.toBe(day);
  });

  const bucket = (day: string, timezone: string, reserved = 1, accepted = 0, unknown = 0, definitelyFailed = 0) => ({ day, timezone, reserved, accepted, unknown, definitelyFailed });

  it('counts what may have left, and not what surely did not', () => {
    expect(usedWithin([bucket('2026-11-06', 'UTC', 1, 2, 4, 8)], { day: '2026-11-06', timezone: 'UTC' })).toBe(7);
  });

  it('counts a day of another time zone that overlaps this one', () => {
    const today = { day: '2026-11-06', timezone: 'UTC' };
    expect(usedWithin([bucket('2026-11-07', 'Asia/Tokyo')], today)).toBe(1);
    expect(usedWithin([bucket('2026-11-05', 'America/New_York')], today)).toBe(1);
    expect(usedWithin([bucket('2026-11-08', 'Asia/Tokyo')], today)).toBe(0);
    expect(usedWithin([bucket('2026-11-05', 'UTC')], today)).toBe(0);
    expect(usedWithin([bucket('2026-11-07', 'UTC')], today)).toBe(0);
  });
});

describe('the daily limits', () => {
  it('no more than the account\'s, however many ask at once', async () => {
    const w = await world(withLimits(2, 100));
    const ids = await Promise.all([1, 2, 3, 4, 5].map(async () => (await w.submit()).messageId));
    const results = await Promise.all(ids.map(id => reserveDispatch(w.ctx, id, 1, NOON)));
    expect(results.filter(r => r.kind === 'reserved')).toHaveLength(2);
    expect(results.filter(r => r.kind === 'refused' && r.reasonCodes.includes('daily_limit_exceeded'))).toHaveLength(3);
    expect((await bucketsOf(w)).map(b => [b.scope, b.reserved]).sort()).toEqual([['account', 2], ['domain', 2]]);
  });

  it('no more than the domain\'s across its accounts and channels, whichever policy they go by', async () => {
    const w = await world(withLimits(100, 2));
    const second = await aChannelOf(w.c, { name: 'Second' });
    await aPolicyOf(w.c, second.id, { ...withLimits(100, 2), timezone: 'Asia/Tokyo' });
    const { account } = await anAccountOf(w.c, second.id, w.c.head.id, 'Two');
    await aPermissionOf(w.c, w.contact.id, second.id);
    const parts = await partsOf(w.c, second.id);
    const blocks = [{ kind: 'price', id: parts.price.entryId, revision: 1 }, { kind: 'link', id: parts.link.entryId, revision: 1 }] as typeof w.document.blocks;
    const document = { locale: 'en', templateId: parts.template.entryId, templateRevision: 1, blocks, variables: [{ slotId: parts.variableSlot, valueRef: parts.field.entryId }] };
    await w.c.db.update(tasks).set({ assigneeAgentId: w.c.head.id, executorAgentId: w.c.head.id }).where(eq(tasks.id, w.c.salesTask.id));
    await w.c.db.update(tasks).set({ departmentId: w.c.dev.id }).where(eq(tasks.id, w.c.salesTask.id));
    const theirs = await submitOutbound(w.ctx, { ...w.authority, agentId: w.c.head.id }, w.input({ task: w.c.salesTask.id, channelId: second.id, accountId: account.id, segmentId: parts.segment.entryId, document }));
    const mine = await Promise.all([w.submit(), w.submit()]);
    const results = await Promise.all([theirs, ...mine].map(m => reserveDispatch(w.ctx, m.messageId, 1, NOON)));
    expect(results.filter(r => r.kind === 'reserved')).toHaveLength(2);
    expect(results.filter(r => r.kind === 'refused' && r.reasonCodes.includes('daily_limit_exceeded'))).toHaveLength(1);
  });

  it('a refused one stays where it was and goes the next day', async () => {
    const w = await world(withLimits(1, 100));
    const first = await w.submit();
    const second = await w.submit();
    expect((await reserveDispatch(w.ctx, first.messageId, 1, NOON)).kind).toBe('reserved');
    expect(await reserveDispatch(w.ctx, second.messageId, 1, NOON)).toEqual({ kind: 'refused', reasonCodes: ['daily_limit_exceeded'] });
    expect((await w.messageOf(second.messageId)).status).toBe('scheduled');
    expect((await reserveDispatch(w.ctx, second.messageId, 1, new Date('2026-11-07T12:00:00.000Z'))).kind).toBe('reserved');
  });

  it('midnight is the policy\'s: a minute either side of Lisbon\'s are two days', async () => {
    const w = await world(withLimits(1, 100));
    const [a, b, c] = [await w.submit(), await w.submit(), await w.submit()];
    expect((await reserveDispatch(w.ctx, a.messageId, 1, new Date('2026-07-01T22:59:00.000Z'))).kind).toBe('reserved');
    expect((await reserveDispatch(w.ctx, b.messageId, 1, new Date('2026-07-01T23:00:30.000Z'))).kind).toBe('reserved');
    expect((await reserveDispatch(w.ctx, c.messageId, 1, new Date('2026-07-01T23:30:00.000Z')))).toEqual({ kind: 'refused', reasonCodes: ['daily_limit_exceeded'] });
  });

  it('the hour that comes twice in autumn gives no second allowance', async () => {
    const w = await world(withLimits(1, 100));
    const [a, b] = [await w.submit(), await w.submit()];
    expect((await reserveDispatch(w.ctx, a.messageId, 1, new Date('2026-10-25T00:30:00.000Z'))).kind).toBe('reserved');
    expect(await reserveDispatch(w.ctx, b.messageId, 1, new Date('2026-10-25T01:30:00.000Z'))).toEqual({ kind: 'refused', reasonCodes: ['daily_limit_exceeded'] });
  });

  it('changing the time zone gives no new budget', async () => {
    const w = await world(withLimits(1, 100));
    const [a, b] = [await w.submit(), await w.submit()];
    expect((await reserveDispatch(w.ctx, a.messageId, 1, NOON)).kind).toBe('reserved');
    await aPolicyOf(w.c, w.channel.id, { ...withLimits(1, 100), timezone: 'Asia/Tokyo' }, 2);
    expect(await reserveDispatch(w.ctx, b.messageId, 1, NOON)).toEqual({ kind: 'refused', reasonCodes: ['daily_limit_exceeded'] });
  });

  it('changing the limit counts what is already out against the new one', async () => {
    const w = await world(withLimits(2, 100));
    const [a, b, c] = [await w.submit(), await w.submit(), await w.submit()];
    expect((await reserveDispatch(w.ctx, a.messageId, 1, NOON)).kind).toBe('reserved');
    expect((await reserveDispatch(w.ctx, b.messageId, 1, NOON)).kind).toBe('reserved');
    await aPolicyOf(w.c, w.channel.id, withLimits(3, 100), 2);
    expect((await reserveDispatch(w.ctx, c.messageId, 1, NOON)).kind).toBe('reserved');
    const d = await w.submit();
    await aPolicyOf(w.c, w.channel.id, withLimits(1, 100), 3);
    expect(await reserveDispatch(w.ctx, d.messageId, 1, NOON)).toEqual({ kind: 'refused', reasonCodes: ['daily_limit_exceeded'] });
  });

  it('a surely failed send gives its place back; an unknown or accepted one keeps it', async () => {
    const w = await world(withLimits(1, 100));
    const first = await w.submit();
    const begun = await dispatched(w, first.messageId, NOON);
    if (begun.kind !== 'begun') throw new Error('It did not begin.');
    await settleAttempt(w.ctx, begun.attemptId, { kind: 'definitely_not_accepted', safeCode: 'connect_failed' });
    expect(await w.messageOf(first.messageId)).toMatchObject({ status: 'definitely_failed' });
    expect((await bucketsOf(w)).find(b => b.scope === 'account')).toMatchObject({ reserved: 0, definitelyFailed: 1, accepted: 0, unknown: 0 });

    const second = await w.submit();
    const again = await dispatched(w, second.messageId, NOON);
    if (again.kind !== 'begun') throw new Error('It did not begin.');
    await settleAttempt(w.ctx, again.attemptId, { kind: 'unknown', safeCode: 'timeout' });
    expect(await w.messageOf(second.messageId)).toMatchObject({ status: 'unknown' });
    expect((await bucketsOf(w)).find(b => b.scope === 'account')).toMatchObject({ reserved: 0, unknown: 1 });

    const third = await w.submit();
    expect(await reserveDispatch(w.ctx, third.messageId, 1, NOON)).toEqual({ kind: 'refused', reasonCodes: ['daily_limit_exceeded'] });
  });
});

describe('sampling', () => {
  const base = { status: 'active', segment: 100, author: 100, channel: 1, owed: false } as const;

  it('a new channel reviews everything', () => {
    expect(selectedForReview(QUIET.sampling, { ...base, status: 'new' })).toBe(true);
  });
  it('goes by the first of a segment, the first of an author and every Nth', () => {
    const s = { matureAfter: 0, firstPerSegment: 2, firstPerAuthor: 3, everyNth: 10 };
    expect(selectedForReview(s, base)).toBe(false);
    expect(selectedForReview(s, { ...base, segment: 2 })).toBe(true);
    expect(selectedForReview(s, { ...base, segment: 3 })).toBe(false);
    expect(selectedForReview(s, { ...base, author: 3 })).toBe(true);
    expect(selectedForReview(s, { ...base, author: 4 })).toBe(false);
    expect(selectedForReview(s, { ...base, channel: 10 })).toBe(true);
    expect(selectedForReview(s, { ...base, channel: 11 })).toBe(false);
    expect(selectedForReview(s, { ...base, channel: 20 })).toBe(true);
  });
  it('a segment that has no count, as a reply has none, is no reason', () => {
    const s = { matureAfter: 0, firstPerSegment: 2, firstPerAuthor: 0, everyNth: 10 };
    expect(selectedForReview(s, { ...base, segment: null })).toBe(false);
  });
  it('what was owed is still owed', () => {
    expect(selectedForReview(QUIET.sampling, { ...base, owed: true })).toBe(true);
  });

  const reviewReceipt = (messageId: string, contentDigest: string, decision: 'allow' | 'block' | 'escalate', checkId: string, bindingDigest: string): Review => ({
    messageId, revision: 1, checkId, bindingDigest, subjectDigest: contentDigest, reviewer: checkBinding().model, result: { kind: 'review', decision, reasonCodes: [] },
  });
  /* The check of this department as certified now, which only a passed run does in real life. */
  async function aCertifiedCheck(w: World) {
    const bindingDigest = sha('this binding');
    const [check] = await w.c.db.insert(modelChecks).values({ companyId: w.c.companyId, departmentId: w.c.dev.id, kind: 'outbound_review', status: 'on', bindingDigest, validUntil: new Date('2036-01-01T00:00:00.000Z'), thresholds: { falseAllows: 0, falseDenies: 0, classErrors: 0 } as never, thresholdsBy: w.c.ids.ceo }).returning();
    return { check: check!, bindingDigest };
  }
  const allowed = (w: World, messageId: string, contentDigest: string, c: { check: { id: string }; bindingDigest: string }, decision: 'allow' | 'block' | 'escalate' = 'allow') =>
    recordReview(w.ctx, reviewReceipt(messageId, contentDigest, decision, c.check.id, c.bindingDigest));

  it('a message on a new channel waits for its check, and no check means it holds', async () => {
    const w = await world(QUIET, { status: 'new' });
    const result = await w.submit();
    expect(result).toMatchObject({ status: 'waiting_checks', reasonCodes: ['check_uncertified'] });
    expect(await dispatched(w, result.messageId, NOON)).toEqual({ kind: 'refused', reasonCodes: [] });
  });

  it('with a certified check it waits for the review of itself', async () => {
    const w = await world(QUIET, { status: 'new' });
    await aCertifiedCheck(w);
    expect(await w.submit()).toMatchObject({ status: 'waiting_checks', reasonCodes: ['review_unavailable'] });
  });

  it('a passed review of exactly these bytes lets it go on', async () => {
    const w = await world(QUIET, { status: 'new' });
    const certified = await aCertifiedCheck(w);
    const { messageId, contentDigest } = await w.submit();
    await allowed(w, messageId, contentDigest, certified);
    expect((await w.messageOf(messageId)).status).toBe('scheduled');
    expect((await dispatched(w, messageId, NOON)).kind).toBe('begun');
  });

  it('a review of other bytes does nothing', async () => {
    const w = await world(QUIET, { status: 'new' });
    const certified = await aCertifiedCheck(w);
    const { messageId } = await w.submit();
    await expect(allowed(w, messageId, sha('other bytes'), certified)).rejects.toMatchObject({ status: 409 });
    expect((await w.messageOf(messageId)).status).toBe('waiting_checks');
  });

  it('a certificate that ended holds what was reviewed under it', async () => {
    const w = await world(QUIET, { status: 'new' });
    const certified = await aCertifiedCheck(w);
    const { messageId, contentDigest } = await w.submit();
    await allowed(w, messageId, contentDigest, certified);
    await w.c.db.update(modelChecks).set({ status: 'off', offReason: 'scope', validUntil: null }).where(eq(modelChecks.id, certified.check.id));
    expect(await dispatched(w, messageId, NOON)).toEqual({ kind: 'refused', reasonCodes: ['check_uncertified'] });
    expect((await w.messageOf(messageId)).status).toBe('scheduled');
  });

  it('a block stops the channel before anything else starts, and a person alone reopens it', async () => {
    const w = await world(QUIET, { status: 'new' });
    const certified = await aCertifiedCheck(w);
    const first = await w.submit();
    const other = await w.submit();
    await allowed(w, other.messageId, other.contentDigest, certified);
    await allowed(w, first.messageId, first.contentDigest, certified, 'block');
    expect(await w.messageOf(first.messageId)).toMatchObject({ status: 'rejected', reasonCodes: ['review_failed'] });
    const [channel] = await w.c.db.select().from(outboundChannels).where(eq(outboundChannels.id, w.channel.id));
    expect(channel).toMatchObject({ status: 'stopped', stoppedReason: 'review_failed', generation: 2 });
    expect(await dispatched(w, other.messageId, NOON)).toEqual({ kind: 'refused', reasonCodes: ['channel_stopped'] });
    expect(await w.submit()).toMatchObject({ status: 'rejected', reasonCodes: ['channel_stopped'] });
  });

  it('numbers go on by the counters, deterministically, and a retry takes none', async () => {
    const w = await world(sampling({ everyNth: 3 }));
    await aCertifiedCheck(w);
    const key = randomUUID();
    const statuses = [(await w.submit({ idempotencyKey: key })).status];
    await w.submit({ idempotencyKey: key });
    for (let i = 0; i < 5; i++) statuses.push((await w.submit()).status);
    expect(statuses).toEqual(['scheduled', 'scheduled', 'waiting_checks', 'scheduled', 'scheduled', 'waiting_checks']);
    const [counter] = await w.c.db.select().from(outboundSamplingCounters).where(and(eq(outboundSamplingCounters.channelId, w.channel.id), eq(outboundSamplingCounters.scope, 'channel')));
    expect(counter!.next).toBe(7);
  });

  it('keeps each message\'s numbers on it', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    expect((await w.messageOf(messageId)).samplingOrdinals).toMatchObject({ channel: 1, segment: 1, author: 1 });
  });

  it('the first of a segment and the first of an author are reviewed, and then no more', async () => {
    const w = await world(sampling({ firstPerSegment: 1 }));
    await aCertifiedCheck(w);
    expect((await w.submit()).status).toBe('waiting_checks');
    expect((await w.submit()).status).toBe('scheduled');
    const other = await published(w.c, { kind: 'segment', name: 'Cafes' });
    expect((await w.submit({ segmentId: other.entryId })).status).toBe('waiting_checks');
    const byAuthor = await world(sampling({ firstPerAuthor: 2 }));
    await aCertifiedCheck(byAuthor);
    expect([(await byAuthor.submit()).status, (await byAuthor.submit()).status, (await byAuthor.submit()).status]).toEqual(['waiting_checks', 'waiting_checks', 'scheduled']);
  });

  it('a refused message takes no number, so that refusals change nothing', async () => {
    const w = await world(sampling({ everyNth: 2 }));
    await aCertifiedCheck(w);
    await w.submit({ document: { ...w.document, blocks: [] } });
    expect((await w.submit()).status).toBe('scheduled');
  });

  it('cancelling a chosen message fishes for nothing: its number is gone and the next is reviewed instead', async () => {
    const w = await world(sampling({ everyNth: 2 }));
    await aCertifiedCheck(w);
    expect((await w.submit()).status).toBe('scheduled');
    const chosen = await w.submit();
    expect(chosen.status).toBe('waiting_checks');
    await w.c.db.update(outboundMessages).set({ status: 'cancelled' }).where(eq(outboundMessages.id, chosen.messageId));
    expect((await w.submit()).status).toBe('waiting_checks');
    expect((await w.messageOf(chosen.messageId)).samplingOrdinals).toMatchObject({ channel: 2 });
  });

  it('once a chosen one has passed, nothing is owed any more', async () => {
    const w = await world(sampling({ everyNth: 2 }));
    const certified = await aCertifiedCheck(w);
    await w.submit();
    const chosen = await w.submit();
    await w.c.db.update(outboundMessages).set({ status: 'cancelled' }).where(eq(outboundMessages.id, chosen.messageId));
    const owed = await w.submit();
    expect(owed.status).toBe('waiting_checks');
    await allowed(w, owed.messageId, owed.contentDigest, certified);
    expect((await w.submit()).status).toBe('waiting_checks');
    expect((await w.submit()).status).toBe('scheduled');
  });

  it('an accepted message counts as clean and a new channel grows up by it; an unknown one never does', async () => {
    const w = await world(sampling({ matureAfter: 1 }), { status: 'new' });
    const certified = await aCertifiedCheck(w);
    const first = await w.submit();
    await allowed(w, first.messageId, first.contentDigest, certified);
    const begun = await dispatched(w, first.messageId, NOON);
    if (begun.kind !== 'begun') throw new Error('It did not begin.');
    await settleAttempt(w.ctx, begun.attemptId, { kind: 'unknown', safeCode: 'timeout' });
    const channelRow = async () => (await w.c.db.select().from(outboundChannels).where(eq(outboundChannels.id, w.channel.id)))[0]!;
    expect((await channelRow()).status).toBe('new');
    await settleAttempt(w.ctx, begun.attemptId, { kind: 'accepted', providerReceipt: 'r-1', acceptedAt: NOON.toISOString() });
    expect((await channelRow()).status).toBe('active');
    expect((await w.submit()).status).toBe('scheduled');
  });

  it('a person\'s reopening starts the channel as new again, with its check holding', async () => {
    const w = await world();
    await w.c.db.transaction(tx => stopChannel(tx, w.channel.id, 'review_failed', NOON));
    expect((await w.submit()).status).toBe('rejected');
    expect(await statusOf(reopenChannel(w.ctx, { companyId: w.c.companyId, channelId: w.channel.id }))).toBe(409);
    await aCertifiedCheck(w);
    expect(await reopenChannel(w.ctx, { companyId: w.c.companyId, channelId: w.channel.id })).toMatchObject({ status: 'new', generation: 3, stoppedAt: null, stoppedReason: null });
    expect(await w.submit()).toMatchObject({ status: 'waiting_checks', reasonCodes: ['review_unavailable'] });
  });

  it('reopening what is not stopped or not there is refused', async () => {
    const w = await world();
    await aCertifiedCheck(w);
    expect(await statusOf(reopenChannel(w.ctx, { companyId: w.c.companyId, channelId: w.channel.id }))).toBe(409);
    expect(await statusOf(reopenChannel(w.ctx, { companyId: w.c.companyId, channelId: randomUUID() }))).toBe(404);
  });
});

describe('the last look', () => {
  it('turns one reservation into one attempt with its generations and hands over the sealed payload', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    const begun = await dispatched(w, messageId, NOON);
    expect(begun).toMatchObject({ kind: 'begun', accountId: w.account.id, configGeneration: 1, sealedPayload: { recipient: 'ann@shop.example', subject: 'Hello' } });
    expect(await attemptsOf(w, messageId)).toMatchObject([{ status: 'sending', bindingGeneration: 1, configGeneration: 1, channelGeneration: 1 }]);
    expect((await w.messageOf(messageId)).status).toBe('sending');
  });

  it('a second look finds nothing to begin', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    await dispatched(w, messageId, NOON);
    expect(await beginDispatch(w.ctx, messageId, 1, NOON)).toEqual({ kind: 'refused', reasonCodes: [] });
    expect(await reserveDispatch(w.ctx, messageId, 1, NOON)).toEqual({ kind: 'refused', reasonCodes: [] });
    expect(await attemptsOf(w, messageId)).toHaveLength(1);
  });

  it('two at once begin it once', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    await reserveDispatch(w.ctx, messageId, 1, NOON);
    const both = await Promise.all([beginDispatch(w.ctx, messageId, 1, NOON), beginDispatch(w.ctx, messageId, 1, NOON)]);
    expect(both.filter(b => b.kind === 'begun')).toHaveLength(1);
  });

  it('a message that was never reserved does not begin', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    expect(await beginDispatch(w.ctx, messageId, 1, NOON)).toEqual({ kind: 'refused', reasonCodes: [] });
  });

  it('knows no message that does not exist', async () => {
    const w = await world();
    expect(await reserveDispatch(w.ctx, randomUUID(), 1, NOON)).toEqual({ kind: 'refused', reasonCodes: [] });
    expect(await beginDispatch(w.ctx, randomUUID(), 1, NOON)).toEqual({ kind: 'refused', reasonCodes: [] });
  });

  it('a revision that is not the one expected, as after an edit, does not begin', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    expect(await reserveDispatch(w.ctx, messageId, 2, NOON)).toEqual({ kind: 'refused', reasonCodes: ['stale_binding'] });
    await reserveDispatch(w.ctx, messageId, 1, NOON);
    expect(await beginDispatch(w.ctx, messageId, 2, NOON)).toEqual({ kind: 'refused', reasonCodes: ['stale_binding'] });
    expect((await beginDispatch(w.ctx, messageId, 1, NOON)).kind).toBe('begun');
  });

  it('edited sealed bytes do not match what was frozen', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    const [frozen] = await w.c.db.select().from(outboundMessageRevisions).where(eq(outboundMessageRevisions.messageId, messageId));
    const sealedEnc = encryptSecret(JSON.stringify({ recipient: 'ann@shop.example', subject: 'Hello', text: 'Pay here: https://evil.example' }), w.ctx.config.secret);
    await w.c.db.insert(outboundMessageRevisions).values({ ...frozen!, id: randomUUID(), revision: 2, sealedEnc });
    await w.c.db.update(outboundMessages).set({ revision: 2 }).where(eq(outboundMessages.id, messageId));
    expect(await reserveDispatch(w.ctx, messageId, 2, NOON)).toEqual({ kind: 'refused', reasonCodes: ['stale_binding'] });
    expect((await w.messageOf(messageId)).status).toBe('cancelled');
  });

  it('a seal that cannot be opened counts as edited', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    const [frozen] = await w.c.db.select().from(outboundMessageRevisions).where(eq(outboundMessageRevisions.messageId, messageId));
    await w.c.db.insert(outboundMessageRevisions).values({ ...frozen!, id: randomUUID(), revision: 2, sealedEnc: 'sealed' });
    await w.c.db.update(outboundMessages).set({ revision: 2 }).where(eq(outboundMessages.id, messageId));
    expect(await reserveDispatch(w.ctx, messageId, 2, NOON)).toEqual({ kind: 'refused', reasonCodes: ['stale_binding'] });
  });

  it('a forged attempt in the database does not start anything', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    await reserveDispatch(w.ctx, messageId, 1, NOON);
    await w.c.db.update(outboundMessages).set({ status: 'scheduled' }).where(eq(outboundMessages.id, messageId));
    expect(await beginDispatch(w.ctx, messageId, 1, NOON)).toEqual({ kind: 'refused', reasonCodes: [] });
  });

  it.each<[string, (w: World) => Promise<unknown>, string]>([
    ['the task was cancelled', w => w.c.db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, w.c.task.id)), 'stale_binding'],
    ['the task went to someone else', w => w.c.db.update(tasks).set({ executorAgentId: w.c.head.id, assigneeAgentId: w.c.head.id }).where(eq(tasks.id, w.c.task.id)), 'stale_binding'],
    ['its author left', w => w.c.db.update(agents).set({ removedAt: new Date() }).where(eq(agents.id, w.c.worker.id)), 'stale_binding'],
    ['the binding was released', w => w.c.db.update(outboundBindings).set({ status: 'released', releasedAt: new Date() }).where(eq(outboundBindings.id, w.binding.id)), 'stale_binding'],
    ['a price was taken back', w => w.c.db.update(outboundCatalogRevisions).set({ status: 'revoked', revokedAt: new Date() }).where(eq(outboundCatalogRevisions.entryId, w.price.entryId)), 'price_unapproved'],
    ['a new revision of a price came', w => published(w.c, w.price.value, {}, w.price.entryId, 2), 'price_unapproved'],
  ])('when %s, what waits is cancelled and gives its place back', async (_name, change, code) => {
    const w = await world();
    const { messageId } = await w.submit();
    await reserveDispatch(w.ctx, messageId, 1, NOON);
    await change(w);
    expect(await beginDispatch(w.ctx, messageId, 1, NOON)).toEqual({ kind: 'refused', reasonCodes: [code] });
    expect(await w.messageOf(messageId)).toMatchObject({ status: 'cancelled', reasonCodes: [code] });
    expect((await bucketsOf(w)).find(b => b.scope === 'account')!.reserved).toBe(0);
  });

  it('the task being done is no reason: its work was accepted', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    await w.c.db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, w.c.task.id));
    expect((await dispatched(w, messageId, NOON)).kind).toBe('begun');
  });

  it('a new generation of the channel, the account or the binding makes a reservation stale', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    await reserveDispatch(w.ctx, messageId, 1, NOON);
    await w.c.db.update(outboundAccounts).set({ configGeneration: 2 }).where(eq(outboundAccounts.id, w.account.id));
    expect(await beginDispatch(w.ctx, messageId, 1, NOON)).toEqual({ kind: 'refused', reasonCodes: ['stale_binding'] });

    const other = await world();
    const second = await other.submit();
    await reserveDispatch(other.ctx, second.messageId, 1, NOON);
    await other.c.db.update(outboundChannels).set({ generation: 2 }).where(eq(outboundChannels.id, other.channel.id));
    expect(await beginDispatch(other.ctx, second.messageId, 1, NOON)).toEqual({ kind: 'refused', reasonCodes: ['stale_binding'] });
  });

  it('a stop gives the reservation back and keeps the message for when it is reopened', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    await reserveDispatch(w.ctx, messageId, 1, NOON);
    await w.c.db.update(outboundChannels).set({ status: 'stopped', stoppedReason: 'review_failed', stoppedAt: new Date(), generation: 2 }).where(eq(outboundChannels.id, w.channel.id));
    expect(await beginDispatch(w.ctx, messageId, 1, NOON)).toEqual({ kind: 'refused', reasonCodes: ['channel_stopped'] });
    expect((await w.messageOf(messageId)).status).toBe('scheduled');
    expect((await bucketsOf(w)).find(b => b.scope === 'account')!.reserved).toBe(0);
  });

  it('nothing else leaves an account while one may be on its way', async () => {
    const w = await world();
    const first = await w.submit();
    const second = await w.submit();
    const begun = await dispatched(w, first.messageId, NOON);
    if (begun.kind !== 'begun') throw new Error('It did not begin.');
    expect((await reserveDispatch(w.ctx, second.messageId, 1, NOON)).kind).toBe('reserved');
    expect(await beginDispatch(w.ctx, second.messageId, 1, NOON)).toEqual({ kind: 'refused', reasonCodes: ['delivery_unknown'] });
    await settleAttempt(w.ctx, begun.attemptId, { kind: 'unknown', safeCode: 'timeout' });
    expect(await beginDispatch(w.ctx, second.messageId, 1, NOON)).toEqual({ kind: 'refused', reasonCodes: ['delivery_unknown'] });
    await settleAttempt(w.ctx, begun.attemptId, { kind: 'accepted', providerReceipt: 'r-1', acceptedAt: NOON.toISOString() });
    expect((await beginDispatch(w.ctx, second.messageId, 1, NOON)).kind).toBe('begun');
  });

  it('settling twice changes nothing, and an end stays the end', async () => {
    const w = await world();
    const { messageId } = await w.submit();
    const begun = await dispatched(w, messageId, NOON);
    if (begun.kind !== 'begun') throw new Error('It did not begin.');
    const accepted = { kind: 'accepted', providerReceipt: 'r-1', acceptedAt: NOON.toISOString() } as const;
    await settleAttempt(w.ctx, begun.attemptId, accepted);
    await settleAttempt(w.ctx, begun.attemptId, accepted);
    await settleAttempt(w.ctx, begun.attemptId, { kind: 'definitely_not_accepted', safeCode: 'connect_failed' });
    expect(await attemptsOf(w, messageId)).toMatchObject([{ status: 'accepted', providerReceipt: 'r-1' }]);
    expect((await w.messageOf(messageId)).status).toBe('sent');
    expect((await bucketsOf(w)).find(b => b.scope === 'account')).toMatchObject({ reserved: 0, accepted: 1, definitelyFailed: 0 });
  });

  it('settling an attempt nobody has does nothing', async () => {
    const w = await world();
    await settleAttempt(w.ctx, randomUUID(), { kind: 'unknown', safeCode: 'timeout' });
    expect(await bucketsOf(w)).toEqual([]);
  });

  it('what is due comes up for the dispatcher, and nothing that is not', async () => {
    const w = await world();
    const later = await w.submit({ scheduledAt: '2036-01-01T00:00:00.000Z' });
    const due = await w.submit();
    const refused = await w.submit({ document: { ...w.document, blocks: [] } });
    const found = (await dueMessages(w.ctx, NOON)).map(m => m.messageId);
    expect(found).toContain(due.messageId);
    expect(found).not.toContain(later.messageId);
    expect(found).not.toContain(refused.messageId);
    expect(await dueMessages(w.ctx, NOON)).toContainEqual({ messageId: due.messageId, revision: 1 });
  });

  it('a message not yet due is not reserved', async () => {
    const w = await world();
    const later = await w.submit({ scheduledAt: '2036-01-01T00:00:00.000Z' });
    expect(await reserveDispatch(w.ctx, later.messageId, 1, NOON)).toEqual({ kind: 'refused', reasonCodes: [] });
  });
});

describe('a public post', () => {
  it('goes to its registered audience, frozen, and only with a person\'s approval of it', async () => {
    const w = await world(QUIET, { audience: 'public' });
    const audience = await published(w.c, { kind: 'audience', name: 'Blog', destination: 'https://blog.example/' });
    const template = await published(w.c, { kind: 'template', locale: 'en', subject: 'News', parts: [{ kind: 'text', text: 'News for everyone.' }] });
    const document = { locale: 'en', templateId: template.entryId, templateRevision: 1, blocks: [], variables: [] };
    const result = await w.submit({ target: { kind: 'audience', audienceId: audience.entryId }, document });
    expect(result).toMatchObject({ status: 'waiting_approval', reasonCodes: ['approval_required'] });
    const [revision] = await w.c.db.select().from(outboundMessageRevisions).where(eq(outboundMessageRevisions.messageId, result.messageId));
    expect(JSON.parse(decryptSecret(revision!.sealedEnc, w.ctx.config.secret))).toEqual({ recipient: 'https://blog.example/', subject: 'News', text: 'News for everyone.' });
  });

  it('an audience nobody published refuses', async () => {
    const w = await world(QUIET, { audience: 'public' });
    const template = await published(w.c, { kind: 'template', locale: 'en', subject: 'News', parts: [{ kind: 'text', text: 'News.' }] });
    const document = { locale: 'en', templateId: template.entryId, templateRevision: 1, blocks: [], variables: [] };
    expect(await w.submit({ target: { kind: 'audience', audienceId: randomUUID() }, document })).toMatchObject({ status: 'rejected', reasonCodes: ['template_unapproved'] });
  });
});
