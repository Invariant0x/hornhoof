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

// Protocol scaffolds stay unavailable until their targeted RED is followed by implementation.
export const SourceRef = z.never();
export type SourceRef = z.infer<typeof SourceRef>;
export const QuestionAudience = z.never();
export type QuestionAudience = z.infer<typeof QuestionAudience>;
export const QuestionRouteTarget = z.never();
export type QuestionRouteTarget = z.infer<typeof QuestionRouteTarget>;
export const QuestionMutationGuard = z.never();
export type QuestionMutationGuard = z.infer<typeof QuestionMutationGuard>;
export const HumanActionBinding = z.never();
export type HumanActionBinding = z.infer<typeof HumanActionBinding>;
