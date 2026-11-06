import { z } from 'zod';
import { ReviewSha } from './review-schema.js';

const LiteralRef = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9/._-]*$/)
  .refine(value => !/(?:\.\.|\/\/|\/$|\.$|(?:^|\/)\.|\.lock(?:\/|$))/.test(value));
const Receipt = z.object({
  receiptId: z.uuid(), repositoryId: z.uuid(), taskId: z.uuid(), workspaceId: z.uuid(),
  bindingVersion: z.number().int().min(1), submissionRevision: z.number().int().min(0),
  taskBranch: LiteralRef, submittedHeadSha: ReviewSha, publicationReceiptId: z.uuid(),
  integrationKind: z.enum(['turn', 'main']), integrationRef: LiteralRef,
  integrationCommitSha: ReviewSha, batchOrReleaseId: z.uuid(), confirmedAt: z.iso.datetime(),
}).strict();
export type MergeInclusionReceipt = z.infer<typeof Receipt>;

const Expected = Receipt.pick({ repositoryId: true, taskId: true, workspaceId: true, bindingVersion: true,
  submissionRevision: true, taskBranch: true, submittedHeadSha: true, publicationReceiptId: true,
  integrationKind: true, integrationRef: true }).extend({ companyId: z.uuid() }).strict();
export type StagingInclusionKey = z.infer<typeof Expected>;
const StoredInclusion = z.object({ companyId: z.uuid(), receipt: Receipt }).strict();

/* Shape and identity only. Trusted origin and durable publication are separate checks. */
export function matchStagingInclusion(record: unknown, expected: unknown): MergeInclusionReceipt | null {
  const stored = StoredInclusion.safeParse(record), query = Expected.safeParse(expected);
  if (!stored.success || !query.success) return null;
  const actual: Record<string, unknown> = { companyId: stored.data.companyId, ...stored.data.receipt };
  return Object.entries(query.data).every(([field, value]) => actual[field] === value) ? stored.data.receipt : null;
}
