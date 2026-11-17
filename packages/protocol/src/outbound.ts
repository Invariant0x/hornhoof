import { z } from 'zod';
import { Sha256, UtcTime } from './model-check.js';

/* The outbound gateway at its edge. Every object is strict, so a field nobody agreed on is refused:
   an author passes references, never words, numbers, links or a recipient, and company, author and time come from the
   server. Nothing here has a default, as a limit nobody chose must not look like one somebody did. */
const Uuid = z.uuid();
const Revision = z.number().int().positive();
const Count = z.number().int().nonnegative();
const Limit = z.number().int().positive();
const Name = z.string().min(1).max(200);

const isLocale = (tag: string): boolean => {
  try {
    return Intl.getCanonicalLocales(tag).length === 1;
  } catch {
    return false;
  }
};
const isTimeZone = (zone: string): boolean => {
  try {
    return new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
};
/* A link with no space in it, on https, with no sign-in: what a person published cannot reach further than its own address. */
const isSafeLink = (link: string): boolean => {
  if (/[\s\p{Cc}]/u.test(link) || !URL.canParse(link)) return false;
  const { protocol, username, password } = new URL(link);
  return protocol === 'https:' && username === '' && password === '';
};

const Locale = z.string().max(35).refine(isLocale);
const SafeLink = z.string().max(2048).refine(isSafeLink);
/* Words a person published: lines are allowed, control characters are not. A subject is one line. */
const Text = z.string().min(1).max(20000).regex(/^[^\p{Cc}\p{Zl}\p{Zp}]*(?:\n[^\p{Cc}\p{Zl}\p{Zp}]*)*$/u);
const Line = z.string().min(1).max(500).regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u);
const Decimal = z.string().max(40).regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
const Currency = z.string().regex(/^[A-Z]{3}$/);

/* The name of a task the way its tools take it: 12, "#12", or its id. */
const TaskRef = z.union([z.number().int().positive(), z.string().regex(/^#[1-9][0-9]*$/), Uuid]);

export const GATE_CODES = ['price_unapproved', 'terms_unapproved', 'link_unapproved', 'claim_unapproved', 'template_unapproved', 'contact_field_missing', 'contact_field_invalid', 'unsupported_locale', 'contact_suppressed', 'consent_missing', 'support_escalation_required', 'support_intent_forbidden', 'secret_forbidden', 'pii_forbidden', 'channel_stopped', 'account_bound_elsewhere', 'stale_binding', 'daily_limit_exceeded', 'approval_required', 'review_unavailable', 'review_failed', 'check_uncertified', 'delivery_unknown', 'restored'] as const;
export const GateCode = z.enum(GATE_CODES);
export type GateCode = z.infer<typeof GateCode>;

/* A submit ends in one of the first four. The rest are the way of a message through the dispatcher. */
const SUBMIT_STATUSES = ['scheduled', 'waiting_checks', 'waiting_approval', 'rejected'] as const;
export const MESSAGE_STATUSES = [...SUBMIT_STATUSES, 'reserved', 'sending', 'sent', 'definitely_failed', 'unknown', 'cancelled'] as const;
export const MessageStatus = z.enum(MESSAGE_STATUSES);
export type MessageStatus = z.infer<typeof MessageStatus>;

const Block = z.strictObject({ kind: z.enum(['price', 'link', 'claim', 'knowledge']), id: Uuid, revision: Revision });
const Variable = z.strictObject({ slotId: Uuid, valueRef: Uuid });
export const MessageDocument = z.strictObject({ locale: Locale, templateId: Uuid, templateRevision: Revision, blocks: z.array(Block).max(100), variables: z.array(Variable).max(100) });
export type MessageDocument = z.infer<typeof MessageDocument>;

const ContactTarget = z.strictObject({ kind: z.literal('contact'), contactId: Uuid });
const AudienceTarget = z.strictObject({ kind: z.literal('audience'), audienceId: Uuid });
const Sending = { task: TaskRef, idempotencyKey: Uuid, channelId: Uuid, accountId: Uuid, bindingGeneration: Revision, document: MessageDocument, scheduledAt: UtcTime };

export const OutboundSubmit = z.strictObject({ ...Sending, target: z.discriminatedUnion('kind', [ContactTarget, AudienceTarget]), segmentId: Uuid });
export type OutboundSubmit = z.infer<typeof OutboundSubmit>;
/* A reply takes its recipient and purpose from the ticket, and its class from the server's receipt. */
export const SupportSubmit = z.strictObject({ ...Sending, ticketId: Uuid, ticketRevision: Revision, classificationReceiptId: Uuid });
export type SupportSubmit = z.infer<typeof SupportSubmit>;

/* A refusal always says why. */
const reasonsFit = ({ status, reasonCodes }: { status: MessageStatus; reasonCodes: GateCode[] }): boolean => status !== 'rejected' || reasonCodes.length > 0;
const Outcome = { messageId: Uuid, revision: Revision, contentDigest: Sha256, reasonCodes: z.array(GateCode) };
export const SubmitResult = z.strictObject({ ...Outcome, status: z.enum(SUBMIT_STATUSES) }).refine(reasonsFit);
export type SubmitResult = z.infer<typeof SubmitResult>;
/* What an author may read of a message: nothing of the contact, the adapter or the provider. */
export const OutboundMessageView = z.strictObject({ ...Outcome, status: MessageStatus, channelId: Uuid, accountId: Uuid, scheduledAt: UtcTime, updatedAt: UtcTime }).refine(reasonsFit);
export type OutboundMessageView = z.infer<typeof OutboundMessageView>;
export const OutboundStatusInput = z.strictObject({ messageId: Uuid });
export type OutboundStatusInput = z.infer<typeof OutboundStatusInput>;

export const SupportClassifyInput = z.strictObject({ task: TaskRef, ticketId: Uuid, ticketRevision: Revision, idempotencyKey: Uuid });
export type SupportClassifyInput = z.infer<typeof SupportClassifyInput>;
export const SupportClassifyResult = z.strictObject({ classificationReceiptId: Uuid, status: z.enum(['pending', 'ready', 'unavailable']) });
export type SupportClassifyResult = z.infer<typeof SupportClassifyResult>;

/* What an author sees of an account: that it exists and may be used. Its secrets have no field to be in. */
export const OutboundAccountView = z.strictObject({ accountId: Uuid, channelId: Uuid, available: z.boolean() });
export type OutboundAccountView = z.infer<typeof OutboundAccountView>;

/* An approval is of exact bytes or of an exact approach, never of a kind named in words. */
const Approved = { requestId: Uuid, policyDigest: Sha256, sourceRevisionsDigest: Sha256, authorityFingerprint: Sha256 };
export const MessageApproval = z.strictObject({ ...Approved, kind: z.literal('message'), messageId: Uuid, revision: Revision, contentDigest: Sha256, accountId: Uuid, bindingGeneration: Revision });
export type MessageApproval = z.infer<typeof MessageApproval>;
export const ApproachApproval = z.strictObject({ ...Approved, kind: z.literal('approach'), channelId: Uuid, templateId: Uuid, templateRevision: Revision, segmentId: Uuid, locale: Locale });
export type ApproachApproval = z.infer<typeof ApproachApproval>;
export const OutboundApprovalBinding = z.discriminatedUnion('kind', [MessageApproval, ApproachApproval]);
export type OutboundApprovalBinding = z.infer<typeof OutboundApprovalBinding>;

const decimalsFit = ({ amount, scale }: { amount: string; scale: number }): boolean => (amount.split('.')[1] ?? '').length === scale;
const endsAfterStart = ({ validFrom, validUntil }: { validFrom: string; validUntil: string | null }): boolean => validUntil === null || Date.parse(validUntil) > Date.parse(validFrom);
const Price = z.strictObject({
  kind: z.literal('price'), amount: Decimal, currency: Currency, scale: z.number().int().min(0).max(8), rounding: z.enum(['half_up', 'half_even', 'down']),
  discountId: Uuid.nullable(), termsId: Uuid.nullable(), validFrom: UtcTime, validUntil: UtcTime.nullable(),
}).refine(decimalsFit).refine(endsAfterStart);

const Words = { locale: Locale, text: Text };
const TEMPLATE_SLOTS = ['price', 'link', 'claim', 'knowledge', 'terms', 'variable', 'unsubscribe'] as const;
const TemplatePart = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('text'), text: Text }), z.strictObject({ kind: z.literal('slot'), slotId: Uuid, type: z.enum(TEMPLATE_SLOTS) })]);
type TemplatePart = z.infer<typeof TemplatePart>;
const slotId = (part: TemplatePart): string[] => (part.kind === 'slot' ? [part.slotId] : []);
const slotsAreOnce = ({ parts }: { parts: TemplatePart[] }): boolean => {
  const slots = parts.flatMap(slotId);
  return new Set(slots).size === slots.length;
};
const Template = z.strictObject({ kind: z.literal('template'), locale: Locale, subject: Line.nullable(), parts: z.array(TemplatePart).min(1).max(200) }).refine(slotsAreOnce);
const SupportClass = z.strictObject({ classId: z.string().regex(/^[a-z][a-z0-9_]*$/).max(80), requiresHuman: z.boolean(), description: Line });

/* A revision a person published. The row's own kind must be this one; the database holds them to each other. */
export const CATALOG_KINDS = ['template', 'price', 'discount', 'terms', 'link', 'claim', 'knowledge', 'unsubscribe', 'segment', 'audience', 'variable', 'taxonomy'] as const;
export const CatalogValue = z.discriminatedUnion('kind', [
  Template,
  Price,
  z.strictObject({ kind: z.literal('discount'), off: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('percent'), value: Decimal }), z.strictObject({ kind: z.literal('amount'), value: Decimal, currency: Currency })]) }),
  z.strictObject({ kind: z.literal('terms'), ...Words }),
  z.strictObject({ kind: z.literal('link'), url: SafeLink }),
  z.strictObject({ kind: z.literal('claim'), ...Words }),
  z.strictObject({ kind: z.literal('knowledge'), ...Words }),
  z.strictObject({ kind: z.literal('unsubscribe'), ...Words }),
  z.strictObject({ kind: z.literal('segment'), name: Name }),
  z.strictObject({ kind: z.literal('audience'), name: Name, destination: SafeLink }),
  z.strictObject({ kind: z.literal('variable'), field: z.string().regex(/^[a-z][a-z0-9_]*$/).max(80) }),
  z.strictObject({ kind: z.literal('taxonomy'), classes: z.array(SupportClass).min(1).max(200) }),
]);
export type CatalogValue = z.infer<typeof CatalogValue>;

/* An owner's revision of a channel's limits. The numbers are the owner's: the design names examples, not defaults. */
export const OutboundPolicyValue = z.strictObject({
  timezone: z.string().max(64).refine(isTimeZone),
  accountDailyLimit: Limit,
  domainDailyLimit: Limit,
  sampling: z.strictObject({ matureAfter: Count, firstPerSegment: Count, firstPerAuthor: Count, everyNth: Limit }),
  circuit: z.strictObject({ windowHours: Limit, minimumSample: Limit, maxComplaints: Count, maxRefusals: Count, maxBounces: Count }),
  /* The owner's word that a direct message of this channel goes without a person's yes to each one. Limits, consent,
     suppression, content checks, prices and a check that wants a person still hold. Left out, each one is asked. */
  autoSend: z.boolean().optional(),
});
export type OutboundPolicyValue = z.infer<typeof OutboundPolicyValue>;
