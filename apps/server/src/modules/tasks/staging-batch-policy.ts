import { z } from 'zod';

const Scope = z.strictObject({ companyId: z.uuid(), repositoryId: z.uuid(), turnId: z.uuid() });
export type StagingBatchScope = z.infer<typeof Scope>;
const Clock = z.number().int().nonnegative();
const Eligible = Scope.extend({ submissionId: z.uuid(), taskId: z.uuid(), acceptedAtMs: Clock }).strict();
export type EligibleStagingSubmission = z.infer<typeof Eligible>;
const Policy = z.strictObject({ enabled: z.boolean(), maxBatchSize: z.number().int().positive(), maxWaitMs: Clock });
export type StagingBatchPolicy = z.infer<typeof Policy>;
/* Unmeasured bootstrap: no added wait; remains disabled until the head enables the actual controller. */
export const INITIAL_STAGING_BATCH_POLICY: Readonly<StagingBatchPolicy> = Object.freeze({ enabled: false, maxBatchSize: 4, maxWaitMs: 0 });
const Input = z.strictObject({ scope: Scope, eligible: z.array(Eligible), nowMs: Clock, policy: Policy.default(INITIAL_STAGING_BATCH_POLICY) });
export type StagingBatchInput = z.input<typeof Input>;
export type StagingBatchDecision = { status: 'disabled' | 'empty' | 'unavailable' } | { status: 'waiting'; retryAtMs: number }
  | { status: 'ready'; reason: 'size' | 'window'; submissionIds: string[] };

function sameLane(row: EligibleStagingSubmission, scope: StagingBatchScope): boolean {
  return Object.entries(scope).every(([field, value]) => row[field as keyof StagingBatchScope] === value);
}

function validLane(input: z.output<typeof Input>): boolean {
  if (input.eligible.some(row => row.acceptedAtMs > input.nowMs || !sameLane(row, input.scope))) return false;
  const submissions = new Set(input.eligible.map(row => row.submissionId)), tasks = new Set(input.eligible.map(row => row.taskId));
  return submissions.size === input.eligible.length && tasks.size === input.eligible.length;
}

/* Scheduling only. Private admission/author-quality checks and atomic durable claiming belong to the caller. */
export function chooseStagingBatch(input: StagingBatchInput): StagingBatchDecision {
  const parsed = Input.safeParse(input);
  if (!parsed.success || !validLane(parsed.data)) return { status: 'unavailable' };
  const { policy, eligible, nowMs } = parsed.data;
  if (!policy.enabled) return { status: 'disabled' };
  if (!eligible.length) return { status: 'empty' };
  const ordered = [...eligible].sort((a, b) => a.acceptedAtMs - b.acceptedAtMs || a.submissionId.localeCompare(b.submissionId));
  const retryAtMs = ordered[0]!.acceptedAtMs + policy.maxWaitMs;
  if (ordered.length < policy.maxBatchSize && nowMs < retryAtMs) return { status: 'waiting', retryAtMs };
  return { status: 'ready', reason: ordered.length >= policy.maxBatchSize ? 'size' : 'window',
    submissionIds: ordered.slice(0, policy.maxBatchSize).map(row => row.submissionId) };
}
