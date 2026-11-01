import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { codexRateLimits } from '../src/providers/codex.js';
import { kimiAdapter } from '../src/providers/kimi.js';
import { kimiObservedLimits, kimiUsageLimits } from '../src/terminal/transcripts.js';
import { UsageSampler } from '../src/usage.js';

const rate = (usedPercent: unknown, reset: unknown = null) => ({ rateLimits: { primary: { usedPercent, windowDurationMins: 300, resetsAt: reset } } });

describe('Codex budget source numbers', () => {
  it.each([null, undefined, '', ' ', '0', true, NaN, Infinity, -1])('keeps unknown %s distinct from a measured zero', value => {
    expect(codexRateLimits(rate(value))?.windows[0]?.utilization).toBeNull();
  });

  it('keeps numeric zero and raw fractional percentages', () => {
    expect(codexRateLimits(rate(0))?.windows[0]?.utilization).toBe(0);
    expect(codexRateLimits(rate(89.99999999999999))?.windows[0]?.utilization).toBe(89.99999999999999 / 100);
  });

  it.each([NaN, Infinity, 1e20])('keeps an invalid reset %s unknown without losing the measured ratio', reset => {
    expect(codexRateLimits(rate(90, reset))?.windows[0]).toMatchObject({ utilization: 0.9, resetsAt: null });
  });

  it('does not call an incomplete window list authoritative when an unidentifiable window was skipped', () => {
    const data = rate(20);
    expect(codexRateLimits({ rateLimits: { ...data.rateLimits, secondary: { usedPercent: 30, windowDurationMins: 'invalid' } } })).toMatchObject({ complete: false, windows: [{ name: 'five_hour', utilization: 0.2 }] });
  });
});

const monthly = { usages: { limit_5h: { used_ratio: 0.1 }, limit_month_total: { used_ratio: 0.89, reset_time: '2030-02-01T00:00:00Z' }, limit_month_code: { used_ratio: 0.91, reset_time: '2030-02-02T00:00:00Z' } } };
const observedWindows = [
  { name: 'five_hour', utilization: 0.1, resetsAt: null },
  { name: 'month_total', utilization: 0.89, resetsAt: '2030-02-01T00:00:00.000Z' },
  { name: 'month_code', utilization: 0.91, resetsAt: '2030-02-02T00:00:00.000Z' },
];

describe('Kimi budget window collection', () => {
  it.each([null, undefined, '', ' ', false, -0.1, '-0.1'])('retains an unknown ratio %s instead of a measured zero', used_ratio => {
    expect(kimiUsageLimits({ usages: { limit_5h: { used_ratio } } })?.windows[0]?.utilization).toBeNull();
  });

  it('retains both actual monthly identities alongside the existing fuller-month projection', () => {
    expect(kimiUsageLimits({ usages: { limit_5h: { used_ratio: 0 } } })?.windows[0]?.utilization).toBe(0);
    expect(kimiObservedLimits(monthly)).toMatchObject({ observedWindows });
    expect(kimiUsageLimits(monthly)).toEqual({ status: 'allowed', complete: true, windows: [observedWindows[0], { name: 'month', utilization: 0.91, resetsAt: '2030-02-02T00:00:00.000Z' }] });
  });

  it('samples raw windows before merging and strips the internal field from cached legacy limits', async () => {
    const sampling = new UsageSampler();
    sampling.setEpoch('00000000-0000-4000-8000-000000000066');
    const collected = { status: 'allowed' as const, complete: true, windows: [{ name: 'month', utilization: 0.91, resetsAt: null }], observedWindows };
    const updated = await sampling.update(() => null, async () => collected, (_before, news) => news);
    expect(sampling.metadata().usageObservation?.windows).toEqual(observedWindows);
    expect(updated?.limits).not.toHaveProperty('observedWindows');
    expect(updated?.limits?.windows).toEqual(collected.windows);
  });

  it('collects both projections from exactly one existing usage fetch with synthetic credentials', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hh-budget-usage-'));
    mkdirSync(join(home, 'credentials'));
    writeFileSync(join(home, 'credentials', 'kimi-code.json'), JSON.stringify({ access_token: 'synthetic-local-test' }));
    const read = vi.fn(async () => new Response(JSON.stringify(monthly), { status: 200 }));
    vi.stubGlobal('fetch', read);
    onTestFinished(() => { vi.unstubAllGlobals(); rmSync(home, { recursive: true, force: true }); });
    expect(await kimiAdapter({ home, tools: home }).limits?.()).toMatchObject({ observedWindows });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
