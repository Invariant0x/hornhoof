import { randomUUID } from 'node:crypto';
import { canonicalJson } from '@hornhoof/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { encryptSecret } from '../src/crypto/secrets.js';
import {
  outboundAccounts,
  outboundApprovals,
  outboundAttempts,
  outboundBindings,
  outboundCatalogRevisions,
  outboundChannels,
  outboundContacts,
  outboundDailyUsage,
  outboundMessageRevisions,
  outboundMessages,
  outboundPolicies,
  requests,
  supportClassifications,
  supportTickets,
} from '../src/db/schema.js';
import type { SealedPayload } from '../src/modules/outbound/ports.js';
import { outboundViewRoutes } from '../src/modules/outbound/views.js';
import { company } from './department-owner-fixture.js';
import { POLICY, sha } from './outbound-fixture.js';

type Company = Awaited<ReturnType<typeof company>>;

const NOW = new Date('2026-11-06T12:00:00.000Z');
const SECRET_CFG = 'SECRET_CFG_MARKER_991_SMTP_PASSWORD';
const SECRET_PII = 'SECRET_PII_MARKER_992:ann@customer.example';
const SECRET_TICKET = 'SECRET_TICKET_LOG_993: raw customer stack trace and private token';
const SECRET_PROVIDER_RECEIPT = 'SECRET_PROVIDER_RECEIPT_994';

let current: Company | null = null;
afterEach(async () => {
  if (current) await current.app.close();
  current = null;
});

async function seedOutboundViewWorld() {
  const c = await company();
  current = c;
  outboundViewRoutes(c.app, c.app.ctx);
  await c.setOwner(c.ceoToken, c.sales.id, c.ids.sam);

  const [channel] = await c.db
    .insert(outboundChannels)
    .values({
      companyId: c.companyId,
      departmentId: c.sales.id,
      name: 'Sales Mail',
      adapter: 'smtp',
      purpose: 'first_contact',
      audience: 'direct',
      status: 'active',
      createdBy: c.ids.sam,
    })
    .returning();
  const [policy] = await c.db
    .insert(outboundPolicies)
    .values({ companyId: c.companyId, channelId: channel!.id, revision: 1, digest: sha('sales-policy-1'), value: POLICY, createdBy: c.ids.sam })
    .returning();
  const [account] = await c.db
    .insert(outboundAccounts)
    .values({
      companyId: c.companyId,
      departmentId: c.sales.id,
      channelId: channel!.id,
      senderDomain: 'mail.acme.example',
      label: 'Sales Primary',
      configEnc: encryptSecret(JSON.stringify({ smtpPassword: SECRET_CFG }), c.app.ctx.config.secret),
      createdBy: c.ids.sam,
    })
    .returning();
  await c.db.insert(outboundBindings).values({ companyId: c.companyId, accountId: account!.id, agentId: c.seller.id, generation: 2, createdBy: c.ids.sam });

  const [contact] = await c.db
    .insert(outboundContacts)
    .values({
      companyId: c.companyId,
      kind: 'email',
      addressEnc: encryptSecret(SECRET_PII, c.app.ctx.config.secret),
      addressHash: sha(SECRET_PII),
    })
    .returning();

  const tplId = randomUUID();
  const tplValue = {
    kind: 'template' as const,
    locale: 'en',
    subject: 'Quarterly plan overview',
    parts: [
      { kind: 'text' as const, text: 'Plan price: ' },
      { kind: 'slot' as const, slotId: randomUUID(), type: 'price' as const },
      { kind: 'text' as const, text: '\nDetails: ' },
      { kind: 'slot' as const, slotId: randomUUID(), type: 'link' as const },
    ],
  };
  await c.db.insert(outboundCatalogRevisions).values({
    companyId: c.companyId,
    entryId: tplId,
    revision: 3,
    departmentId: c.sales.id,
    kind: 'template',
    locale: 'en',
    status: 'published',
    value: tplValue,
    digest: sha(canonicalJson(tplValue)),
    validFrom: new Date('2026-11-01T00:00:00.000Z'),
    createdByKind: 'person',
    createdById: c.ids.sam,
    publishedBy: c.ids.sam,
    publishedAt: NOW,
  });

  const priceId = randomUUID();
  const priceValue = {
    kind: 'price' as const,
    amount: '29.00',
    currency: 'USD',
    scale: 2,
    rounding: 'half_up' as const,
    discountId: null,
    termsId: null,
    validFrom: '2026-11-01T00:00:00.000Z',
    validUntil: null,
  };
  await c.db.insert(outboundCatalogRevisions).values({
    companyId: c.companyId,
    entryId: priceId,
    revision: 2,
    departmentId: c.sales.id,
    kind: 'price',
    locale: null,
    status: 'published',
    value: priceValue,
    digest: sha(canonicalJson(priceValue)),
    validFrom: new Date('2026-11-01T00:00:00.000Z'),
    createdByKind: 'person',
    createdById: c.ids.sam,
    publishedBy: c.ids.sam,
    publishedAt: NOW,
  });

  const linkId = randomUUID();
  const linkValue = { kind: 'link' as const, url: 'https://acme.example/pricing' };
  await c.db.insert(outboundCatalogRevisions).values({
    companyId: c.companyId,
    entryId: linkId,
    revision: 1,
    departmentId: c.sales.id,
    kind: 'link',
    locale: null,
    status: 'published',
    value: linkValue,
    digest: sha(canonicalJson(linkValue)),
    validFrom: new Date('2026-11-01T00:00:00.000Z'),
    createdByKind: 'person',
    createdById: c.ids.sam,
    publishedBy: c.ids.sam,
    publishedAt: NOW,
  });

  const segmentId = randomUUID();
  const segmentValue = { kind: 'segment' as const, name: 'Verified retail leads' };
  await c.db.insert(outboundCatalogRevisions).values({
    companyId: c.companyId,
    entryId: segmentId,
    revision: 1,
    departmentId: c.sales.id,
    kind: 'segment',
    locale: null,
    status: 'published',
    value: segmentValue,
    digest: sha(canonicalJson(segmentValue)),
    validFrom: new Date('2026-11-01T00:00:00.000Z'),
    createdByKind: 'person',
    createdById: c.ids.sam,
    publishedBy: c.ids.sam,
    publishedAt: NOW,
  });

  const [waitingMsg] = await c.db
    .insert(outboundMessages)
    .values({
      companyId: c.companyId,
      departmentId: c.sales.id,
      taskId: c.salesTask.id,
      authorAgentId: c.seller.id,
      idempotencyKey: randomUUID(),
      requestDigest: sha('req-1'),
      channelId: channel!.id,
      accountId: account!.id,
      bindingGeneration: 2,
      targetKind: 'contact',
      contactId: contact!.id,
      segmentId,
      status: 'waiting_approval',
      reasonCodes: ['approval_required'],
      scheduledAt: NOW,
    })
    .returning();

  const sealedPayload: SealedPayload = {
    recipient: SECRET_PII,
    subject: 'Quarterly plan overview',
    text: 'Plan price: $29.00\nDetails: https://acme.example/pricing\nUnsubscribe https://acme.example/u/1',
  };
  const contentDigest = sha('frozen-msg-1');
  const sourcesDigest = sha('sources-msg-1');
  await c.db.insert(outboundMessageRevisions).values({
    companyId: c.companyId,
    messageId: waitingMsg!.id,
    revision: 1,
    document: {
      locale: 'en',
      templateId: tplId,
      templateRevision: 3,
      blocks: [
        { kind: 'price', id: priceId, revision: 2 },
        { kind: 'link', id: linkId, revision: 1 },
      ],
      variables: [],
    },
    contentDigest,
    sealedEnc: encryptSecret(canonicalJson(sealedPayload), c.app.ctx.config.secret),
    sourceRevisionsDigest: sourcesDigest,
    policyId: policy!.id,
    policyDigest: policy!.digest,
  });

  const [msgReq] = await c.db
    .insert(requests)
    .values({
      companyId: c.companyId,
      taskId: c.salesTask.id,
      agentId: c.seller.id,
      kind: 'approval',
      text: 'Approve outbound message to verified retail lead',
      decisionTopic: 'task',
      approvalChannel: 'message',
      approvalKind: 'first_contact',
    })
    .returning();
  await c.db.insert(outboundApprovals).values({
    companyId: c.companyId,
    requestId: msgReq!.id,
    kind: 'message',
    messageId: waitingMsg!.id,
    messageRevision: 1,
    contentDigest,
    accountId: account!.id,
    bindingGeneration: 2,
    policyDigest: policy!.digest,
    sourceRevisionsDigest: sourcesDigest,
    authorityFingerprint: sha('sam-sales-owner'),
  });

  const [approachReq] = await c.db
    .insert(requests)
    .values({
      companyId: c.companyId,
      taskId: c.salesTask.id,
      agentId: c.seller.id,
      kind: 'approval',
      text: 'Approve outbound approach for Verified retail leads',
      decisionTopic: 'task',
      approvalChannel: 'message',
      approvalKind: 'approach',
    })
    .returning();
  await c.db.insert(outboundApprovals).values({
    companyId: c.companyId,
    requestId: approachReq!.id,
    kind: 'approach',
    channelId: channel!.id,
    templateId: tplId,
    templateRevision: 3,
    segmentId,
    locale: 'en',
    policyDigest: policy!.digest,
    sourceRevisionsDigest: sourcesDigest,
    authorityFingerprint: sha('sam-sales-owner'),
  });

  const [unknownMsg] = await c.db
    .insert(outboundMessages)
    .values({
      companyId: c.companyId,
      departmentId: c.sales.id,
      taskId: c.salesTask.id,
      authorAgentId: c.seller.id,
      idempotencyKey: randomUUID(),
      requestDigest: sha('req-unknown'),
      channelId: channel!.id,
      accountId: account!.id,
      bindingGeneration: 2,
      targetKind: 'contact',
      contactId: contact!.id,
      segmentId,
      status: 'unknown',
      reasonCodes: ['delivery_unknown'],
      scheduledAt: NOW,
    })
    .returning();
  await c.db.insert(outboundMessageRevisions).values({
    companyId: c.companyId,
    messageId: unknownMsg!.id,
    revision: 1,
    document: { locale: 'en', templateId: tplId, templateRevision: 3, blocks: [], variables: [] },
    contentDigest: sha('unknown-bytes'),
    sealedEnc: encryptSecret(canonicalJson(sealedPayload), c.app.ctx.config.secret),
    sourceRevisionsDigest: sourcesDigest,
    policyId: policy!.id,
    policyDigest: policy!.digest,
  });
  const [sentMsg] = await c.db
    .insert(outboundMessages)
    .values({
      companyId: c.companyId,
      departmentId: c.sales.id,
      taskId: c.salesTask.id,
      authorAgentId: c.seller.id,
      idempotencyKey: randomUUID(),
      requestDigest: sha('req-sent'),
      channelId: channel!.id,
      accountId: account!.id,
      bindingGeneration: 2,
      targetKind: 'contact',
      contactId: contact!.id,
      segmentId,
      status: 'sent',
      reasonCodes: [],
      scheduledAt: NOW,
    })
    .returning();
  await c.db.insert(outboundMessageRevisions).values({
    companyId: c.companyId,
    messageId: sentMsg!.id,
    revision: 1,
    document: { locale: 'en', templateId: tplId, templateRevision: 3, blocks: [], variables: [] },
    contentDigest: sha('sent-bytes'),
    sealedEnc: encryptSecret(canonicalJson(sealedPayload), c.app.ctx.config.secret),
    sourceRevisionsDigest: sourcesDigest,
    policyId: policy!.id,
    policyDigest: policy!.digest,
  });

  const [acctBucket] = await c.db
    .insert(outboundDailyUsage)
    .values({ companyId: c.companyId, scope: 'account', scopeKey: account!.id, day: '2026-11-06', timezone: 'Europe/Lisbon', reserved: 1, unknown: 1, accepted: 1, limitVersion: 1 })
    .returning();
  const [domBucket] = await c.db
    .insert(outboundDailyUsage)
    .values({ companyId: c.companyId, scope: 'domain', scopeKey: account!.senderDomain, day: '2026-11-06', timezone: 'Europe/Lisbon', reserved: 1, unknown: 1, accepted: 1, limitVersion: 1 })
    .returning();
  await c.db.insert(outboundAttempts).values({
    companyId: c.companyId,
    messageId: sentMsg!.id,
    messageRevision: 1,
    accountId: account!.id,
    bindingGeneration: 2,
    configGeneration: 1,
    channelGeneration: 1,
    accountBucketId: acctBucket!.id,
    domainBucketId: domBucket!.id,
    status: 'accepted',
    providerReceipt: SECRET_PROVIDER_RECEIPT,
    startedAt: NOW,
    endedAt: NOW,
  });
  await c.db.insert(outboundAttempts).values({
    companyId: c.companyId,
    messageId: unknownMsg!.id,
    messageRevision: 1,
    accountId: account!.id,
    bindingGeneration: 2,
    configGeneration: 1,
    channelGeneration: 1,
    accountBucketId: acctBucket!.id,
    domainBucketId: domBucket!.id,
    status: 'unknown',
    safeCode: 'timeout',
    startedAt: NOW,
    endedAt: NOW,
  });

  const ticketUuid = randomUUID();
  const [ticket] = await c.db
    .insert(supportTickets)
    .values({
      companyId: c.companyId,
      departmentId: c.sales.id,
      ticketId: ticketUuid,
      revision: 1,
      contactId: contact!.id,
      status: 'escalated',
      externalRef: 'TKT-77',
      textEnc: encryptSecret(SECRET_TICKET, c.app.ctx.config.secret),
      digest: sha(SECRET_TICKET),
    })
    .returning();
  await c.db.insert(supportClassifications).values({
    companyId: c.companyId,
    ticketId: ticket!.ticketId,
    ticketRevision: 1,
    ticketDigest: ticket!.digest,
    bindingDigest: sha('binding-77'),
    idempotencyKey: randomUUID(),
    status: 'ready',
    classId: 'refund_request',
    requiresHuman: true,
    reasonCodes: ['requires_human'],
    reviewer: {
      providerId: 'openai_api',
      vendorId: 'openai',
      modelId: 'gpt-5-mini',
      revisionId: 'gpt-5-mini-2026-10',
      inferenceConfigHash: sha('cfg'),
    },
    decidedAt: NOW,
  });

  return { c, msgReq: msgReq!, approachReq: approachReq!, waitingMsg: waitingMsg!, unknownMsg: unknownMsg!, ticketUuid, channel: channel!, account: account! };
}

describe('safe outbound & bound approval read views (#447 T8-17)', () => {
  it('returns exact frozen content, catalog revisions, unknown recovery guidance, and escalations to the department owner with zero credential or PII leaks', async () => {
    const w = await seedOutboundViewWorld();

    const overviewRes = await w.c.app.inject({
      method: 'GET',
      url: '/api/outbound',
      headers: { cookie: w.c.samToken },
    });
    expect(overviewRes.statusCode).toBe(200);
    const overviewBody = overviewRes.body;
    for (const forbidden of [SECRET_CFG, SECRET_PII, SECRET_TICKET, SECRET_PROVIDER_RECEIPT, 'ann@customer.example']) {
      expect(overviewBody).not.toContain(forbidden);
    }

    const dto = overviewRes.json();
    expect(dto.channels).toHaveLength(1);
    expect(dto.channels[0].accounts[0]).toMatchObject({
      label: 'Sales Primary',
      senderDomain: 'mail.acme.example',
      available: false,
    });

    const unknownItem = dto.messages.find((m: { id: string }) => m.id === w.unknownMsg.id);
    expect(unknownItem).toMatchObject({
      status: 'unknown',
      unknownRecovery: {
        safeCode: 'timeout',
        quotaHeld: true,
        nextActionCode: 'check_receiver_before_resend',
      },
    });

    expect(dto.escalations).toHaveLength(1);
    expect(dto.escalations[0]).toMatchObject({
      ticketId: w.ticketUuid,
      status: 'escalated',
      classId: 'refund_request',
      canAnswer: true,
      ownerPersonId: w.c.ids.sam,
    });

    const msgApprovalRes = await w.c.app.inject({
      method: 'GET',
      url: `/api/requests/${w.msgReq.id}/outbound-approval`,
      headers: { cookie: w.c.samToken },
    });
    expect(msgApprovalRes.statusCode).toBe(200);
    for (const forbidden of [SECRET_CFG, SECRET_PII, SECRET_TICKET, 'ann@customer.example']) {
      expect(msgApprovalRes.body).not.toContain(forbidden);
    }
    const msgApproval = msgApprovalRes.json();
    expect(msgApproval).toMatchObject({
      kind: 'message',
      requestId: w.msgReq.id,
      canAnswer: true,
      rendered: {
        subject: 'Quarterly plan overview',
        body: 'Plan price: $29.00\nDetails: https://acme.example/pricing\nUnsubscribe https://acme.example/u/1',
      },
    });
    expect(msgApproval.sources.map((s: { kind: string; revision: number }) => `${s.kind}@${s.revision}`).sort()).toEqual([
      'link@1',
      'price@2',
      'template@3',
    ]);

    const approachRes = await w.c.app.inject({
      method: 'GET',
      url: `/api/requests/${w.approachReq.id}/outbound-approval`,
      headers: { cookie: w.c.samToken },
    });
    expect(approachRes.statusCode).toBe(200);
    expect(approachRes.json()).toMatchObject({
      kind: 'approach',
      requestId: w.approachReq.id,
      canAnswer: true,
      segment: { name: 'Verified retail leads', revision: 1 },
      template: { revision: 3, locale: 'en', subject: 'Quarterly plan overview' },
    });
  });

  it('distinguishes read-only whole-company viewers from decision owners and denies cross-department or unauthenticated callers', async () => {
    const w = await seedOutboundViewWorld();

    const wesOverview = await w.c.app.inject({
      method: 'GET',
      url: '/api/outbound',
      headers: { cookie: w.c.wholeToken },
    });
    expect(wesOverview.statusCode).toBe(200);
    const wesDto = wesOverview.json();
    expect(wesDto.escalations[0].canAnswer).toBe(false);
    expect(wesDto.approvals.every((a: { canAnswer: boolean }) => a.canAnswer === false)).toBe(true);

    const wesBound = await w.c.app.inject({
      method: 'GET',
      url: `/api/requests/${w.msgReq.id}/outbound-approval`,
      headers: { cookie: w.c.wholeToken },
    });
    expect(wesBound.statusCode).toBe(200);
    expect(wesBound.json()).toMatchObject({
      canAnswer: false,
      decidedBy: { kind: 'owner_and_ceo' },
    });

    const danaOverview = await w.c.app.inject({
      method: 'GET',
      url: `/api/outbound?department=${w.c.sales.id}`,
      headers: { cookie: w.c.danaToken },
    });
    expect(danaOverview.statusCode).toBe(404);

    const danaBound = await w.c.app.inject({
      method: 'GET',
      url: `/api/requests/${w.msgReq.id}/outbound-approval`,
      headers: { cookie: w.c.danaToken },
    });
    expect(danaBound.statusCode).toBe(404);

    const anonBound = await w.c.app.inject({
      method: 'GET',
      url: `/api/requests/${w.msgReq.id}/outbound-approval`,
    });
    expect(anonBound.statusCode).toBe(401);
  });
});
