import { randomUUID } from 'node:crypto';
import type { GateCode, MessageDocument, OutboundMessageView, OutboundSubmit, SubmitResult } from '@hornhoof/protocol';
import { and, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { decryptSecret, encryptSecret } from '../../crypto/secrets.js';
import { agents, outboundAccounts, outboundAttempts, outboundBindings, outboundCatalogRevisions, outboundChannels, outboundContacts, outboundDailyUsage, outboundMessageRevisions, outboundMessages, outboundPermissions, outboundReviewReceipts, outboundSamplingCounters, supportClassifications, tasks } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { publicUrl } from '../link/link.js';
import { isOn } from '../model-checks/lifecycle.js';
import { CLOSED, type Task, type Tx } from '../tasks/engine.js';
import { taskByRef } from '../tasks/views.js';
import { approvalNeed, approvalState, askApproval, authorityFingerprint, deciderOf, rulesFor, sendingChannel, type ApprovalState, type Bound, type Need, type Shared, withdrawAskedBefore } from './approvals.js';
import { catalogValue, currentRevision, digestOf, unsafeLink, usable, type Catalog, type Money, type Place, type Source } from './checks.js';
import { recipientDigest, unsubscribeUrl } from './contacts.js';
import { currentPolicy, dayOf, lockBuckets, releaseAttempt, reviewCheck, selectedForReview, stopChannel, usedWithin, type Channel, type CurrentPolicy } from './policies.js';
import type { BeginDispatch, DispatchAdmission, SealedPayload, SettleAttempt } from './ports.js';
import { frozenDigest, renderMessage, sourcesDigest, type Rendered, type SourceRef } from './render.js';

/* The one way a message gets out of Hornhoof. Both the agent's tool and its HTTP route come here, the server's dispatcher
   takes its last look here, and nothing else writes these tables. Locks go one way round in every path: channel, account and
   binding, contact, quota, then message and attempt. No network happens inside any of this. */

type Account = typeof outboundAccounts.$inferSelect;
type Binding = typeof outboundBindings.$inferSelect;
type Contact = typeof outboundContacts.$inferSelect;
type Message = typeof outboundMessages.$inferSelect;
type Revision = typeof outboundMessageRevisions.$inferSelect;
type Attempt = typeof outboundAttempts.$inferSelect;

/* Who submits: from the token of a running job, never from what it says about itself. */
export type Authority = { companyId: string; agentId: string; departmentId: string | null; jobId: string | null };
type Target = { kind: 'contact'; contactId: string } | { kind: 'audience'; audienceId: string } | { kind: 'ticket'; contactId: string; ticketId: string; ticketRevision: number; classificationId: string };
export type Draft = { task: number | string; idempotencyKey: string; channelId: string; accountId: string; bindingGeneration: number; target: Target; segmentId: string | null; document: MessageDocument; scheduledAt: string };

const unknown = (what: string) => new ApiError(404, 'not_found', `There is no such ${what}.`, 'outbound_unknown');
const notYours = (message: string) => new ApiError(403, 'forbidden', message, 'outbound_not_allowed');
const conflict = (message: string, reasonCodes: GateCode[] = []) => new ApiError(409, 'conflict', message, 'outbound_conflict', { reasonCodes });

const RESERVABLE: readonly Message['status'][] = ['scheduled', 'waiting_approval'];
const LEASE_MS = 300_000;

const resultOf = (message: Message, contentDigest: string): SubmitResult => ({ messageId: message.id, revision: message.revision, contentDigest, status: message.status as SubmitResult['status'], reasonCodes: message.reasonCodes });

async function revisionOf(db: Pick<Ctx['db'], 'select'>, message: Pick<Message, 'id' | 'revision'>): Promise<Revision | null> {
  const [row] = await db.select().from(outboundMessageRevisions).where(and(eq(outboundMessageRevisions.messageId, message.id), eq(outboundMessageRevisions.revision, message.revision)));
  return row ?? null;
}

/* The same key again: the same answer as long as it is the same request. A refused request has no bytes, so its digest
   names the request itself. */
async function answerAgain(db: Pick<Ctx['db'], 'select'>, authority: Authority, key: string, requestDigest: string): Promise<SubmitResult | null> {
  const [kept] = await db.select().from(outboundMessages).where(and(eq(outboundMessages.companyId, authority.companyId), eq(outboundMessages.authorAgentId, authority.agentId), eq(outboundMessages.idempotencyKey, key)));
  if (!kept) return null;
  if (kept.requestDigest !== requestDigest) throw conflict('This key was used for another request. A new request takes a new key.');
  return resultOf(kept, (await revisionOf(db, kept))?.contentDigest ?? requestDigest);
}

function requireHeld(task: Task, authority: Authority): void {
  if (CLOSED.includes(task.status)) throw conflict(`#${task.number} is closed.`);
  if (task.assigneeAgentId !== authority.agentId) throw notYours(`#${task.number} is not with you.`);
}

const inChannelPlace = (task: Pick<Task, 'departmentId' | 'productId'>, channel: Channel): boolean => task.departmentId === channel.departmentId && (channel.productId === null || task.productId === channel.productId);

type Way = { channel: Channel | undefined; account: Account | undefined; binding: Binding | undefined };

/* Takes the channel, its account and who writes from it, in that order. */
async function holdWay(tx: Tx, companyId: string, channelId: string, accountId: string): Promise<Way> {
  const [channel] = await tx.select().from(outboundChannels).where(and(eq(outboundChannels.id, channelId), eq(outboundChannels.companyId, companyId))).for('update');
  const [account] = channel ? await tx.select().from(outboundAccounts).where(and(eq(outboundAccounts.id, accountId), eq(outboundAccounts.channelId, channel.id))).for('update') : [];
  const [binding] = account ? await tx.select().from(outboundBindings).where(and(eq(outboundBindings.accountId, account.id), eq(outboundBindings.status, 'active'))).for('update') : [];
  return { channel, account, binding };
}

function requireBound(way: Way, authority: Authority, generation: number): void {
  if (!way.binding) throw conflict('This account is bound to nobody now.', ['stale_binding']);
  if (way.binding.agentId !== authority.agentId) throw conflict('This account is bound to someone else.', ['account_bound_elsewhere']);
  if (way.binding.generation !== generation) throw conflict('This account changed hands since. Read it again.', ['stale_binding']);
}

/* Refuses a way that does not exist, is not this author's or does not work now. */
async function theWay(tx: Tx, authority: Authority, draft: Draft, task: Task): Promise<{ channel: Channel; account: Account; binding: Binding }> {
  const way = await holdWay(tx, authority.companyId, draft.channelId, draft.accountId);
  if (!way.channel) throw unknown('channel');
  if (!way.account) throw unknown('account');
  if (authority.departmentId !== way.channel.departmentId) throw notYours('This channel belongs to another department.');
  if (!inChannelPlace(task, way.channel)) throw notYours(`#${task.number} is not work of this channel.`);
  requireBound(way, authority, draft.bindingGeneration);
  if (way.account.status !== 'active') throw new ApiError(503, 'unavailable', 'This account cannot send now.', 'outbound_unavailable');
  return { channel: way.channel, account: way.account, binding: way.binding! };
}

/* Everyone a message is to, as the server knows them. */
type Reached = { recipient: string; reasons: GateCode[]; source: Source | null };

function targetFits(channel: Channel, target: Target): void {
  const fits = channel.audience === 'public' ? target.kind === 'audience' : target.kind !== 'audience';
  if (!fits) throw new ApiError(400, 'validation', channel.audience === 'public' ? 'This channel posts to its registered audience.' : 'This channel writes to one contact.', 'outbound_invalid');
}

const hasPermission = async (tx: Tx, contact: Contact, channel: Channel): Promise<boolean> =>
  (await tx.select(idOnly(outboundPermissions)).from(outboundPermissions).where(and(eq(outboundPermissions.contactId, contact.id), eq(outboundPermissions.channelId, channel.id), eq(outboundPermissions.purpose, channel.purpose), eq(outboundPermissions.status, 'granted')))).length > 0;

const contactReasons = async (tx: Tx, contact: Contact, channel: Channel): Promise<GateCode[]> => {
  if (contact.doNotContact) return ['contact_suppressed'];
  return (await hasPermission(tx, contact, channel)) ? [] : ['consent_missing'];
};

/* The contact, held so that a refusal comes wholly before or wholly after whatever reads it here. */
async function holdContact(tx: Tx, companyId: string, contactId: string): Promise<Contact | null> {
  const [contact] = await tx.select().from(outboundContacts).where(and(eq(outboundContacts.id, contactId), eq(outboundContacts.companyId, companyId))).for('update');
  return contact ?? null;
}

async function reachContact(tx: Tx, ctx: Ctx, contact: Contact, channel: Channel): Promise<Reached> {
  return { recipient: decryptSecret(contact.addressEnc, ctx.config.secret), reasons: await contactReasons(tx, contact, channel), source: null };
}

const CATALOG_ROW = {
  entryId: outboundCatalogRevisions.entryId, revision: outboundCatalogRevisions.revision, kind: outboundCatalogRevisions.kind, locale: outboundCatalogRevisions.locale, value: outboundCatalogRevisions.value, digest: outboundCatalogRevisions.digest,
  status: outboundCatalogRevisions.status, validFrom: outboundCatalogRevisions.validFrom, validUntil: outboundCatalogRevisions.validUntil, departmentId: outboundCatalogRevisions.departmentId, productId: outboundCatalogRevisions.productId, channelId: outboundCatalogRevisions.channelId,
};

const placeOf = (channel: Channel): Place => ({ channelId: channel.id, departmentId: channel.departmentId, productId: channel.productId });

async function currentOf(tx: Tx, companyId: string, entryId: string): Promise<Source | null> {
  return currentRevision(await tx.select(CATALOG_ROW).from(outboundCatalogRevisions).where(and(eq(outboundCatalogRevisions.companyId, companyId), eq(outboundCatalogRevisions.entryId, entryId))));
}

/* A public channel's only destination: the one its owner registered. */
async function reachAudience(tx: Tx, channel: Channel, audienceId: string, now: Date): Promise<Reached> {
  const source = await currentOf(tx, channel.companyId, audienceId);
  const value = source && usable(source, placeOf(channel), now) ? catalogValue(source, 'audience') : null;
  if (!value || unsafeLink(value.destination)) return { recipient: '', reasons: ['template_unapproved'], source: null };
  return { recipient: value.destination, reasons: [], source };
}

async function segmentOf(tx: Tx, channel: Channel, segmentId: string | null, now: Date): Promise<{ source: Source | null; reasons: GateCode[] }> {
  if (segmentId === null) return { source: null, reasons: [] };
  const source = await currentOf(tx, channel.companyId, segmentId);
  return source && usable(source, placeOf(channel), now) && catalogValue(source, 'segment') ? { source, reasons: [] } : { source: null, reasons: ['template_unapproved'] };
}

const idsNamedBy = (document: MessageDocument): string[] => [document.templateId, ...document.blocks.map(b => b.id), ...document.variables.map(v => v.valueRef)];

const namedByPrice = (rows: readonly Source[]): string[] => rows.flatMap(row => {
  const price = catalogValue(row, 'price');
  return price ? [price.discountId, price.termsId].filter(id => id !== null) : [];
});

const rowsOf = async (tx: Tx, companyId: string, ids: readonly string[]): Promise<Source[]> =>
  ids.length ? tx.select(CATALOG_ROW).from(outboundCatalogRevisions).where(and(eq(outboundCatalogRevisions.companyId, companyId), inArray(outboundCatalogRevisions.entryId, [...ids]))) : [];

function byEntry(rows: readonly Source[]): Map<string, Source[]> {
  const entries = new Map<string, Source[]>();
  for (const row of rows) entries.set(row.entryId, [...(entries.get(row.entryId) ?? []), row]);
  return entries;
}

/* The revision that counts now of all a document names, and all its prices rest on. */
async function catalogFor(tx: Tx, companyId: string, document: MessageDocument): Promise<Catalog> {
  const named = await rowsOf(tx, companyId, idsNamedBy(document));
  const entries = byEntry([...named, ...(await rowsOf(tx, companyId, namedByPrice(named)))]);
  return id => currentRevision(entries.get(id) ?? []);
}

/* What a channel's messages may use now: of each entry the revision that counts, when it is in place and in time. */
export async function currentCatalog(db: Pick<Ctx['db'], 'select'>, channel: Channel, now: Date, only?: SQL): Promise<Source[]> {
  const rows = await db.select(CATALOG_ROW).from(outboundCatalogRevisions).where(and(eq(outboundCatalogRevisions.companyId, channel.companyId), eq(outboundCatalogRevisions.departmentId, channel.departmentId), only));
  return [...byEntry(rows).values()].flatMap(revisions => currentRevision(revisions) ?? []).filter(row => usable(row, placeOf(channel), now));
}

const specificity = (source: Source): number => (source.channelId ? 2 : source.productId ? 1 : 0);

/* The published words of this language for stopping messages: the closest to the channel there is. */
async function stopWords(tx: Tx, channel: Channel, locale: string, now: Date): Promise<Source | null> {
  const current = await currentCatalog(tx, channel, now, and(eq(outboundCatalogRevisions.kind, 'unsubscribe'), eq(outboundCatalogRevisions.locale, locale)));
  return current.sort((a, b) => specificity(b) - specificity(a) || a.entryId.localeCompare(b.entryId))[0] ?? null;
}

const refOf = (source: Source): SourceRef => ({ entryId: source.entryId, revision: source.revision, digest: source.digest });

/* Bytes of a message and what they rest on, or what stops them. */
type Drawn = { ok: true; rendered: Rendered; sourcesDigest: string } | { ok: false; reasons: GateCode[] };
type Sketch = { channel: Channel; account: Account; document: MessageDocument; contactId: string | null; segment: Source | null; audience: Source | null; base: string; now: Date };

function stopAddress(ctx: Ctx, s: Sketch): string | null {
  if (!s.contactId) return null;
  return unsubscribeUrl(s.base, ctx.config.secret, { companyId: s.channel.companyId, contactId: s.contactId, channelId: s.channel.id, purpose: s.channel.purpose });
}

async function draw(tx: Tx, ctx: Ctx, s: Sketch): Promise<Drawn> {
  const result = renderMessage({
    document: s.document, place: placeOf(s.channel), audience: s.channel.audience, catalog: await catalogFor(tx, s.channel.companyId, s.document),
    unsubscribe: { source: s.channel.audience === 'direct' ? await stopWords(tx, s.channel, s.document.locale, s.now) : null, url: stopAddress(ctx, s) },
    fields: { account_label: s.account.label, channel_name: s.channel.name }, now: s.now,
  });
  if (!result.ok) return { ok: false, reasons: result.reasonCodes };
  const extra = [s.segment, s.audience].filter(source => source !== null).map(refOf);
  return { ok: true, rendered: result.rendered, sourcesDigest: sourcesDigest([...result.rendered.sources, ...extra].sort((a, b) => a.entryId.localeCompare(b.entryId))) };
}

/* Numbers only go on, whatever is retried or cancelled. */
async function nextNumber(tx: Tx, channel: Channel, scope: 'channel' | 'segment' | 'author', scopeKey: string): Promise<number> {
  const [row] = await tx
    .insert(outboundSamplingCounters)
    .values({ companyId: channel.companyId, channelId: channel.id, scope, scopeKey, next: 2 })
    .onConflictDoUpdate({ target: [outboundSamplingCounters.companyId, outboundSamplingCounters.channelId, outboundSamplingCounters.scope, outboundSamplingCounters.scopeKey], set: { next: sql`${outboundSamplingCounters.next} + 1` } })
    .returning({ next: outboundSamplingCounters.next });
  return row!.next - 1;
}

/* Whether the last chosen message of this author went away before it passed. */
async function reviewOwed(tx: Tx, channelId: string, agentId: string): Promise<boolean> {
  const [last] = await tx
    .select(only(outboundMessages, 'status'))
    .from(outboundMessages)
    .where(and(eq(outboundMessages.channelId, channelId), eq(outboundMessages.authorAgentId, agentId), sql`${outboundMessages.samplingOrdinals} ->> 'review' = '1'`))
    .orderBy(desc(sql`(${outboundMessages.samplingOrdinals} ->> 'channel')::int`))
    .limit(1);
  return last?.status === 'cancelled';
}

async function takeNumbers(tx: Tx, channel: Channel, policy: CurrentPolicy, agentId: string, segmentId: string | null): Promise<Record<string, number>> {
  const numbers = {
    channel: await nextNumber(tx, channel, 'channel', channel.id),
    author: await nextNumber(tx, channel, 'author', agentId),
    segment: segmentId === null ? null : await nextNumber(tx, channel, 'segment', segmentId),
  };
  const chosen = selectedForReview(policy.value.sampling, { ...numbers, status: channel.status, owed: await reviewOwed(tx, channel.id, agentId) });
  return { channel: numbers.channel, author: numbers.author, ...(numbers.segment === null ? {} : { segment: numbers.segment }), review: chosen ? 1 : 0 };
}

type Reviewed = { codes: GateCode[]; escalated: boolean };
const clear: Reviewed = { codes: [], escalated: false };
const DECISIONS: Record<string, Reviewed> = { allow: clear, escalate: { codes: [], escalated: true }, block: { codes: ['review_failed'], escalated: false } };
type UnderReview = { id: string; revision: number; contentDigest: string; samplingOrdinals: Record<string, number>; targetKind: Message['targetKind'] };

/* A chosen message needs its check certified now and that check's word on exactly these bytes. Without either it holds. */
async function reviewGate(tx: Tx, channel: Channel, m: UnderReview, now: Date): Promise<Reviewed> {
  if (!m.samplingOrdinals.review) return clear;
  const check = await reviewCheck(tx, channel, m.targetKind === 'ticket' ? 'support_reply_review' : 'outbound_review');
  if (!check || !isOn(check, now)) return { codes: ['check_uncertified'], escalated: false };
  const [receipt] = await tx.select().from(outboundReviewReceipts).where(and(eq(outboundReviewReceipts.messageId, m.id), eq(outboundReviewReceipts.messageRevision, m.revision), eq(outboundReviewReceipts.bindingDigest, check.bindingDigest!), eq(outboundReviewReceipts.subjectDigest, m.contentDigest)));
  if (!receipt) return { codes: ['review_unavailable'], escalated: false };
  return receipt.result.kind === 'review' ? DECISIONS[receipt.result.decision]! : DECISIONS.block!;
}

/* restored: the message came back with a restored database, and waits for a person's word given since. */
type Asked = { need: Need; state: ApprovalState; bound: Bound | null; restored?: boolean };
type ToApprove = { channel: Channel; account: Account; bindingGeneration: number; decider: string; policy: CurrentPolicy; sources: string; money: readonly Money[]; escalated: boolean; document: MessageDocument; segmentId: string | null; messageId: string; revision: number; contentDigest: string; restored?: Date | null };

function boundFor(a: ToApprove, need: Need): Bound {
  const shared: Shared = {
    policyDigest: a.policy.digest, sourceRevisionsDigest: a.sources,
    authorityFingerprint: authorityFingerprint({ companyId: a.channel.companyId, departmentId: a.channel.departmentId, productId: a.channel.productId, decider: a.decider, channelGeneration: a.channel.generation, accountId: a.account.id, bindingGeneration: a.bindingGeneration, configGeneration: a.account.configGeneration }),
  };
  if (need === 'approach') return { kind: 'approach', channelId: a.channel.id, templateId: a.document.templateId, templateRevision: a.document.templateRevision, segmentId: a.segmentId!, locale: a.document.locale, ...shared };
  return { kind: 'message', messageId: a.messageId, messageRevision: a.revision, contentDigest: a.contentDigest, accountId: a.account.id, bindingGeneration: a.bindingGeneration, ...shared };
}

/* When the database in use was last put back from a backup, for a message that was in it then: such a message may have
   gone out between the backup and the restore, which the restored database cannot know. Null for one written since, and
   where nothing was restored. */
async function restoredOver(tx: Tx, m: Pick<Message, 'createdAt'>): Promise<Date | null> {
  const answer: unknown = await tx.execute(sql`SELECT max(at) AS at FROM net.restores`);
  const [last] = Array.isArray(answer) ? (answer as { at: Date | string | null }[]) : (answer as { rows: { at: Date | string | null }[] }).rows;
  const at = last?.at ? new Date(last.at) : null;
  return at && m.createdAt <= at ? at : null;
}

/* The department's rules as they are now, and what a person said of exactly this. A message that came back with a
   restored database goes only on a person's word for this very message, given after the restore, whatever the rules. */
async function approvalGate(tx: Tx, a: ToApprove): Promise<Asked> {
  const rules = await rulesFor(tx, a.channel.departmentId, a.channel.audience);
  const need = a.restored ? 'message' : approvalNeed(rules, { audience: a.channel.audience, money: a.money, escalated: a.escalated, hasSegment: a.segmentId !== null, autoSend: a.policy.value.autoSend === true });
  if (need === 'none') return { need, state: 'approved', bound: null };
  const bound = boundFor(a, need);
  if (a.restored) await withdrawAskedBefore(tx, a.channel.companyId, bound, a.restored, new Date());
  return { need, state: await approvalState(tx, a.channel.companyId, bound, a.restored ?? null), bound, restored: Boolean(a.restored) };
}

/* What a person reads. A stop link is nobody's to follow but its contact's, so it is not in these words. */
const RESTORED = 'Hornhoof was restored from a backup after this message was written. It may have gone out already: check before you let it go.';
const peopleText = (rendered: Rendered, stop: string | null, channel: Channel, restored = false): string => {
  const body = stop ? rendered.text.split(stop).join('[unsubscribe link]') : rendered.text;
  return `${restored ? `${RESTORED}\n` : ''}Approve this exact message on ${channel.name}.\nSubject: ${rendered.subject}\n\n${body}`;
};

const asking = (m: Pick<Message, 'companyId' | 'taskId' | 'authorAgentId' | 'authorJobId'>, channel: Channel, bound: Bound, text: string) => ({
  companyId: m.companyId, taskId: m.taskId, authorAgentId: m.authorAgentId, authorJobId: m.authorJobId, channel: sendingChannel(channel.audience), kindName: `outbound ${channel.name}`, text, bound,
});

type Prepared = { decider: string; base: string; now: Date };

const stateReasons = (asked: Asked): GateCode[] => (asked.state === 'approved' ? [] : asked.restored ? ['approval_required', 'restored'] : ['approval_required']);

const firstStatus = (review: Reviewed, asked: Asked): SubmitResult['status'] => {
  if (review.codes.length) return 'waiting_checks';
  return asked.state === 'approved' ? 'scheduled' : 'waiting_approval';
};

type Admitted = { result: SubmitResult; ask: ReturnType<typeof asking> | null };

type Admission = { tx: Tx; ctx: Ctx; authority: Authority; draft: Draft; task: Task; requestDigest: string; prepared: Prepared };

const messageValues = (a: Admission, channel: Channel) => ({
  companyId: a.authority.companyId, departmentId: channel.departmentId, productId: channel.productId, taskId: a.task.id, authorAgentId: a.authority.agentId, authorJobId: a.authority.jobId, idempotencyKey: a.draft.idempotencyKey, requestDigest: a.requestDigest,
  channelId: channel.id, accountId: a.draft.accountId, bindingGeneration: a.draft.bindingGeneration, targetKind: a.draft.target.kind, segmentId: a.draft.segmentId, scheduledAt: new Date(a.draft.scheduledAt),
  contactId: 'contactId' in a.draft.target ? a.draft.target.contactId : null, audienceEntryId: a.draft.target.kind === 'audience' ? a.draft.target.audienceId : null,
  ticketId: a.draft.target.kind === 'ticket' ? a.draft.target.ticketId : null, ticketRevision: a.draft.target.kind === 'ticket' ? a.draft.target.ticketRevision : null, classificationId: classificationOf(a.draft.target),
});

/* A refusal is kept, so that the same request has the same answer later. Its row says only why. */
async function refuseAdmission(a: Admission, channel: Channel, reasons: GateCode[]): Promise<Admitted> {
  const [row] = await a.tx.insert(outboundMessages).values({ ...messageValues(a, channel), status: 'rejected', reasonCodes: [...new Set(reasons)].sort() }).onConflictDoNothing().returning();
  if (row) return { result: resultOf(row, a.requestDigest), ask: null };
  return { result: (await answerAgain(a.tx, a.authority, a.draft.idempotencyKey, a.requestDigest))!, ask: null };
}

const contactIdOf = (target: Target): string | null => ('contactId' in target ? target.contactId : null);

async function reachTarget(a: Admission, channel: Channel): Promise<Reached> {
  targetFits(channel, a.draft.target);
  const contactId = contactIdOf(a.draft.target);
  if (contactId === null) return reachAudience(a.tx, channel, (a.draft.target as { audienceId: string }).audienceId, a.prepared.now);
  const contact = await holdContact(a.tx, a.authority.companyId, contactId);
  if (!contact) throw unknown('contact');
  return reachContact(a.tx, a.ctx, contact, channel);
}

const scheduledIso = (draft: Draft): string => new Date(draft.scheduledAt).toISOString();

function frozenOf(a: Admission, channel: Channel, account: Account, recipient: string, drawn: Extract<Drawn, { ok: true }>) {
  return frozenDigest({
    subject: drawn.rendered.subject, text: drawn.rendered.text, recipientDigest: recipientDigest(recipient), accountId: account.id, channelId: channel.id, purpose: channel.purpose, locale: a.draft.document.locale,
    segmentId: a.draft.segmentId, scheduledAt: scheduledIso(a.draft), sourceRevisionsDigest: drawn.sourcesDigest, bindingGeneration: a.draft.bindingGeneration,
  });
}

const channelReasons = (channel: Channel, policy: CurrentPolicy | null): GateCode[] => [...(channel.status === 'stopped' ? (['channel_stopped'] as const) : []), ...(policy ? [] : (['daily_limit_exceeded'] as const))];

/* Everything of an admission, in the locks' order. Nothing here leaves the server. */
async function admitHolding(a: Admission): Promise<Admitted> {
  const { channel, account } = await theWay(a.tx, a.authority, a.draft, a.task);
  const again = await answerAgain(a.tx, a.authority, a.draft.idempotencyKey, a.requestDigest);
  if (again) return { result: again, ask: null };
  const reached = await reachTarget(a, channel);
  const policy = await currentPolicy(a.tx, channel.id);
  const before = [...channelReasons(channel, policy), ...reached.reasons];
  if (before.length) return refuseAdmission(a, channel, before);
  const segment = await segmentOf(a.tx, channel, a.draft.segmentId, a.prepared.now);
  if (segment.reasons.length) return refuseAdmission(a, channel, segment.reasons);
  const contactId = contactIdOf(a.draft.target);
  const drawn = await draw(a.tx, a.ctx, { channel, account, document: a.draft.document, contactId, segment: segment.source, audience: reached.source, base: a.prepared.base, now: a.prepared.now });
  if (!drawn.ok) return refuseAdmission(a, channel, drawn.reasons);
  return freeze(a, channel, account, policy!, reached, drawn);
}

const classificationOf = (target: Target): string | null => (target.kind === 'ticket' ? target.classificationId : null);

/* A class of ticket that wants a person wants one for this very reply. A classifier that has not said so yes or no counts. */
async function wantsPerson(tx: Tx, companyId: string, classificationId: string | null): Promise<boolean> {
  if (!classificationId) return false;
  const [classified] = await tx.select(only(supportClassifications, 'requiresHuman')).from(supportClassifications).where(and(eq(supportClassifications.id, classificationId), eq(supportClassifications.companyId, companyId)));
  return classified?.requiresHuman !== false;
}

async function freeze(a: Admission, channel: Channel, account: Account, policy: CurrentPolicy, reached: Reached, drawn: Extract<Drawn, { ok: true }>): Promise<Admitted> {
  const messageId = randomUUID();
  const contentDigest = frozenOf(a, channel, account, reached.recipient, drawn);
  const asked = await approvalGate(a.tx, { channel, account, bindingGeneration: a.draft.bindingGeneration, decider: a.prepared.decider, policy, sources: drawn.sourcesDigest, money: drawn.rendered.money, escalated: await wantsPerson(a.tx, a.authority.companyId, classificationOf(a.draft.target)), document: a.draft.document, segmentId: a.draft.segmentId, messageId, revision: 1, contentDigest });
  if (asked.state === 'declined') return refuseAdmission(a, channel, ['approval_required']);
  const samplingOrdinals = await takeNumbers(a.tx, channel, policy, a.authority.agentId, a.draft.segmentId);
  const review = await reviewGate(a.tx, channel, { id: messageId, revision: 1, contentDigest, samplingOrdinals, targetKind: a.draft.target.kind }, a.prepared.now);
  const status = firstStatus(review, asked);
  const reasonCodes = review.codes.length ? review.codes : stateReasons(asked);
  const [row] = await a.tx.insert(outboundMessages).values({ ...messageValues(a, channel), id: messageId, samplingOrdinals, status, reasonCodes }).onConflictDoNothing().returning();
  if (!row) return { result: (await answerAgain(a.tx, a.authority, a.draft.idempotencyKey, a.requestDigest))!, ask: null };
  const sealed: SealedPayload = { recipient: reached.recipient, subject: drawn.rendered.subject, text: drawn.rendered.text };
  await a.tx.insert(outboundMessageRevisions).values({ companyId: row.companyId, messageId, revision: 1, document: a.draft.document, contentDigest, sealedEnc: encryptSecret(JSON.stringify(sealed), a.ctx.config.secret), sourceRevisionsDigest: drawn.sourcesDigest, policyId: policy.id, policyDigest: policy.digest });
  const stop = stopAddress(a.ctx, { channel, account, document: a.draft.document, contactId: contactIdOf(a.draft.target), segment: null, audience: null, base: a.prepared.base, now: a.prepared.now });
  const toAsk = status === 'waiting_approval' && asked.state === 'missing' && asked.bound ? asking(row, channel, asked.bound, peopleText(drawn.rendered, stop, channel)) : null;
  return { result: resultOf(row, contentDigest), ask: toAsk };
}

const prepare = async (ctx: Ctx, place: { companyId: string; departmentId: string | null; productId: string | null }, now: Date): Promise<Prepared> => ({
  decider: place.departmentId ? await deciderOf(ctx, { ...place, departmentId: place.departmentId }) : '',
  base: await publicUrl(ctx.db, ctx.config),
  now,
});

/* Puts it before a person. If nobody can be asked any more, it goes no further. */
async function askOrCancel(ctx: Ctx, messageId: string, ask: ReturnType<typeof asking>): Promise<void> {
  try {
    await askApproval(ctx, ask);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    await ctx.db.transaction(async tx => {
      const [message] = await tx.select(only(outboundMessages, 'channelId')).from(outboundMessages).where(eq(outboundMessages.id, messageId));
      await tx.select(idOnly(outboundChannels)).from(outboundChannels).where(eq(outboundChannels.id, message!.channelId)).for('update');
      await tx.update(outboundMessages).set({ status: 'cancelled', reasonCodes: ['stale_binding'], updatedAt: new Date() }).where(and(eq(outboundMessages.id, messageId), inArray(outboundMessages.status, [...RESERVABLE])));
    });
  }
}

/* The kernel behind a submit of any kind. Neither path sends: what is admitted waits for the dispatcher. */
export async function admit(ctx: Ctx, authority: Authority, draft: Draft): Promise<SubmitResult> {
  const task = await taskByRef(ctx, authority.companyId, draft.task);
  if (!task) throw unknown('task');
  const requestDigest = digestOf({ ...draft, task: task.id });
  const kept = await answerAgain(ctx.db, authority, draft.idempotencyKey, requestDigest);
  if (kept) return kept;
  requireHeld(task, authority);
  const prepared = await prepare(ctx, task, new Date());
  const { result, ask } = await ctx.db.transaction(tx => admitHolding({ tx, ctx, authority, draft, task, requestDigest, prepared }));
  if (ask) await askOrCancel(ctx, result.messageId, ask);
  return result;
}

export const submitOutbound = (ctx: Ctx, authority: Authority, input: OutboundSubmit): Promise<SubmitResult> => admit(ctx, authority, input);

async function mayRead(ctx: Pick<Ctx, 'db'>, authority: Authority, message: Message): Promise<boolean> {
  if (message.authorAgentId === authority.agentId) return true;
  const [agent] = await ctx.db.select({ kind: agents.kind, departmentId: agents.departmentId }).from(agents).where(and(eq(agents.id, authority.agentId), eq(agents.companyId, authority.companyId)));
  return agent?.kind === 'orchestrator' || (agent?.kind === 'head' && agent.departmentId === message.departmentId);
}

/* What an author may read of a message: nothing of its contact, adapter or provider. Reading moves nothing. */
export async function outboundStatus(ctx: Pick<Ctx, 'db'>, authority: Authority, messageId: string): Promise<OutboundMessageView> {
  const [message] = await ctx.db.select().from(outboundMessages).where(and(eq(outboundMessages.id, messageId), eq(outboundMessages.companyId, authority.companyId)));
  if (!message || !(await mayRead(ctx, authority, message))) throw unknown('message');
  const contentDigest = (await revisionOf(ctx.db, message))?.contentDigest ?? message.requestDigest;
  return { messageId: message.id, revision: message.revision, contentDigest, reasonCodes: message.reasonCodes, status: message.status, channelId: message.channelId, accountId: message.accountId, scheduledAt: message.scheduledAt.toISOString(), updatedAt: message.updatedAt.toISOString() };
}

/* What was frozen, when the seal still opens and still says it. */
function openSeal(ctx: Ctx, m: Message, revision: Revision, channel: Channel): SealedPayload | null {
  try {
    const sealed = JSON.parse(decryptSecret(revision.sealedEnc, ctx.config.secret)) as SealedPayload;
    const digest = frozenDigest({
      subject: sealed.subject, text: sealed.text, recipientDigest: recipientDigest(sealed.recipient), accountId: m.accountId, channelId: m.channelId, purpose: channel.purpose, locale: revision.document.locale,
      segmentId: m.segmentId, scheduledAt: m.scheduledAt.toISOString(), sourceRevisionsDigest: revision.sourceRevisionsDigest, bindingGeneration: m.bindingGeneration,
    });
    return digest === revision.contentDigest ? sealed : null;
  } catch {
    return null;
  }
}

/* The author still answers for this work: it was not cancelled or given to someone else, and they did not leave. A task
   that ended well is no reason: its work was accepted. */
async function authorStands(tx: Tx, m: Message): Promise<boolean> {
  const [task] = await tx.select({ status: tasks.status, executor: tasks.executorAgentId, assignee: tasks.assigneeAgentId }).from(tasks).where(eq(tasks.id, m.taskId));
  const [author] = await tx.select(only(agents, 'removedAt')).from(agents).where(eq(agents.id, m.authorAgentId));
  return task?.status !== 'cancelled' && (task?.executor ?? task?.assignee) === m.authorAgentId && author?.removedAt === null;
}

const wayStands = (m: Message, way: Way): boolean => way.account?.status === 'active' && way.binding?.agentId === m.authorAgentId && way.binding.generation === m.bindingGeneration;

/* What is said of a message at a look: final ends it, hold keeps it for later. */
type Gates = { final: GateCode[]; hold: GateCode[]; ask: ReturnType<typeof asking> | null; sealed: SealedPayload | null };
const ended = (final: GateCode[]): Gates => ({ final, hold: [], ask: null, sealed: null });

async function reachMessage(tx: Tx, ctx: Ctx, m: Message, channel: Channel, now: Date): Promise<Reached> {
  if (m.audienceEntryId) return reachAudience(tx, channel, m.audienceEntryId, now);
  const contact = await holdContact(tx, m.companyId, m.contactId!);
  return reachContact(tx, ctx, contact!, channel);
}

/* The sources and bytes a message rests on, as they are now. */
async function currentBytes(tx: Tx, ctx: Ctx, l: Look, reached: Reached): Promise<{ drawn: Extract<Drawn, { ok: true }>; sealed: SealedPayload } | { final: GateCode[] }> {
  const { message: m, revision, channel, account, prepared } = l;
  const segment = await segmentOf(tx, channel, m.segmentId, prepared.now);
  if (segment.reasons.length) return { final: segment.reasons };
  const drawn = await draw(tx, ctx, { channel, account, document: revision.document, contactId: m.contactId, segment: segment.source, audience: reached.source, base: prepared.base, now: prepared.now });
  if (!drawn.ok) return { final: drawn.reasons };
  const sealed = openSeal(ctx, m, revision, channel);
  return sealed && drawn.sourcesDigest === revision.sourceRevisionsDigest ? { drawn, sealed } : { final: ['stale_binding'] };
}

type Look = { message: Message; revision: Revision; channel: Channel; account: Account; way: Way; prepared: Prepared };

/* The review and the person, as they stand now over bytes that are still current. */
async function peopleAndChecks(tx: Tx, ctx: Ctx, l: Look, drawn: Extract<Drawn, { ok: true }>, sealed: SealedPayload, policy: CurrentPolicy): Promise<Gates> {
  const { message: m, revision, channel, account, prepared } = l;
  const review = await reviewGate(tx, channel, { id: m.id, revision: revision.revision, contentDigest: revision.contentDigest, samplingOrdinals: m.samplingOrdinals, targetKind: m.targetKind }, prepared.now);
  if (review.codes.includes('review_failed')) return ended(['review_failed']);
  const asked = await approvalGate(tx, { channel, account, bindingGeneration: m.bindingGeneration, decider: prepared.decider, policy, sources: drawn.sourcesDigest, money: drawn.rendered.money, escalated: review.escalated || (await wantsPerson(tx, m.companyId, m.classificationId)), document: revision.document, segmentId: m.segmentId, messageId: m.id, revision: revision.revision, contentDigest: revision.contentDigest, restored: await restoredOver(tx, m) });
  if (asked.state === 'declined') return ended(['approval_required']);
  const hold = [...(channel.status === 'stopped' ? (['channel_stopped'] as const) : []), ...review.codes, ...stateReasons(asked)];
  const stop = m.contactId ? stopAddress(ctx, { channel, account, document: revision.document, contactId: m.contactId, segment: null, audience: null, base: prepared.base, now: prepared.now }) : null;
  const onlyAPerson = hold.filter(code => code !== 'restored').length === 1 && asked.state === 'missing' && asked.bound;
  return { final: [], hold, ask: onlyAPerson ? asking(m, channel, asked.bound!, peopleText(drawn.rendered, stop, channel, asked.restored)) : null, sealed };
}

/* All the gates over again, as of this moment, under the locks. */
async function gatesOf(tx: Tx, ctx: Ctx, l: Look): Promise<Gates> {
  const { message: m, channel, way, prepared } = l;
  if (!wayStands(m, way) || !(await authorStands(tx, m))) return ended(['stale_binding']);
  const reached = await reachMessage(tx, ctx, m, channel, prepared.now);
  if (reached.reasons.length) return ended(reached.reasons);
  const bytes = await currentBytes(tx, ctx, l, reached);
  if ('final' in bytes) return ended(bytes.final);
  const policy = await currentPolicy(tx, channel.id);
  if (!policy) return { final: [], hold: ['daily_limit_exceeded'], ask: null, sealed: null };
  return peopleAndChecks(tx, ctx, l, bytes.drawn, bytes.sealed, policy);
}

const seenMessage = async (db: Pick<Ctx['db'], 'select'>, messageId: string): Promise<Message | null> => (await db.select().from(outboundMessages).where(eq(outboundMessages.id, messageId)))[0] ?? null;

const lockMessage = async (tx: Tx, messageId: string): Promise<Message> => (await tx.select().from(outboundMessages).where(eq(outboundMessages.id, messageId)).for('update'))[0]!;

const setStatus = (tx: Tx, messageId: string, status: Message['status'], reasonCodes: GateCode[], now: Date) => tx.update(outboundMessages).set({ status, reasonCodes, updatedAt: now }).where(eq(outboundMessages.id, messageId));

type Refused = Extract<DispatchAdmission, { kind: 'refused' }>;
const NOTHING: Refused = { kind: 'refused', reasonCodes: [] };
const refusedFor = (reasonCodes: GateCode[]): Refused => ({ kind: 'refused', reasonCodes });

/* A hold keeps a message for later. A check that has not read it as it stands reads only what waits for one; a person's answer it
   waits for shows on it. */
const heldStatus = (hold: readonly GateCode[]): Message['status'] => {
  if (hold.includes('review_unavailable')) return 'waiting_checks';
  return hold.includes('approval_required') ? 'waiting_approval' : 'scheduled';
};

/* Takes the day's places of the account and its sender domain together. The domain counts company-wide, across its accounts
   and whatever policy each goes by, so it is one at a time per domain. */
async function takePlaces(tx: Tx, m: Message, account: Account, policy: CurrentPolicy, now: Date): Promise<{ accountBucketId: string; domainBucketId: string } | null> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`outbound:${m.companyId}:${account.senderDomain}`}::text, 0))`);
  const accountBucketId = await placeIn(tx, m.companyId, 'account', account.id, policy, policy.value.accountDailyLimit, now);
  if (!accountBucketId) return null;
  const domainBucketId = await placeIn(tx, m.companyId, 'domain', account.senderDomain, policy, policy.value.domainDailyLimit, now);
  if (!domainBucketId) return null;
  await tx.update(outboundDailyUsage).set({ reserved: sql`${outboundDailyUsage.reserved} + 1` }).where(inArray(outboundDailyUsage.id, [accountBucketId, domainBucketId]));
  return { accountBucketId, domainBucketId };
}

const daysAround = (day: string, by: number): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + by * 86_400_000).toISOString().slice(0, 10);

/* This day's bucket of a scope, when what overlaps it leaves room. */
async function placeIn(tx: Tx, companyId: string, scope: 'account' | 'domain', scopeKey: string, policy: CurrentPolicy, limit: number, now: Date): Promise<string | null> {
  const { timezone } = policy.value;
  const day = dayOf(now, timezone);
  await tx.insert(outboundDailyUsage).values({ companyId, scope, scopeKey, day, timezone, limitVersion: policy.revision }).onConflictDoNothing();
  const near = await tx.select().from(outboundDailyUsage).where(and(eq(outboundDailyUsage.companyId, companyId), eq(outboundDailyUsage.scope, scope), eq(outboundDailyUsage.scopeKey, scopeKey), gte(outboundDailyUsage.day, daysAround(day, -2)), lte(outboundDailyUsage.day, daysAround(day, 2))));
  if (usedWithin(near, { day, timezone }) >= limit) return null;
  return near.find(b => b.day === day && b.timezone === timezone && b.limitVersion === policy.revision)!.id;
}

const notDue = (m: Message, now: Date): boolean => !RESERVABLE.includes(m.status) || m.scheduledAt > now;

type Reserved = { kind: 'reserved'; attemptId: string } | Refused;

/* What a look ending in a refusal does to the message. */
async function afterRefusal(tx: Tx, messageId: string, gates: Gates, now: Date): Promise<GateCode[]> {
  if (gates.final.length) {
    await setStatus(tx, messageId, 'cancelled', gates.final, now);
    return gates.final;
  }
  await setStatus(tx, messageId, heldStatus(gates.hold), gates.hold, now);
  return gates.hold;
}

/* Under the channel's and the contact's locks a message stands still: whoever changes it holds one of them. */
async function reserveUnderLocks(tx: Tx, ctx: Ctx, seen: Message, expectedRevision: number, prepared: Prepared): Promise<{ result: Reserved; ask: Gates['ask'] }> {
  const way = await holdWay(tx, seen.companyId, seen.channelId, seen.accountId);
  if (seen.contactId) await holdContact(tx, seen.companyId, seen.contactId);
  const message = (await seenMessage(tx, seen.id))!;
  if (message.revision !== expectedRevision) return { result: refusedFor(['stale_binding']), ask: null };
  if (message.status === 'reserved') return { result: { kind: 'reserved', attemptId: (await reservationOf(tx, seen.id))!.id }, ask: null };
  if (notDue(message, prepared.now)) return { result: NOTHING, ask: null };
  const revision = await revisionOf(tx, message);
  const gates = await gatesOf(tx, ctx, { message, revision: revision!, channel: way.channel!, account: way.account!, way, prepared });
  if (gates.final.length || gates.hold.length) return { result: refusedFor(await afterRefusal(tx, message.id, gates, prepared.now)), ask: gates.ask };
  return { result: await reserveHolding(tx, message, way, prepared.now), ask: null };
}

/* Holds a due message's places for the day. Nothing has left yet, and nothing has decided it will. */
export async function reserveDispatch(ctx: Ctx, messageId: string, expectedRevision: number, now = new Date()): Promise<Reserved> {
  const seen = await seenMessage(ctx.db, messageId);
  if (!seen) return NOTHING;
  const prepared = await prepare(ctx, seen, now);
  const out = await ctx.db.transaction(tx => reserveUnderLocks(tx, ctx, seen, expectedRevision, prepared));
  if (out.ask) await askOrCancel(ctx, messageId, out.ask);
  return out.result;
}

async function reserveHolding(tx: Tx, message: Message, way: Way, now: Date): Promise<Reserved> {
  const policy = (await currentPolicy(tx, message.channelId))!;
  const places = await takePlaces(tx, message, way.account!, policy, now);
  if (!places) {
    await setStatus(tx, message.id, 'scheduled', ['daily_limit_exceeded'], now);
    return refusedFor(['daily_limit_exceeded']);
  }
  const [attempt] = await tx.insert(outboundAttempts).values({ companyId: message.companyId, messageId: message.id, messageRevision: message.revision, accountId: message.accountId, bindingGeneration: message.bindingGeneration, configGeneration: way.account!.configGeneration, channelGeneration: way.channel!.generation, status: 'reserved', ...places }).returning();
  await setStatus(tx, message.id, 'reserved', [], now);
  return { kind: 'reserved', attemptId: attempt!.id };
}

const reservationOf = async (db: Pick<Ctx['db'], 'select'>, messageId: string): Promise<Attempt | null> => (await db.select().from(outboundAttempts).where(and(eq(outboundAttempts.messageId, messageId), eq(outboundAttempts.status, 'reserved'))))[0] ?? null;

/* A stop is said by the stop itself: its reservation goes back and its message stays. Any other new generation ends it. */
const sameGenerations = (attempt: Attempt, way: Way): boolean => (way.channel!.status === 'stopped' || attempt.channelGeneration === way.channel!.generation) && attempt.configGeneration === way.account!.configGeneration;

const anyOnItsWay = async (tx: Tx, m: Message): Promise<boolean> => (await tx.select(idOnly(outboundAttempts)).from(outboundAttempts).where(and(eq(outboundAttempts.companyId, m.companyId), eq(outboundAttempts.accountId, m.accountId), inArray(outboundAttempts.status, ['sending', 'unknown'])))).length > 0;

type Begin = { result: DispatchAdmission; ask: Gates['ask'] };

async function goAhead(tx: Tx, m: Message, attempt: Attempt, account: Account, sealed: SealedPayload, now: Date): Promise<Begin> {
  await tx.update(outboundAttempts).set({ status: 'sending', leaseId: randomUUID(), leaseUntil: new Date(now.getTime() + LEASE_MS), startedAt: now }).where(eq(outboundAttempts.id, attempt.id));
  await setStatus(tx, m.id, 'sending', [], now);
  return { result: { kind: 'begun', attemptId: attempt.id, accountId: account.id, configGeneration: account.configGeneration, sealedPayload: sealed }, ask: null };
}

/* A look that said no gives the reservation back: nothing was handed to any transport. */
async function giveBack(tx: Tx, m: Message, attempt: Attempt, gates: Gates, now: Date): Promise<Begin> {
  await releaseAttempt(tx, attempt, now);
  return { result: refusedFor(await afterRefusal(tx, m.id, gates, now)), ask: gates.ask };
}

/* The last look, under the locks. */
async function beginHolding(tx: Tx, ctx: Ctx, message: Message, attempt: Attempt, way: Way, prepared: Prepared): Promise<Begin> {
  const { now } = prepared;
  if (!sameGenerations(attempt, way)) return giveBack(tx, message, attempt, ended(['stale_binding']), now);
  const revision = (await revisionOf(tx, message))!;
  const gates = await gatesOf(tx, ctx, { message, revision, channel: way.channel!, account: way.account!, way, prepared });
  if (gates.final.length || gates.hold.length) return giveBack(tx, message, attempt, gates, now);
  if (await anyOnItsWay(tx, message)) return { result: refusedFor(['delivery_unknown']), ask: null };
  return goAhead(tx, message, attempt, way.account!, gates.sealed!, now);
}

/* Current sources, consent, suppression, approval, certificate, account and channel, all over again, and then one attempt.
   Only the trusted dispatcher calls this and only it gets the payload. It sends outside this step. */
export const beginDispatch: (...args: [...Parameters<BeginDispatch>, now?: Date]) => Promise<DispatchAdmission> = async (ctx, messageId, expectedRevision, now = new Date()) => {
  const seen = await seenMessage(ctx.db, messageId);
  const reservation = seen && (await reservationOf(ctx.db, messageId));
  if (!seen || !reservation) return NOTHING;
  const prepared = await prepare(ctx, seen, now);
  const out = await ctx.db.transaction(async (tx): Promise<Begin> => {
    const way = await holdWay(tx, seen.companyId, seen.channelId, seen.accountId);
    if (seen.contactId) await holdContact(tx, seen.companyId, seen.contactId);
    await lockBuckets(tx, [reservation]);
    const message = await lockMessage(tx, messageId);
    if (message.revision !== expectedRevision) return { result: refusedFor(['stale_binding']), ask: null };
    const attempt = await reservationOf(tx, messageId);
    if (message.status !== 'reserved' || !attempt) return { result: NOTHING, ask: null };
    return beginHolding(tx, ctx, message, attempt, way, prepared);
  });
  if (out.ask) await askOrCancel(ctx, messageId, out.ask);
  return out.result;
};

const OUTCOME_STATUS = { accepted: 'sent', definitely_not_accepted: 'definitely_failed', unknown: 'unknown' } as const;
const CAME_FROM = { reserved: { reserved: sql`${outboundDailyUsage.reserved} - 1` }, unknown: { unknown: sql`${outboundDailyUsage.unknown} - 1` } };
const WENT_TO = { accepted: { accepted: sql`${outboundDailyUsage.accepted} + 1` }, definitely_not_accepted: { definitelyFailed: sql`${outboundDailyUsage.definitelyFailed} + 1` }, unknown: { unknown: sql`${outboundDailyUsage.unknown} + 1` } };

type Outcome = Parameters<SettleAttempt>[2];

const outcomeColumns = (outcome: Outcome, now: Date) => {
  if (outcome.kind === 'accepted') return { status: outcome.kind, providerReceipt: outcome.providerReceipt, safeCode: null, endedAt: new Date(outcome.acceptedAt) };
  return { status: outcome.kind, safeCode: outcome.safeCode, providerReceipt: null, endedAt: now };
};

const moveCount = (tx: Tx, attempt: Attempt, outcome: Outcome) =>
  tx.update(outboundDailyUsage).set({ ...CAME_FROM[attempt.status === 'unknown' ? 'unknown' : 'reserved'], ...WENT_TO[outcome.kind] }).where(inArray(outboundDailyUsage.id, [attempt.accountBucketId, attempt.domainBucketId]));

/* A clean outcome counts toward a channel growing up. An unknown one never does. */
async function countClean(tx: Tx, m: Message): Promise<void> {
  const [channel] = await tx.select({ id: outboundChannels.id, status: outboundChannels.status }).from(outboundChannels).where(eq(outboundChannels.id, m.channelId));
  const [counter] = await tx
    .update(outboundSamplingCounters)
    .set({ cleanOutcomes: sql`${outboundSamplingCounters.cleanOutcomes} + 1` })
    .where(and(eq(outboundSamplingCounters.channelId, m.channelId), eq(outboundSamplingCounters.scope, 'channel')))
    .returning({ clean: outboundSamplingCounters.cleanOutcomes });
  const policy = await currentPolicy(tx, m.channelId);
  if (channel?.status === 'new' && policy && (counter?.clean ?? 0) >= policy.value.sampling.matureAfter) await tx.update(outboundChannels).set({ status: 'active' }).where(eq(outboundChannels.id, m.channelId));
}

const settled = (attempt: Attempt, outcome: Outcome): boolean => !['sending', 'unknown'].includes(attempt.status) || (attempt.status === 'unknown' && outcome.kind === 'unknown');

/* What the transport said of an attempt. "accepted" and a sure failure are for good; "unknown" keeps its place and its
   account closed until something settles it. */
export const settleAttempt: (...args: [...Parameters<SettleAttempt>, now?: Date]) => Promise<void> = async (ctx, attemptId, outcome, now = new Date()) => {
  const [seen] = await ctx.db.select().from(outboundAttempts).where(eq(outboundAttempts.id, attemptId));
  if (!seen) return;
  const [owner] = await ctx.db.select(only(outboundMessages, 'channelId')).from(outboundMessages).where(eq(outboundMessages.id, seen.messageId));
  await ctx.db.transaction(async tx => {
    await tx.select(idOnly(outboundChannels)).from(outboundChannels).where(eq(outboundChannels.id, owner!.channelId)).for('update');
    await lockBuckets(tx, [seen]);
    const [attempt] = await tx.select().from(outboundAttempts).where(eq(outboundAttempts.id, attemptId)).for('update');
    if (settled(attempt!, outcome)) return;
    await tx.update(outboundAttempts).set(outcomeColumns(outcome, now)).where(eq(outboundAttempts.id, attemptId));
    await moveCount(tx, attempt!, outcome);
    const message = await lockMessage(tx, attempt!.messageId);
    await setStatus(tx, message.id, OUTCOME_STATUS[outcome.kind], outcome.kind === 'unknown' ? ['delivery_unknown'] : [], now);
    if (outcome.kind === 'accepted') await countClean(tx, message);
  });
};

/* What a person or a limit keeps. Each may have been let go since, which only a look finds out. */
const heldBack = sql`(${outboundMessages.status} = 'waiting_approval' OR (${outboundMessages.status} = 'scheduled' AND jsonb_array_length(${outboundMessages.reasonCodes}) > 0))`;

/* What the dispatcher may look at now, a part of each account's queue and of what it holds back, so a long or stuck one holds no
   other back: what can go oldest first, what is held the longest unseen first, as each look writes on it. Being listed decides
   nothing: its last look does. */
export async function dueMessages(ctx: Pick<Ctx, 'db'>, now: Date, perAccount = 20): Promise<{ messageId: string; revision: number }[]> {
  const ranked = ctx.db
    .select({
      messageId: outboundMessages.id,
      revision: outboundMessages.revision,
      scheduledAt: outboundMessages.scheduledAt,
      createdAt: outboundMessages.createdAt,
      place: sql<number>`row_number() over (partition by ${outboundMessages.accountId}, ${heldBack} order by case when ${heldBack} then ${outboundMessages.updatedAt} end, ${outboundMessages.scheduledAt}, ${outboundMessages.createdAt})`.as('place'),
    })
    .from(outboundMessages)
    .where(and(inArray(outboundMessages.status, ['scheduled', 'waiting_approval', 'reserved']), lte(outboundMessages.scheduledAt, now)))
    .as('ranked');
  return ctx.db.select({ messageId: ranked.messageId, revision: ranked.revision }).from(ranked).where(lte(ranked.place, perAccount)).orderBy(ranked.scheduledAt, ranked.createdAt);
}

export type Review = { messageId: string; revision: number; checkId: string; bindingDigest: string; subjectDigest: string; reviewer: typeof outboundReviewReceipts.$inferInsert.reviewer; result: typeof outboundReviewReceipts.$inferInsert.result };

/* A block ends the message and stops the channel before anything else starts. Anything else moves it on, by all the gates. */
async function afterReview(tx: Tx, ctx: Ctx, l: Look, review: Review): Promise<Gates['ask']> {
  const decision = review.result.kind === 'review' ? review.result.decision : 'block';
  const { message, prepared } = l;
  if (decision === 'block') {
    await stopChannel(tx, message.channelId, 'review_failed', prepared.now);
    await setStatus(tx, message.id, 'rejected', ['review_failed'], prepared.now);
    return null;
  }
  if (message.status !== 'waiting_checks') return null;
  const gates = await gatesOf(tx, ctx, l);
  await afterRefusal(tx, message.id, gates, prepared.now);
  return gates.ask;
}

/* The word of a fresh check on one revision, from the server's own call of it. It must be about exactly these bytes. */
export async function recordReview(ctx: Ctx, review: Review, now = new Date()): Promise<void> {
  const seen = await seenMessage(ctx.db, review.messageId);
  if (!seen) throw unknown('message');
  const prepared = await prepare(ctx, seen, now);
  const ask = await ctx.db.transaction(async tx => {
    const way = await holdWay(tx, seen.companyId, seen.channelId, seen.accountId);
    if (seen.contactId) await holdContact(tx, seen.companyId, seen.contactId);
    const message = await lockMessage(tx, review.messageId);
    const revision = await revisionOf(tx, message);
    if (!revision || revision.revision !== review.revision || revision.contentDigest !== review.subjectDigest) throw conflict('This review is not of the bytes as they are.');
    await tx.insert(outboundReviewReceipts).values({ companyId: message.companyId, messageId: message.id, messageRevision: revision.revision, checkId: review.checkId, bindingDigest: review.bindingDigest, subjectDigest: review.subjectDigest, reviewer: review.reviewer, result: review.result }).onConflictDoNothing();
    return afterReview(tx, ctx, { message, revision, channel: way.channel!, account: way.account!, way, prepared }, review);
  });
  if (ask) await askOrCancel(ctx, review.messageId, ask);
}
