import type { BudgetDecision, BudgetQuality, BudgetReason, BudgetUsage, BudgetView, ControlCoverage, Limits, WindowEvidence, WindowSample } from '@hornhoof/protocol';
import { MAX_USAGE_AGE_MS, quotaBlocked, type QuotaState } from './quota.js';

export type BudgetInput = { budgetPercent: number; limits: Limits | null; usage: BudgetUsage | null; limitUntil: string | null; control: ControlCoverage; nowMs: number };

function freshWindow(window: WindowSample, now: number): boolean {
  if (!window.admissionEligible || window.delivery !== 'live' || !window.sampledAt) return false;
  const age = now - Date.parse(window.sampledAt);
  return age >= 0 && age < MAX_USAGE_AGE_MS;
}

function qualityOf(input: BudgetInput): BudgetQuality {
  const { usage, limits, nowMs } = input;
  if (!usage) return limits ? 'legacy' : 'missing';
  if (!usage.windows.length) return 'missing';
  if (usage.windows.some(w => !freshWindow(w, nowMs))) return 'stale';
  if (!usage.authoritativeNames?.length) return 'partial';
  const known = usage.windows.filter(w => w.utilization !== null).map(w => w.name);
  return usage.authoritativeNames.every(name => known.includes(name)) ? 'complete' : 'partial';
}

function publicWindow(window: WindowEvidence): WindowEvidence {
  const { name, utilization, resetsAt, sampledAt, receivedAt, source } = window;
  return { name, utilization, resetsAt, sampledAt, receivedAt, source };
}

function evidenceOf(input: BudgetInput): WindowEvidence[] {
  const sampled = input.usage?.windows ?? [];
  const legacy = (input.limits?.windows ?? []).filter(w => !sampled.some(s => s.name === w.name));
  return [...sampled.map(publicWindow), ...legacy.map(w => publicWindow({ ...w, sampledAt: null, receivedAt: null, source: 'legacy' }))];
}

function reasonOf(input: BudgetInput, quality: BudgetQuality, blocking: WindowEvidence[]): BudgetReason | null {
  if (input.budgetPercent === 0) return 'budget_disabled';
  if (providerRestricted(input)) return 'provider_limit';
  if (blocking.length) return 'budget_reached';
  if (input.budgetPercent === 100) return null;
  if (quality !== 'complete') return 'usage_unknown';
  return input.control === 'complete' ? null : 'control_unavailable';
}

function futureLimit(input: BudgetInput): string | null {
  return Date.parse(input.limitUntil ?? '') > input.nowMs ? input.limitUntil : null;
}

function providerRestricted(input: BudgetInput): boolean {
  return input.limits?.status === 'rejected' || input.usage?.providerStatus === 'rejected' || futureLimit(input) !== null;
}

function earliest(windows: WindowEvidence[], field: 'sampledAt' | 'receivedAt'): string | null {
  const times = windows.map(w => w[field]).filter((at): at is string => at !== null && Number.isFinite(Date.parse(at)));
  return times.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
}

function resetHint(windows: WindowEvidence[]): string | null {
  const resets = windows.flatMap(w => w.resetsAt && Number.isFinite(Date.parse(w.resetsAt)) ? [w.resetsAt] : []);
  if (!windows.length || resets.length !== windows.length) return null;
  return resets.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

export function evaluateSubscriptionBudget(input: BudgetInput): BudgetDecision {
  const quality = qualityOf(input);
  const windows = evidenceOf(input);
  const blockingWindows = windows.filter(w => w.utilization !== null && w.utilization >= input.budgetPercent / 100);
  const reason = reasonOf(input, quality, blockingWindows);
  const evidence = { quality, blockingWindows, resetHintAt: resetHint(blockingWindows) ?? futureLimit(input), ...sampleTimes(input, windows) };
  return reason ? { ...evidence, allowed: false, reason } : { ...evidence, allowed: true, reason: null };
}

function sampleTimes(input: BudgetInput, windows: WindowEvidence[]): { sampledAt: string | null; receivedAt: string | null } {
  return { sampledAt: earliest(windows, 'sampledAt') ?? input.usage?.statusSampledAt ?? null, receivedAt: earliest(windows, 'receivedAt') ?? input.usage?.statusReceivedAt ?? null };
}

type BudgetSubscription = { budgetPercent: number; limits: Limits | null; quotaState: QuotaState | null };

function effectiveLimits(sub: BudgetSubscription): Limits | null {
  if (!quotaBlocked(sub.quotaState)) return sub.limits;
  return { ...sub.limits, status: 'rejected', windows: sub.limits?.windows ?? [] };
}

function evidenceExpiry(quality: BudgetQuality, usage: BudgetUsage | null): string | null {
  if (quality !== 'complete') return null;
  const sampled = earliest(usage?.windows ?? [], 'sampledAt');
  return sampled ? new Date(Date.parse(sampled) + MAX_USAGE_AGE_MS).toISOString() : null;
}

export function subscriptionBudget(sub: BudgetSubscription, nowMs: number): BudgetView {
  /* No native lane is qualified by B0 yet. Persisting a setting does not claim enforcement. */
  const control: ControlCoverage = 'unavailable';
  const usage = sub.quotaState?.usage ?? null;
  const decision = evaluateSubscriptionBudget({ budgetPercent: sub.budgetPercent, limits: effectiveLimits(sub), usage, limitUntil: null, control, nowMs });
  return { decision, control, checkedAt: new Date(nowMs).toISOString(), freshUntil: evidenceExpiry(decision.quality, usage) };
}
