import { z } from 'zod';

/* What a department's approvals are about. "other" takes whatever the rest do not name, so no work falls outside a policy,
   in any company and on any channel it uses. */
export const APPROVAL_CHANNELS = ['message', 'price', 'publication', 'commit', 'spend', 'other'] as const;
export const ApprovalChannel = z.enum(APPROVAL_CHANNELS);
export type ApprovalChannel = z.infer<typeof ApprovalChannel>;

export const APPROVAL_MODES = ['every', 'new_kinds', 'within_limits', 'none'] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/* The largest number a limit or an amount can be: far above any real one, and still exact as a number. */
const MOST = 1_000_000_000_000;
export const ApprovalAmount = z.number().nonnegative().max(MOST);

/* How one channel of a department is approved: every time, only for a kind nobody approved yet, with no approval up to a
   limit, or with no approval at all. A limit belongs to the mode of limits alone and that mode always has one. unit only
   says what the limit counts, like USD or people. */
export const ApprovalRule = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('none') }).strict(),
  z.object({ mode: z.literal('every') }).strict(),
  z.object({ mode: z.literal('new_kinds') }).strict(),
  z.object({ mode: z.literal('within_limits'), limit: ApprovalAmount, unit: z.string().trim().min(1).max(16).optional() }).strict(),
]);
export type ApprovalRule = z.infer<typeof ApprovalRule>;

/* What goes out of the company: messages, the prices in them and publications. A department sends them by itself; one that
   wants to approve its own sets a rule for them. */
export const GOING_OUT_CHANNELS = ['message', 'price', 'publication'] as const satisfies readonly ApprovalChannel[];

/* The rule of a channel nobody set a rule for: what goes out asks nothing, a commit asks every time, and the rest ask only
   for a kind nobody approved yet. */
export function defaultRule(channel: ApprovalChannel): ApprovalRule {
  if ((GOING_OUT_CHANNELS as readonly ApprovalChannel[]).includes(channel)) return { mode: 'none' };
  return channel === 'commit' ? { mode: 'every' } : { mode: 'new_kinds' };
}

/* What the database keeps of a rule. */
export type StoredApprovalRule = { mode: ApprovalMode; limitAmount: number | null; limitUnit: string | null };

/* A rule of a channel as it is stored. Without a limit a mode of limits asks every time, never passes everything. */
export function ruleOf(stored: StoredApprovalRule | undefined, channel: ApprovalChannel): ApprovalRule {
  if (!stored) return defaultRule(channel);
  if (stored.mode === 'none' || stored.mode === 'new_kinds') return { mode: stored.mode };
  if (stored.mode !== 'within_limits' || stored.limitAmount === null) return { mode: 'every' };
  return { mode: 'within_limits', limit: stored.limitAmount, ...(stored.limitUnit ? { unit: stored.limitUnit } : {}) };
}

/* One piece of work asking whether it may go: how much it is, when it says, and whether this kind was approved before. */
export type ApprovalWork = { amount: number | null; known: boolean };

/* Whether a person has to approve this work under this rule. Work that does not say how much is not within any limit. */
export function approvalNeeded(rule: ApprovalRule, work: ApprovalWork): boolean {
  if (rule.mode === 'none') return false;
  if (rule.mode === 'every') return true;
  if (rule.mode === 'new_kinds') return !work.known;
  return work.amount === null || work.amount > rule.limit;
}

/* A kind of work as it is compared: "Welcome  email" and "welcome email" are one kind. */
export const kindKey = (kind: string): string => kind.trim().replace(/\s+/g, ' ').toLowerCase();
