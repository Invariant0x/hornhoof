import { createHash, randomUUID } from 'node:crypto';
import type { OutboundPolicyValue } from '@hornhoof/protocol';
import { agents, companies, departments, modelCheckDatasets, modelCheckEvaluations, modelCheckRevisions, modelChecks, outboundAccounts, outboundApprovals, outboundBindings, outboundCatalogRevisions, outboundChannels, outboundContacts, outboundDailyUsage, outboundMessageRevisions, outboundMessages, outboundPermissions, outboundPolicies, people, requests, supportClassifications, supportTickets, tasks } from '../src/db/schema.js';
import type { createTestDb } from './helpers.js';
import { binding } from './model-check-fixture.js';

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

/* Rows of the outbound tables for tests of what the database itself refuses. They hold no real price, contact or consent. */
export const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
export const POLICY: OutboundPolicyValue = {
  timezone: 'Europe/Lisbon', accountDailyLimit: 50, domainDailyLimit: 200,
  sampling: { matureAfter: 50, firstPerSegment: 5, firstPerAuthor: 5, everyNth: 10 },
  circuit: { windowHours: 24, minimumSample: 20, maxComplaints: 1, maxRefusals: 3, maxBounces: 5 },
};
export const PRICE = { kind: 'price', amount: '10.00', currency: 'USD', scale: 2, rounding: 'half_up', discountId: null, termsId: null, validFrom: '2026-11-01T00:00:00.000Z', validUntil: null } as const;
const NOW = new Date('2026-11-06T10:00:00.000Z');

/* A company with a department and a product in it, a person who owns them, an author and a question of that author. */
export async function aCompany(db: TestDb, name = 'Acme') {
  const [company] = await db.insert(companies).values({ name }).returning();
  const companyId = company!.id;
  const [person] = await db.insert(people).values({ companyId, name: 'Dana', email: `dana@${name}.example`, status: 'active', scopeKind: 'listed' }).returning();
  const [department] = await db.insert(departments).values({ companyId, templateKey: 'sales', roleCode: 'SAL' }).returning();
  const [product] = await db.insert(departments).values({ companyId, parentId: department!.id, roleCode: 'PRD' }).returning();
  const [agent] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Rita', departmentId: department!.id, model: '' }).returning();
  const [other] = await db.insert(agents).values({ companyId, kind: 'worker', name: 'Omar', departmentId: department!.id, model: '' }).returning();
  const [task] = await db.insert(tasks).values({ companyId, number: 1, title: 'Write to shops', departmentId: department!.id, assigneeAgentId: agent!.id }).returning();
  return { companyId, person: person!, department: department!, product: product!, agent: agent!, other: other!, task: task! };
}
export type Company = Awaited<ReturnType<typeof aCompany>>;

export async function aChannel(db: TestDb, at: Company, name = 'Mail') {
  const values = { companyId: at.companyId, departmentId: at.department.id, name, adapter: 'smtp', purpose: 'first_contact', audience: 'direct', createdBy: at.person.id } as const;
  return (await db.insert(outboundChannels).values(values).returning())[0]!;
}

export async function aPolicy(db: TestDb, at: Company, channelId: string, revision = 1) {
  return (await db.insert(outboundPolicies).values({ companyId: at.companyId, channelId, revision, digest: sha(`policy ${revision}`), value: POLICY, createdBy: at.person.id }).returning())[0]!;
}

export async function anAccount(db: TestDb, at: Company, channelId: string, label = 'One') {
  const values = { companyId: at.companyId, departmentId: at.department.id, channelId, senderDomain: 'acme.example', label, configEnc: 'sealed', createdBy: at.person.id };
  return (await db.insert(outboundAccounts).values(values).returning())[0]!;
}

export async function aBinding(db: TestDb, at: Company, accountId: string, agentId = at.agent.id, generation = 1) {
  return (await db.insert(outboundBindings).values({ companyId: at.companyId, accountId, agentId, generation, createdBy: at.person.id }).returning())[0]!;
}

export async function aContact(db: TestDb, at: Company, address = 'ann@shop.example') {
  return (await db.insert(outboundContacts).values({ companyId: at.companyId, kind: 'email', addressEnc: 'sealed', addressHash: sha(address) }).returning())[0]!;
}

export async function aPermission(db: TestDb, at: Company, contactId: string, channelId: string) {
  const values = { companyId: at.companyId, contactId, channelId, purpose: 'first_contact', source: 'person', evidenceDigest: sha('evidence') };
  return (await db.insert(outboundPermissions).values(values).returning())[0]!;
}

export async function aRevision(db: TestDb, at: Company, entryId: string = randomUUID(), revision = 1) {
  const values = { companyId: at.companyId, departmentId: at.department.id, entryId, revision, kind: 'price', value: PRICE, digest: sha('price'), createdByKind: 'person', createdById: at.person.id } as const;
  return (await db.insert(outboundCatalogRevisions).values(values).returning())[0]!;
}

/* The way to a message to one contact: its channel, policy, account, binding and contact, and the message with its bytes. */
export async function aMessage(db: TestDb, at: Company) {
  const channel = await aChannel(db, at);
  const policy = await aPolicy(db, at, channel.id);
  const account = await anAccount(db, at, channel.id);
  const bound = await aBinding(db, at, account.id);
  const contact = await aContact(db, at);
  const values = {
    companyId: at.companyId, departmentId: at.department.id, taskId: at.task.id, authorAgentId: at.agent.id, idempotencyKey: randomUUID(), requestDigest: sha('request'),
    channelId: channel.id, accountId: account.id, bindingGeneration: bound.generation, targetKind: 'contact', contactId: contact.id, segmentId: randomUUID(), status: 'scheduled', scheduledAt: NOW,
  } as const;
  const message = (await db.insert(outboundMessages).values(values).returning())[0]!;
  return { channel, policy, account, bound, contact, message, values };
}
export type Sending = Awaited<ReturnType<typeof aMessage>>;

export async function theBytes(db: TestDb, at: Company, sending: Sending, revision = 1) {
  const document = { locale: 'en', templateId: randomUUID(), templateRevision: 1, blocks: [], variables: [] };
  const values = { companyId: at.companyId, messageId: sending.message.id, revision, document, contentDigest: sha(`bytes ${revision}`), sealedEnc: 'sealed', sourceRevisionsDigest: sha('sources'), policyId: sending.policy.id, policyDigest: sending.policy.digest };
  return (await db.insert(outboundMessageRevisions).values(values).returning())[0]!;
}

export async function aBucket(db: TestDb, at: Company, scope: 'account' | 'domain', scopeKey: string, day = '2026-11-06') {
  return (await db.insert(outboundDailyUsage).values({ companyId: at.companyId, scope, scopeKey, day, timezone: 'Europe/Lisbon', limitVersion: 1 }).returning())[0]!;
}

/* One attempt of a message with its bytes, its two buckets and all its generations. */
export async function attemptValues(db: TestDb, at: Company, sending: Sending) {
  await theBytes(db, at, sending);
  const account = await aBucket(db, at, 'account', sending.account.id);
  const domain = await aBucket(db, at, 'domain', sending.account.senderDomain);
  return {
    companyId: at.companyId, messageId: sending.message.id, messageRevision: 1, accountId: sending.account.id, bindingGeneration: 1, configGeneration: 1, channelGeneration: 1,
    accountBucketId: account.id, domainBucketId: domain.id, status: 'reserved',
  } as const;
}

export async function aRequest(db: TestDb, at: Company) {
  return (await db.insert(requests).values({ companyId: at.companyId, taskId: at.task.id, agentId: at.agent.id, kind: 'question', text: 'Send this?' }).returning())[0]!;
}

export const messageApprovalValues = (at: Company, sending: Sending, requestId: string) => ({
  companyId: at.companyId, requestId, kind: 'message', messageId: sending.message.id, messageRevision: 1, contentDigest: sha('bytes 1'), accountId: sending.account.id, bindingGeneration: 1,
  policyDigest: sending.policy.digest, sourceRevisionsDigest: sha('sources'), authorityFingerprint: sha('authority'),
} as const);

export const approachApprovalValues = (at: Company, channelId: string, requestId: string) => ({
  companyId: at.companyId, requestId, kind: 'approach', channelId, templateId: randomUUID(), templateRevision: 1, segmentId: randomUUID(), locale: 'en',
  policyDigest: sha('policy'), sourceRevisionsDigest: sha('sources'), authorityFingerprint: sha('authority'),
} as const);

export async function anApproval(db: TestDb, at: Company, sending: Sending) {
  await theBytes(db, at, sending);
  const request = await aRequest(db, at);
  return (await db.insert(outboundApprovals).values(messageApprovalValues(at, sending, request.id)).returning())[0]!;
}

export async function aTicket(db: TestDb, at: Company, contactId: string, ticketId: string = randomUUID(), revision = 1) {
  const values = { companyId: at.companyId, departmentId: at.department.id, ticketId, revision, contactId, textEnc: 'sealed', digest: sha(`ticket ${revision}`) };
  return (await db.insert(supportTickets).values(values).returning())[0]!;
}

export async function aClassification(db: TestDb, at: Company, contactId: string) {
  const ticket = await aTicket(db, at, contactId);
  const values = { companyId: at.companyId, ticketId: ticket.ticketId, ticketRevision: ticket.revision, ticketDigest: ticket.digest, bindingDigest: sha('binding'), idempotencyKey: randomUUID() };
  return { ticket, values, row: (await db.insert(supportClassifications).values(values).returning())[0]! };
}

/* A check of the department with one finished run: what a certificate points at. */
export async function aFinishedRun(db: TestDb, at: Company) {
  const [check] = await db.insert(modelChecks).values({ companyId: at.companyId, departmentId: at.department.id, kind: 'outbound_review' }).returning();
  const author = { authorKind: 'person', authorId: at.person.id } as const;
  const [revision] = await db.insert(modelCheckRevisions).values({ checkId: check!.id, definitionVersion: 1, checkerCodeHash: sha('code'), promptHash: sha('prompt'), outputSchemaHash: sha('output'), sourceListHash: sha('list'), model: binding().model, ...author }).returning();
  const [dataset] = await db.insert(modelCheckDatasets).values({ checkId: check!.id, version: 1, hash: sha('set'), jsonlEnc: 'sealed', cases: 1, holdoutCases: 0, mustBlockCases: 0, addedByKind: 'person', addedById: at.person.id }).returning();
  const [run] = await db.insert(modelCheckEvaluations).values({ checkId: check!.id, revisionId: revision!.id, datasetId: dataset!.id, binding: binding(), bindingDigest: sha('binding'), trigger: 'change', dedupKey: 'one' }).returning();
  return { check: check!, run: run! };
}
