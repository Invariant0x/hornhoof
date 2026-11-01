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
  return [...sampled.map(publicWindow), ...legacy.map(w => ({ ...w, sampledAt: null, receivedAt: null, source: 'legacy' as const }))];
}

function reasonOf(input: BudgetInput, quality: BudgetQuality, blocking: WindowEvidence[]): BudgetReason | null {
  if (input.budgetPercent === 0) return 'budget_disabled';
  if (input.limits?.status === 'rejected' || input.usage?.providerStatus === 'rejected' || Date.parse(input.limitUntil ?? '') > input.nowMs) return 'provider_limit';
  if (blocking.length) return 'budget_reached';
  if (input.budgetPercent === 100) return null;
  if (quality !== 'complete') return 'usage_unknown';
  return input.control === 'complete' ? null : 'control_unavailable';
}

function earliest(windows: WindowEvidence[], field: 'sampledAt' | 'receivedAt'): string | null {
  const times = windows.map(w => w[field]).filter((at): at is string => at !== null && Number.isFinite(Date.parse(at)));
  return times.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
}

function resetHint(windows: WindowEvidence[]): string | null {
  if (!windows.length || windows.some(w => !w.resetsAt || !Number.isFinite(Date.parse(w.resetsAt)))) return null;
  return windows.map(w => w.resetsAt!).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

export function evaluateSubscriptionBudget(input: BudgetInput): BudgetDecision {
  const quality = qualityOf(input);
  const windows = evidenceOf(input);
  const blockingWindows = windows.filter(w => w.utilization !== null && w.utilization >= input.budgetPercent / 100);
  const reason = reasonOf(input, quality, blockingWindows);
  const evidence = { quality, blockingWindows, resetHintAt: resetHint(blockingWindows) ?? (Date.parse(input.limitUntil ?? '') > input.nowMs ? input.limitUntil : null), sampledAt: earliest(windows, 'sampledAt') ?? input.usage?.statusSampledAt ?? null, receivedAt: earliest(windows, 'receivedAt') ?? input.usage?.statusReceivedAt ?? null };
  return reason ? { ...evidence, allowed: false, reason } : { ...evidence, allowed: true, reason: null };
}

export function subscriptionBudget(sub: { budgetPercent: number; limits: Limits | null; quotaState: QuotaState | null }, nowMs: number): BudgetView {
  /* No native lane is qualified by B0 yet. Persisting a setting does not claim enforcement. */
  const control: ControlCoverage = 'unavailable';
  const limits = quotaBlocked(sub.quotaState) ? { ...sub.limits, status: 'rejected' as const, windows: sub.limits?.windows ?? [] } : sub.limits;
  const usage = sub.quotaState?.usage ?? null;
  const decision = evaluateSubscriptionBudget({ budgetPercent: sub.budgetPercent, limits, usage, limitUntil: null, control, nowMs });
  const sampled = decision.quality === 'complete' ? earliest(usage?.windows ?? [], 'sampledAt') : null;
  return { decision, control, checkedAt: new Date(nowMs).toISOString(), freshUntil: sampled ? new Date(Date.parse(sampled) + MAX_USAGE_AGE_MS).toISOString() : null };
}
