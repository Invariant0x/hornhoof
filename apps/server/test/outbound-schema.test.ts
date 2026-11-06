import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { modelCheckCertificates, modelChecks, outboundAccounts, outboundApprovals, outboundAttempts, outboundBindings, outboundCatalogRevisions, outboundChannels, outboundContactEvents, outboundContacts, outboundDailyUsage, outboundEvents, outboundMessageRevisions, outboundMessages, outboundPermissions, outboundPolicies, outboundReviewReceipts, outboundSamplingCounters, supportClassifications, supportTickets } from '../src/db/schema.js';
import { createTestDb } from './helpers.js';
import { aBinding, aBucket, aChannel, aClassification, aCompany, aContact, aFinishedRun, aMessage, anAccount, anApproval, approachApprovalValues, aPermission, aPolicy, aRequest, aRevision, attemptValues, aTicket, messageApprovalValues, POLICY, PRICE, sha, theBytes, type Sending } from './outbound-fixture.js';

const refusedBy = (constraint: string) => ({ cause: { constraint } });
const FROZEN = { cause: { code: '23001' } };
const LATER = new Date('2026-11-07T10:00:00.000Z');
const EARLIER = new Date('2026-11-05T10:00:00.000Z');

describe('nothing is put in the tables of the gateway by a migration', () => {
  it.each(['outbound_channels', 'outbound_policies', 'outbound_accounts', 'outbound_bindings', 'outbound_catalog_revisions', 'outbound_contacts', 'outbound_permissions', 'outbound_contact_events', 'outbound_messages', 'outbound_message_revisions', 'outbound_approvals', 'outbound_review_receipts', 'outbound_daily_usage', 'outbound_attempts', 'outbound_events', 'outbound_sampling_counters', 'support_tickets', 'support_classifications', 'model_check_certificates'])('%s comes empty', async table => {
    const db = await createTestDb();
    expect((await db.execute(sql.raw(`select count(*)::int as n from ${table}`))).rows).toEqual([{ n: 0 }]);
  });
});

describe('a channel', () => {
  it('starts new, in its first generation, with nothing that stopped it', async () => {
    const db = await createTestDb();
    expect(await aChannel(db, await aCompany(db))).toMatchObject({ status: 'new', generation: 1, stoppedReason: null, stoppedAt: null, productId: null });
  });

  it('has one name in one place, and may share it with a product of that place', async () => {
    const db = await createTestDb();
    const at = await aCompany(db);
    await aChannel(db, at);
    await expect(aChannel(db, at)).rejects.toMatchObject(refusedBy('outbound_channels_place'));
    await expect(db.insert(outboundChannels).values({ companyId: at.companyId, departmentId: at.department.id, productId: at.product.id, name: 'Mail', adapter: 'smtp', purpose: 'first_contact', audience: 'direct', createdBy: at.person.id })).resolves.toBeDefined();
  });

  it('cannot stand in a department or a product of another company', async () => {
    const db = await createTestDb();
    const [mine, theirs] = [await aCompany(db), await aCompany(db, 'Other')];
    const values = { companyId: mine.companyId, name: 'Mail', adapter: 'smtp', purpose: 'first_contact', audience: 'direct', createdBy: mine.person.id } as const;
    await expect(db.insert(outboundChannels).values({ ...values, departmentId: theirs.department.id })).rejects.toMatchObject(refusedBy('outbound_channels_department'));
    await expect(db.insert(outboundChannels).values({ ...values, departmentId: mine.department.id, productId: theirs.product.id })).rejects.toMatchObject(refusedBy('outbound_channels_product'));
  });

  it('is stopped with a reason and a time, or not at all', async () => {
    const db = await createTestDb();
    const channel = await aChannel(db, await aCompany(db));
    await expect(db.update(outboundChannels).set({ status: 'stopped' }).where(eq(outboundChannels.id, channel.id))).rejects.toMatchObject(refusedBy('outbound_channels_stop'));
    await expect(db.update(outboundChannels).set({ stoppedAt: LATER }).where(eq(outboundChannels.id, channel.id))).rejects.toMatchObject(refusedBy('outbound_channels_stop'));
    await expect(db.update(outboundChannels).set({ status: 'stopped', stoppedAt: LATER, stoppedReason: 'channel_stopped' }).where(eq(outboundChannels.id, channel.id))).resolves.toBeDefined();
  });

  it('cannot go back to a generation it left', async () => {
    const db = await createTestDb();
    const channel = await aChannel(db, await aCompany(db));
    await db.update(outboundChannels).set({ generation: 2 }).where(eq(outboundChannels.id, channel.id));
    await expect(db.update(outboundChannels).set({ generation: 1 }).where(eq(outboundChannels.id, channel.id))).rejects.toMatchObject(FROZEN);
  });
});

describe('a policy', () => {
  it('is one revision of one channel, never changed and never removed', async () => {
    const db = await createTestDb();
    const at = await aCompany(db);
    const channel = await aChannel(db, at);
    const policy = await aPolicy(db, at, channel.id);
    await expect(aPolicy(db, at, channel.id)).rejects.toMatchObject(refusedBy('outbound_policies_revision'));
    await expect(db.update(outboundPolicies).set({ value: { ...POLICY, accountDailyLimit: 5000 } }).where(eq(outboundPolicies.id, policy.id))).rejects.toMatchObject(FROZEN);
    await expect(db.delete(outboundPolicies).where(eq(outboundPolicies.id, policy.id))).rejects.toMatchObject(FROZEN);
  });

  it('has a real digest', async () => {
    const db = await createTestDb();
    const at = await aCompany(db);
    const channel = await aChannel(db, at);
    await expect(db.insert(outboundPolicies).values({ companyId: at.companyId, channelId: channel.id, revision: 1, digest: 'ABC', value: POLICY, createdBy: at.person.id })).rejects.toMatchObject(refusedBy('outbound_policies_digest'));
  });

  it('cannot be of a channel of another company', async () => {
    const db = await createTestDb();
    const [mine, theirs] = [await aCompany(db), await aCompany(db, 'Other')];
    const channel = await aChannel(db, theirs);
    await expect(aPolicy(db, mine, channel.id)).rejects.toMatchObject(refusedBy('outbound_policies_channel'));
  });
});

describe('an account', () => {
  it('starts in its first generation of settings, in use', async () => {
    const db = await createTestDb();
    const at = await aCompany(db);
    expect(await anAccount(db, at, (await aChannel(db, at)).id)).toMatchObject({ status: 'active', configGeneration: 1, productId: null });
  });

  it('has its one label on its channel', async () => {
    const db = await createTestDb();
    const at = await aCompany(db);
    const channel = await aChannel(db, at);
    await anAccount(db, at, channel.id);
    await expect(anAccount(db, at, channel.id)).rejects.toMatchObject(refusedBy('outbound_accounts_label'));
  });

  it('is of a domain written one way, so that a limit counts it once', async () => {
    const db = await createTestDb();
    const at = await aCompany(db);
    const channel = await aChannel(db, at);
    await expect(db.insert(outboundAccounts).values({ companyId: at.companyId, departmentId: at.department.id, channelId: channel.id, senderDomain: 'Acme.Example', label: 'One', configEnc: 'sealed', createdBy: at.person.id })).rejects.toMatchObject(refusedBy('outbound_accounts_domain'));
  });

  it('cannot be of a channel of another company', async () => {
    const db = await createTestDb();
    const [mine, theirs] = [await aCompany(db), await aCompany(db, 'Other')];
    await expect(anAccount(db, mine, (await aChannel(db, theirs)).id)).rejects.toMatchObject(refusedBy('outbound_accounts_channel'));
  });

  it('cannot go back to settings it left', async () => {
    const db = await createTestDb();
    const at = await aCompany(db);
    const account = await anAccount(db, at, (await aChannel(db, at)).id);
    await db.update(outboundAccounts).set({ configGeneration: 2 }).where(eq(outboundAccounts.id, account.id));
    await expect(db.update(outboundAccounts).set({ configGeneration: 1 }).where(eq(outboundAccounts.id, account.id))).rejects.toMatchObject(FROZEN);
  });
});

describe('a binding', () => {
  async function bound() {
    const db = await createTestDb();
    const at = await aCompany(db);
    const channel = await aChannel(db, at);
    const account = await anAccount(db, at, channel.id);
    return { db, at, channel, account, row: await aBinding(db, at, account.id) };
  }

  it('holds one account to one author at a time', async () => {
    const { db, at, account } = await bound();
    await expect(aBinding(db, at, account.id, at.other.id, 2)).rejects.toMatchObject(refusedBy('outbound_bindings_one_author'));
  });

  it('holds one author to one account at a time', async () => {
    const { db, at, channel } = await bound();
    const second = await anAccount(db, at, channel.id, 'Two');
    await expect(aBinding(db, at, second.id, at.agent.id, 1)).rejects.toMatchObject(refusedBy('outbound_bindings_one_account'));
  });

  it('leaves the account free once released, with a new generation', async () => {
    const { db, at, account, row } = await bound();
    await db.update(outboundBindings).set({ status: 'released', releasedAt: LATER }).where(eq(outboundBindings.id, row.id));
    await expect(aBinding(db, at, account.id, at.other.id, 1)).rejects.toMatchObject(refusedBy('outbound_bindings_generation'));
    await expect(aBinding(db, at, account.id, at.other.id, 2)).resolves.toMatchObject({ generation: 2, status: 'active' });
  });

  it('says when it was released, and only then', async () => {
    const { db, row } = await bound();
    await expect(db.update(outboundBindings).set({ status: 'released' }).where(eq(outboundBindings.id, row.id))).rejects.toMatchObject(refusedBy('outbound_bindings_release'));
    await expect(db.update(outboundBindings).set({ releasedAt: LATER }).where(eq(outboundBindings.id, row.id))).rejects.toMatchObject(refusedBy('outbound_bindings_release'));
  });

  it.each([['author', { agentId: randomUUID() }], ['generation', { generation: 9 }], ['account', { accountId: randomUUID() }]])('never changes its %s', async (_name, change) => {
    const { db, row } = await bound();
    await expect(db.update(outboundBindings).set(change).where(eq(outboundBindings.id, row.id))).rejects.toMatchObject(FROZEN);
  });

  it('cannot come back once released, nor be removed', async () => {
    const { db, row } = await bound();
    await expect(db.delete(outboundBindings).where(eq(outboundBindings.id, row.id))).rejects.toMatchObject(FROZEN);
    await db.update(outboundBindings).set({ status: 'released', releasedAt: LATER }).where(eq(outboundBindings.id, row.id));
    await expect(db.update(outboundBindings).set({ status: 'active', releasedAt: null }).where(eq(outboundBindings.id, row.id))).rejects.toMatchObject(FROZEN);
  });

  it('cannot give an account of another company to an author', async () => {
    const db = await createTestDb();
    const [mine, theirs] = [await aCompany(db), await aCompany(db, 'Other')];
    const account = await anAccount(db, theirs, (await aChannel(db, theirs)).id);
    await expect(aBinding(db, mine, account.id)).rejects.toMatchObject(refusedBy('outbound_bindings_account'));
  });
});

describe('a revision of the catalog', () => {
  async function proposed() {
    const db = await createTestDb();
    const at = await aCompany(db);
    return { db, at, row: await aRevision(db, at) };
  }
  const publish = (personId: string) => ({ status: 'published', publishedBy: personId, publishedAt: LATER }) as const;

  it('starts proposed, by nobody published', async () => {
    const { row } = await proposed();
    expect(row).toMatchObject({ status: 'proposed', publishedBy: null, publishedAt: null, revokedAt: null, channelId: null });
  });

  it('is once for a number of an entry', async () => {
    const { db, at, row } = await proposed();
    await expect(aRevision(db, at, row.entryId, 1)).rejects.toMatchObject(refusedBy('outbound_catalog_revision'));
    await expect(aRevision(db, at, row.entryId, 2)).resolves.toMatchObject({ revision: 2 });
  });

  it('holds the same kind as its value', async () => {
    const { db, at } = await proposed();
    await expect(db.insert(outboundCatalogRevisions).values({ companyId: at.companyId, departmentId: at.department.id, entryId: randomUUID(), revision: 1, kind: 'link', value: PRICE, digest: sha('price'), createdByKind: 'person', createdById: at.person.id })).rejects.toMatchObject(refusedBy('outbound_catalog_kind'));
  });

  it('is published by a person, and only an existing one', async () => {
    const { db, row } = await proposed();
    await expect(db.update(outboundCatalogRevisions).set({ status: 'published' }).where(eq(outboundCatalogRevisions.id, row.id))).rejects.toMatchObject(refusedBy('outbound_catalog_published'));
    await expect(db.update(outboundCatalogRevisions).set(publish(randomUUID())).where(eq(outboundCatalogRevisions.id, row.id))).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('carries no publisher while only proposed', async () => {
    const { db, at, row } = await proposed();
    await expect(db.update(outboundCatalogRevisions).set({ publishedBy: at.person.id, publishedAt: LATER }).where(eq(outboundCatalogRevisions.id, row.id))).rejects.toMatchObject(refusedBy('outbound_catalog_published'));
  });

  it('ends after it starts', async () => {
    const { db, row } = await proposed();
    const { validFrom } = row;
    await expect(aRevisionEnding(db, row, validFrom)).rejects.toMatchObject(refusedBy('outbound_catalog_validity'));
  });

  it.each([['value', { value: { ...PRICE, amount: '1.00' } }], ['digest', { digest: sha('other') }], ['kind', { kind: 'link' }], ['number', { revision: 7 }], ['entry', { entryId: randomUUID() }], ['start', { validFrom: EARLIER }], ['end', { validUntil: LATER }]] as const)('never changes its %s', async (_name, change) => {
    const { db, row } = await proposed();
    await expect(db.update(outboundCatalogRevisions).set(change).where(eq(outboundCatalogRevisions.id, row.id))).rejects.toMatchObject(FROZEN);
  });

  it('is never removed', async () => {
    const { db, row } = await proposed();
    await expect(db.delete(outboundCatalogRevisions).where(eq(outboundCatalogRevisions.id, row.id))).rejects.toMatchObject(FROZEN);
  });

  it('goes from proposed to published to revoked, and never back', async () => {
    const { db, at, row } = await proposed();
    const where = eq(outboundCatalogRevisions.id, row.id);
    await db.update(outboundCatalogRevisions).set(publish(at.person.id)).where(where);
    await expect(db.update(outboundCatalogRevisions).set({ status: 'proposed', publishedBy: null, publishedAt: null }).where(where)).rejects.toMatchObject(FROZEN);
    await db.update(outboundCatalogRevisions).set({ status: 'revoked', revokedAt: LATER }).where(where);
    await expect(db.update(outboundCatalogRevisions).set({ status: 'published', revokedAt: null }).where(where)).rejects.toMatchObject(FROZEN);
  });

  it('does not change who published it', async () => {
    const { db, at, row } = await proposed();
    const where = eq(outboundCatalogRevisions.id, row.id);
    await db.update(outboundCatalogRevisions).set(publish(at.person.id)).where(where);
    await expect(db.update(outboundCatalogRevisions).set({ publishedBy: at.other.id }).where(where)).rejects.toMatchObject(FROZEN);
  });
});

function aRevisionEnding(db: Awaited<ReturnType<typeof createTestDb>>, row: typeof outboundCatalogRevisions.$inferSelect, validUntil: Date) {
  return db.insert(outboundCatalogRevisions).values({ companyId: row.companyId, departmentId: row.departmentId, entryId: row.entryId, revision: 2, kind: row.kind, value: row.value, digest: row.digest, createdByKind: row.createdByKind, createdById: row.createdById, validFrom: row.validFrom, validUntil });
}

describe('a contact', () => {
  it('is one row for one address in one company, so that no copy escapes a refusal', async () => {
    const db = await createTestDb();
    const [mine, theirs] = [await aCompany(db), await aCompany(db, 'Other')];
    await aContact(db, mine);
    await expect(aContact(db, mine)).rejects.toMatchObject(refusedBy('outbound_contacts_address'));
    await expect(aContact(db, theirs)).resolves.toMatchObject({ doNotContact: false, suppressedAt: null });
  });

  it('says when it was suppressed, and only then', async () => {
    const db = await createTestDb();
    const contact = await aContact(db, await aCompany(db));
    await expect(db.update(outboundContacts).set({ doNotContact: true }).where(eq(outboundContacts.id, contact.id))).rejects.toMatchObject(refusedBy('outbound_contacts_suppressed'));
    await expect(db.update(outboundContacts).set({ suppressedAt: LATER }).where(eq(outboundContacts.id, contact.id))).rejects.toMatchObject(refusedBy('outbound_contacts_suppressed'));
  });

  it('stays suppressed for good, whatever an import says later', async () => {
    const db = await createTestDb();
    const contact = await aContact(db, await aCompany(db));
    const where = eq(outboundContacts.id, contact.id);
    await db.update(outboundContacts).set({ doNotContact: true, suppressedAt: LATER }).where(where);
    await expect(db.update(outboundContacts).set({ doNotContact: false, suppressedAt: null }).where(where)).rejects.toMatchObject(FROZEN);
  });

  it('keeps its address hash', async () => {
    const db = await createTestDb();
    const contact = await aContact(db, await aCompany(db));
    await expect(db.update(outboundContacts).set({ addressHash: sha('another') }).where(eq(outboundContacts.id, contact.id))).rejects.toMatchObject(FROZEN);
  });
});

describe('a permission', () => {
  async function granted() {
    const db = await createTestDb();
    const at = await aCompany(db);
    const channel = await aChannel(db, at);
    const contact = await aContact(db, at);
    return { db, at, channel, contact, row: await aPermission(db, at, contact.id, channel.id) };
  }

  it('is once at a time for a contact, a channel and a purpose', async () => {
    const { db, at, channel, contact } = await granted();
    await expect(aPermission(db, at, contact.id, channel.id)).rejects.toMatchObject(refusedBy('outbound_permissions_active'));
  });

  it('can be given again after it was taken away, as a new row', async () => {
    const { db, at, channel, contact, row } = await granted();
    await db.update(outboundPermissions).set({ status: 'revoked', revokedAt: LATER }).where(eq(outboundPermissions.id, row.id));
    await expect(aPermission(db, at, contact.id, channel.id)).resolves.toMatchObject({ status: 'granted' });
  });

  it('does not come back by itself once taken away, nor go without a trace', async () => {
    const { db, row } = await granted();
    const where = eq(outboundPermissions.id, row.id);
    await expect(db.delete(outboundPermissions).where(where)).rejects.toMatchObject(FROZEN);
    await db.update(outboundPermissions).set({ status: 'revoked', revokedAt: LATER }).where(where);
    await expect(db.update(outboundPermissions).set({ status: 'granted', revokedAt: null }).where(where)).rejects.toMatchObject(FROZEN);
  });

  it('says when it was taken away, and only then', async () => {
    const { db, row } = await granted();
    await expect(db.update(outboundPermissions).set({ status: 'revoked' }).where(eq(outboundPermissions.id, row.id))).rejects.toMatchObject(refusedBy('outbound_permissions_revoked'));
  });

  it('cannot join a contact and a channel of two companies', async () => {
    const db = await createTestDb();
    const [mine, theirs] = [await aCompany(db), await aCompany(db, 'Other')];
    const contact = await aContact(db, mine);
    await expect(aPermission(db, mine, contact.id, (await aChannel(db, theirs)).id)).rejects.toMatchObject(refusedBy('outbound_permissions_channel'));
    await expect(aPermission(db, mine, (await aContact(db, theirs)).id, (await aChannel(db, mine)).id)).rejects.toMatchObject(refusedBy('outbound_permissions_contact'));
  });
});

describe('the history of a contact', () => {
  async function anEvent() {
    const db = await createTestDb();
    const at = await aCompany(db);
    const contact = await aContact(db, at);
    const values = { companyId: at.companyId, contactId: contact.id, kind: 'unsubscribed', dedupKey: 'token-1', evidenceDigest: sha('token'), occurredAt: LATER } as const;
    return { db, values, row: (await db.insert(outboundContactEvents).values(values).returning())[0]! };
  }

  it('counts one event once', async () => {
    const { db, values } = await anEvent();
    await expect(db.insert(outboundContactEvents).values(values)).rejects.toMatchObject(refusedBy('outbound_contact_events_dedup'));
  });

  it('is never rewritten', async () => {
    const { db, row } = await anEvent();
    await expect(db.update(outboundContactEvents).set({ kind: 'consent_granted' }).where(eq(outboundContactEvents.id, row.id))).rejects.toMatchObject(FROZEN);
    await expect(db.delete(outboundContactEvents).where(eq(outboundContactEvents.id, row.id))).rejects.toMatchObject(FROZEN);
  });
});

describe('a message', () => {
  async function sending() {
    const db = await createTestDb();
    const at = await aCompany(db);
    return { db, at, ...(await aMessage(db, at)) };
  }

  it('starts at its first revision, with no reasons', async () => {
    const { message } = await sending();
    expect(message).toMatchObject({ revision: 1, reasonCodes: [], samplingOrdinals: {}, productId: null, authorJobId: null });
  });

  it('is one for one key of one author, so that a retry gets the same message', async () => {
    const { db, values } = await sending();
    await expect(db.insert(outboundMessages).values(values)).rejects.toMatchObject(refusedBy('outbound_messages_idempotency'));
  });

  it.each([
    ['a contact target with no contact', { contactId: null }],
    ['a contact target with an audience', { audienceEntryId: randomUUID() }],
    ['a contact target with a ticket', { ticketId: randomUUID(), ticketRevision: 1, classificationId: randomUUID() }],
    ['a target of no segment', { segmentId: null }],
    ['an audience target with a contact', { targetKind: 'audience', audienceEntryId: randomUUID() }],
    ['an audience target with nothing', { targetKind: 'audience', contactId: null }],
    ['a reply with no ticket', { targetKind: 'ticket', segmentId: null }],
    ['a reply with a segment', { targetKind: 'ticket', ticketId: randomUUID(), ticketRevision: 1, classificationId: randomUUID() }],
  ] as const)('refuses %s', async (_name, change) => {
    const { db, values } = await sending();
    await expect(db.insert(outboundMessages).values({ ...values, idempotencyKey: randomUUID(), ...change })).rejects.toMatchObject(refusedBy('outbound_messages_target'));
  });

  it('cannot use a generation its account never had', async () => {
    const { db, values } = await sending();
    await expect(db.insert(outboundMessages).values({ ...values, idempotencyKey: randomUUID(), bindingGeneration: 9 })).rejects.toMatchObject(refusedBy('outbound_messages_binding'));
  });

  it('cannot use a channel, an account or a contact of another company', async () => {
    const { db, values } = await sending();
    const theirs = await aCompany(db, 'Other');
    const channel = await aChannel(db, theirs);
    const account = await anAccount(db, theirs, channel.id);
    const fresh = { ...values, idempotencyKey: randomUUID() };
    await expect(db.insert(outboundMessages).values({ ...fresh, channelId: channel.id })).rejects.toMatchObject(refusedBy('outbound_messages_channel'));
    await expect(db.insert(outboundMessages).values({ ...fresh, accountId: account.id })).rejects.toMatchObject(refusedBy('outbound_messages_account'));
    await expect(db.insert(outboundMessages).values({ ...fresh, contactId: (await aContact(db, theirs)).id })).rejects.toMatchObject(refusedBy('outbound_messages_contact'));
  });

  it('is refused with a reason it says', async () => {
    const { db, message } = await sending();
    const where = eq(outboundMessages.id, message.id);
    await expect(db.update(outboundMessages).set({ status: 'rejected' }).where(where)).rejects.toMatchObject(refusedBy('outbound_messages_rejected'));
    await expect(db.update(outboundMessages).set({ status: 'rejected', reasonCodes: ['price_unapproved'] }).where(where)).resolves.toBeDefined();
  });

  it.each([['author', { authorAgentId: randomUUID() }], ['key', { idempotencyKey: randomUUID() }], ['request', { requestDigest: sha('other') }], ['channel', { channelId: randomUUID() }], ['account', { accountId: randomUUID() }], ['generation', { bindingGeneration: 2 }], ['contact', { contactId: randomUUID() }], ['segment', { segmentId: randomUUID() }], ['sampling', { samplingOrdinals: { channel: 1 } }], ['task', { taskId: randomUUID() }]] as const)('never changes its %s', async (_name, change) => {
    const { db, message } = await sending();
    await expect(db.update(outboundMessages).set(change).where(eq(outboundMessages.id, message.id))).rejects.toMatchObject(FROZEN);
  });

  it('is never removed, so that a sampled number is not fished for again', async () => {
    const { db, message } = await sending();
    await expect(db.delete(outboundMessages).where(eq(outboundMessages.id, message.id))).rejects.toMatchObject(FROZEN);
  });

  it('goes on through its states and keeps its next revision', async () => {
    const { db, message } = await sending();
    await expect(db.update(outboundMessages).set({ status: 'waiting_checks', revision: 2, updatedAt: LATER }).where(eq(outboundMessages.id, message.id))).resolves.toBeDefined();
  });

  it('cannot go back to a revision it left', async () => {
    const { db, message } = await sending();
    await db.update(outboundMessages).set({ revision: 2 }).where(eq(outboundMessages.id, message.id));
    await expect(db.update(outboundMessages).set({ revision: 1 }).where(eq(outboundMessages.id, message.id))).rejects.toMatchObject(FROZEN);
  });
});

describe('the bytes of a message', () => {
  async function frozen() {
    const db = await createTestDb();
    const at = await aCompany(db);
    const sending = await aMessage(db, at);
    return { db, at, sending, row: await theBytes(db, at, sending) };
  }

  it('are one row for one revision', async () => {
    const { db, at, sending } = await frozen();
    await expect(theBytes(db, at, sending)).rejects.toMatchObject(refusedBy('outbound_message_revisions_number'));
    await expect(theBytes(db, at, sending, 2)).resolves.toMatchObject({ revision: 2 });
  });

  it.each([['digest', { contentDigest: sha('edited') }], ['sealed bytes', { sealedEnc: 'edited' }], ['document', { document: { locale: 'ru', templateId: randomUUID(), templateRevision: 1, blocks: [], variables: [] } }], ['sources', { sourceRevisionsDigest: sha('edited') }]])('never change: %s', async (_name, change) => {
    const { db, row } = await frozen();
    await expect(db.update(outboundMessageRevisions).set(change).where(eq(outboundMessageRevisions.id, row.id))).rejects.toMatchObject(FROZEN);
  });

  it('are never removed', async () => {
    const { db, row } = await frozen();
    await expect(db.delete(outboundMessageRevisions).where(eq(outboundMessageRevisions.id, row.id))).rejects.toMatchObject(FROZEN);
  });

  it('cannot be of a message of another company', async () => {
    const { db, sending } = await frozen();
    const theirs = await aCompany(db, 'Other');
    await expect(theBytes(db, theirs, sending, 2)).rejects.toMatchObject(refusedBy('outbound_message_revisions_message'));
  });
});

describe('an approval', () => {
  async function asked() {
    const db = await createTestDb();
    const at = await aCompany(db);
    const sending = await aMessage(db, at);
    await theBytes(db, at, sending);
    return { db, at, sending, request: await aRequest(db, at) };
  }

  it('binds a request to exact bytes', async () => {
    const { db, at, sending, request } = await asked();
    await expect(db.insert(outboundApprovals).values(messageApprovalValues(at, sending, request.id)).returning()).resolves.toMatchObject([{ kind: 'message', messageRevision: 1, channelId: null, templateId: null }]);
  });

  it('binds a request to an exact approach', async () => {
    const { db, at, sending, request } = await asked();
    await expect(db.insert(outboundApprovals).values(approachApprovalValues(at, sending.channel.id, request.id)).returning()).resolves.toMatchObject([{ kind: 'approach', messageId: null, contentDigest: null, templateRevision: 1 }]);
  });

  it('is one for a request', async () => {
    const { db, at, sending, request } = await asked();
    await db.insert(outboundApprovals).values(messageApprovalValues(at, sending, request.id));
    await expect(db.insert(outboundApprovals).values(approachApprovalValues(at, sending.channel.id, request.id))).rejects.toMatchObject(refusedBy('outbound_approvals_request'));
  });

  it.each([
    ['of bytes with no digest', { contentDigest: null }],
    ['of bytes with no generation', { bindingGeneration: null }],
    ['of bytes with an approach in it', { templateId: randomUUID() }],
    ['of bytes with a language of an approach', { locale: 'en' }],
  ])('refuses one %s', async (_name, change) => {
    const { db, at, sending, request } = await asked();
    await expect(db.insert(outboundApprovals).values({ ...messageApprovalValues(at, sending, request.id), ...change })).rejects.toMatchObject(refusedBy('outbound_approvals_kind'));
  });

  it.each([
    ['of an approach with no language', { locale: null }],
    ['of an approach with no template', { templateId: null }],
    ['of an approach with bytes in it', { contentDigest: sha('bytes') }],
  ])('refuses one %s', async (_name, change) => {
    const { db, at, sending, request } = await asked();
    await expect(db.insert(outboundApprovals).values({ ...approachApprovalValues(at, sending.channel.id, request.id), ...change })).rejects.toMatchObject(refusedBy('outbound_approvals_kind'));
  });

  it('cannot be of bytes that were never frozen', async () => {
    const { db, at, sending, request } = await asked();
    await expect(db.insert(outboundApprovals).values({ ...messageApprovalValues(at, sending, request.id), messageRevision: 9 })).rejects.toMatchObject(refusedBy('outbound_approvals_revision'));
  });

  it('cannot be of a request of another company', async () => {
    const { db, at, sending } = await asked();
    const theirs = await aCompany(db, 'Other');
    const request = await aRequest(db, theirs);
    await expect(db.insert(outboundApprovals).values(messageApprovalValues(at, sending, request.id))).rejects.toMatchObject(refusedBy('outbound_approvals_of_request'));
  });

  it('is never rewritten', async () => {
    const db = await createTestDb();
    const at = await aCompany(db);
    const row = await anApproval(db, at, await aMessage(db, at));
    await expect(db.update(outboundApprovals).set({ contentDigest: sha('edited') }).where(eq(outboundApprovals.id, row.id))).rejects.toMatchObject(FROZEN);
    await expect(db.delete(outboundApprovals).where(eq(outboundApprovals.id, row.id))).rejects.toMatchObject(FROZEN);
  });
});

describe('a review of a message', () => {
  async function reviewed() {
    const db = await createTestDb();
    const at = await aCompany(db);
    const sending = await aMessage(db, at);
    await theBytes(db, at, sending);
    const { check } = await aFinishedRun(db, at);
    const values = { companyId: at.companyId, messageId: sending.message.id, messageRevision: 1, checkId: check.id, bindingDigest: sha('binding'), subjectDigest: sha('bytes 1'), reviewer: { providerId: 'codex' as const, vendorId: 'openai', modelId: 'm', revisionId: 'r', inferenceConfigHash: sha('config') }, result: { kind: 'review' as const, decision: 'allow' as const, reasonCodes: [] } };
    return { db, values, row: (await db.insert(outboundReviewReceipts).values(values).returning())[0]! };
  }

  it('counts one binding once for one revision', async () => {
    const { db, values } = await reviewed();
    await expect(db.insert(outboundReviewReceipts).values(values)).rejects.toMatchObject(refusedBy('outbound_review_receipts_once'));
  });

  it('is never rewritten', async () => {
    const { db, row } = await reviewed();
    await expect(db.update(outboundReviewReceipts).set({ result: { kind: 'review', decision: 'block', reasonCodes: [] } }).where(eq(outboundReviewReceipts.id, row.id))).rejects.toMatchObject(FROZEN);
    await expect(db.delete(outboundReviewReceipts).where(eq(outboundReviewReceipts.id, row.id))).rejects.toMatchObject(FROZEN);
  });
});

describe('a count of a day', () => {
  it('is one bucket for one scope, day, zone and limit, and starts at nothing', async () => {
    const db = await createTestDb();
    const at = await aCompany(db);
    await expect(aBucket(db, at, 'account', 'one')).resolves.toMatchObject({ reserved: 0, accepted: 0, unknown: 0, definitelyFailed: 0 });
    await expect(aBucket(db, at, 'account', 'one')).rejects.toMatchObject(refusedBy('outbound_daily_usage_bucket'));
    await expect(aBucket(db, at, 'domain', 'one')).resolves.toBeDefined();
    await expect(aBucket(db, at, 'account', 'one', '2026-11-07')).resolves.toBeDefined();
  });

  it.each(['reserved', 'accepted', 'unknown', 'definitelyFailed'])('does not go below nothing: %s', async column => {
    const db = await createTestDb();
    const bucket = await aBucket(db, await aCompany(db), 'account', 'one');
    await expect(db.update(outboundDailyUsage).set({ [column]: -1 }).where(eq(outboundDailyUsage.id, bucket.id))).rejects.toMatchObject(refusedBy('outbound_daily_usage_counts'));
  });

  it('is not reset by removing it, nor moved to another day', async () => {
    const db = await createTestDb();
    const bucket = await aBucket(db, await aCompany(db), 'account', 'one');
    await expect(db.delete(outboundDailyUsage).where(eq(outboundDailyUsage.id, bucket.id))).rejects.toMatchObject(FROZEN);
    await expect(db.update(outboundDailyUsage).set({ day: '2026-11-07' }).where(eq(outboundDailyUsage.id, bucket.id))).rejects.toMatchObject(FROZEN);
  });
});

describe('an attempt', () => {
  async function ready() {
    const db = await createTestDb();
    const at = await aCompany(db);
    const sending = await aMessage(db, at);
    return { db, at, sending, values: await attemptValues(db, at, sending) };
  }
  const started = { status: 'sending', leaseId: randomUUID(), leaseUntil: LATER, startedAt: EARLIER } as const;
  const failed = { status: 'definitely_not_accepted', safeCode: 'recipient_refused', endedAt: LATER } as const;

  it('is the only one of its message while it may still have an effect', async () => {
    const { db, values } = await ready();
    await db.insert(outboundAttempts).values(values);
    await expect(db.insert(outboundAttempts).values(values)).rejects.toMatchObject(refusedBy('outbound_attempts_one_of_message'));
  });

  it('may follow one that surely did not leave', async () => {
    const { db, values } = await ready();
    await db.insert(outboundAttempts).values({ ...values, ...failed });
    await expect(db.insert(outboundAttempts).values(values)).resolves.toBeDefined();
  });

  it('never follows one that may have left', async () => {
    const { db, values } = await ready();
    await db.insert(outboundAttempts).values({ ...values, status: 'unknown', safeCode: 'timeout', endedAt: LATER });
    await expect(db.insert(outboundAttempts).values(values)).rejects.toMatchObject(refusedBy('outbound_attempts_one_of_message'));
  });

  it('is the only unresolved one of its account', async () => {
    const { db, at, sending, values } = await ready();
    await db.insert(outboundAttempts).values({ ...values, ...started });
    const second = await aMessageOnTheSameAccount(db, at, sending);
    await expect(db.insert(outboundAttempts).values({ ...values, messageId: second, ...started })).rejects.toMatchObject(refusedBy('outbound_attempts_one_of_account'));
  });

  it('keeps the account closed while its outcome is unknown', async () => {
    const { db, at, sending, values } = await ready();
    await db.insert(outboundAttempts).values({ ...values, status: 'unknown', safeCode: 'timeout', endedAt: LATER });
    const second = await aMessageOnTheSameAccount(db, at, sending);
    await expect(db.insert(outboundAttempts).values({ ...values, messageId: second, ...started })).rejects.toMatchObject(refusedBy('outbound_attempts_one_of_account'));
  });

  it.each([
    ['taken with no receipt', { status: 'accepted', endedAt: LATER }],
    ['taken with a code of a failure', { status: 'accepted', providerReceipt: 'q1', safeCode: 'timeout', endedAt: LATER }],
    ['not taken with no code', { status: 'definitely_not_accepted', endedAt: LATER }],
    ['unknown with no code', { status: 'unknown', endedAt: LATER }],
    ['not taken with a receipt', { status: 'definitely_not_accepted', safeCode: 'timeout', providerReceipt: 'q1', endedAt: LATER }],
    ['still reserved with a receipt', { providerReceipt: 'q1' }],
    ['ended with no time', { status: 'accepted', providerReceipt: 'q1' }],
    ['running with an end', { endedAt: LATER }],
  ] as const)('refuses one %s', async (_name, change) => {
    const { db, values } = await ready();
    await expect(db.insert(outboundAttempts).values({ ...values, ...change })).rejects.toMatchObject(refusedBy('outbound_attempts_outcome'));
  });

  it('cannot claim a generation its account never had, or bytes never frozen', async () => {
    const { db, values } = await ready();
    await expect(db.insert(outboundAttempts).values({ ...values, bindingGeneration: 9 })).rejects.toMatchObject(refusedBy('outbound_attempts_binding'));
    await expect(db.insert(outboundAttempts).values({ ...values, messageRevision: 9 })).rejects.toMatchObject(refusedBy('outbound_attempts_revision'));
  });

  it.each([['message', { messageId: randomUUID() }], ['revision', { messageRevision: 2 }], ['account', { accountId: randomUUID() }], ['binding', { bindingGeneration: 2 }], ['settings', { configGeneration: 2 }], ['circuit', { channelGeneration: 2 }], ['bucket', { accountBucketId: randomUUID() }]])('never changes its %s', async (_name, change) => {
    const { db, values } = await ready();
    const [row] = await db.insert(outboundAttempts).values(values).returning();
    await expect(db.update(outboundAttempts).set(change).where(eq(outboundAttempts.id, row!.id))).rejects.toMatchObject(FROZEN);
  });

  it('settles an unknown outcome, then stays', async () => {
    const { db, values } = await ready();
    const [row] = await db.insert(outboundAttempts).values({ ...values, status: 'unknown', safeCode: 'timeout', endedAt: LATER }).returning();
    const where = eq(outboundAttempts.id, row!.id);
    await db.update(outboundAttempts).set({ status: 'accepted', safeCode: null, providerReceipt: 'q1' }).where(where);
    await expect(db.update(outboundAttempts).set({ status: 'unknown', providerReceipt: null, safeCode: 'timeout' }).where(where)).rejects.toMatchObject(FROZEN);
    await expect(db.delete(outboundAttempts).where(where)).rejects.toMatchObject(FROZEN);
  });
});

/* A second message from the same account, frozen too, for what its account allows. */
async function aMessageOnTheSameAccount(db: Awaited<ReturnType<typeof createTestDb>>, at: Awaited<ReturnType<typeof aCompany>>, sending: Sending) {
  const [second] = await db.insert(outboundMessages).values({ ...sending.values, idempotencyKey: randomUUID() }).returning();
  await theBytes(db, at, { ...sending, message: second! });
  return second!.id;
}

describe('an event from a provider', () => {
  async function anEvent() {
    const db = await createTestDb();
    const at = await aCompany(db);
    const values = { companyId: at.companyId, kind: 'complaint', source: 'webhook', providerEventId: 'e1', occurredAt: LATER } as const;
    return { db, values, row: (await db.insert(outboundEvents).values(values).returning())[0]! };
  }

  it('counts once, however often it is delivered', async () => {
    const { db, values } = await anEvent();
    await expect(db.insert(outboundEvents).values(values)).rejects.toMatchObject(refusedBy('outbound_events_once'));
  });

  it('is never rewritten', async () => {
    const { db, row } = await anEvent();
    await expect(db.update(outboundEvents).set({ kind: 'delivered' }).where(eq(outboundEvents.id, row.id))).rejects.toMatchObject(FROZEN);
    await expect(db.delete(outboundEvents).where(eq(outboundEvents.id, row.id))).rejects.toMatchObject(FROZEN);
  });
});

describe('the counters of sampling', () => {
  async function aCounter() {
    const db = await createTestDb();
    const at = await aCompany(db);
    const channel = await aChannel(db, at);
    const values = { companyId: at.companyId, channelId: channel.id, scope: 'author', scopeKey: at.agent.id } as const;
    return { db, values, row: (await db.insert(outboundSamplingCounters).values(values).returning())[0]! };
  }

  it('are one for a scope of a channel, and start at the first number', async () => {
    const { db, values, row } = await aCounter();
    expect(row).toMatchObject({ next: 1, cleanOutcomes: 0 });
    await expect(db.insert(outboundSamplingCounters).values(values)).rejects.toMatchObject(refusedBy('outbound_sampling_counters_scope'));
  });

  it('go on, and never back, so that no retry or cancel fishes for a number nobody reviews', async () => {
    const { db, row } = await aCounter();
    const where = eq(outboundSamplingCounters.id, row.id);
    await db.update(outboundSamplingCounters).set({ next: 5 }).where(where);
    await expect(db.update(outboundSamplingCounters).set({ next: 4 }).where(where)).rejects.toMatchObject(FROZEN);
    await expect(db.delete(outboundSamplingCounters).where(where)).rejects.toMatchObject(FROZEN);
  });
});

describe('a ticket', () => {
  async function aFirstRevision() {
    const db = await createTestDb();
    const at = await aCompany(db);
    const contact = await aContact(db, at);
    return { db, at, contact, row: await aTicket(db, at, contact.id) };
  }

  it('is one row for a revision', async () => {
    const { db, at, contact, row } = await aFirstRevision();
    await expect(aTicket(db, at, contact.id, row.ticketId, 1)).rejects.toMatchObject(refusedBy('support_tickets_revision'));
    await expect(aTicket(db, at, contact.id, row.ticketId, 2)).resolves.toMatchObject({ revision: 2, status: 'open' });
  });

  it.each([['words', { textEnc: 'edited' }], ['digest', { digest: sha('edited') }], ['contact', { contactId: randomUUID() }], ['number', { revision: 7 }]])('never changes its %s', async (_name, change) => {
    const { db, row } = await aFirstRevision();
    await expect(db.update(supportTickets).set(change).where(eq(supportTickets.id, row.id))).rejects.toMatchObject(FROZEN);
  });

  it('changes its state', async () => {
    const { db, row } = await aFirstRevision();
    await expect(db.update(supportTickets).set({ status: 'escalated' }).where(eq(supportTickets.id, row.id))).resolves.toBeDefined();
  });

  it('cannot be of a contact of another company', async () => {
    const db = await createTestDb();
    const [mine, theirs] = [await aCompany(db), await aCompany(db, 'Other')];
    await expect(aTicket(db, mine, (await aContact(db, theirs)).id)).rejects.toMatchObject(refusedBy('support_tickets_contact'));
  });
});

describe('a classification', () => {
  async function pending() {
    const db = await createTestDb();
    const at = await aCompany(db);
    const contact = await aContact(db, at);
    return { db, at, contact, ...(await aClassification(db, at, contact.id)) };
  }
  const reviewer = { providerId: 'codex', vendorId: 'openai', modelId: 'm', revisionId: 'r', inferenceConfigHash: sha('config') } as const;
  const ready = { status: 'ready', classId: 'refund', requiresHuman: true, reviewer, decidedAt: LATER } as const;

  it('starts pending, with no class', async () => {
    const { row } = await pending();
    expect(row).toMatchObject({ status: 'pending', classId: null, requiresHuman: null, reviewer: null, reasonCodes: [], decidedAt: null });
  });

  it('is one operation for one revision and one binding', async () => {
    const { db, values } = await pending();
    await expect(db.insert(supportClassifications).values({ ...values, idempotencyKey: randomUUID() })).rejects.toMatchObject(refusedBy('support_classifications_once'));
    await expect(db.insert(supportClassifications).values({ ...values, bindingDigest: sha('other') })).rejects.toMatchObject(refusedBy('support_classifications_idempotency'));
  });

  it('cannot be of a revision of a ticket that does not exist', async () => {
    const { db, values } = await pending();
    await expect(db.insert(supportClassifications).values({ ...values, idempotencyKey: randomUUID(), ticketRevision: 9 })).rejects.toMatchObject(refusedBy('support_classifications_ticket'));
  });

  it.each([
    ['ready with no class', { status: 'ready', requiresHuman: true, reviewer, decidedAt: LATER }],
    ['ready with no word on a person', { status: 'ready', classId: 'refund', reviewer, decidedAt: LATER }],
    ['ready with no reviewer', { status: 'ready', classId: 'refund', requiresHuman: true, decidedAt: LATER }],
    ['ready with no time', { status: 'ready', classId: 'refund', requiresHuman: true, reviewer }],
    ['pending with a class', { classId: 'refund' }],
    ['unavailable with a class', { status: 'unavailable', classId: 'refund', decidedAt: LATER }],
    ['unavailable with no time', { status: 'unavailable' }],
  ] as const)('refuses one %s', async (_name, change) => {
    const { db, values } = await pending();
    await expect(db.update(supportClassifications).set(change).where(eq(supportClassifications.ticketId, values.ticketId))).rejects.toMatchObject(refusedBy('support_classifications_decision'));
  });

  it('stays what it was decided, and is never removed', async () => {
    const { db, row } = await pending();
    const where = eq(supportClassifications.id, row.id);
    await expect(db.delete(supportClassifications).where(where)).rejects.toMatchObject(FROZEN);
    await db.update(supportClassifications).set(ready).where(where);
    await expect(db.update(supportClassifications).set({ classId: 'safe', requiresHuman: false }).where(where)).rejects.toMatchObject(FROZEN);
  });

  it('keeps what it is of while still pending', async () => {
    const { db, row } = await pending();
    await expect(db.update(supportClassifications).set({ ticketDigest: sha('edited') }).where(eq(supportClassifications.id, row.id))).rejects.toMatchObject(FROZEN);
  });
});

describe('a certificate', () => {
  async function certified() {
    const db = await createTestDb();
    const at = await aCompany(db);
    const { check, run } = await aFinishedRun(db, at);
    const values = { checkId: check.id, bindingDigest: sha('binding'), reportId: run.id, evaluatedAt: EARLIER, validUntil: LATER };
    return { db, at, check, run, values, row: (await db.insert(modelCheckCertificates).values(values).returning())[0]! };
  }
  const ended = { status: 'invalidated', invalidatedReason: 'prompt', invalidatedAt: LATER } as const;

  it('starts active, and ends after it starts', async () => {
    const { db, values, row } = await certified();
    expect(row).toMatchObject({ status: 'active', invalidatedReason: null, invalidatedAt: null });
    await expect(db.insert(modelCheckCertificates).values({ ...values, bindingDigest: sha('other'), validUntil: EARLIER })).rejects.toMatchObject(refusedBy('model_check_certificates_validity'));
  });

  it('is the only active one of its check', async () => {
    const { db, values } = await certified();
    await expect(db.insert(modelCheckCertificates).values({ ...values, bindingDigest: sha('other') })).rejects.toMatchObject(refusedBy('model_check_certificates_one_active'));
  });

  it('leaves room for the next once it ended', async () => {
    const { db, values, row } = await certified();
    await db.update(modelCheckCertificates).set(ended).where(eq(modelCheckCertificates.id, row.id));
    await expect(db.insert(modelCheckCertificates).values({ ...values, bindingDigest: sha('next') })).resolves.toBeDefined();
  });

  it.each([['no reason', { status: 'invalidated', invalidatedAt: LATER }], ['no time', { status: 'invalidated', invalidatedReason: 'prompt' }], ['a reason while active', { invalidatedReason: 'prompt' }]] as const)('refuses an end with %s', async (_name, change) => {
    const { db, row } = await certified();
    await expect(db.update(modelCheckCertificates).set(change).where(eq(modelCheckCertificates.id, row.id))).rejects.toMatchObject(refusedBy('model_check_certificates_end'));
  });

  it('does not come back once it ended', async () => {
    const { db, row } = await certified();
    const where = eq(modelCheckCertificates.id, row.id);
    await db.update(modelCheckCertificates).set(ended).where(where);
    await expect(db.update(modelCheckCertificates).set({ status: 'active', invalidatedReason: null, invalidatedAt: null }).where(where)).rejects.toMatchObject(FROZEN);
  });

  it.each([['binding', { bindingDigest: sha('other') }], ['report', { reportId: randomUUID() }], ['end', { validUntil: new Date('2030-01-01T00:00:00.000Z') }], ['evaluation time', { evaluatedAt: LATER }]])('never changes its %s', async (_name, change) => {
    const { db, row } = await certified();
    await expect(db.update(modelCheckCertificates).set(change).where(eq(modelCheckCertificates.id, row.id))).rejects.toMatchObject(FROZEN);
  });

  it('goes with its check, as every row of a check does', async () => {
    const { db, check } = await certified();
    await db.delete(modelChecks).where(eq(modelChecks.id, check.id));
    expect(await db.select().from(modelCheckCertificates)).toEqual([]);
  });
});
