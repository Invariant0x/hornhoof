import { randomUUID } from 'node:crypto';
import { canonicalJson } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { encryptSecret } from '../src/crypto/secrets.js';
import {
  agents,
  outboundAccounts,
  outboundApprovals,
  outboundBindings,
  outboundCatalogEntries,
  outboundCatalogRevisions,
  outboundChannels,
  outboundContacts,
  outboundDailyUsage,
  outboundMessageRevisions,
  outboundMessages,
  outboundPolicies,
  outboundSegments,
  outboundSendAttempts,
  requests,
  supportClassifications,
  supportTickets,
} from '../src/db/schema.js';
import type { SealedPayload } from '../src/modules/outbound/ports.js';
import { outboundViewRoutes } from '../src/modules/outbound/views.js';
import { company, type Company } from './department-owner-fixture.js';
import { POLICY, sha } from './outbound-fixture.js';

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
  await c.setOwner(c.sales, c.ids.dana);
  await c.db.update(agents).set({ departmentId: c.sales }).where(eq(agents.id, c.worker));
  const taskId = await c.task({ department: c.sales, assignee: c.worker, title: 'Send verified updates' });

  const [channel] = await c.db
    .insert(outboundChannels)
    .values({
      companyId: c.companyId,
      departmentId: c.sales,
      name: 'Sales Mail',
      adapter: 'smtp',
      purpose: 'first_contact',
      audience: 'direct',
      status: 'active',
      createdBy: c.ids.dana,
    })
    .returning();
  const [policy] = await c.db
    .insert(outboundPolicies)
    .values({ companyId: c.companyId, channelId: channel!.id, revision: 1, digest: sha('sales-policy-1'), value: POLICY, createdBy: c.ids.dana })
    .returning();
  const [account] = await c.db
    .insert(outboundAccounts)
    .values({
      companyId: c.companyId,
      departmentId: c.sales,
      channelId: channel!.id,
      senderDomain: 'mail.acme.example',
      label: 'Sales Primary',
      configEnc: encryptSecret(JSON.stringify({ smtpPassword: SECRET_CFG }), c.app.ctx.config.secretKey),
      createdBy: c.ids.dana,
    })
    .returning();
  await c.db.insert(outboundBindings).values({ companyId: c.companyId, accountId: account!.id, agentId: c.worker, generation: 2, createdBy: c.ids.dana });

  const [contact] = await c.db
    .insert(outboundContacts)
    .values({
      companyId: c.companyId,
      kind: 'email',
      addressEnc: encryptSecret(SECRET_PII, c.app.ctx.config.secretKey),
      addressHash: sha(SECRET_PII),
    })
    .returning();

  const [tplEntry] = await c.db
    .insert(outboundCatalogEntries)
    .values({ companyId: c.companyId, departmentId: c.sales, kind: 'template', slug: 'intro-en', createdBy: c.ids.dana })
    .returning();
  const tplValue = {
    kind: 'template' as const,
    subject: 'Quarterly plan overview',
    parts: [
      { kind: 'text' as const, text: 'Plan price: ' },
      { kind: 'slot' as const, slotId: 'p1', type: 'price' as const },
      { kind: 'text' as const, text: '\nDetails: ' },
      { kind: 'slot' as const, slotId: 'l1', type: 'link' as const },
    ],
  };
  await c.db.insert(outboundCatalogRevisions).values({
    companyId: c.companyId,
    entryId: tplEntry!.id,
    revision: 3,
    departmentId: c.sales,
    kind: 'template',
    locale: 'en',
    status: 'published',
    value: tplValue,
    digest: sha(canonicalJson(tplValue)),
    validFrom: new Date('2026-11-01T00:00:00.000Z'),
    createdByKind: 'person',
    createdById: c.ids.dana,
    approvedBy: c.ids.dana,
    approvedAt: NOW,
  });

  const [priceEntry] = await c.db
    .insert(outboundCatalogEntries)
    .values({ companyId: c.companyId, departmentId: c.sales, kind: 'price', slug: 'pro-monthly', createdBy: c.ids.dana })
    .returning();
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
    entryId: priceEntry!.id,
    revision: 2,
    departmentId: c.sales,
    kind: 'price',
    locale: null,
    status: 'published',
    value: priceValue,
    digest: sha(canonicalJson(priceValue)),
    validFrom: new Date('2026-11-01T00:00:00.000Z'),
    createdByKind: 'person',
    createdById: c.ids.dana,
    approvedBy: c.ids.dana,
    approvedAt: NOW,
  });

  const [linkEntry] = await c.db
    .insert(outboundCatalogEntries)
    .values({ companyId: c.companyId, departmentId: c.sales, kind: 'link', slug: 'pricing-page', createdBy: c.ids.dana })
    .returning();
  const linkValue = { kind: 'link' as const, url: 'https://acme.example/pricing' };
  await c.db.insert(outboundCatalogRevisions).values({
    companyId: c.companyId,
    entryId: linkEntry!.id,
    revision: 1,
    departmentId: c.sales,
    kind: 'link',
    locale: null,
    status: 'published',
    value: linkValue,
    digest: sha(canonicalJson(linkValue)),
    validFrom: new Date('2026-11-01T00:00:00.000Z'),
    createdByKind: 'person',
    createdById: c.ids.dana,
    approvedBy: c.ids.dana,
    approvedAt: NOW,
  });

  const [segment] = await c.db
    .insert(outboundSegments)
    .values({ companyId: c.companyId, departmentId: c.sales, revision: 1, name: 'Verified retail leads', digest: sha('seg-1'), createdBy: c.ids.dana })
    .returning();

  const [waitingMsg] = await c.db
    .insert(outboundMessages)
    .values({
      companyId: c.companyId,
      departmentId: c.sales,
      taskId,
      authorAgentId: c.worker,
      idempotencyKey: randomUUID(),
      requestDigest: sha('req-1'),
      channelId: channel!.id,
      accountId: account!.id,
      bindingGeneration: 2,
      targetKind: 'contact',
      contactId: contact!.id,
      segmentId: segment!.id,
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
      templateId: tplEntry!.id,
      templateRevision: 3,
      blocks: [
        { kind: 'price', id: priceEntry!.id, revision: 2 },
        { kind: 'link', id: linkEntry!.id, revision: 1 },
      ],
      variables: [],
    },
    contentDigest,
    sealedEnc: encryptSecret(canonicalJson(sealedPayload), c.app.ctx.config.secretKey),
    sourceRevisionsDigest: sourcesDigest,
    policyId: policy!.id,
    policyDigest: policy!.digest,
  });

  const [msgReq] = await c.db
    .insert(requests)
    .values({
      companyId: c.companyId,
      taskId,
      agentId: c.worker,
      kind: 'approval',
      text: 'Approve outbound message to verified retail lead',
      decisionTopic: 'department',
      approvalChannel: 'outbound',
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
    authorityFingerprint: sha('dana-sales-owner'),
  });

  const [approachReq] = await c.db
    .insert(requests)
    .values({
      companyId: c.companyId,
      taskId,
      agentId: c.worker,
      kind: 'approval',
      text: 'Approve outbound approach for Verified retail leads',
      decisionTopic: 'department',
      approvalChannel: 'outbound',
      approvalKind: 'approach',
    })
    .returning();
  await c.db.insert(outboundApprovals).values({
    companyId: c.companyId,
    requestId: approachReq!.id,
    kind: 'approach',
    channelId: channel!.id,
    templateId: tplEntry!.id,
    templateRevision: 3,
    segmentId: segment!.id,
    locale: 'en',
    policyDigest: policy!.digest,
    sourceRevisionsDigest: sourcesDigest,
    authorityFingerprint: sha('dana-sales-owner'),
  });

  const [unknownMsg] = await c.db
    .insert(outboundMessages)
    .values({
      companyId: c.companyId,
      departmentId: c.sales,
      taskId,
      authorAgentId: c.worker,
      idempotencyKey: randomUUID(),
      requestDigest: sha('req-unknown'),
      channelId: channel!.id,
      accountId: account!.id,
      bindingGeneration: 2,
      targetKind: 'contact',
      contactId: contact!.id,
      segmentId: segment!.id,
      status: 'unknown',
      reasonCodes: ['unknown_delivery'],
      scheduledAt: NOW,
    })
    .returning();
  await c.db.insert(outboundMessageRevisions).values({
    companyId: c.companyId,
    messageId: unknownMsg!.id,
    revision: 1,
    document: { locale: 'en', templateId: tplEntry!.id, templateRevision: 3, blocks: [], variables: [] },
    contentDigest: sha('unknown-bytes'),
    sealedEnc: encryptSecret(canonicalJson(sealedPayload), c.app.ctx.config.secretKey),
    sourceRevisionsDigest: sourcesDigest,
    policyId: policy!.id,
    policyDigest: policy!.digest,
  });
  const [acctBucket] = await c.db
    .insert(outboundDailyUsage)
    .values({ companyId: c.companyId, scope: 'account', scopeKey: account!.id, day: '2026-11-06', timezone: 'Europe/Lisbon', reserved: 1, limitVersion: 1 })
    .returning();
  const [domBucket] = await c.db
    .insert(outboundDailyUsage)
    .values({ companyId: c.companyId, scope: 'domain', scopeKey: account!.senderDomain, day: '2026-11-06', timezone: 'Europe/Lisbon', reserved: 1, limitVersion: 1 })
    .returning();
  await c.db.insert(outboundSendAttempts).values({
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
    providerReceipt: SECRET_PROVIDER_RECEIPT,
    startedAt: NOW,
    endedAt: NOW,
  });

  const [ticket] = await c.db
    .insert(supportTickets)
    .values({
      companyId: c.companyId,
      departmentId: c.sales,
      ticketId: 'TKT-77',
      revision: 1,
      contactId: contact!.id,
      status: 'escalated',
      textEnc: encryptSecret(SECRET_TICKET, c.app.ctx.config.secretKey),
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
    reasonCodes: ['approval_required'],
    reviewer: { providerId: 'openai_api', vendorId: 'openai', modelId: 'gpt-5.4', modelRevision: 'gpt-5.4-2026-08-01' },
    decidedAt: NOW,
  });

  return { c, msgReq: msgReq!, approachReq: approachReq!, waitingMsg: waitingMsg!, unknownMsg: unknownMsg!, channel: channel!, account: account! };
}

describe('safe outbound & bound approval read views (#447 T8-17)', () => {
  it('returns exact frozen content, catalog revisions, unknown recovery guidance, and escalations to the department owner with zero credential or PII leaks', async () => {
    const w = await seedOutboundViewWorld();

    const overviewRes = await w.c.app.inject({
      method: 'GET',
      url: '/api/outbound',
      headers: { cookie: w.c.danaToken },
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
      ticketId: 'TKT-77',
      status: 'escalated',
      classId: 'refund_request',
      canAnswer: true,
      ownerPersonId: w.c.ids.dana,
    });

    const msgApprovalRes = await w.c.app.inject({
      method: 'GET',
      url: `/api/requests/${w.msgReq.id}/outbound-approval`,
      headers: { cookie: w.c.danaToken },
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
      headers: { cookie: w.c.danaToken },
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

    const samOverview = await w.c.app.inject({
      method: 'GET',
      url: `/api/outbound?department=${w.c.sales}`,
      headers: { cookie: w.c.samToken },
    });
    expect(samOverview.statusCode).toBe(404);

    const samBound = await w.c.app.inject({
      method: 'GET',
      url: `/api/requests/${w.msgReq.id}/outbound-approval`,
      headers: { cookie: w.c.samToken },
    });
    expect(samBound.statusCode).toBe(404);

    const anonBound = await w.c.app.inject({
      method: 'GET',
      url: `/api/requests/${w.msgReq.id}/outbound-approval`,
    });
    expect(anonBound.statusCode).toBe(401);
  });
});
