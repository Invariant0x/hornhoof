import { z } from 'zod';
import { PROVIDER_IDS } from './providers.js';

/* The frozen contract of a check made by a model (#403, section 10). Every object is strict, so a field nobody agreed on
   is refused at the edge. Whatever decides anything, like a must-block example or the identity on a receipt, is built by
   the server from what it really called, not read from a model's words. */
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const Uuid = z.uuid();
const Utc = z.iso.datetime();
const Label = z.string().min(1);
const Count = z.number().int().nonnegative();

export const canonicalJson = (value: unknown): string => JSON.stringify(value);

export const MODEL_CHECK_KINDS = ['outbound_review', 'support_reply_review', 'support_classification'] as const;
export type ModelCheckKind = (typeof MODEL_CHECK_KINDS)[number];

/* The design asks for fixed codes and names none. This is the smallest list its words support: one for each kind of fact,
   for the forbidden list and the policy, and for what must reach a person. A code is never a customer's words. */
export const REASON_CODES = ['price_mismatch', 'link_mismatch', 'claim_mismatch', 'knowledge_mismatch', 'forbidden_content', 'policy_violation', 'private_data', 'requires_human', 'uncertain'] as const;
export const ReasonCode = z.enum(REASON_CODES);
export type ReasonCode = z.infer<typeof ReasonCode>;

/* What ended a certificate: a change to one part of the binding, or the evaluation itself. */
export const INVALIDATION_CODES = ['code', 'prompt', 'output_schema', 'list', 'taxonomy', 'model', 'dataset', 'thresholds', 'scope', 'evaluation_failed'] as const;
export const InvalidationCode = z.enum(INVALIDATION_CODES);
export type InvalidationCode = z.infer<typeof InvalidationCode>;

export const ModelIdentity = z.strictObject({ providerId: z.enum(PROVIDER_IDS), vendorId: Label, modelId: Label, revisionId: Label, inferenceConfigHash: Sha256 });
export type ModelIdentity = z.infer<typeof ModelIdentity>;

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
const Fact = z.strictObject({ kind: z.enum(['price', 'link', 'claim', 'knowledge']), id: Uuid, revision: Count, canonicalValue: z.string(), sourceId: Uuid });

export const ReviewInput = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.enum(['outbound_review', 'support_reply_review']),
  locale: Label,
  subject: Subject,
  message: z.strictObject({ subject: z.string().nullable(), body: z.string() }),
  facts: z.array(Fact),
  policyDigest: Sha256,
  authorVendorId: Label,
});
export const ClassificationInput = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal('support_classification'),
  locale: Label,
  subject: Subject,
  ticket: z.strictObject({ text: z.string() }),
  taxonomyRevision: Sha256,
  taxonomy: z.array(z.strictObject({ classId: Label, requiresHuman: z.boolean(), description: z.string() })),
});
export const CheckInput = z.union([ReviewInput, ClassificationInput]);
export type CheckInput = z.infer<typeof CheckInput>;

/* An example says allow or block: escalating is a model's way of not deciding, not something a labeller expects of it. */
export const Case = z.strictObject({
  schemaVersion: z.literal(1),
  id: Uuid,
  kind: z.enum(MODEL_CHECK_KINDS),
  locale: Label,
  split: z.enum(['dev', 'holdout']),
  input: CheckInput,
  expected: z.union([z.strictObject({ decision: z.enum(['allow', 'block']) }), z.strictObject({ classId: Label, requiresHuman: z.boolean() })]),
  mustBlock: z.boolean(),
  labelledBy: z.strictObject({ kind: z.enum(['person', 'agent']), id: Uuid }),
  labelledAt: Utc,
  sourceIncidentId: Uuid.nullable(),
});
export type Case = z.infer<typeof Case>;

export const ReviewResult = z.strictObject({ kind: z.literal('review'), decision: z.enum(['allow', 'block', 'escalate']), reasonCodes: z.array(ReasonCode) });
export const ClassificationResult = z.strictObject({ kind: z.literal('classification'), classId: Label, requiresHuman: z.boolean(), reasonCodes: z.array(ReasonCode) });
export const CheckResult = z.union([ReviewResult, ClassificationResult]);
export type CheckResult = z.infer<typeof CheckResult>;

export const CheckReceipt = z.strictObject({ schemaVersion: z.literal(1), checkId: Uuid, bindingDigest: Sha256, subjectDigest: Sha256, reviewer: ModelIdentity, result: CheckResult });
export type CheckReceipt = z.infer<typeof CheckReceipt>;

export const CheckUnavailable = z.strictObject({ kind: z.literal('unavailable'), code: z.enum(['unavailable', 'invalid_output', 'uncertified', 'vendor_conflict']) });
export type CheckUnavailable = z.infer<typeof CheckUnavailable>;

export const CertifiedCheck = z.strictObject({ certificateId: Uuid, bindingDigest: Sha256, reportId: Uuid, evaluatedAt: Utc, validUntil: Utc, status: z.literal('active') });
export type CertifiedCheck = z.infer<typeof CertifiedCheck>;

/* Mistakes by kind and, for classes, what each was taken for: never one accuracy that hides an unsafe allow. */
export const EvaluationCounts = z.strictObject({ falseAllows: Count, falseDenies: Count, classErrors: Count, total: Count, unavailable: Count, confusion: z.record(Label, z.record(Label, Count)).optional() });
export type EvaluationCounts = z.infer<typeof EvaluationCounts>;

/* What only the trusted evaluator publishes. It is no certificate: whether one follows is the gate's decision. */
export const VerifiedEvaluation = z.strictObject({ bindingDigest: Sha256, reportId: Uuid, datasetHash: Sha256, complete: z.boolean(), infraErrors: Count, mustBlockMisses: Count, metrics: EvaluationCounts, holdoutMetrics: EvaluationCounts, evaluatedAt: Utc });
export type VerifiedEvaluation = z.infer<typeof VerifiedEvaluation>;
