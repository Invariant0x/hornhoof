import { z } from 'zod';

/* What a department's approvals are about. "other" takes whatever the rest do not name, so no work falls outside a policy,
   in any company and on any channel it uses. */
export const APPROVAL_CHANNELS = ['message', 'price', 'publication', 'commit', 'spend', 'other'] as const;
export const ApprovalChannel = z.enum(APPROVAL_CHANNELS);
export type ApprovalChannel = z.infer<typeof ApprovalChannel>;

export const APPROVAL_MODES = ['every', 'new_kinds', 'within_limits'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/* The largest number a limit or an amount can be: far above any real one, and still exact as a number. */
const MOST = 1_000_000_000_000;
export const ApprovalAmount = z.number().nonnegative().max(MOST);

/* How one channel of a department is approved: every time, only for a kind nobody approved yet, or with no approval up to a
   limit. A limit belongs to that mode alone and that mode always has one, so approvals cannot be switched off without saying
   how far. unit only says what the limit counts, like USD or people. */
export const ApprovalRule = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('every') }).strict(),
  z.object({ mode: z.literal('new_kinds') }).strict(),
  z.object({ mode: z.literal('within_limits'), limit: ApprovalAmount, unit: z.string().trim().min(1).max(16).optional() }).strict(),
]);
export type ApprovalRule = z.infer<typeof ApprovalRule>;

/* A channel nobody set a rule for asks only for a kind nobody approved yet. */
export const DEFAULT_APPROVAL_RULE: ApprovalRule = { mode: 'new_kinds' };

/* What the database keeps of a rule. */
export type StoredApprovalRule = { mode: ApprovalMode; limitAmount: number | null; limitUnit: string | null };

/* A rule as it is stored. Without a limit a mode of limits asks every time, never passes everything. */
export function ruleOf(stored: StoredApprovalRule | undefined): ApprovalRule {
  if (!stored) return DEFAULT_APPROVAL_RULE;
  if (stored.mode === 'new_kinds') return { mode: 'new_kinds' };
  if (stored.mode !== 'within_limits' || stored.limitAmount === null) return { mode: 'every' };
  return { mode: 'within_limits', limit: stored.limitAmount, ...(stored.limitUnit ? { unit: stored.limitUnit } : {}) };
}

/* One piece of work asking whether it may go: how much it is, when it says, and whether this kind was approved before. */
export type ApprovalWork = { amount: number | null; known: boolean };

/* Whether a person has to approve this work under this rule. Work that does not say how much is not within any limit. */
export function approvalNeeded(rule: ApprovalRule, work: ApprovalWork): boolean {
  if (rule.mode === 'every') return true;
  if (rule.mode === 'new_kinds') return !work.known;
  return work.amount === null || work.amount > rule.limit;
}

/* A kind of work as it is compared: "Welcome  email" and "welcome email" are one kind. */
export const kindKey = (kind: string): string => kind.trim().replace(/\s+/g, ' ').toLowerCase();
