import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  CheckBinding,
  ClassificationInput,
  ReviewInput,
  SupportClassifyInput,
  SupportClassifyResult,
  SupportSubmit,
  SubmitResult,
  canonicalJson,
  type CatalogValue,
  type CheckBinding as CheckBindingDto,
  type GateCode,
  type MessageDocument,
  type ModelCheckKind,
  type ProviderId,
  type ReasonCode,
  type SupportClassifyInput as SupportClassifyInputDto,
  type SupportClassifyResult as SupportClassifyResultDto,
  type SupportSubmit as SupportSubmitDto,
  type SubmitResult as SubmitResultDto,
} from '@hornhoof/protocol';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { z } from 'zod';

type ClassificationInputDto = z.infer<typeof ClassificationInput>;
type ReviewInputDto = z.infer<typeof ReviewInput>;
import type { Ctx } from '../../app.js';
import { decryptSecret, encryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import {
  modelCheckDatasets,
  modelCheckRevisions,
  modelChecks,
  outboundAccounts,
  outboundApprovals,
  outboundBindings,
  outboundCatalogRevisions,
  outboundChannels,
  outboundContacts,
  outboundMessageRevisions,
  outboundMessages,
  outboundPermissions,
  outboundPolicies,
  supportClassifications,
  supportTickets,
} from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { publicUrl } from '../link/link.js';
import { bindingDigest, isOn } from '../model-checks/lifecycle.js';
import { decisionPerson } from '../tasks/decisions.js';
import { ask, taskSpot } from '../tasks/engine.js';
import { taskByRef } from '../tasks/views.js';
import { wakeAll } from '../tasks/wake.js';
import type { ModelCheckPorts, SealedPayload } from './ports.js';
import { reviewOutboundMessageRevision } from './model-checks.js';

export type SupportCaller = {
  readonly companyId: string;
  readonly agentId: string;
  readonly jobId?: string | null;
  readonly authorProvider?: ProviderId | null;
  readonly authorVendorId: string;
};

export class SupportGatewayError extends Error {
  readonly statusCode: number;
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.statusCode = status;
  }
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i,
];

const EMAIL_GLOBAL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CARD_CANDIDATE_RE = /\b(?:\d[ -]*?){13,19}\b/g;

const FORBIDDEN_PROMISE_PATTERNS: readonly RegExp[] = [
  /\b(?:refund|credit|reimburse|reimbursement|chargeback|money[- ]back|waive\s+fee)\b/i,
  /\b(?:guarantee|guaranteed|sla\s+credit|contract\s+clause|legal\s+settlement|indemnif(?:y|ication)|binding\s+agreement)\b/i,
  /(?:\$\s*\d+|\b\d+\.\d{2}\s*(?:USD|EUR|GBP|RUB)\b)/i,
  /\b(?:by|before|on)\s+20\d{2}-\d{2}-\d{2}\b/i,
];

function luhnDigit(digit: number, doubled: boolean): number {
  if (!doubled) return digit;
  const prod = digit * 2;
  return prod > 9 ? prod - 9 : prod;
}

function isValidLuhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    const posFromRight = digits.length - 1 - i;
    sum += luhnDigit(Number(digits[i]), posFromRight % 2 === 1);
  }
  return sum % 10 === 0;
}

function hasPaymentCard(text: string): boolean {
  const matches = text.match(CARD_CANDIDATE_RE) ?? [];
  return matches.some(raw => isValidLuhn(raw.replace(/\D/g, '')));
}

export function containsSecretMaterial(text: string): boolean {
  return SECRET_PATTERNS.some(re => re.test(text));
}

export function containsThirdPartyPii(text: string): boolean {
  EMAIL_GLOBAL_RE.lastIndex = 0;
  return EMAIL_GLOBAL_RE.test(text) || hasPaymentCard(text);
}

export function containsForbiddenSupportPromise(text: string): boolean {
  return FORBIDDEN_PROMISE_PATTERNS.some(re => re.test(text));
}

function hasWithheldTicketData(text: string): boolean {
  if (containsSecretMaterial(text) || hasPaymentCard(text)) return true;
  const emails = new Set((text.match(EMAIL_GLOBAL_RE) ?? []).map(item => item.toLowerCase()));
  return emails.size >= 2;
}

type CatalogRow = typeof outboundCatalogRevisions.$inferSelect;
type TemplateValue = Extract<CatalogValue, { kind: 'template' }>;
type TemplateSlot = Extract<TemplateValue['parts'][number], { kind: 'slot' }>;
type PlaceScope = { departmentId: string; productId: string | null; channelId: string | null };

function currentRevision(rows: readonly CatalogRow[]): CatalogRow | null {
  const sorted = [...rows].sort((a, b) => b.revision - a.revision);
  return sorted[0] ?? null;
}

function matchesPlaceScope(row: CatalogRow, place: PlaceScope): boolean {
  if (row.departmentId !== place.departmentId) return false;
  const prodOk = row.productId === null || row.productId === place.productId;
  const chanOk = row.channelId === null || place.channelId === null || row.channelId === place.channelId;
  return prodOk && chanOk;
}

function isUsableRevision(row: CatalogRow, place: PlaceScope, now: Date): boolean {
  if (row.status !== 'published' || row.revokedAt !== null) return false;
  if (!matchesPlaceScope(row, place)) return false;
  return now >= row.validFrom && (row.validUntil === null || now < row.validUntil);
}

function groupLatestByEntry(rows: readonly CatalogRow[]): Map<string, CatalogRow> {
  const grouped = new Map<string, CatalogRow[]>();
  for (const row of rows) grouped.set(row.entryId, [...(grouped.get(row.entryId) ?? []), row]);
  const latest = new Map<string, CatalogRow>();
  for (const [entryId, revs] of grouped) {
    const top = currentRevision(revs);
    if (top) latest.set(entryId, top);
  }
  return latest;
}

async function activeCheckBinding(
  db: Pick<Db, 'select'>,
  place: { companyId: string; departmentId: string; productId: string | null; kind: ModelCheckKind },
  now: Date,
): Promise<{ binding: CheckBindingDto; digest: string } | null> {
  const [check] = await db
    .select()
    .from(modelChecks)
    .where(
      and(
        eq(modelChecks.companyId, place.companyId),
        eq(modelChecks.departmentId, place.departmentId),
        place.productId ? eq(modelChecks.productId, place.productId) : isNull(modelChecks.productId),
        eq(modelChecks.kind, place.kind),
      ),
    );
  if (!check || !isOn(check, now)) return null;
  const [[revision], [dataset]] = await Promise.all([
    db.select().from(modelCheckRevisions).where(eq(modelCheckRevisions.checkId, check.id)).orderBy(desc(modelCheckRevisions.definitionVersion)).limit(1),
    db.select().from(modelCheckDatasets).where(eq(modelCheckDatasets.checkId, check.id)).orderBy(desc(modelCheckDatasets.version)).limit(1),
  ]);
  if (!revision) return null;
  const fallbackHash = check.bindingDigest ?? sha256(check.id);
  const binding = CheckBinding.parse({
    schemaVersion: 1,
    companyId: check.companyId,
    departmentId: check.departmentId,
    productId: check.productId,
    checkId: check.id,
    kind: check.kind,
    definitionVersion: revision.definitionVersion,
    checkerCodeHash: revision.checkerCodeHash,
    promptHash: revision.promptHash,
    outputSchemaHash: revision.outputSchemaHash,
    sourceListHash: revision.sourceListHash,
    taxonomyHash: revision.taxonomyHash,
    model: revision.model,
    datasetVersion: dataset?.id ?? check.id,
    datasetHash: dataset?.hash ?? fallbackHash,
    thresholdsHash: sha256(canonicalJson(check.thresholds ?? {})),
  });
  return { binding, digest: check.bindingDigest ?? bindingDigest(binding) };
}

type TaxonomyInfo = { digest: string; classes: Extract<CatalogValue, { kind: 'taxonomy' }>['classes'] };

async function publishedTaxonomy(
  db: Pick<Db, 'select'>,
  companyId: string,
  departmentId: string,
  productId: string | null,
  now: Date,
): Promise<TaxonomyInfo | null> {
  const rows = await db
    .select()
    .from(outboundCatalogRevisions)
    .where(
      and(
        eq(outboundCatalogRevisions.companyId, companyId),
        eq(outboundCatalogRevisions.departmentId, departmentId),
        eq(outboundCatalogRevisions.kind, 'taxonomy'),
      ),
    );
  const current = [...groupLatestByEntry(rows).values()].find(row =>
    isUsableRevision(row, { departmentId, productId, channelId: null }, now),
  );
  return current && current.value.kind === 'taxonomy' ? { digest: current.digest, classes: current.value.classes } : null;
}

async function requireAssignedTask(ctx: Ctx, caller: SupportCaller, ref: number | string) {
  const task = await taskByRef(ctx, caller.companyId, ref);
  if (!task || task.assigneeAgentId !== caller.agentId) {
    throw new ApiError(403, 'forbidden', 'This task is not assigned to the calling agent.', 'task_not_yours');
  }
  return task;
}

async function existingClassificationByKey(
  db: Pick<Db, 'select'>,
  companyId: string,
  input: SupportClassifyInputDto,
): Promise<SupportClassifyResultDto | null> {
  const [existing] = await db
    .select()
    .from(supportClassifications)
    .where(and(eq(supportClassifications.companyId, companyId), eq(supportClassifications.idempotencyKey, input.idempotencyKey)));
  if (!existing) return null;
  if (existing.ticketId !== input.ticketId || existing.ticketRevision !== input.ticketRevision) {
    throw new SupportGatewayError(409, 'idempotency_conflict', 'This idempotency key was already used for another ticket.');
  }
  return SupportClassifyResult.parse({ classificationReceiptId: existing.id, status: existing.status });
}

async function storeUnavailableClassification(
  db: Pick<Db, 'insert' | 'update'>,
  ticket: typeof supportTickets.$inferSelect,
  bindingDigestValue: string,
  idempotencyKey: string,
  reasonCode: ReasonCode,
  now: Date,
): Promise<SupportClassifyResultDto> {
  const [inserted] = await db
    .insert(supportClassifications)
    .values({
      companyId: ticket.companyId,
      ticketId: ticket.ticketId,
      ticketRevision: ticket.revision,
      ticketDigest: ticket.digest,
      bindingDigest: bindingDigestValue,
      idempotencyKey,
      status: 'unavailable',
      reasonCodes: [reasonCode],
      decidedAt: now,
    })
    .returning();
  await db.update(supportTickets).set({ status: 'escalated' }).where(eq(supportTickets.id, ticket.id));
  return SupportClassifyResult.parse({ classificationReceiptId: inserted!.id, status: 'unavailable' });
}

async function runTicketModelClassification(
  ctx: Ctx,
  ports: Pick<ModelCheckPorts, 'runModelCheck'>,
  ticket: typeof supportTickets.$inferSelect,
  ticketText: string,
  idempotencyKey: string,
  checkInfo: { binding: CheckBindingDto; digest: string },
  taxonomy: TaxonomyInfo,
  now: Date,
): Promise<SupportClassifyResultDto> {
  const modelInput: ClassificationInputDto = {
    schemaVersion: 1,
    kind: 'support_classification',
    locale: 'en',
    subject: { id: ticket.ticketId, contentDigest: ticket.digest },
    ticket: { text: ticketText },
    taxonomyRevision: taxonomy.digest,
    taxonomy: taxonomy.classes,
  };
  const checked = await ports.runModelCheck(checkInfo.binding, modelInput);
  if ('code' in checked || checked.result.kind !== 'classification') {
    return storeUnavailableClassification(ctx.db, ticket, checkInfo.digest, idempotencyKey, 'uncertain', now);
  }
  const classified = checked.result;
  const entry = taxonomy.classes.find(item => item.classId === classified.classId);
  if (!entry || (entry.requiresHuman && !classified.requiresHuman)) {
    return storeUnavailableClassification(ctx.db, ticket, checkInfo.digest, idempotencyKey, 'uncertain', now);
  }
  const requiresHuman = entry.requiresHuman || classified.requiresHuman;
  const [saved] = await ctx.db
    .insert(supportClassifications)
    .values({
      companyId: ticket.companyId,
      ticketId: ticket.ticketId,
      ticketRevision: ticket.revision,
      ticketDigest: ticket.digest,
      bindingDigest: checkInfo.digest,
      idempotencyKey,
      status: 'ready',
      classId: classified.classId,
      requiresHuman,
      reasonCodes: classified.reasonCodes,
      reviewer: checked.reviewer,
      decidedAt: now,
    })
    .returning();
  if (requiresHuman) {
    await ctx.db.update(supportTickets).set({ status: 'escalated' }).where(eq(supportTickets.id, ticket.id));
  }
  return SupportClassifyResult.parse({ classificationReceiptId: saved!.id, status: 'ready' });
}

export async function classifySupportTicket(
  ctx: Ctx,
  ports: Pick<ModelCheckPorts, 'runModelCheck'>,
  caller: SupportCaller,
  rawInput: SupportClassifyInputDto,
  now: Date = new Date(),
): Promise<SupportClassifyResultDto> {
  const input = SupportClassifyInput.parse(rawInput);
  await requireAssignedTask(ctx, caller, input.task);
  const replay = await existingClassificationByKey(ctx.db, caller.companyId, input);
  if (replay) return replay;

  const [ticket] = await ctx.db
    .select()
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.companyId, caller.companyId),
        eq(supportTickets.ticketId, input.ticketId),
        eq(supportTickets.revision, input.ticketRevision),
      ),
    );
  if (!ticket) throw new SupportGatewayError(404, 'ticket_unknown', 'Support ticket revision was not found.');

  const checkInfo = await activeCheckBinding(
    ctx.db,
    { companyId: caller.companyId, departmentId: ticket.departmentId, productId: ticket.productId, kind: 'support_classification' },
    now,
  );
  const digest = checkInfo?.digest ?? sha256(`uncertified:${ticket.departmentId}:support_classification`);
  const [sameRev] = await ctx.db
    .select()
    .from(supportClassifications)
    .where(
      and(
        eq(supportClassifications.companyId, caller.companyId),
        eq(supportClassifications.ticketId, input.ticketId),
        eq(supportClassifications.ticketRevision, input.ticketRevision),
        eq(supportClassifications.bindingDigest, digest),
      ),
    );
  if (sameRev) return SupportClassifyResult.parse({ classificationReceiptId: sameRev.id, status: sameRev.status });

  const ticketText = decryptSecret(ticket.textEnc, ctx.config.secret);
  if (hasWithheldTicketData(ticketText)) {
    return storeUnavailableClassification(ctx.db, ticket, digest, input.idempotencyKey, 'private_data', now);
  }

  const taxonomy = await publishedTaxonomy(ctx.db, caller.companyId, ticket.departmentId, ticket.productId, now);
  if (!checkInfo || !taxonomy) {
    return storeUnavailableClassification(ctx.db, ticket, digest, input.idempotencyKey, 'uncertain', now);
  }
  return runTicketModelClassification(ctx, ports, ticket, ticketText, input.idempotencyKey, checkInfo, taxonomy, now);
}

type SupportFact = ReviewInputDto['facts'][number];
type SupportRenderOutcome = {
  subject: string;
  body: string;
  sourcesDigest: string;
  facts: SupportFact[];
  reasons: GateCode[];
};

type RenderBag = {
  place: PlaceScope;
  locale: string;
  now: Date;
  byEntry: Map<string, CatalogRow>;
  reasons: Set<GateCode>;
  used: Map<string, CatalogRow>;
  facts: SupportFact[];
  slotText: Map<string, string>;
};

function scanRenderedContent(text: string, reasons: Set<GateCode>): void {
  if (containsSecretMaterial(text)) reasons.add('secret_forbidden');
  if (containsThirdPartyPii(text)) reasons.add('pii_forbidden');
  if (containsForbiddenSupportPromise(text)) reasons.add('support_intent_forbidden');
}

async function signedUnsubscribeUrl(
  ctx: Ctx,
  companyId: string,
  contactId: string,
  channelId: string,
  purpose: string,
): Promise<string> {
  const payload = Buffer.from(JSON.stringify({ c: companyId, k: contactId, h: channelId, p: purpose })).toString('base64url');
  const sig = createHmac('sha256', ctx.config.secret)
    .update(`hornhoof outbound unsubscribe v1\n${payload}`)
    .digest('base64url');
  const base = await publicUrl(ctx.db, ctx.config);
  return `${base}/api/outbound/unsubscribe/${payload}.${sig}`;
}

async function loadSupportCatalogMap(
  db: Pick<Db, 'select'>,
  companyId: string,
  departmentId: string,
  document: MessageDocument,
): Promise<{ byEntry: Map<string, CatalogRow>; unsubscribeRows: CatalogRow[] }> {
  const ids = [document.templateId, ...document.blocks.map(b => b.id), ...document.variables.map(v => v.valueRef)];
  const namedPromise = ids.length
    ? db
        .select()
        .from(outboundCatalogRevisions)
        .where(and(eq(outboundCatalogRevisions.companyId, companyId), inArray(outboundCatalogRevisions.entryId, ids)))
    : Promise.resolve([]);
  const unsubPromise = db
    .select()
    .from(outboundCatalogRevisions)
    .where(
      and(
        eq(outboundCatalogRevisions.companyId, companyId),
        eq(outboundCatalogRevisions.departmentId, departmentId),
        eq(outboundCatalogRevisions.kind, 'unsubscribe'),
        eq(outboundCatalogRevisions.locale, document.locale),
      ),
    );
  const [named, unsubscribeRows] = await Promise.all([namedPromise, unsubPromise]);
  return { byEntry: groupLatestByEntry(named), unsubscribeRows };
}

function fillSingleBlock(block: MessageDocument['blocks'][number], bag: RenderBag): string {
  if (block.kind === 'price') {
    bag.reasons.add('support_intent_forbidden');
    return '';
  }
  const source = bag.byEntry.get(block.id);
  const validSource = source !== undefined && source.revision === block.revision && isUsableRevision(source, bag.place, bag.now);
  if (!validSource || source.kind !== block.kind) {
    bag.reasons.add(block.kind === 'link' ? 'link_unapproved' : 'claim_unapproved');
    return '';
  }
  if (source.value.kind === 'link') {
    bag.used.set(source.entryId, source);
    bag.facts.push({ kind: 'link', id: source.entryId, revision: source.revision, canonicalValue: source.value.url, sourceId: source.id });
    return source.value.url;
  }
  if (source.locale !== bag.locale || (source.value.kind !== 'claim' && source.value.kind !== 'knowledge')) {
    bag.reasons.add('unsupported_locale');
    return '';
  }
  bag.used.set(source.entryId, source);
  scanRenderedContent(source.value.text, bag.reasons);
  bag.facts.push({
    kind: source.value.kind,
    id: source.entryId,
    revision: source.revision,
    canonicalValue: source.value.text,
    sourceId: source.id,
  });
  return source.value.text;
}

function fillBlockSlots(tpl: TemplateValue, document: MessageDocument, bag: RenderBag): void {
  if (document.blocks.some(b => b.kind === 'price')) bag.reasons.add('support_intent_forbidden');
  if (tpl.parts.some(p => p.kind === 'slot' && (p.type === 'price' || p.type === 'terms'))) {
    bag.reasons.add('support_intent_forbidden');
  }
  for (const kind of ['link', 'claim', 'knowledge'] as const) {
    const slots = tpl.parts.filter((p): p is TemplateSlot => p.kind === 'slot' && p.type === kind);
    const blocks = document.blocks.filter(b => b.kind === kind);
    if (slots.length !== blocks.length) bag.reasons.add('template_unapproved');
    slots.forEach((slot, idx) => {
      bag.slotText.set(slot.slotId, blocks[idx] ? fillSingleBlock(blocks[idx], bag) : '');
    });
  }
}

function resolveVariableText(
  slotId: string,
  variables: MessageDocument['variables'],
  fields: Readonly<Record<string, string>>,
  bag: RenderBag,
): string | null {
  const given = variables.find(v => v.slotId === slotId);
  const row = given ? bag.byEntry.get(given.valueRef) : undefined;
  if (!row || !isUsableRevision(row, bag.place, bag.now) || row.value.kind !== 'variable') return null;
  const val = fields[row.value.field];
  if (val === undefined) return null;
  bag.used.set(row.entryId, row);
  return val;
}

function fillVariableSlots(tpl: TemplateValue, document: MessageDocument, fields: Readonly<Record<string, string>>, bag: RenderBag): void {
  const varSlots = tpl.parts.filter((p): p is TemplateSlot => p.kind === 'slot' && p.type === 'variable');
  if (varSlots.length !== document.variables.length) bag.reasons.add('template_unapproved');
  for (const slot of varSlots) {
    const text = resolveVariableText(slot.slotId, document.variables, fields, bag);
    if (text === null) bag.reasons.add('template_unapproved');
    else bag.slotText.set(slot.slotId, text);
  }
}

function fillUnsubscribeSlots(tpl: TemplateValue, unsubscribeRows: readonly CatalogRow[], url: string, bag: RenderBag): void {
  const unsubSlots = tpl.parts.filter((p): p is TemplateSlot => p.kind === 'slot' && p.type === 'unsubscribe');
  if (unsubSlots.length === 0) {
    bag.reasons.add('template_unapproved');
    return;
  }
  const usable = [...groupLatestByEntry(unsubscribeRows).values()]
    .filter(row => isUsableRevision(row, bag.place, bag.now))
    .sort((a, b) => Number(Boolean(b.channelId)) - Number(Boolean(a.channelId)) || a.entryId.localeCompare(b.entryId))[0];
  if (!usable || usable.value.kind !== 'unsubscribe') {
    bag.reasons.add('unsupported_locale');
    return;
  }
  bag.used.set(usable.entryId, usable);
  for (const slot of unsubSlots) bag.slotText.set(slot.slotId, `${usable.value.text} ${url}`);
}

function assembleTemplateOutput(tpl: TemplateValue, bag: RenderBag): SupportRenderOutcome {
  const subject = tpl.subject ?? '';
  if (subject) scanRenderedContent(subject, bag.reasons);
  const chunks = tpl.parts.map(part => {
    if (part.kind === 'text') {
      scanRenderedContent(part.text, bag.reasons);
      return part.text;
    }
    return bag.slotText.get(part.slotId) ?? '';
  });
  const refs = [...bag.used.values()]
    .map(row => ({ entryId: row.entryId, revision: row.revision, digest: row.digest }))
    .sort((a, b) => a.entryId.localeCompare(b.entryId));
  return {
    subject,
    body: chunks.join(''),
    sourcesDigest: sha256(canonicalJson(refs)),
    facts: bag.facts,
    reasons: [...bag.reasons],
  };
}

function usableTemplateRow(row: CatalogRow | undefined, revision: number, place: PlaceScope, now: Date): CatalogRow | null {
  if (!row || row.revision !== revision || row.value.kind !== 'template') return null;
  return isUsableRevision(row, place, now) ? row : null;
}

async function renderSupportDocument(
  ctx: Ctx,
  spec: {
    companyId: string;
    channel: typeof outboundChannels.$inferSelect;
    account: typeof outboundAccounts.$inferSelect;
    contactId: string;
    document: MessageDocument;
    now: Date;
  },
): Promise<SupportRenderOutcome> {
  const place: PlaceScope = { departmentId: spec.channel.departmentId, productId: spec.channel.productId, channelId: spec.channel.id };
  const { byEntry, unsubscribeRows } = await loadSupportCatalogMap(ctx.db, spec.companyId, spec.channel.departmentId, spec.document);
  const bag: RenderBag = {
    place,
    locale: spec.document.locale,
    now: spec.now,
    byEntry,
    reasons: new Set<GateCode>(),
    used: new Map<string, CatalogRow>(),
    facts: [],
    slotText: new Map<string, string>(),
  };

  if (spec.document.blocks.some(b => b.kind === 'price')) bag.reasons.add('support_intent_forbidden');
  const tplRow = usableTemplateRow(byEntry.get(spec.document.templateId), spec.document.templateRevision, place, spec.now);
  if (!tplRow || tplRow.value.kind !== 'template') {
    bag.reasons.add('template_unapproved');
    return { subject: '', body: '', sourcesDigest: sha256('missing-template'), facts: [], reasons: [...bag.reasons] };
  }
  if (tplRow.locale !== spec.document.locale) {
    bag.reasons.add('unsupported_locale');
    return { subject: '', body: '', sourcesDigest: sha256('locale-mismatch'), facts: [], reasons: [...bag.reasons] };
  }

  bag.used.set(tplRow.entryId, tplRow);
  const tpl = tplRow.value;
  fillBlockSlots(tpl, spec.document, bag);
  fillVariableSlots(tpl, spec.document, { account_label: spec.account.label, channel_name: spec.channel.name }, bag);
  const unsubUrl = await signedUnsubscribeUrl(ctx, spec.companyId, spec.contactId, spec.channel.id, spec.channel.purpose);
  fillUnsubscribeSlots(tpl, unsubscribeRows, unsubUrl, bag);
  return assembleTemplateOutput(tpl, bag);
}

async function checkAccountAndChannel(
  db: Pick<Db, 'select'>,
  caller: SupportCaller,
  input: SupportSubmitDto,
  channel: typeof outboundChannels.$inferSelect,
  account: typeof outboundAccounts.$inferSelect,
  reasons: Set<GateCode>,
): Promise<void> {
  if (channel.status !== 'active') reasons.add('channel_stopped');
  if (account.status !== 'active' || account.channelId !== channel.id) reasons.add('account_bound_elsewhere');
  const [binding] = await db
    .select()
    .from(outboundBindings)
    .where(and(eq(outboundBindings.accountId, account.id), eq(outboundBindings.status, 'active'), isNull(outboundBindings.releasedAt)));
  if (!binding || binding.agentId !== caller.agentId) reasons.add('account_bound_elsewhere');
  else if (binding.generation !== input.bindingGeneration) reasons.add('stale_binding');
}

async function checkContactPermission(
  db: Pick<Db, 'select'>,
  channel: typeof outboundChannels.$inferSelect,
  contact: typeof outboundContacts.$inferSelect,
  reasons: Set<GateCode>,
): Promise<void> {
  if (contact.doNotContact || contact.suppressedAt !== null) {
    reasons.add('contact_suppressed');
    return;
  }
  const perms = await db
    .select()
    .from(outboundPermissions)
    .where(
      and(
        eq(outboundPermissions.contactId, contact.id),
        eq(outboundPermissions.channelId, channel.id),
        eq(outboundPermissions.purpose, channel.purpose),
        eq(outboundPermissions.status, 'granted'),
      ),
    );
  if (!perms.some(p => p.source !== 'asserted_import' && p.revokedAt === null)) {
    reasons.add('consent_missing');
  }
}

function matchesTicketClassification(
  classification: typeof supportClassifications.$inferSelect | undefined,
  ticket: typeof supportTickets.$inferSelect,
): classification is typeof supportClassifications.$inferSelect {
  if (!classification || classification.status !== 'ready') return false;
  const sameTicket = classification.ticketId === ticket.ticketId && classification.ticketRevision === ticket.revision;
  return sameTicket && classification.ticketDigest === ticket.digest;
}

async function checkSupportPreconditions(
  db: Pick<Db, 'select'>,
  caller: SupportCaller,
  input: SupportSubmitDto,
  ticket: typeof supportTickets.$inferSelect,
  channel: typeof outboundChannels.$inferSelect,
  account: typeof outboundAccounts.$inferSelect,
  contact: typeof outboundContacts.$inferSelect,
): Promise<{ reasons: GateCode[]; classification: typeof supportClassifications.$inferSelect | null }> {
  const reasons = new Set<GateCode>();
  await checkAccountAndChannel(db, caller, input, channel, account, reasons);
  await checkContactPermission(db, channel, contact, reasons);
  const [classification] = await db
    .select()
    .from(supportClassifications)
    .where(and(eq(supportClassifications.companyId, caller.companyId), eq(supportClassifications.id, input.classificationReceiptId)));
  if (!matchesTicketClassification(classification, ticket)) {
    reasons.add('support_escalation_required');
    return { reasons: [...reasons], classification: null };
  }
  return { reasons: [...reasons], classification };
}

async function createSupportApprovalRequest(
  ctx: Ctx,
  spec: {
    companyId: string;
    taskId: string;
    authorAgentId: string;
    departmentId: string;
    productId: string | null;
    channelGeneration: number;
    accountId: string;
    bindingGeneration: number;
    configGeneration: number;
    messageId: string;
    contentDigest: string;
    policyDigest: string;
    sourcesDigest: string;
    subject: string;
    body: string;
  },
): Promise<void> {
  const spot = taskSpot({ departmentId: spec.departmentId, productId: spec.productId });
  const decider = await decisionPerson(ctx, spec.companyId, { source: 'request', kind: 'approval', topic: 'task', spot });
  const authorityHash = sha256(
    canonicalJson({
      companyId: spec.companyId,
      departmentId: spec.departmentId,
      productId: spec.productId,
      decider,
      channelGeneration: spec.channelGeneration,
      accountId: spec.accountId,
      bindingGeneration: spec.bindingGeneration,
      configGeneration: spec.configGeneration,
    }),
  );
  const moved = await ask(ctx, spec.authorAgentId, spec.taskId, {
    kind: 'approval',
    text: spec.subject ? `${spec.subject}\n\n${spec.body}` : spec.body,
    approval: { channel: 'message', kind: 'support_reply', amount: null },
    topic: 'task',
  });
  await ctx.db.insert(outboundApprovals).values({
    companyId: spec.companyId,
    requestId: moved.request.id,
    kind: 'message',
    messageId: spec.messageId,
    messageRevision: 1,
    contentDigest: spec.contentDigest,
    accountId: spec.accountId,
    bindingGeneration: spec.bindingGeneration,
    policyDigest: spec.policyDigest,
    sourceRevisionsDigest: spec.sourcesDigest,
    authorityFingerprint: authorityHash,
  });
  await wakeAll(ctx, moved.wakes);
}

async function replaySubmitIfPresent(
  db: Pick<Db, 'select'>,
  caller: SupportCaller,
  idempotencyKey: string,
  requestDigest: string,
): Promise<SubmitResultDto | null> {
  const [existing] = await db
    .select()
    .from(outboundMessages)
    .where(
      and(
        eq(outboundMessages.companyId, caller.companyId),
        eq(outboundMessages.authorAgentId, caller.agentId),
        eq(outboundMessages.idempotencyKey, idempotencyKey),
      ),
    );
  if (!existing) return null;
  if (existing.requestDigest !== requestDigest) {
    throw new SupportGatewayError(409, 'idempotency_conflict', 'This idempotency key was already used for another support reply.');
  }
  const [rev] = await db
    .select()
    .from(outboundMessageRevisions)
    .where(and(eq(outboundMessageRevisions.messageId, existing.id), eq(outboundMessageRevisions.revision, existing.revision)));
  return SubmitResult.parse({
    messageId: existing.id,
    revision: existing.revision,
    contentDigest: rev?.contentDigest ?? requestDigest,
    status: existing.status,
    reasonCodes: existing.reasonCodes,
  });
}

async function loadSupportEntities(ctx: Ctx, companyId: string, input: SupportSubmitDto) {
  const [[ticket], [channel], [account]] = await Promise.all([
    ctx.db
      .select()
      .from(supportTickets)
      .where(and(eq(supportTickets.companyId, companyId), eq(supportTickets.ticketId, input.ticketId), eq(supportTickets.revision, input.ticketRevision))),
    ctx.db.select().from(outboundChannels).where(and(eq(outboundChannels.companyId, companyId), eq(outboundChannels.id, input.channelId))),
    ctx.db.select().from(outboundAccounts).where(and(eq(outboundAccounts.companyId, companyId), eq(outboundAccounts.id, input.accountId))),
  ]);
  if (!ticket || !channel || !account) {
    throw new SupportGatewayError(404, 'outbound_unknown', 'Support ticket, channel, or account was not found.');
  }
  const [[contact], [policy]] = await Promise.all([
    ctx.db.select().from(outboundContacts).where(and(eq(outboundContacts.companyId, companyId), eq(outboundContacts.id, ticket.contactId))),
    ctx.db.select().from(outboundPolicies).where(eq(outboundPolicies.channelId, channel.id)).orderBy(desc(outboundPolicies.revision)).limit(1),
  ]);
  if (!contact || !policy) {
    throw new SupportGatewayError(404, 'outbound_unknown', 'Support contact or channel policy was not found.');
  }
  return { ticket, channel, account, contact, policy };
}

async function ensureClassificationIdForRejection(
  db: Pick<Db, 'insert'>,
  existingId: string | null,
  ticket: typeof supportTickets.$inferSelect,
  messageId: string,
  now: Date,
): Promise<string> {
  if (existingId) return existingId;
  const [fallback] = await db
    .insert(supportClassifications)
    .values({
      companyId: ticket.companyId,
      ticketId: ticket.ticketId,
      ticketRevision: ticket.revision,
      ticketDigest: ticket.digest,
      bindingDigest: sha256(`missing-classification:${messageId}`),
      idempotencyKey: randomUUID(),
      status: 'unavailable',
      reasonCodes: ['uncertain'],
      decidedAt: now,
    })
    .returning();
  return fallback!.id;
}

async function judgeSupportReplyReview(
  ctx: Ctx,
  ports: Pick<ModelCheckPorts, 'runModelCheck'>,
  spec: {
    companyId: string;
    departmentId: string;
    productId: string | null;
    messageId: string;
    locale: string;
    contentDigest: string;
    subject: string;
    body: string;
    facts: SupportFact[];
    policyDigest: string;
    authorVendorId: string;
    requiresHuman: boolean;
    now: Date;
  },
): Promise<{ status: SubmitResultDto['status']; reasonCodes: GateCode[] }> {
  const reviewCheck = await activeCheckBinding(
    ctx.db,
    { companyId: spec.companyId, departmentId: spec.departmentId, productId: spec.productId, kind: 'support_reply_review' },
    spec.now,
  );
  if (!reviewCheck) return { status: 'waiting_approval', reasonCodes: ['approval_required', 'check_uncertified'] };

  const reviewInput: ReviewInputDto = {
    schemaVersion: 1,
    kind: 'support_reply_review',
    locale: spec.locale,
    subject: { id: spec.messageId, contentDigest: spec.contentDigest },
    message: { subject: spec.subject, body: spec.body },
    facts: spec.facts,
    policyDigest: spec.policyDigest,
    authorVendorId: spec.authorVendorId,
  };
  const reviewed = await reviewOutboundMessageRevision(ctx, ports, {
    companyId: spec.companyId,
    messageId: spec.messageId,
    messageRevision: 1,
    binding: reviewCheck.binding,
    input: reviewInput,
  });
  if ('code' in reviewed) {
    const reason = reviewed.code === 'uncertified' ? 'check_uncertified' : 'review_unavailable';
    return { status: 'waiting_approval', reasonCodes: ['approval_required', reason] };
  }
  if (reviewed.result.kind === 'review' && reviewed.result.decision === 'block') {
    return { status: 'rejected', reasonCodes: ['review_failed'] };
  }
  if (spec.requiresHuman || (reviewed.result.kind === 'review' && reviewed.result.decision === 'escalate')) {
    return { status: 'waiting_approval', reasonCodes: ['approval_required'] };
  }
  return { status: 'scheduled', reasonCodes: [] };
}

export async function submitSupportReply(
  ctx: Ctx,
  ports: Pick<ModelCheckPorts, 'runModelCheck'>,
  caller: SupportCaller,
  rawInput: SupportSubmitDto,
  now: Date = new Date(),
): Promise<SubmitResultDto> {
  const input = SupportSubmit.parse(rawInput);
  const task = await requireAssignedTask(ctx, caller, input.task);
  const requestDigest = sha256(canonicalJson(input));
  const replayed = await replaySubmitIfPresent(ctx.db, caller, input.idempotencyKey, requestDigest);
  if (replayed) return replayed;

  const { ticket, channel, account, contact, policy } = await loadSupportEntities(ctx, caller.companyId, input);
  const pre = await checkSupportPreconditions(ctx.db, caller, input, ticket, channel, account, contact);
  const rendered = await renderSupportDocument(ctx, {
    companyId: caller.companyId,
    channel,
    account,
    contactId: contact.id,
    document: input.document,
    now,
  });

  const allReasons = [...new Set<GateCode>([...pre.reasons, ...rendered.reasons])];
  const messageId = randomUUID();
  const baseMessage = {
    id: messageId,
    companyId: caller.companyId,
    departmentId: channel.departmentId,
    productId: channel.productId,
    taskId: task.id,
    authorAgentId: caller.agentId,
    authorJobId: caller.jobId ?? null,
    idempotencyKey: input.idempotencyKey,
    requestDigest,
    channelId: channel.id,
    accountId: account.id,
    bindingGeneration: input.bindingGeneration,
    targetKind: 'ticket' as const,
    contactId: contact.id,
    ticketId: ticket.ticketId,
    ticketRevision: ticket.revision,
    scheduledAt: new Date(input.scheduledAt),
  };

  if (allReasons.length > 0) {
    const classificationId = await ensureClassificationIdForRejection(ctx.db, pre.classification?.id ?? null, ticket, messageId, now);
    await ctx.db.insert(outboundMessages).values({ ...baseMessage, classificationId, status: 'rejected', reasonCodes: allReasons });
    return SubmitResult.parse({ messageId, revision: 1, contentDigest: requestDigest, status: 'rejected', reasonCodes: allReasons });
  }

  const sealed: SealedPayload = {
    recipient: decryptSecret(contact.addressEnc, ctx.config.secret),
    subject: rendered.subject,
    text: rendered.body,
  };
  const contentDigest = sha256(canonicalJson(sealed));
  await ctx.db.insert(outboundMessages).values({
    ...baseMessage,
    classificationId: pre.classification!.id,
    status: 'waiting_checks',
    reasonCodes: [],
  });
  await ctx.db.insert(outboundMessageRevisions).values({
    companyId: caller.companyId,
    messageId,
    revision: 1,
    document: input.document,
    contentDigest,
    sealedEnc: encryptSecret(canonicalJson(sealed), ctx.config.secret),
    sourceRevisionsDigest: rendered.sourcesDigest,
    policyId: policy.id,
    policyDigest: policy.digest,
  });

  const verdict = await judgeSupportReplyReview(ctx, ports, {
    companyId: caller.companyId,
    departmentId: channel.departmentId,
    productId: channel.productId,
    messageId,
    locale: input.document.locale,
    contentDigest,
    subject: rendered.subject,
    body: rendered.body,
    facts: rendered.facts,
    policyDigest: policy.digest,
    authorVendorId: caller.authorVendorId,
    requiresHuman: pre.classification!.requiresHuman ?? true,
    now,
  });
  await ctx.db.update(outboundMessages).set({ status: verdict.status, reasonCodes: verdict.reasonCodes, updatedAt: now }).where(eq(outboundMessages.id, messageId));

  if (verdict.status === 'waiting_approval') {
    await ctx.db.update(supportTickets).set({ status: 'escalated' }).where(eq(supportTickets.id, ticket.id));
    await createSupportApprovalRequest(ctx, {
      companyId: caller.companyId,
      taskId: task.id,
      authorAgentId: caller.agentId,
      departmentId: channel.departmentId,
      productId: channel.productId,
      channelGeneration: channel.generation,
      accountId: account.id,
      bindingGeneration: input.bindingGeneration,
      configGeneration: account.configGeneration,
      messageId,
      contentDigest,
      policyDigest: policy.digest,
      sourcesDigest: rendered.sourcesDigest,
      subject: rendered.subject,
      body: rendered.body,
    });
  }

  return SubmitResult.parse({ messageId, revision: 1, contentDigest, status: verdict.status, reasonCodes: verdict.reasonCodes });
}
