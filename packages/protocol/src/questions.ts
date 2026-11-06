import { z } from 'zod';
import { MATERIAL_LIMITS, MaterialInput, materialMetadataFits } from './request-materials.js';

const lists = { common: z.array(MaterialInput).max(MATERIAL_LIMITS.perList), options: z.array(z.array(MaterialInput).max(MATERIAL_LIMITS.perList)).max(MATERIAL_LIMITS.options) };
const Result = z.strictObject({ presentation: z.literal('result'), ...lists }).refine(value =>
  value.options.length ? value.options.every(materials => materials.length > 0) : value.common.length > 0,
  'materials_required: Attach a material to each result option, or to the common result when there are no options.');
/* B matches this positional array to the actual source options and forces result
   for ready_result/exact commits; action is never an authority/legacy waiver. */
export const QuestionMaterials = z.discriminatedUnion('presentation', [Result, z.strictObject({ presentation: z.literal('action'), ...lists })])
  .refine(materialMetadataFits, 'Oversized material metadata.');
export type QuestionMaterials = z.infer<typeof QuestionMaterials>;

/* Native source identity, without a synthetic task or caller-supplied authority. */
export const SourceRef = z.strictObject({ kind: z.enum(['task_request', 'proposal', 'computer_access']), id: z.uuid() });
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
  kind: z.enum(['payment', 'owner_login', 'manual_machine_action', 'ceo_permission']), resourceId: ResourceReference,
});
export type HumanActionBinding = z.infer<typeof HumanActionBinding>;

/* Deliberately unavailable until the contract's positive RED cases are observed. */
export const ClassificationInput = z.never();
export const QuestionPurpose = z.never();
export const QuestionAuthorityBinding = z.never();
