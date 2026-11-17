import type { CatalogValue } from '@hornhoof/protocol';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf, listsDepartment, type Access } from '../../auth/access.js';
import { actsAsCeo, canDecide, decidedBy } from '../../auth/decisions.js';
import { requirePerson, type Person } from '../../auth/session.js';
import { decryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import {
  agents,
  departments,
  outboundAccounts,
  outboundApprovals,
  outboundAttempts,
  outboundBindings,
  outboundCatalogRevisions,
  outboundChannels,
  outboundMessageRevisions,
  outboundMessages,
  requests,
  supportClassifications,
  supportTickets,
  tasks,
} from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { decidedByView } from '../tasks/decision-views.js';
import { candidates, decisionOwner, departmentNames, mayOpenRequest, type Candidate, type DecisionSubject } from '../tasks/decisions.js';
import { requestSubject, taskSpot } from '../tasks/engine.js';
import { currentPolicy } from './policies.js';
import type { SealedPayload } from './ports.js';

const IdParams = z.object({ id: z.uuid() });
const OverviewQuery = z.object({ department: z.uuid().optional() });

type Places = Awaited<ReturnType<typeof departmentNames>>;
type ApprovalRow = typeof outboundApprovals.$inferSelect;
type RequestRow = typeof requests.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;
type CatalogRow = typeof outboundCatalogRevisions.$inferSelect;

type CatalogSummarizers = {
  readonly [K in CatalogValue['kind']]: (value: Extract<CatalogValue, { kind: K }>) => string;
};

const CATALOG_SUMMARIZERS: CatalogSummarizers = {
  template: v => v.subject ?? v.locale,
  price: v => `${v.amount} ${v.currency}`,
  discount: v => (v.off.kind === 'percent' ? `${v.off.value}%` : `${v.off.value} ${v.off.currency}`),
  terms: v => v.text.slice(0, 120),
  link: v => v.url,
  claim: v => v.text.slice(0, 120),
  knowledge: v => v.text.slice(0, 120),
  unsubscribe: v => v.text.slice(0, 120),
  segment: v => v.name,
  audience: v => v.name,
  variable: v => v.field,
  taxonomy: v => `${v.classes.length} classes`,
};

export function summarizeCatalogValue<K extends CatalogValue['kind']>(value: Extract<CatalogValue, { kind: K }>): string {
  const summarize = CATALOG_SUMMARIZERS[value.kind] as (item: Extract<CatalogValue, { kind: K }>) => string;
  return summarize(value);
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

type ApprovalBase = {
  requestId: string;
  status: RequestRow['status'];
  canAnswer: boolean;
  decidedBy: ReturnType<typeof decidedByView>;
};

const MESSAGE_APPROVAL_KEYS = ['messageId', 'messageRevision', 'accountId', 'bindingGeneration', 'contentDigest'] as const;
type MessageApprovalFields = { [K in (typeof MESSAGE_APPROVAL_KEYS)[number]]: NonNullable<ApprovalRow[K]> };

function pickApprovalFields<K extends keyof ApprovalRow>(
  bound: ApprovalRow,
  keys: readonly K[],
): { [P in K]: NonNullable<ApprovalRow[P]> } | null {
  for (const k of keys) {
    if (!bound[k]) return null;
  }
  return bound as unknown as { [P in K]: NonNullable<ApprovalRow[P]> };
}

async function loadMessageApprovalRows(db: Db, fields: MessageApprovalFields) {
  const [[msg], [rev], [account]] = await Promise.all([
    db.select().from(outboundMessages).where(eq(outboundMessages.id, fields.messageId)),
    db
      .select()
      .from(outboundMessageRevisions)
      .where(and(eq(outboundMessageRevisions.messageId, fields.messageId), eq(outboundMessageRevisions.revision, fields.messageRevision))),
    db.select().from(outboundAccounts).where(eq(outboundAccounts.id, fields.accountId)),
  ]);
  if (![msg, rev, account].every(Boolean)) return null;
  const [channel] = await db.select().from(outboundChannels).where(eq(outboundChannels.id, msg!.channelId));
  return channel ? { msg: msg!, rev: rev!, account: account!, channel } : null;
}

async function buildMessageApprovalDto(ctx: Ctx, bound: ApprovalRow, base: ApprovalBase) {
  const fields = pickApprovalFields(bound, MESSAGE_APPROVAL_KEYS);
  if (!fields) return null;
  const loaded = await loadMessageApprovalRows(ctx.db, fields);
  if (!loaded) return null;
  const { msg, rev, account, channel } = loaded;
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
      bindingGeneration: fields.bindingGeneration,
    },
    messageId: msg.id,
    /* It came back with a restored database and may have gone out before the restore: the person is told so. */
    restored: msg.reasonCodes.includes('restored'),
    revision: rev.revision,
    locale: rev.document.locale,
    contentDigest: fields.contentDigest,
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

const APPROACH_APPROVAL_KEYS = ['channelId', 'templateId', 'templateRevision', 'segmentId', 'locale'] as const;
type ApproachApprovalFields = { [K in (typeof APPROACH_APPROVAL_KEYS)[number]]: NonNullable<ApprovalRow[K]> };

type SegmentCatalogRow = CatalogRow & { value: Extract<CatalogValue, { kind: 'segment' }> };
type TemplateCatalogRow = CatalogRow & { value: Extract<CatalogValue, { kind: 'template' }> };

const asSegmentRow = (row: CatalogRow | null): SegmentCatalogRow | null =>
  row && row.value.kind === 'segment' ? (row as SegmentCatalogRow) : null;

const asTemplateRow = (row: CatalogRow | undefined): TemplateCatalogRow | null =>
  row && row.value.kind === 'template' ? (row as TemplateCatalogRow) : null;

async function loadApproachApprovalRows(db: Db, companyId: string, fields: ApproachApprovalFields) {
  const [[channel], rawSeg, [rawTpl]] = await Promise.all([
    db.select().from(outboundChannels).where(eq(outboundChannels.id, fields.channelId)),
    latestCatalogRow(db, companyId, fields.segmentId),
    db
      .select()
      .from(outboundCatalogRevisions)
      .where(
        and(
          eq(outboundCatalogRevisions.companyId, companyId),
          eq(outboundCatalogRevisions.entryId, fields.templateId),
          eq(outboundCatalogRevisions.revision, fields.templateRevision),
        ),
      ),
  ]);
  const segRow = asSegmentRow(rawSeg);
  const tplRow = asTemplateRow(rawTpl);
  return [channel, segRow, tplRow].every(Boolean) ? { channel: channel!, segRow: segRow!, tplRow: tplRow! } : null;
}

async function buildApproachApprovalDto(ctx: Ctx, bound: ApprovalRow, base: ApprovalBase) {
  const fields = pickApprovalFields(bound, APPROACH_APPROVAL_KEYS);
  if (!fields) return null;
  const loaded = await loadApproachApprovalRows(ctx.db, bound.companyId, fields);
  if (!loaded) return null;
  const { channel, segRow, tplRow } = loaded;
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
      locale: fields.locale,
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
    decidedBy: decidedByView(decidedBy(subject, everyone), places),
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

/* Who writes from each account now, by name. */
async function authorsOf(db: Db, companyId: string, accountIds: readonly string[]) {
  if (!accountIds.length) return new Map<string, { agentId: string; name: string; generation: number }>();
  const rows = await db
    .select({ accountId: outboundBindings.accountId, agentId: outboundBindings.agentId, generation: outboundBindings.generation, name: agents.name })
    .from(outboundBindings)
    .innerJoin(agents, eq(agents.id, outboundBindings.agentId))
    .where(and(eq(outboundBindings.companyId, companyId), eq(outboundBindings.status, 'active'), inArray(outboundBindings.accountId, [...accountIds])));
  return new Map(rows.map(({ accountId, ...author }) => [accountId, author]));
}

/* The limits each channel goes by now, and whether it sends without a person's yes to each message. */
async function policiesOf(db: Db, channelIds: readonly string[]) {
  const pairs = await Promise.all(channelIds.map(async id => [id, await currentPolicy(db, id)] as const));
  return new Map(pairs.map(([id, policy]) => [id, policy ? { revision: policy.revision, value: policy.value } : null]));
}

async function loadChannelDtos(db: Db, companyId: string, deptIds: readonly string[], runs: (departmentId: string) => boolean = () => false) {
  if (deptIds.length === 0) return { channels: [], channelMap: new Map(), accountMap: new Map() };
  const [channels, accounts, activeAttempts] = await Promise.all([
    db.select().from(outboundChannels).where(and(eq(outboundChannels.companyId, companyId), inArray(outboundChannels.departmentId, [...deptIds]))),
    db.select().from(outboundAccounts).where(and(eq(outboundAccounts.companyId, companyId), inArray(outboundAccounts.departmentId, [...deptIds]))),
    db.select(only(outboundAttempts, 'accountId')).from(outboundAttempts).where(and(eq(outboundAttempts.companyId, companyId), inArray(outboundAttempts.status, ['sending', 'unknown']))),
  ]);
  const [authors, policies] = await Promise.all([authorsOf(db, companyId, accounts.map(a => a.id)), policiesOf(db, channels.map(c => c.id))]);
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
    canManage: runs(ch.departmentId),
    policy: policies.get(ch.id) ?? null,
    accounts: accounts
      .filter(acc => acc.channelId === ch.id)
      .map(acc => ({
        id: acc.id,
        label: acc.label,
        senderDomain: acc.senderDomain,
        status: acc.status,
        configGeneration: acc.configGeneration,
        available: ch.status === 'active' && acc.status === 'active' && !heldIds.has(acc.id),
        author: authors.get(acc.id) ?? null,
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

type MessageRow = typeof outboundMessages.$inferSelect;
type RevisionRow = typeof outboundMessageRevisions.$inferSelect;
type AttemptRow = typeof outboundAttempts.$inferSelect;
type ChannelRow = typeof outboundChannels.$inferSelect;
type AccountRow = typeof outboundAccounts.$inferSelect;
type TicketRow = typeof supportTickets.$inferSelect;
type ClassificationRow = typeof supportClassifications.$inferSelect;

const pairKey = (id: string, revision: number): string => `${id}:${revision}`;

function channelNameOf(channelMap: ReadonlyMap<string, ChannelRow>, channelId: string): string {
  const ch = channelMap.get(channelId);
  return ch ? ch.name : '';
}

function accountLabelsOf(accountMap: ReadonlyMap<string, AccountRow>, accountId: string) {
  const acc = accountMap.get(accountId);
  return acc ? { accountLabel: acc.label, senderDomain: acc.senderDomain } : { accountLabel: '', senderDomain: '' };
}

function toMessageDto(
  m: MessageRow,
  revMap: ReadonlyMap<string, RevisionRow>,
  attemptMap: ReadonlyMap<string, AttemptRow>,
  channelMap: ReadonlyMap<string, ChannelRow>,
  accountMap: ReadonlyMap<string, AccountRow>,
) {
  const key = pairKey(m.id, m.revision);
  const rev = revMap.get(key);
  const { accountLabel, senderDomain } = accountLabelsOf(accountMap, m.accountId);
  return {
    id: m.id,
    departmentId: m.departmentId,
    productId: m.productId,
    taskId: m.taskId,
    channelId: m.channelId,
    channelName: channelNameOf(channelMap, m.channelId),
    accountId: m.accountId,
    accountLabel,
    senderDomain,
    revision: m.revision,
    contentDigest: rev ? rev.contentDigest : m.requestDigest,
    status: m.status,
    reasonCodes: m.reasonCodes,
    scheduledAt: m.scheduledAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    unknownRecovery: m.status === 'unknown' ? unknownRecoveryDto(attemptMap.get(key)) : null,
  };
}

async function loadMessageDtos(
  db: Db,
  companyId: string,
  deptIds: readonly string[],
  channelMap: Map<string, ChannelRow>,
  accountMap: Map<string, AccountRow>,
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
  const revMap = new Map(revs.map(r => [pairKey(r.messageId, r.revision), r] as const));
  const attemptMap = new Map(unknownAttempts.map(a => [pairKey(a.messageId, a.messageRevision), a] as const));
  return msgs.map(m => toMessageDto(m, revMap, attemptMap, channelMap, accountMap));
}

const approvalMessageEntry = (row: ApprovalRow): readonly [string, ApprovalRow][] =>
  row.messageId ? [[row.messageId, row]] : [];

async function loadApprovalsByMessageId(db: Db, msgIds: readonly string[]): Promise<Map<string, ApprovalRow>> {
  if (msgIds.length === 0) return new Map();
  const rows = await db.select().from(outboundApprovals).where(inArray(outboundApprovals.messageId, [...msgIds]));
  return new Map(rows.flatMap(approvalMessageEntry));
}

function indexFirstClassification(rows: readonly ClassificationRow[]): Map<string, ClassificationRow> {
  const map = new Map<string, ClassificationRow>();
  for (const row of rows) {
    const key = pairKey(row.ticketId, row.ticketRevision);
    if (!map.has(key)) map.set(key, row);
  }
  return map;
}

const ticketReplyEntry = (row: MessageRow): readonly [string, MessageRow][] =>
  row.ticketId ? [[`${row.ticketId}:${String(row.ticketRevision)}`, row]] : [];

const indexTicketReplies = (rows: readonly MessageRow[]): Map<string, MessageRow> =>
  new Map(rows.flatMap(ticketReplyEntry));

function classificationFields(cls: ClassificationRow | undefined) {
  return cls ? { classId: cls.classId, reasonCodes: cls.reasonCodes } : { classId: null, reasonCodes: [] };
}

function replyLinkFields(msg: MessageRow | undefined, approvalMap: ReadonlyMap<string, ApprovalRow>) {
  if (!msg) return { requestId: null, taskId: null };
  const bound = approvalMap.get(msg.id);
  return { requestId: bound ? bound.requestId : null, taskId: msg.taskId };
}

type EscalationContext = {
  me: Person;
  access: Access;
  everyone: readonly Candidate[];
  places: Places;
  clsMap: ReadonlyMap<string, ClassificationRow>;
  replyMap: ReadonlyMap<string, MessageRow>;
  approvalMap: ReadonlyMap<string, ApprovalRow>;
};

function toEscalationDto(t: TicketRow, ctx: EscalationContext) {
  const key = pairKey(t.ticketId, t.revision);
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
    ...classificationFields(ctx.clsMap.get(key)),
    ...replyLinkFields(ctx.replyMap.get(key), ctx.approvalMap),
    ownerPersonId: decisionOwner(subject, ctx.everyone),
    canAnswer: canDecide(subject, ctx.me, ctx.access, ctx.me.companyId),
    decidedBy: decidedByView(decidedBy(subject, ctx.everyone), ctx.places),
    createdAt: t.createdAt.toISOString(),
  };
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
  const approvalMap = await loadApprovalsByMessageId(
    db,
    replyMsgs.map(m => m.id),
  );
  const escCtx: EscalationContext = {
    me,
    access,
    everyone,
    places,
    clsMap: indexFirstClassification(classifications),
    replyMap: indexTicketReplies(replyMsgs),
    approvalMap,
  };
  return tickets.map(t => toEscalationDto(t, escCtx));
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

/* A department's channels as its head reads them: limits, accounts by name and who writes from each, never a setting. */
export const channelsOfDepartment = async (db: Db, companyId: string, departmentId: string) => (await loadChannelDtos(db, companyId, [departmentId], () => true)).channels;

export function outboundViewRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.get('/api/outbound', async req => {
    const me = await requirePerson(req, ctx.db);
    const query = OverviewQuery.parse(req.query);
    const access = await accessOf(ctx.db, me);
    const deptIds = await resolveVisibleDepartmentIds(ctx.db, me, access, query.department);
    const [everyone, places] = await Promise.all([candidates(ctx, me.companyId), departmentNames(ctx, deptIds)]);
    const runs = (id: string) => actsAsCeo(me) || access.owns?.has(id) === true;
    const { channels, channelMap, accountMap } = await loadChannelDtos(ctx.db, me.companyId, deptIds, runs);
    const [messages, escalations, approvals] = await Promise.all([
      loadMessageDtos(ctx.db, me.companyId, deptIds, channelMap, accountMap),
      loadEscalationDtos(ctx.db, me, access, everyone, places, deptIds),
      loadOpenApprovalDtos(ctx, me, access, everyone, places, deptIds),
    ]);
    /* The departments whose messages this person runs, each named as the screens name it. */
    const departments = deptIds.filter(runs).flatMap(id => {
      const place = places.get(id);
      return place ? [{ id, name: place.name, templateKey: place.templateKey }] : [];
    });
    return { channels, messages, escalations, approvals, departments };
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
