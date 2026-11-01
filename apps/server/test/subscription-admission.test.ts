import type { BudgetUsage, ControlCoverage, Limits, WindowSample } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { evaluateSubscriptionBudget } from '../src/modules/subscriptions/admission.js';

const at = '2030-01-01T00:00:00.000Z';
const nowMs = Date.parse(at);
const epoch = '00000000-0000-4000-8000-000000000066';
const window = (utilization: number | null, name = 'five_hour'): WindowSample => ({ name, utilization, resetsAt: null, sampledAt: at, receivedAt: at, source: 'usage_fetch', epoch, seq: 1, delivery: 'live', admissionEligible: true });
const usage = (windows = [window(0.89)]): BudgetUsage => ({ windows, authoritativeNames: windows.map(w => w.name), lastCompleteSampledAt: at, lastCompleteReceivedAt: at, lastRefreshReceivedAt: at, lastRefreshOutcome: 'success', providerStatus: 'allowed', statusSampledAt: at, statusReceivedAt: at });
const evaluate = (data: BudgetUsage | null = usage(), change: Partial<Parameters<typeof evaluateSubscriptionBudget>[0]> = {}) => evaluateSubscriptionBudget({ budgetPercent: 90, usage: data, limits: null, limitUntil: null, control: 'complete', nowMs, ...change });

describe('subscription budget decision', () => {
  it.each([[0.89, true], [0.90, false], [0.91, false], [0.8999999999999999, true], [0.9000000000000001, false]] as const)('compares raw utilization %s without display rounding', (value, allowed) => {
    expect(evaluate(usage([window(value)]))).toMatchObject({ allowed, reason: allowed ? null : 'budget_reached', quality: 'complete' });
  });

  it('applies zero first, retains provider restrictions at 100 and adds no missing-data reserve at 100', () => {
    expect(evaluate(null, { budgetPercent: 0, limitUntil: '2030-01-01T01:00:00Z' })).toMatchObject({ allowed: false, reason: 'budget_disabled' });
    expect(evaluate(null, { budgetPercent: 100, control: 'unavailable' })).toMatchObject({ allowed: true, reason: null, quality: 'missing' });
    expect(evaluate(usage([window(1)]), { budgetPercent: 100 })).toMatchObject({ allowed: false, reason: 'budget_reached' });
    const limits: Limits = { status: 'rejected', windows: [] };
    expect(evaluate(null, { budgetPercent: 100, limits })).toMatchObject({ allowed: false, reason: 'provider_limit' });
    expect(evaluate(null, { budgetPercent: 100, limitUntil: '2030-01-01T01:00:00Z' })).toMatchObject({ allowed: false, reason: 'provider_limit' });
  });

  it('blocks on any known window even while other required data is unknown', () => {
    const data = usage([window(0.89), window(0.91, 'seven_day'), window(null, 'month_total')]);
    expect(evaluate(data)).toMatchObject({ allowed: false, reason: 'budget_reached', quality: 'partial', blockingWindows: [{ name: 'seven_day', utilization: 0.91 }] });
    data.windows[1]!.utilization = 0.89;
    expect(evaluate(data)).toMatchObject({ allowed: false, reason: 'usage_unknown' });
    expect(evaluate({ ...data, authoritativeNames: null })).toMatchObject({ reason: 'usage_unknown' });
    expect(evaluate(null)).toMatchObject({ reason: 'usage_unknown' });
  });

  it.each([599999, 600000, 600001, -1])('uses original sampling time at age %s, never receipt time', age => {
    const data = usage();
    data.windows[0]!.receivedAt = new Date(nowMs + age).toISOString();
    expect(evaluate(data, { nowMs: nowMs + age })).toMatchObject({ allowed: age === 599999, reason: age === 599999 ? null : 'usage_unknown' });
  });

  it('requires every authoritative window and rejects invalid or missing original timestamps', () => {
    for (const sampledAt of [null, 'invalid', '2030-01-01T01:00:00Z']) {
      expect(evaluate(usage([{ ...window(0.1), sampledAt }]))).toMatchObject({ allowed: false, reason: 'usage_unknown' });
    }
    expect(evaluate({ ...usage(), authoritativeNames: ['five_hour', 'seven_day'] })).toMatchObject({ reason: 'usage_unknown' });
    expect(evaluate(usage([{ ...window(0.1), admissionEligible: false }]))).toMatchObject({ reason: 'usage_unknown' });
    expect(evaluate(usage([{ ...window(0.1), delivery: 'outbox' }]))).toMatchObject({ reason: 'usage_unknown' });
  });

  it('does not refresh an old second window when only the first window is newly sampled', () => {
    const later = nowMs + 500000;
    const data = usage([{ ...window(0.1), sampledAt: new Date(later).toISOString() }, window(0.2, 'seven_day')]);
    expect(evaluate(data, { nowMs: nowMs + 600000 })).toMatchObject({ allowed: false, reason: 'usage_unknown', quality: 'stale' });
  });

  it('keeps month windows distinct and shows a reset hint only if all blocking resets are known', () => {
    const data = usage([{ ...window(0.91, 'month_total'), resetsAt: '2030-01-02T00:00:00Z' }, { ...window(0.95, 'month_code'), resetsAt: '2030-01-03T00:00:00Z' }]);
    expect(evaluate(data)).toMatchObject({ reason: 'budget_reached', resetHintAt: '2030-01-03T00:00:00Z', blockingWindows: [{ name: 'month_total' }, { name: 'month_code' }] });
    data.windows[0]!.resetsAt = null;
    expect(evaluate(data).resetHintAt).toBeNull();
    expect(evaluate(data, { nowMs: nowMs + 4 * 86400000 }).allowed).toBe(false);
  });

  it.each(['unavailable', 'server_only'] satisfies ControlCoverage[])('does not promise native enforcement with %s control', control => {
    expect(evaluate(usage(), { control })).toMatchObject({ allowed: false, reason: 'control_unavailable' });
    expect(evaluate(usage(), { control, budgetPercent: 100 })).toMatchObject({ allowed: true, reason: null });
  });

  it('preserves reason order and public evidence without exposing internal grants', () => {
    const data = { ...usage(), providerStatus: 'rejected' as const };
    expect(evaluate(data)).toMatchObject({ reason: 'provider_limit' });
    expect(evaluate(usage(), { control: 'unavailable', limitUntil: '2030-01-01T01:00:00Z' }).reason).toBe('provider_limit');
    expect(evaluate(usage([window(0.91)]), { control: 'unavailable' }).reason).toBe('budget_reached');
    const blocked = evaluate(usage([window(0.91)]));
    expect(JSON.stringify(blocked)).not.toMatch(/epoch|seq|admissionEligible|delivery/);
    const legacy = evaluate(null, { limits: { status: 'allowed', windows: [window(0.91)] } });
    expect(JSON.stringify(legacy)).not.toMatch(/epoch|seq|admissionEligible|delivery/);
  });
});
