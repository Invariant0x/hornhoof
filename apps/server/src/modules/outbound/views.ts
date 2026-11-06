import type { CatalogValue } from '@hornhoof/protocol';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf, listsDepartment, type Access } from '../../auth/access.js';
import { canDecide, decidedBy, type DecidedBy } from '../../auth/decisions.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { decryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import {
  departments,
  outboundAccounts,
  outboundApprovals,
  outboundAttempts,
  outboundCatalogRevisions,
  outboundChannels,
  outboundMessageRevisions,
  outboundMessages,
  requests,
  supportClassifications,
  supportTickets,
  tasks,
} from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { deptName } from '../departments/templates.js';
import { candidates, decisionOwner, departmentNames, mayOpenRequest, type Candidate, type DecisionSubject } from '../tasks/decisions.js';
import { requestSubject, taskSpot } from '../tasks/engine.js';
import type { SealedPayload } from './ports.js';

const IdParams = z.object({ id: z.uuid() });
const OverviewQuery = z.object({ department: z.uuid().optional() });

type Places = Awaited<ReturnType<typeof departmentNames>>;
type ApprovalRow = typeof outboundApprovals.$inferSelect;
type RequestRow = typeof requests.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;
type CatalogRow = typeof outboundCatalogRevisions.$inferSelect;

function decidedByDto(d: DecidedBy, places: Places) {
  const place = d.departmentId ? places.get(d.departmentId) : undefined;
  return { kind: d.kind, department: place ? { id: place.id, name: deptName(place) } : null };
}

function summarizeStructuredCatalog(value: CatalogValue): string | null {
  if (value.kind === 'template') return value.subject ?? value.locale;
  if (value.kind === 'price') return `${value.amount} ${value.currency}`;
  if (value.kind === 'link') return value.url;
  if (value.kind === 'discount') {
    return value.off.kind === 'percent' ? `${value.off.value}%` : `${value.off.value} ${value.off.currency}`;
  }
  return null;
}

function summarizeCatalogValue(value: CatalogValue): string {
  const structured = summarizeStructuredCatalog(value);
  if (structured !== null) return structured;
  if (value.kind === 'segment' || value.kind === 'audience') return value.name;
  if (value.kind === 'variable') return value.field;
  if (value.kind === 'taxonomy') return `${value.classes.length} classes`;
  return 'text' in value ? value.text.slice(0, 120) : value.kind;
}

function templatePreview(value: Extract<CatalogValue, { kind: 'template' }>): string {
  return value.parts.map(part => (part.kind === 'text' ? part.text : `[${part.type}]`)).join('');
}

function decodeFrozenSubjectAndBody(sealedEnc: string, secret: Buffer): { subject: string; body: string } {
  const parsed = JSON.parse(decryptSecret(sealedEnc, secret)) as SealedPayload;
  return { subject: parsed.subject, body: parsed.text };
}

function channelSummary(ch: typeof outboundChannels.$inferSelect) {
  return { id: ch.id, name: ch.name, adapter: ch.adapter, purpose: ch.purpose, audience: ch.audience };
}

async function catalogSourcesForRefs(
  db: Pick<Db, 'select'>,
  companyId: string,
  refs: readonly { id: string; revision: number }[],
) {
  if (refs.length === 0) return [];
  const ids = [...new Set(refs.map(r => r.id))];
  const rows = await db
    .select()
    .from(outboundCatalogRevisions)
    .where(and(eq(outboundCatalogRevisions.companyId, companyId), inArray(outboundCatalogRevisions.entryId, ids)));
  return refs.flatMap(ref => {
    const match = rows.find(row => row.entryId === ref.id && row.revision === ref.revision);
    if (!match) return [];
    return [{ kind: match.kind, entryId: match.entryId, revision: match.revision, summary: summarizeCatalogValue(match.value) }];
  });
}

async function buildMessageApprovalDto(
  ctx: Ctx,
  bound: ApprovalRow,
  base: { requestId: string; status: RequestRow['status']; canAnswer: boolean; decidedBy: ReturnType<typeof decidedByDto> },
) {
  if (!bound.messageId || !bound.messageRevision || !bound.accountId || !bound.bindingGeneration || !bound.contentDigest) {
    return null;
  }
  const [[msg], [rev], [account]] = await Promise.all([
    ctx.db.select().from(outboundMessages).where(eq(outboundMessages.id, bound.messageId)),
    ctx.db
      .select()
      .from(outboundMessageRevisions)
      .where(and(eq(outboundMessageRevisions.messageId, bound.messageId), eq(outboundMessageRevisions.revision, bound.messageRevision))),
    ctx.db.select().from(outboundAccounts).where(eq(outboundAccounts.id, bound.accountId)),
  ]);
  if (!msg || !rev || !account) return null;
  const [channel] = await ctx.db.select().from(outboundChannels).where(eq(outboundChannels.id, msg.channelId));
  if (!channel) return null;

  const refs = [
    { id: rev.document.templateId, revision: rev.document.templateRevision },
    ...rev.document.blocks.map(b => ({ id: b.id, revision: b.revision })),
  ];
  const sources = await catalogSourcesForRefs(ctx.db, bound.companyId, refs);
  return {
    ...base,
    kind: 'message' as const,
    channel: channelSummary(channel),
    account: {
      id: account.id,
      label: account.label,
      senderDomain: account.senderDomain,
      bindingGeneration: bound.bindingGeneration,
    },
    messageId: msg.id,
    revision: rev.revision,
    locale: rev.document.locale,
    contentDigest: bound.contentDigest,
    policyDigest: bound.policyDigest,
    sourceRevisionsDigest: bound.sourceRevisionsDigest,
    rendered: decodeFrozenSubjectAndBody(rev.sealedEnc, ctx.config.secret),
    sources,
  };
}

async function latestCatalogRow(db: Pick<Db, 'select'>, companyId: string, entryId: string): Promise<CatalogRow | null> {
  const [row] = await db
    .select()
    .from(outboundCatalogRevisions)
    .where(and(eq(outboundCatalogRevisions.companyId, companyId), eq(outboundCatalogRevisions.entryId, entryId)))
    .orderBy(desc(outboundCatalogRevisions.revision))
    .limit(1);
  return row ?? null;
}

async function buildApproachApprovalDto(
  ctx: Ctx,
  bound: ApprovalRow,
  base: { requestId: string; status: RequestRow['status']; canAnswer: boolean; decidedBy: ReturnType<typeof decidedByDto> },
) {
  if (!bound.channelId || !bound.templateId || !bound.templateRevision || !bound.segmentId || !bound.locale) return null;
  const [[channel], segRow, [tplRow]] = await Promise.all([
    ctx.db.select().from(outboundChannels).where(eq(outboundChannels.id, bound.channelId)),
    latestCatalogRow(ctx.db, bound.companyId, bound.segmentId),
    ctx.db
      .select()
      .from(outboundCatalogRevisions)
      .where(
        and(
          eq(outboundCatalogRevisions.companyId, bound.companyId),
          eq(outboundCatalogRevisions.entryId, bound.templateId),
          eq(outboundCatalogRevisions.revision, bound.templateRevision),
        ),
      ),
  ]);
  if (!channel || !segRow || segRow.value.kind !== 'segment' || !tplRow || tplRow.value.kind !== 'template') return null;
  const sources = await catalogSourcesForRefs(ctx.db, bound.companyId, [
    { id: tplRow.entryId, revision: tplRow.revision },
    { id: segRow.entryId, revision: segRow.revision },
  ]);
  return {
    ...base,
    kind: 'approach' as const,
    channel: channelSummary(channel),
    segment: { id: segRow.entryId, revision: segRow.revision, name: segRow.value.name },
    template: {
      id: tplRow.entryId,
      revision: tplRow.revision,
      locale: bound.locale,
      subject: tplRow.value.subject ?? '',
      preview: templatePreview(tplRow.value),
    },
    policyDigest: bound.policyDigest,
    sourceRevisionsDigest: bound.sourceRevisionsDigest,
    sources,
  };
}

async function buildBoundApprovalDto(
  ctx: Ctx,
  me: Person,
  access: Access,
  everyone: readonly Candidate[],
  places: Places,
  bound: ApprovalRow,
  reqRow: RequestRow,
  taskRow: TaskRow,
) {
  const subject = requestSubject(reqRow, taskRow);
  const canAnswer = reqRow.status === 'open' && canDecide(subject, me, access, me.companyId);
  const base = {
    requestId: reqRow.id,
    status: reqRow.status,
    canAnswer,
    decidedBy: decidedByDto(decidedBy(subject, everyone), places),
  };
  if (bound.kind === 'message') return buildMessageApprovalDto(ctx, bound, base);
  return buildApproachApprovalDto(ctx, bound, base);
}

async function resolveVisibleDepartmentIds(
  db: Db,
  me: Person,
  access: Access,
  requestedDepartment?: string,
): Promise<string[]> {
  const allDepts = await db.select().from(departments).where(eq(departments.companyId, me.companyId));
  if (requestedDepartment) {
    const target = allDepts.find(d => d.id === requestedDepartment && d.parentId === null);
    if (!target || !listsDepartment(access, target.id)) {
      throw new ApiError(404, 'not_found', 'This department does not exist.', 'department_unknown');
    }
    return [target.id];
  }
  return allDepts.filter(d => d.parentId === null && listsDepartment(access, d.id)).map(d => d.id);
}

async function loadChannelDtos(db: Db, companyId: string, deptIds: readonly string[]) {
  if (deptIds.length === 0) return { channels: [], channelMap: new Map(), accountMap: new Map() };
  const [channels, accounts, activeAttempts] = await Promise.all([
    db.select().from(outboundChannels).where(and(eq(outboundChannels.companyId, companyId), inArray(outboundChannels.departmentId, [...deptIds]))),
    db.select().from(outboundAccounts).where(and(eq(outboundAccounts.companyId, companyId), inArray(outboundAccounts.departmentId, [...deptIds]))),
    db.select({ accountId: outboundAttempts.accountId }).from(outboundAttempts).where(and(eq(outboundAttempts.companyId, companyId), inArray(outboundAttempts.status, ['sending', 'unknown']))),
  ]);
  const heldIds = new Set(activeAttempts.map(a => a.accountId));
  const channelMap = new Map(channels.map(c => [c.id, c]));
  const accountMap = new Map(accounts.map(a => [a.id, a]));

  const dtos = channels.map(ch => ({
    id: ch.id,
    departmentId: ch.departmentId,
    productId: ch.productId,
    name: ch.name,
    adapter: ch.adapter,
    purpose: ch.purpose,
    audience: ch.audience,
    status: ch.status,
    generation: ch.generation,
    stoppedReason: ch.stoppedReason,
    stoppedAt: ch.stoppedAt ? ch.stoppedAt.toISOString() : null,
    accounts: accounts
      .filter(acc => acc.channelId === ch.id)
      .map(acc => ({
        id: acc.id,
        label: acc.label,
        senderDomain: acc.senderDomain,
        status: acc.status,
        configGeneration: acc.configGeneration,
        available: ch.status === 'active' && acc.status === 'active' && !heldIds.has(acc.id),
      })),
  }));
  return { channels: dtos, channelMap, accountMap };
}

function unknownRecoveryDto(attempt: typeof outboundAttempts.$inferSelect | undefined) {
  if (!attempt || !attempt.safeCode) return null;
  const finishedAt = attempt.endedAt ?? attempt.startedAt ?? attempt.createdAt;
  return {
    attemptId: attempt.id,
    safeCode: attempt.safeCode,
    endedAt: finishedAt.toISOString(),
    quotaHeld: true as const,
    nextActionCode: 'check_receiver_before_resend' as const,
  };
}

async function loadMessageDtos(
  db: Db,
  companyId: string,
  deptIds: readonly string[],
  channelMap: Map<string, typeof outboundChannels.$inferSelect>,
  accountMap: Map<string, typeof outboundAccounts.$inferSelect>,
) {
  if (deptIds.length === 0) return [];
  const msgs = await db
    .select()
    .from(outboundMessages)
    .where(and(eq(outboundMessages.companyId, companyId), inArray(outboundMessages.departmentId, [...deptIds])))
    .orderBy(desc(outboundMessages.createdAt));
  if (msgs.length === 0) return [];
  const msgIds = msgs.map(m => m.id);
  const [revs, unknownAttempts] = await Promise.all([
    db.select().from(outboundMessageRevisions).where(inArray(outboundMessageRevisions.messageId, msgIds)),
    db
      .select()
      .from(outboundAttempts)
      .where(and(inArray(outboundAttempts.messageId, msgIds), eq(outboundAttempts.status, 'unknown'))),
  ]);
  return msgs.map(m => {
    const rev = revs.find(r => r.messageId === m.id && r.revision === m.revision);
    const attempt = unknownAttempts.find(a => a.messageId === m.id && a.messageRevision === m.revision);
    const ch = channelMap.get(m.channelId);
    const acc = accountMap.get(m.accountId);
    return {
      id: m.id,
      departmentId: m.departmentId,
      productId: m.productId,
      taskId: m.taskId,
      channelId: m.channelId,
      channelName: ch?.name ?? '',
      accountId: m.accountId,
      accountLabel: acc?.label ?? '',
      senderDomain: acc?.senderDomain ?? '',
      revision: m.revision,
      contentDigest: rev?.contentDigest ?? m.requestDigest,
      status: m.status,
      reasonCodes: m.reasonCodes,
      scheduledAt: m.scheduledAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
      unknownRecovery: m.status === 'unknown' ? unknownRecoveryDto(attempt) : null,
    };
  });
}

async function loadEscalationDtos(
  db: Db,
  me: Person,
  access: Access,
  everyone: readonly Candidate[],
  places: Places,
  deptIds: readonly string[],
) {
  if (deptIds.length === 0) return [];
  const tickets = await db
    .select()
    .from(supportTickets)
    .where(and(eq(supportTickets.companyId, me.companyId), eq(supportTickets.status, 'escalated'), inArray(supportTickets.departmentId, [...deptIds])))
    .orderBy(desc(supportTickets.createdAt));
  if (tickets.length === 0) return [];
  const ticketUuids = tickets.map(t => t.ticketId);
  const [classifications, replyMsgs] = await Promise.all([
    db
      .select()
      .from(supportClassifications)
      .where(and(eq(supportClassifications.companyId, me.companyId), inArray(supportClassifications.ticketId, ticketUuids)))
      .orderBy(desc(supportClassifications.createdAt)),
    db
      .select()
      .from(outboundMessages)
      .where(and(eq(outboundMessages.companyId, me.companyId), inArray(outboundMessages.ticketId, ticketUuids))),
  ]);
  const msgIds = replyMsgs.map(m => m.id);
  const approvals = msgIds.length
    ? await db.select().from(outboundApprovals).where(inArray(outboundApprovals.messageId, msgIds))
    : [];

  return tickets.map(t => {
    const cls = classifications.find(c => c.ticketId === t.ticketId && c.ticketRevision === t.revision);
    const msg = replyMsgs.find(m => m.ticketId === t.ticketId && m.ticketRevision === t.revision);
    const bound = msg ? approvals.find(a => a.messageId === msg.id) : undefined;
    const subject: DecisionSubject = {
      source: 'request',
      kind: 'approval',
      topic: 'task',
      spot: taskSpot({ departmentId: t.departmentId, productId: t.productId }),
    };
    return {
      ticketId: t.ticketId,
      externalRef: t.externalRef,
      revision: t.revision,
      departmentId: t.departmentId,
      productId: t.productId,
      status: t.status,
      classId: cls?.classId ?? null,
      reasonCodes: cls?.reasonCodes ?? [],
      requestId: bound?.requestId ?? null,
      taskId: msg?.taskId ?? null,
      ownerPersonId: decisionOwner(subject, everyone),
      canAnswer: canDecide(subject, me, access, me.companyId),
      decidedBy: decidedByDto(decidedBy(subject, everyone), places),
      createdAt: t.createdAt.toISOString(),
    };
  });
}

async function loadOpenApprovalDtos(
  ctx: Ctx,
  me: Person,
  access: Access,
  everyone: readonly Candidate[],
  places: Places,
  deptIds: readonly string[],
) {
  if (deptIds.length === 0) return [];
  const rows = await ctx.db
    .select({ bound: outboundApprovals, reqRow: requests, taskRow: tasks })
    .from(outboundApprovals)
    .innerJoin(requests, eq(requests.id, outboundApprovals.requestId))
    .innerJoin(tasks, eq(tasks.id, requests.taskId))
    .where(and(eq(requests.companyId, me.companyId), eq(requests.status, 'open'), inArray(tasks.departmentId, [...deptIds])));
  const out = [];
  for (const row of rows) {
    if (!(await mayOpenRequest(ctx.db, me, row.reqRow, row.taskRow))) continue;
    const dto = await buildBoundApprovalDto(ctx, me, access, everyone, places, row.bound, row.reqRow, row.taskRow);
    if (dto) out.push(dto);
  }
  return out;
}

export function outboundViewRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/outbound', async req => {
    const me = await requirePerson(req, ctx.db);
    const query = OverviewQuery.parse(req.query);
    const access = await accessOf(ctx.db, me);
    const deptIds = await resolveVisibleDepartmentIds(ctx.db, me, access, query.department);
    const [everyone, places] = await Promise.all([candidates(ctx, me.companyId), departmentNames(ctx, deptIds)]);
    const { channels, channelMap, accountMap } = await loadChannelDtos(ctx.db, me.companyId, deptIds);
    const [messages, escalations, approvals] = await Promise.all([
      loadMessageDtos(ctx.db, me.companyId, deptIds, channelMap, accountMap),
      loadEscalationDtos(ctx.db, me, access, everyone, places, deptIds),
      loadOpenApprovalDtos(ctx, me, access, everyone, places, deptIds),
    ]);
    return { channels, messages, escalations, approvals };
  });

  app.get('/api/requests/:id/outbound-approval', async req => {
    const me = await requirePerson(req, ctx.db);
    const { id } = IdParams.parse(req.params);
    const [row] = await ctx.db
      .select({ bound: outboundApprovals, reqRow: requests, taskRow: tasks })
      .from(outboundApprovals)
      .innerJoin(requests, eq(requests.id, outboundApprovals.requestId))
      .innerJoin(tasks, eq(tasks.id, requests.taskId))
      .where(and(eq(requests.companyId, me.companyId), eq(requests.id, id)));
    if (!row || !(await mayOpenRequest(ctx.db, me, row.reqRow, row.taskRow))) {
      throw new ApiError(404, 'not_found', 'Outbound approval was not found.', 'request_unknown');
    }
    const [access, everyone] = await Promise.all([accessOf(ctx.db, me), candidates(ctx, me.companyId)]);
    const subject = requestSubject(row.reqRow, row.taskRow);
    const decider = decidedBy(subject, everyone);
    const places = await departmentNames(ctx, decider.departmentId ? [decider.departmentId] : []);
    const dto = await buildBoundApprovalDto(ctx, me, access, everyone, places, row.bound, row.reqRow, row.taskRow);
    if (!dto) throw new ApiError(404, 'not_found', 'Outbound approval details were not found.', 'request_unknown');
    return dto;
  });
}

export const registerOutboundViewRoutes = outboundViewRoutes;
