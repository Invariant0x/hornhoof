import { createHash, randomUUID } from 'node:crypto';
import {
  ClassificationInput,
  SupportClassifyInput,
  SupportClassifyResult,
  SupportSubmit,
  SubmitResult,
  canonicalJson,
  type CatalogValue,
  type CheckBinding as CheckBindingDto,
  type GateCode,
  type MessageDocument,
  type ProviderId,
  type ReasonCode,
  type SupportClassifyInput as SupportClassifyInputDto,
  type SupportClassifyResult as SupportClassifyResultDto,
  type SupportSubmit as SupportSubmitDto,
  type SubmitResult as SubmitResultDto,
} from '@hornhoof/protocol';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { z } from 'zod';
import type { Ctx } from '../../app.js';
import { decryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import {
  outboundAccounts,
  outboundCatalogRevisions,
  outboundChannels,
  outboundContacts,
  outboundMessages,
  outboundPermissions,
  supportClassifications,
  supportTickets,
} from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { taskByRef } from '../tasks/views.js';
import { admit } from './core.js';
import { activeCheckBinding } from './evaluation-port.js';
import { reviewQueuedMessage } from './model-checks.js';
import type { ModelCheckPorts } from './ports.js';

type ClassificationInputDto = z.infer<typeof ClassificationInput>;

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

const LUHN_DOUBLED = [0, 2, 4, 6, 8, 1, 3, 5, 7, 9] as const;

function luhnDigit(digit: number, doubled: boolean): number {
  return doubled ? LUHN_DOUBLED[digit]! : digit;
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
type TaxonomyInfo = { digest: string; classes: Extract<CatalogValue, { kind: 'taxonomy' }>['classes'] };

function isUsableTaxonomy(row: CatalogRow, productId: string | null, now: Date): boolean {
  if (row.status !== 'published' || row.revokedAt !== null) return false;
  if (row.productId !== null && row.productId !== productId) return false;
  return now >= row.validFrom && (row.validUntil === null || now < row.validUntil);
}

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
    )
    .orderBy(desc(outboundCatalogRevisions.revision));
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.entryId)) continue;
    seen.add(row.entryId);
    if (isUsableTaxonomy(row, productId, now) && row.value.kind === 'taxonomy') {
      return { digest: row.digest, classes: row.value.classes };
    }
  }
  return null;
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

type InPlace = { departmentId: string | null; productId: string | null };

/* What is for a whole department takes in each of its products; what is for a product, that product alone. */
const takesIn = (wide: InPlace, narrow: InPlace): boolean => wide.departmentId === narrow.departmentId && (wide.productId === null || wide.productId === narrow.productId);

/* A ticket outside the task's place is not there for its holder: the same answer as one that does not exist, before anything
   of it is read or spent. */
async function loadTicketRevision(
  db: Pick<Db, 'select'>,
  companyId: string,
  input: { ticketId: string; ticketRevision: number },
  task: InPlace,
): Promise<typeof supportTickets.$inferSelect> {
  const [ticket] = await db
    .select()
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.companyId, companyId),
        eq(supportTickets.ticketId, input.ticketId),
        eq(supportTickets.revision, input.ticketRevision),
      ),
    );
  if (!ticket || !takesIn(ticket, task)) throw new SupportGatewayError(404, 'ticket_unknown', 'Support ticket revision was not found.');
  return ticket;
}

async function existingBindingClassification(
  db: Pick<Db, 'select'>,
  companyId: string,
  input: SupportClassifyInputDto,
  digest: string,
): Promise<SupportClassifyResultDto | null> {
  const [sameRev] = await db
    .select()
    .from(supportClassifications)
    .where(
      and(
        eq(supportClassifications.companyId, companyId),
        eq(supportClassifications.ticketId, input.ticketId),
        eq(supportClassifications.ticketRevision, input.ticketRevision),
        eq(supportClassifications.bindingDigest, digest),
      ),
    );
  return sameRev ? SupportClassifyResult.parse({ classificationReceiptId: sameRev.id, status: sameRev.status }) : null;
}

async function decideNewTicketClassification(
  ctx: Ctx,
  ports: Pick<ModelCheckPorts, 'runModelCheck'>,
  ticket: typeof supportTickets.$inferSelect,
  idempotencyKey: string,
  checkInfo: { binding: CheckBindingDto; digest: string } | null,
  digest: string,
  now: Date,
): Promise<SupportClassifyResultDto> {
  const ticketText = decryptSecret(ticket.textEnc, ctx.config.secret);
  if (hasWithheldTicketData(ticketText)) {
    return storeUnavailableClassification(ctx.db, ticket, digest, idempotencyKey, 'private_data', now);
  }
  const taxonomy = await publishedTaxonomy(ctx.db, ticket.companyId, ticket.departmentId, ticket.productId, now);
  if (!checkInfo || !taxonomy) {
    return storeUnavailableClassification(ctx.db, ticket, digest, idempotencyKey, 'uncertain', now);
  }
  return runTicketModelClassification(ctx, ports, ticket, ticketText, idempotencyKey, checkInfo, taxonomy, now);
}

export async function classifySupportTicket(
  ctx: Ctx,
  ports: Pick<ModelCheckPorts, 'runModelCheck'>,
  caller: SupportCaller,
  rawInput: SupportClassifyInputDto,
  now: Date = new Date(),
): Promise<SupportClassifyResultDto> {
  const input = SupportClassifyInput.parse(rawInput);
  const task = await requireAssignedTask(ctx, caller, input.task);
  const ticket = await loadTicketRevision(ctx.db, caller.companyId, input, task);
  const replay = await existingClassificationByKey(ctx.db, caller.companyId, input);
  if (replay) return replay;

  const checkInfo = await activeCheckBinding(
    ctx.db,
    { companyId: caller.companyId, departmentId: ticket.departmentId, productId: ticket.productId, kind: 'support_classification' },
    now,
  );
  const digest = checkInfo ? checkInfo.digest : sha256(`uncertified:${ticket.departmentId}:support_classification`);
  const sameRev = await existingBindingClassification(ctx.db, caller.companyId, input, digest);
  if (sameRev) return sameRev;
  return decideNewTicketClassification(ctx, ports, ticket, input.idempotencyKey, checkInfo, digest, now);
}

function scanSupportText(text: string, reasons: Set<GateCode>): void {
  if (containsSecretMaterial(text)) reasons.add('secret_forbidden');
  if (containsThirdPartyPii(text)) reasons.add('pii_forbidden');
  if (containsForbiddenSupportPromise(text)) reasons.add('support_intent_forbidden');
}

function scanTemplateRow(row: CatalogRow | undefined, reasons: Set<GateCode>): void {
  if (!row || row.value.kind !== 'template') return;
  if (row.value.parts.some(p => p.kind === 'slot' && (p.type === 'price' || p.type === 'terms'))) {
    reasons.add('support_intent_forbidden');
  }
  if (row.value.subject) scanSupportText(row.value.subject, reasons);
  for (const part of row.value.parts) {
    if (part.kind === 'text') scanSupportText(part.text, reasons);
  }
}

async function inspectSupportDocument(
  db: Pick<Db, 'select'>,
  companyId: string,
  document: MessageDocument,
  reasons: Set<GateCode>,
): Promise<void> {
  if (document.blocks.some(b => b.kind === 'price')) reasons.add('support_intent_forbidden');
  const ids = [document.templateId, ...document.blocks.map(b => b.id)];
  const rows = await db
    .select()
    .from(outboundCatalogRevisions)
    .where(and(eq(outboundCatalogRevisions.companyId, companyId), inArray(outboundCatalogRevisions.entryId, ids)));
  const tplRow = rows.find(r => r.entryId === document.templateId && r.revision === document.templateRevision);
  scanTemplateRow(tplRow, reasons);
  for (const block of document.blocks) {
    const row = rows.find(r => r.entryId === block.id && r.revision === block.revision);
    if (row && (row.value.kind === 'claim' || row.value.kind === 'knowledge')) {
      scanSupportText(row.value.text, reasons);
    }
  }
}

function matchesTicketClassification(
  classification: typeof supportClassifications.$inferSelect | undefined,
  ticket: typeof supportTickets.$inferSelect,
): classification is typeof supportClassifications.$inferSelect {
  if (!classification || (classification.status !== 'ready' && classification.status !== 'unavailable')) return false;
  const sameTicket = classification.ticketId === ticket.ticketId && classification.ticketRevision === ticket.revision;
  return sameTicket && classification.ticketDigest === ticket.digest;
}

async function checkImportedConsentOnly(
  db: Pick<Db, 'select'>,
  channel: typeof outboundChannels.$inferSelect,
  contact: typeof outboundContacts.$inferSelect,
  reasons: Set<GateCode>,
): Promise<void> {
  if (contact.doNotContact || contact.suppressedAt !== null) return;
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
  if (perms.length > 0 && !perms.some(p => p.source !== 'asserted_import' && p.revokedAt === null)) {
    reasons.add('consent_missing');
  }
}

/* Ticket, channel and account of one place, the task's. A receipt belongs to its ticket, which matchesTicketClassification holds it to. */
async function loadSupportEntities(db: Pick<Db, 'select'>, companyId: string, input: SupportSubmitDto, task: InPlace) {
  const ticket = await loadTicketRevision(db, companyId, input, task);
  const [[channel], [account]] = await Promise.all([
    db.select().from(outboundChannels).where(and(eq(outboundChannels.companyId, companyId), eq(outboundChannels.id, input.channelId))),
    db.select().from(outboundAccounts).where(and(eq(outboundAccounts.companyId, companyId), eq(outboundAccounts.id, input.accountId))),
  ]);
  if (!channel || !account || !takesIn(channel, ticket) || account.channelId !== channel.id) {
    throw new SupportGatewayError(404, 'outbound_unknown', 'Support channel or account was not found.');
  }
  const [contact] = await db
    .select()
    .from(outboundContacts)
    .where(and(eq(outboundContacts.companyId, companyId), eq(outboundContacts.id, ticket.contactId)));
  if (!contact) throw new SupportGatewayError(404, 'outbound_unknown', 'Support contact was not found.');
  return { ticket, channel, account, contact };
}

async function reviewAfterAdmit(
  ctx: Ctx,
  ports: Pick<ModelCheckPorts, 'runModelCheck'>,
  admitted: SubmitResultDto,
  caller: SupportCaller,
  now: Date,
): Promise<SubmitResultDto> {
  await reviewQueuedMessage(ctx, ports, admitted.messageId, now, {
    provider: caller.authorProvider ?? null,
    vendorId: caller.authorVendorId,
  });
  const [updated] = await ctx.db.select().from(outboundMessages).where(eq(outboundMessages.id, admitted.messageId));
  if (!updated) return admitted;
  return SubmitResult.parse({
    messageId: admitted.messageId,
    revision: updated.revision,
    contentDigest: admitted.contentDigest,
    status: updated.status,
    reasonCodes: updated.reasonCodes,
  });
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
  const { ticket, channel, contact } = await loadSupportEntities(ctx.db, caller.companyId, input, task);

  const reasons = new Set<GateCode>();
  const [classification] = await ctx.db
    .select()
    .from(supportClassifications)
    .where(and(eq(supportClassifications.companyId, caller.companyId), eq(supportClassifications.id, input.classificationReceiptId)));
  if (!matchesTicketClassification(classification, ticket)) reasons.add('support_escalation_required');
  await checkImportedConsentOnly(ctx.db, channel, contact, reasons);
  await inspectSupportDocument(ctx.db, caller.companyId, input.document, reasons);

  if (reasons.size > 0) {
    return SubmitResult.parse({
      messageId: randomUUID(),
      revision: 1,
      contentDigest: sha256(canonicalJson(input)),
      status: 'rejected',
      reasonCodes: [...reasons],
    });
  }

  const admitted = await admit(
    ctx,
    { companyId: caller.companyId, agentId: caller.agentId, departmentId: task.departmentId, jobId: caller.jobId ?? null },
    {
      task: input.task,
      idempotencyKey: input.idempotencyKey,
      channelId: input.channelId,
      accountId: input.accountId,
      bindingGeneration: input.bindingGeneration,
      target: {
        kind: 'ticket',
        contactId: contact.id,
        ticketId: ticket.ticketId,
        ticketRevision: ticket.revision,
        classificationId: classification!.id,
      },
      segmentId: null,
      document: input.document,
      scheduledAt: input.scheduledAt,
    },
  );

  const settled = admitted.status === 'waiting_checks' ? await reviewAfterAdmit(ctx, ports, admitted, caller, now) : admitted;
  if (settled.status === 'waiting_approval' && classification!.requiresHuman !== false) {
    await ctx.db.update(supportTickets).set({ status: 'escalated' }).where(eq(supportTickets.id, ticket.id));
  }
  return settled;
}
