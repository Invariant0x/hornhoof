import { z } from 'zod';
import { MATERIAL_LIMITS, MaterialInput, materialMetadataFits } from './request-materials.js';
import { PROVIDER_IDS } from './providers.js';

const lists = { common: z.array(MaterialInput).max(MATERIAL_LIMITS.perList), options: z.array(z.array(MaterialInput).max(MATERIAL_LIMITS.perList)).max(MATERIAL_LIMITS.options) };
const Result = z.strictObject({ presentation: z.literal('result'), ...lists }).refine(value =>
  value.options.length ? value.options.every(materials => materials.length > 0) : value.common.length > 0,
  'materials_required: Attach a material to each result option, or to the common result when there are no options.');
/* The server matches this positional array to the actual source options and forces result
   for ready_result/exact commits; action is never an authority/legacy waiver. */
export const QuestionMaterials = z.discriminatedUnion('presentation', [Result, z.strictObject({ presentation: z.literal('action'), ...lists })])
  .refine(materialMetadataFits, 'Oversized material metadata.');
export type QuestionMaterials = z.infer<typeof QuestionMaterials>;

/* Native source identity, without a synthetic task or caller-supplied authority. */
export const SourceRef = z.strictObject({ kind: z.enum(['task_request', 'proposal']), id: z.uuid() });
export type SourceRef = z.infer<typeof SourceRef>;
export const QuestionAudience = z.enum(['internal', 'human', 'legacy']);
export type QuestionAudience = z.infer<typeof QuestionAudience>;
export const QuestionRouteTarget = z.enum(['head', 'orchestrator', 'operations']);
export type QuestionRouteTarget = z.infer<typeof QuestionRouteTarget>;
const Revision = z.number().int().positive();
export const QuestionMutationGuard = z.strictObject({
  operationId: z.uuid(), source: SourceRef, expectedRevision: Revision, expectedRouteRevision: Revision,
});
export type QuestionMutationGuard = z.infer<typeof QuestionMutationGuard>;
const ResourceReference = z.string().min(1).max(200)
  .refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value), 'Use the exact resource reference.');
/* The service still verifies the resource and its actual responsible person. */
export const HumanActionBinding = z.strictObject({
  kind: z.enum(['payment', 'owner_login', 'manual_machine_action']), resourceId: ResourceReference,
});
export type HumanActionBinding = z.infer<typeof HumanActionBinding>;

const QUESTION_LIMITS = { payloadBytes: 32768, textBytes: 2048, labelBytes: 256, options: 16, recipients: 256, images: 24 } as const;
const UTF8 = new TextEncoder();
const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const Identifier = z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const distinct = (values: readonly string[]): boolean => new Set(values).size === values.length;

/* Conservative syntax checks only. The current classifier still verifies that
   prose explains the actual effect and never falls back to the technical body. */
function plainQuestionText(value: string, bytes: number): boolean {
  return value.trim().length > 0 && UTF8.encode(value).length <= bytes
    && !/[\u0000-\u0008\u000b-\u001f\u007f\uD800-\uDFFF]/u.test(value)
    && !/[`<>]|\$\(|\[[^\]]*\]\(|\*\*|__|(?:^|\n)\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)/.test(value)
    && !/(?:^|[\s;:])(?:sudo|npm|npx|pnpm|yarn|curl|wget|bash|sh|powershell|python|node|rm|git)\s/i.test(value);
}
const Plain = (bytes: number) => z.string().min(1).max(bytes).refine(value => plainQuestionText(value, bytes), 'Use bounded plain prose without commands or markup.');
const HumanEnvelope = z.strictObject({
  situation: Plain(QUESTION_LIMITS.textBytes), requiredAction: Plain(QUESTION_LIMITS.textBytes),
  options: z.array(z.strictObject({ id: Identifier, label: Plain(QUESTION_LIMITS.labelBytes), consequence: Plain(QUESTION_LIMITS.textBytes) }))
    .max(QUESTION_LIMITS.options).refine(options => distinct(options.map(option => option.id)), 'Use distinct option ids.'),
});
const Artifact = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('commit'), sha: z.string().regex(/^[0-9a-f]{40}$/) }),
  z.strictObject({ kind: z.literal('design'), imageIds: z.array(z.uuid()).min(1).max(QUESTION_LIMITS.images).refine(distinct, 'Use distinct image ids.') }),
  z.strictObject({ kind: z.enum(['staff', 'structure']), digest: Digest }),
]);
const Classification = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ready_result'), artifact: Artifact }),
  z.strictObject({ kind: z.literal('human_only_action'), actionBinding: HumanActionBinding }),
]);
/* The client selects the result/action. It never selects a recipient, authority
   digest or purpose. The server derives those from current native rights in its tx. */
export const QuestionClassificationInput = z.strictObject({
  ...QuestionMutationGuard.shape, classification: Classification, humanEnvelope: HumanEnvelope,
}).refine(materialMetadataFits, 'Oversized classification metadata.');
export type QuestionClassificationInput = z.infer<typeof QuestionClassificationInput>;

const UTC = z.iso.datetime();
const Amount = z.string().regex(/^(?:0|[1-9][0-9]{0,23})(?:\.[0-9]{1,12})?$/).refine(value => /[1-9]/.test(value), 'Use a positive decimal amount.');
export const QuestionPurpose = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('decision'), decisionKind: z.enum(['question', 'approval', 'choice', 'stuck', 'staff', 'structure']), authorityKind: z.enum(['ceo_and_delegate', 'department_and_ceo', 'owner_and_ceo', 'named_person']), departmentId: z.uuid().nullable() }),
  z.strictObject({ kind: z.literal('payment'), resourceId: ResourceReference, amount: Amount, currency: z.string().regex(/^[A-Z]{3}$/), payee: Plain(QUESTION_LIMITS.labelBytes) }),
  z.strictObject({ kind: z.literal('owner_login'), resourceId: ResourceReference, subscriptionId: z.uuid(), ownerPersonId: z.uuid(), provider: z.enum(PROVIDER_IDS) }),
  z.strictObject({ kind: z.literal('manual_machine_action'), resourceId: ResourceReference, machineId: z.uuid(), nodeId: z.uuid().nullable(), actionId: Identifier, until: UTC.nullable() }),
]);
export type QuestionPurpose = z.infer<typeof QuestionPurpose>;
/* PRIVATE snapshot metadata, never a public view, a native grant or client input.
   Unknown payment/manual adapters stay unsupported even when this shape parses. */
export const QuestionAuthorityBinding = z.strictObject({
  recipientPersonIds: z.array(z.uuid()).min(1).max(QUESTION_LIMITS.recipients).refine(distinct, 'Use distinct recipients.'),
  authorityDigest: Digest, purpose: QuestionPurpose,
}).refine(materialMetadataFits, 'Oversized authority metadata.');
export type QuestionAuthorityBinding = z.infer<typeof QuestionAuthorityBinding>;

const TaskAssignmentCapture = z.strictObject({
  taskId: z.uuid(), taskVersion: z.number().int().nonnegative(),
  assigneeAgentId: z.uuid().nullable(), executorAgentId: z.uuid().nullable(), stage: z.number().int().nonnegative(),
});
const SourceBinding = z.strictObject({
  companyId: z.uuid(), authorAgentId: z.uuid(), sourceJobId: z.uuid().nullable(), sourceSequence: z.number().int().nonnegative().nullable(),
  taskAssignment: TaskAssignmentCapture.nullable(),
});
const snapshotShape = z.strictObject({
  classificationId: z.uuid(), source: SourceRef, revision: Revision, routeRevision: Revision, sourceBinding: SourceBinding,
  digest: Digest, classification: Classification, humanEnvelope: HumanEnvelope, authority: QuestionAuthorityBinding,
  materialRevision: Revision.nullable(), materialDigest: Digest.nullable(),
});
type Snapshot = z.infer<typeof snapshotShape>;
function snapshotMaterialsFit(value: Snapshot): boolean {
  return (value.materialRevision === null) === (value.materialDigest === null)
    && (value.classification.kind !== 'ready_result' || value.materialRevision !== null);
}
function snapshotPurposeFits(value: Snapshot): boolean {
  const purpose = value.authority.purpose;
  if (value.classification.kind === 'ready_result') return purpose.kind === 'decision';
  return purpose.kind !== 'decision' && purpose.kind === value.classification.actionBinding.kind
    && purpose.resourceId === value.classification.actionBinding.resourceId;
}
/* PRIVATE consistency metadata only. The server seals the digest, verifies actual source
   and resource rights in its tx, and compares current bindings on every use.
   A parsed digest/task capture is never proof of a current assignment or grant. */
export const QuestionClassificationSnapshot = snapshotShape
  .refine(value => (value.source.kind === 'task_request') === (value.sourceBinding.taskAssignment !== null), 'Only task requests capture a real task assignment.')
  .refine(snapshotMaterialsFit, 'Keep a complete material stamp; ready results require one.')
  .refine(snapshotPurposeFits, 'Bind the exact classification action and purpose.')
  .refine(materialMetadataFits, 'Oversized classification snapshot.');
export type QuestionClassificationSnapshot = z.infer<typeof QuestionClassificationSnapshot>;
