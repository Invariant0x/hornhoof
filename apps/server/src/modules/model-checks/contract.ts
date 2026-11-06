import { z } from 'zod';

/* The frozen catalog of #403, section 10, as this module reads it. It is not the authority: the strict schemas of
   @hornhoof/protocol replace it when #444 publishes them, and this file then goes. */
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Uuid = z.uuid();

export const MODEL_CHECK_KINDS = ['outbound_review', 'support_reply_review', 'support_classification'] as const;
export type ModelCheckKind = (typeof MODEL_CHECK_KINDS)[number];

const ModelIdentity = z.strictObject({ providerId: z.string().min(1), vendorId: z.string().min(1), modelId: z.string().min(1), revisionId: z.string().min(1), inferenceConfigHash: Sha256 });

export const CheckBinding = z.strictObject({
  schemaVersion: z.literal(1),
  companyId: Uuid,
  departmentId: Uuid,
  productId: Uuid.nullable(),
  checkId: Uuid,
  kind: z.enum(MODEL_CHECK_KINDS),
  definitionVersion: z.number().int().positive(),
  checkerCodeHash: Sha256,
  promptHash: Sha256,
  outputSchemaHash: Sha256,
  sourceListHash: Sha256,
  taxonomyHash: Sha256.nullable(),
  model: ModelIdentity,
  datasetVersion: Uuid,
  datasetHash: Sha256,
  thresholdsHash: Sha256,
});
export type CheckBinding = z.infer<typeof CheckBinding>;

const Subject = z.strictObject({ id: Uuid, contentDigest: Sha256 });
const Fact = z.strictObject({ kind: z.enum(['price', 'link', 'claim', 'knowledge']), id: Uuid, revision: z.number().int().nonnegative(), canonicalValue: z.string(), sourceId: Uuid });
const ReviewInput = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.enum(['outbound_review', 'support_reply_review']),
  locale: z.string().min(1),
  subject: Subject,
  message: z.strictObject({ subject: z.string().nullable(), body: z.string() }),
  facts: z.array(Fact),
  policyDigest: Sha256,
  authorVendorId: z.string().min(1),
});
const ClassificationInput = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('support_classification'),
  locale: z.string().min(1),
  subject: Subject,
  ticket: z.strictObject({ text: z.string() }),
  taxonomyRevision: Sha256,
  taxonomy: z.array(z.strictObject({ classId: z.string().min(1), requiresHuman: z.boolean(), description: z.string() })),
});
export const CheckInput = z.union([ReviewInput, ClassificationInput]);
export type CheckInput = z.infer<typeof CheckInput>;

const ReviewExpected = z.strictObject({ decision: z.enum(['allow', 'block']) });
const ClassExpected = z.strictObject({ classId: z.string().min(1), requiresHuman: z.boolean() });

export const Case = z.strictObject({
  schemaVersion: z.literal(1),
  id: Uuid,
  kind: z.enum(MODEL_CHECK_KINDS),
  locale: z.string().min(1),
  split: z.enum(['dev', 'holdout']),
  input: CheckInput,
  expected: z.union([ReviewExpected, ClassExpected]),
  mustBlock: z.boolean(),
  labelledBy: z.strictObject({ kind: z.enum(['person', 'agent']), id: Uuid }),
  labelledAt: z.iso.datetime({ offset: true }),
  sourceIncidentId: Uuid.nullable(),
});
export type Case = z.infer<typeof Case>;
export type Party = Case['labelledBy'];

const ReasonCodes = z.array(z.string());
export const ReviewResult = z.strictObject({ kind: z.literal('review'), decision: z.enum(['allow', 'block', 'escalate']), reasonCodes: ReasonCodes });
export const ClassificationResult = z.strictObject({ kind: z.literal('classification'), classId: z.string().min(1), requiresHuman: z.boolean(), reasonCodes: ReasonCodes });
export const CheckResult = z.union([ReviewResult, ClassificationResult]);
export type CheckResult = z.infer<typeof CheckResult>;

export const CheckReceipt = z.strictObject({ schemaVersion: z.literal(1), checkId: Uuid, bindingDigest: Sha256, subjectDigest: Sha256, reviewer: ModelIdentity, result: CheckResult });
export type CheckReceipt = z.infer<typeof CheckReceipt>;
export type CheckUnavailable = { kind: 'unavailable'; code: 'unavailable' | 'invalid_output' | 'uncertified' | 'vendor_conflict' };

/* The port of a fresh, independent model call: #446 gives the call and #447 the evaluator. */
export type RunModelCheck = (binding: CheckBinding, input: CheckInput) => Promise<CheckReceipt | CheckUnavailable>;

/* What a run has until those land: no model. Nothing it says can pass a run, so no check can turn on without a real call. */
export const NO_MODEL_YET: RunModelCheck = async () => ({ kind: 'unavailable', code: 'unavailable' });
