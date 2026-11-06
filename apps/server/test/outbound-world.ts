import { randomUUID } from 'node:crypto';
import type { CatalogValue, OutboundPolicyValue, OutboundSubmit } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { encryptSecret } from '../src/crypto/secrets.js';
import { outboundAccounts, outboundBindings, outboundCatalogRevisions, outboundChannels, outboundContacts, outboundMessages, outboundPermissions, outboundPolicies } from '../src/db/schema.js';
import { digestOf } from '../src/modules/outbound/checks.js';
import { recipientDigest } from '../src/modules/outbound/contacts.js';
import { beginDispatch, reserveDispatch, submitOutbound, type Authority } from '../src/modules/outbound/core.js';
import { company } from './department-owner-fixture.js';
import { sha } from './outbound-fixture.js';

/* A department with one channel that works: an account bound to its worker, a contact who agreed, a policy that reviews
   nothing and an approval rule that lets ten dollars go. Tests take away what each is about. Everything is synthetic. */
export const QUIET: OutboundPolicyValue = {
  timezone: 'Europe/Lisbon', accountDailyLimit: 50, domainDailyLimit: 200,
  sampling: { matureAfter: 0, firstPerSegment: 0, firstPerAuthor: 0, everyNth: 1000 },
  circuit: { windowHours: 24, minimumSample: 20, maxComplaints: 1, maxRefusals: 3, maxBounces: 5 },
};
const SINCE = '2026-01-01T00:00:00.000Z';
const slot = (type: 'price' | 'link' | 'claim' | 'variable' | 'unsubscribe', slotId: string = randomUUID()) => ({ kind: 'slot', slotId, type }) as const;
const text = (words: string) => ({ kind: 'text', text: words }) as const;

export type C = Awaited<ReturnType<typeof company>>;
/* What the builders below need of a company, however the test made it. */
export type Base = { db: C['db']; companyId: string; dev: { id: string }; ids: { ceo: string }; app: { ctx: C['app']['ctx'] } };
type Scope = { channelId?: string | null; productId?: string | null };

const localeOf = (value: CatalogValue): string | null => ('locale' in value ? value.locale : null);

/* A revision a person published, for the department. */
export async function published(c: Base, value: CatalogValue, scope: Scope = {}, entryId: string = randomUUID(), revision = 1) {
  const values = {
    companyId: c.companyId, departmentId: c.dev.id, productId: scope.productId ?? null, channelId: scope.channelId ?? null, entryId, revision, kind: value.kind, locale: localeOf(value), value, digest: digestOf(value),
    status: 'published', validFrom: new Date(SINCE), createdByKind: 'person', createdById: c.ids.ceo, publishedBy: c.ids.ceo, publishedAt: new Date(),
  } as const;
  return (await c.db.insert(outboundCatalogRevisions).values(values).returning())[0]!;
}

export async function aPolicyOf(c: Base, channelId: string, value: OutboundPolicyValue = QUIET, revision = 1) {
  return (await c.db.insert(outboundPolicies).values({ companyId: c.companyId, channelId, revision, digest: digestOf(value), value, createdBy: c.ids.ceo }).returning())[0]!;
}

type ChannelOver = { name?: string; audience?: 'direct' | 'public'; status?: 'new' | 'active' };

export async function aChannelOf(c: Base, over: ChannelOver = {}) {
  const values = { companyId: c.companyId, departmentId: c.dev.id, name: 'Mail', adapter: 'smtp', purpose: 'first_contact', audience: 'direct', status: 'active', createdBy: c.ids.ceo, ...over } as const;
  return (await c.db.insert(outboundChannels).values(values).returning())[0]!;
}

export async function anAccountOf(c: Base, channelId: string, agentId: string, label = 'One', senderDomain = 'acme.example') {
  const values = { companyId: c.companyId, departmentId: c.dev.id, channelId, senderDomain, label, configEnc: encryptSecret('{}', c.app.ctx.config.secret), createdBy: c.ids.ceo };
  const account = (await c.db.insert(outboundAccounts).values(values).returning())[0]!;
  const binding = (await c.db.insert(outboundBindings).values({ companyId: c.companyId, accountId: account.id, agentId, generation: 1, createdBy: c.ids.ceo }).returning())[0]!;
  return { account, binding };
}

export async function aContactOf(c: Base, address = 'ann@shop.example') {
  const values = { companyId: c.companyId, kind: 'email', addressEnc: encryptSecret(address, c.app.ctx.config.secret), addressHash: recipientDigest(address) } as const;
  return (await c.db.insert(outboundContacts).values(values).returning())[0]!;
}

export async function aPermissionOf(c: Base, contactId: string, channelId: string, purpose = 'first_contact') {
  return (await c.db.insert(outboundPermissions).values({ companyId: c.companyId, contactId, channelId, purpose, source: 'person', evidenceDigest: sha('agreed') }).returning())[0]!;
}

const PRICE: CatalogValue = { kind: 'price', amount: '10.00', currency: 'USD', scale: 2, rounding: 'half_up', discountId: null, termsId: null, validFrom: SINCE, validUntil: null };

/* What one channel's messages are made of: a template with a variable, a price, a link and the way to stop them. */
export async function partsOf(c: Base, channelId: string) {
  const variableSlot = randomUUID();
  const template = await published(c, { kind: 'template', locale: 'en', subject: 'Hello', parts: [text('Hello from '), slot('variable', variableSlot), text('. '), slot('price'), text(' '), slot('link'), text(' '), slot('unsubscribe')] });
  const price = await published(c, PRICE);
  const link = await published(c, { kind: 'link', url: 'https://shop.example/pricing' });
  const field = await published(c, { kind: 'variable', field: 'account_label' });
  const stop = await published(c, { kind: 'unsubscribe', locale: 'en', text: 'To stop these letters:' }, { channelId });
  const segment = await published(c, { kind: 'segment', name: 'Shops' });
  return { template, price, link, field, stop, segment, variableSlot };
}

/* A message of those parts, by reference, as an author writes one. */
export const documentOf = (parts: Awaited<ReturnType<typeof partsOf>>) => ({
  locale: 'en', templateId: parts.template.entryId, templateRevision: 1,
  blocks: [{ kind: 'price', id: parts.price.entryId, revision: 1 }, { kind: 'link', id: parts.link.entryId, revision: 1 }] as OutboundSubmit['document']['blocks'],
  variables: [{ slotId: parts.variableSlot, valueRef: parts.field.entryId }],
});

export async function letTenDollarsGo(c: C) {
  await c.setRule(c.ceoToken, c.dev.id, 'message', { mode: 'within_limits', limit: 100, unit: 'USD' });
  await c.setRule(c.ceoToken, c.dev.id, 'price', { mode: 'within_limits', limit: 100, unit: 'USD' });
}

export async function world(policy: OutboundPolicyValue = QUIET, over: ChannelOver = {}) {
  const c = await company({ PUBLIC_URL: 'https://hornhoof.example' });
  const channel = await aChannelOf(c, over);
  const policyRow = await aPolicyOf(c, channel.id, policy);
  const { account, binding } = await anAccountOf(c, channel.id, c.worker.id);
  const contact = await aContactOf(c);
  const permission = await aPermissionOf(c, contact.id, channel.id);
  const parts = await partsOf(c, channel.id);
  await letTenDollarsGo(c);
  const authority: Authority = { companyId: c.companyId, agentId: c.worker.id, departmentId: c.dev.id, jobId: null };
  const document = documentOf(parts);
  const input = (change: Partial<OutboundSubmit> = {}): OutboundSubmit => ({
    task: c.task.id, idempotencyKey: randomUUID(), channelId: channel.id, accountId: account.id, bindingGeneration: binding.generation, target: { kind: 'contact', contactId: contact.id },
    segmentId: parts.segment.entryId, document, scheduledAt: '2026-01-02T00:00:00.000Z', ...change,
  });
  const submit = (change: Partial<OutboundSubmit> = {}) => submitOutbound(c.app.ctx, authority, input(change));
  const messageOf = async (id: string) => (await c.db.select().from(outboundMessages).where(eq(outboundMessages.id, id)))[0]!;
  return { c, ctx: c.app.ctx, channel, policy: policyRow, account, binding, contact, permission, ...parts, authority, document, input, submit, messageOf };
}
export type World = Awaited<ReturnType<typeof world>>;

/* A message taken as far as the dispatcher takes it: past its reservation and its last look. */
export async function dispatched(w: World, messageId: string, now?: Date) {
  const reserved = await reserveDispatch(w.ctx, messageId, 1, now);
  return reserved.kind === 'reserved' ? beginDispatch(w.ctx, messageId, 1, now) : reserved;
}
