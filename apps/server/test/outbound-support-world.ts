import { randomUUID } from 'node:crypto';
import { canonicalJson, type CatalogValue, type ModelIdentity } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { encryptSecret } from '../src/crypto/secrets.js';
import { modelCheckDatasets, modelCheckRevisions, modelChecks, outboundAccounts, outboundBindings, outboundCatalogRevisions, outboundChannels, outboundContacts, outboundPermissions, outboundPolicies, supportTickets } from '../src/db/schema.js';
import { bindingDigest } from '../src/modules/model-checks/lifecycle.js';
import { recipientDigest } from '../src/modules/outbound/contacts.js';
import { OUTBOUND_CHECK_HASHES } from '../src/modules/outbound/evaluation-port.js';
import { company } from './department-owner-fixture.js';
import { POLICY, sha } from './outbound-fixture.js';

/* A sales department that answers tickets by mail: a channel, an account of its seller, a customer who wrote in and a catalog in
   three languages. Everything is synthetic. */
type Company = Awaited<ReturnType<typeof company>>;
export type SupportWorld = Awaited<ReturnType<typeof supportWorld>>;

const PUBLISHED = new Date('2026-11-06T12:00:00.000Z');
export const REVIEWER_MODEL: ModelIdentity = {
  providerId: 'openai_api',
  vendorId: 'openai',
  modelId: 'gpt-5-mini',
  revisionId: 'gpt-5-mini-2026-10',
  inferenceConfigHash: sha('cfg-support-reviewer'),
};

export const TAXONOMY_CLASSES = [
  { classId: 'how_to', requiresHuman: false, description: 'Routine product usage question' },
  { classId: 'refund_request', requiresHuman: true, description: 'Refund or billing credit request' },
  { classId: 'legal_contract', requiresHuman: true, description: 'Contractual or legal question' },
  { classId: 'uncertain', requiresHuman: true, description: 'Uncertain or ambiguous customer ask' },
];

export async function addCatalogRevision(
  c: Company,
  spec: {
    entryId?: string;
    revision?: number;
    kind: CatalogValue['kind'];
    locale: string | null;
    value: CatalogValue;
    status?: 'published' | 'proposed' | 'revoked';
    validUntil?: Date | null;
    channelId?: string | null;
  },
) {
  const status = spec.status ?? 'published';
  const [rev] = await c.db
    .insert(outboundCatalogRevisions)
    .values({
      companyId: c.companyId,
      entryId: spec.entryId ?? randomUUID(),
      revision: spec.revision ?? 1,
      departmentId: c.sales.id,
      channelId: spec.channelId ?? null,
      kind: spec.kind,
      locale: spec.locale,
      status,
      value: spec.value,
      digest: sha(canonicalJson(spec.value)),
      validFrom: new Date('2026-11-01T00:00:00.000Z'),
      validUntil: spec.validUntil ?? null,
      createdByKind: 'person',
      createdById: c.ids.sam,
      publishedBy: status === 'proposed' ? null : c.ids.sam,
      publishedAt: status === 'proposed' ? null : PUBLISHED,
      revokedAt: status === 'revoked' ? PUBLISHED : null,
    })
    .returning();
  return rev!;
}

export async function supportWorld() {
  const c = await company({ PUBLIC_URL: 'https://hornhoof.example' });
  await c.setOwner(c.ceoToken, c.sales.id, c.ids.sam);
  await c.setRule(c.samToken, c.sales.id, 'message', { mode: 'within_limits', limit: 100, unit: 'USD' });

  const [channel] = await c.db
    .insert(outboundChannels)
    .values({
      companyId: c.companyId,
      departmentId: c.sales.id,
      name: 'Support Mail',
      adapter: 'smtp',
      purpose: 'transactional_support',
      audience: 'direct',
      status: 'active',
      createdBy: c.ids.sam,
    })
    .returning();
  const [policy] = await c.db
    .insert(outboundPolicies)
    .values({ companyId: c.companyId, channelId: channel!.id, revision: 1, digest: sha('support-policy-1'), value: POLICY, createdBy: c.ids.sam })
    .returning();
  const [account] = await c.db
    .insert(outboundAccounts)
    .values({
      companyId: c.companyId,
      departmentId: c.sales.id,
      channelId: channel!.id,
      senderDomain: 'support.acme.example',
      label: 'Support Desk',
      configEnc: encryptSecret('{"pass":"SECRET_SMTP_KEY_999"}', c.app.ctx.config.secret),
      createdBy: c.ids.sam,
    })
    .returning();
  await c.db.insert(outboundBindings).values({ companyId: c.companyId, accountId: account!.id, agentId: c.seller.id, generation: 1, createdBy: c.ids.sam });

  const [contact] = await c.db
    .insert(outboundContacts)
    .values({
      companyId: c.companyId,
      kind: 'email',
      addressEnc: encryptSecret('ann@customer.example', c.app.ctx.config.secret),
      addressHash: recipientDigest('ann@customer.example'),
    })
    .returning();
  await c.db.insert(outboundPermissions).values({
    companyId: c.companyId,
    contactId: contact!.id,
    channelId: channel!.id,
    purpose: 'transactional_support',
    source: 'person',
    evidenceDigest: sha('ticket-opened-by-customer'),
  });

  const taxonomyRev = await addCatalogRevision(c, {
    kind: 'taxonomy',
    locale: null,
    value: { kind: 'taxonomy', classes: TAXONOMY_CLASSES },
  });

  for (const kind of ['support_classification', 'support_reply_review'] as const) {
    const thresholds = { falseAllowRate: 0, falseDenyRate: 0.2, classErrorRate: 0 };
    const [chk] = await c.db
      .insert(modelChecks)
      .values({
        companyId: c.companyId,
        departmentId: c.sales.id,
        kind,
        status: 'on',
        bindingDigest: sha(`support-binding-${kind}`),
        thresholds,
        thresholdsBy: c.ids.sam,
        validUntil: new Date('2026-11-12T00:00:00.000Z'),
      })
      .returning();
    const hashes = OUTBOUND_CHECK_HASHES[kind];
    const sourceListHash = sha('support-sources');
    const taxonomyHash = kind === 'support_classification' ? taxonomyRev.digest : null;
    await c.db.insert(modelCheckRevisions).values({
      checkId: chk!.id,
      definitionVersion: 1,
      checkerCodeHash: hashes.checkerCodeHash,
      promptHash: hashes.promptHash,
      outputSchemaHash: hashes.outputSchemaHash,
      sourceListHash,
      taxonomyHash,
      model: REVIEWER_MODEL,
      authorKind: 'person',
      authorId: c.ids.sam,
    });
    const datasetHash = sha(`support-dataset-${kind}`);
    const [ds] = await c.db
      .insert(modelCheckDatasets)
      .values({
        checkId: chk!.id,
        version: 1,
        hash: datasetHash,
        jsonlEnc: encryptSecret('{}', c.app.ctx.config.secret),
        cases: 2,
        holdoutCases: 1,
        mustBlockCases: 1,
        addedByKind: 'person',
        addedById: c.ids.sam,
      })
      .returning();
    const computedDigest = bindingDigest({
      schemaVersion: 1,
      companyId: c.companyId,
      departmentId: c.sales.id,
      productId: null,
      checkId: chk!.id,
      kind,
      definitionVersion: 1,
      ...hashes,
      sourceListHash,
      taxonomyHash,
      model: REVIEWER_MODEL,
      datasetVersion: ds!.id,
      datasetHash,
      thresholdsHash: sha(canonicalJson(thresholds)),
    });
    await c.db.update(modelChecks).set({ bindingDigest: computedDigest }).where(eq(modelChecks.id, chk!.id));
  }

  const slotKbEn = randomUUID();
  const slotLinkEn = randomUUID();
  const slotUnsubEn = randomUUID();
  const enTemplate = await addCatalogRevision(c, {
    kind: 'template',
    locale: 'en',
    value: {
      kind: 'template',
      locale: 'en',
      subject: 'Your support answer',
      parts: [
        { kind: 'text', text: 'Hello,\n' },
        { kind: 'slot', slotId: slotKbEn, type: 'knowledge' },
        { kind: 'text', text: '\nGuide: ' },
        { kind: 'slot', slotId: slotLinkEn, type: 'link' },
        { kind: 'text', text: '\n' },
        { kind: 'slot', slotId: slotUnsubEn, type: 'unsubscribe' },
      ],
    },
  });
  const enKb = await addCatalogRevision(c, {
    kind: 'knowledge',
    locale: 'en',
    value: { kind: 'knowledge', locale: 'en', text: 'Open Settings and press Reset password to receive a fresh sign-in link.' },
  });
  const enLink = await addCatalogRevision(c, {
    kind: 'link',
    locale: null,
    value: { kind: 'link', url: 'https://docs.acme.example/reset-password' },
  });
  await addCatalogRevision(c, {
    kind: 'unsubscribe',
    locale: 'en',
    value: { kind: 'unsubscribe', locale: 'en', text: 'Manage support notifications:' },
  });

  const ruTemplate = await addCatalogRevision(c, {
    kind: 'template',
    locale: 'ru',
    value: {
      kind: 'template',
      locale: 'ru',
      subject: 'Ответ службы поддержки',
      parts: [
        { kind: 'text', text: 'Здравствуйте,\n' },
        { kind: 'slot', slotId: randomUUID(), type: 'knowledge' },
        { kind: 'text', text: '\n' },
        { kind: 'slot', slotId: randomUUID(), type: 'unsubscribe' },
      ],
    },
  });
  const ruKb = await addCatalogRevision(c, {
    kind: 'knowledge',
    locale: 'ru',
    value: { kind: 'knowledge', locale: 'ru', text: 'Откройте настройки профиля и нажмите кнопку сброса пароля.' },
  });
  await addCatalogRevision(c, {
    kind: 'unsubscribe',
    locale: 'ru',
    value: { kind: 'unsubscribe', locale: 'ru', text: 'Управление уведомлениями:' },
  });

  const arTemplate = await addCatalogRevision(c, {
    kind: 'template',
    locale: 'ar',
    value: {
      kind: 'template',
      locale: 'ar',
      subject: 'رد فريق الدعم',
      parts: [
        { kind: 'text', text: 'مرحبا،\n' },
        { kind: 'slot', slotId: randomUUID(), type: 'knowledge' },
        { kind: 'text', text: '\n' },
        { kind: 'slot', slotId: randomUUID(), type: 'unsubscribe' },
      ],
    },
  });
  const arKb = await addCatalogRevision(c, {
    kind: 'knowledge',
    locale: 'ar',
    value: { kind: 'knowledge', locale: 'ar', text: 'افتح الإعدادات واختر إعادة تعيين كلمة المرور.' },
  });
  await addCatalogRevision(c, {
    kind: 'unsubscribe',
    locale: 'ar',
    value: { kind: 'unsubscribe', locale: 'ar', text: 'إلغاء الاشتراك:' },
  });

  const priceEntry = await addCatalogRevision(c, {
    kind: 'price',
    locale: null,
    value: {
      kind: 'price',
      amount: '49.00',
      currency: 'USD',
      scale: 2,
      rounding: 'half_up',
      discountId: null,
      termsId: null,
      validFrom: '2026-11-01T00:00:00.000Z',
      validUntil: null,
    },
  });

  const addTicket = async (text: string, revision = 1, ticketId: string = randomUUID(), forContactId: string = contact!.id, place: { departmentId?: string; productId?: string } = {}) => {
    const [row] = await c.db
      .insert(supportTickets)
      .values({
        companyId: c.companyId,
        departmentId: c.sales.id,
        ...place,
        ticketId,
        revision,
        contactId: forContactId,
        textEnc: encryptSecret(text, c.app.ctx.config.secret),
        digest: sha(`${ticketId}:${revision}:${text}`),
      })
      .returning();
    return row!;
  };

  const caller = { companyId: c.companyId, agentId: c.seller.id, authorProvider: 'claude' as const, authorVendorId: 'anthropic' };

  return {
    c,
    taskId: c.salesTask.id,
    channel: channel!,
    policy: policy!,
    account: account!,
    contact: contact!,
    enTemplate,
    enKb,
    enLink,
    ruTemplate,
    ruKb,
    arTemplate,
    arKb,
    priceEntry,
    addTicket,
    caller,
    taxonomy: taxonomyRev,
    documentEn: {
      locale: 'en',
      templateId: enTemplate.entryId,
      templateRevision: 1,
      blocks: [{ kind: 'knowledge', id: enKb.entryId, revision: 1 }, { kind: 'link', id: enLink.entryId, revision: 1 }],
      variables: [],
    },
  };
}
