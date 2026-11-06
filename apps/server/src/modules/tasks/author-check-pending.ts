import { z } from 'zod';
import { ReviewRecord } from './review-context.js';

export const AuthorCheckPending = z.object({
  version: z.literal(1), runId: z.string().uuid(), summary: z.string(), evidence: z.string(), baseCommit: z.string(), authorCheckPlan: z.string(), review: ReviewRecord,
}).strict();
export type PendingSubmission = z.infer<typeof AuthorCheckPending>;

export function pendingSubmission(data: Record<string, unknown>): PendingSubmission | null {
  return AuthorCheckPending.safeParse(data.authorCheckPending).data ?? null;
}

export function outcomeRun(data: Record<string, unknown>): { runId?: string; status?: string } | null {
  const value = data.authorCheckOutcome;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as { runId?: string; status?: string } : null;
}
