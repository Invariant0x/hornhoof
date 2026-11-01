import type { QuotaRefusal, UsageObservation } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { currentRefusal, observeQuota, refuseQuota } from '../src/modules/subscriptions/quota.js';

const epoch = '00000000-0000-4000-8000-000000000062';
const at = '2030-01-01T00:00:00Z';
const now = Date.parse(at);
const connection = { epoch, issuedAt: now, current: () => true };
const usage: UsageObservation = { epoch, seq: 1, sampledAt: at, delivery: 'live', source: 'usage_fetch', outcome: 'success', complete: true, status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.1, resetsAt: null }] };
const refusal: QuotaRefusal = { kind: 'provider_quota', provider: 'kimi', epoch, seq: 2, observedAt: at, delivery: 'live', source: { format: 'kimi_wire', version: 'synthetic' }, native: { sessionId: 'session', turnId: '1', cursor: { start: 10, end: 20 } } };

describe('monotonic quota evidence', () => {
  it.each([0, 599999])('accepts a current live sample aged %d ms', age => {
    expect(observeQuota(null, usage, connection, now + age)?.recovered).not.toBeNull();
  });

  it.each([600000, 600001, -1])('rejects stale or future samples aged %d ms', age => {
    expect(observeQuota(null, usage, connection, now + age)).toBeNull();
  });

  it('keeps a denial across newer partial observations and rejects older recovery', () => {
    const granted = observeQuota(null, usage, connection, now);
    const denied = refuseQuota(granted, refusal);
    const partial = observeQuota(denied, { ...usage, seq: 3, complete: false }, connection, now);
    expect(partial?.blocked).toEqual(denied.blocked);
    expect(observeQuota(partial, { ...usage, seq: 2 }, connection, now)).toBe(partial);
    const restored = observeQuota(partial, { ...usage, seq: 4 }, connection, now);
    expect(restored?.blocked).toBeNull();
    expect(refuseQuota(restored, refusal)).toEqual(restored);
  });

  it('orders equal instants by sequence despite different ISO representations', () => {
    const denied = refuseQuota(null, refusal);
    const restored = observeQuota(denied, { ...usage, sampledAt: '2030-01-01T00:00:00.000Z', seq: 3 }, connection, now);
    expect(restored?.blocked).toBeNull();
  });

  it('does not use an outbox, turn report, empty or unknown sample as a recovery grant', () => {
    const denied = refuseQuota(null, refusal);
    for (const change of [{ delivery: 'outbox' }, { source: 'turn_report' }, { windows: [] }, { windows: [{ ...usage.windows[0], utilization: null }] }] as const) {
      const sample = { ...usage, seq: 3, ...change } as UsageObservation;
      expect(observeQuota(denied, sample, connection, now)?.blocked).toEqual(denied.blocked);
    }
  });

  it('qualifies only an owned running conversation with the same native session and a current timestamp', () => {
    const job = { kind: 'conversation', status: 'running', startedAt: new Date(now) };
    const done = { ok: false, error: 'agent_failed', sessionId: 'session' };
    expect(currentRefusal(refusal, job, done, 'kimi', now)).toEqual(refusal);
    expect(currentRefusal(refusal, job, done, 'codex', now)).toBeNull();
    expect(currentRefusal(refusal, job, { ...done, sessionId: 'other' }, 'kimi', now)).toBeNull();
    expect(currentRefusal(refusal, { ...job, status: 'done' }, done, 'kimi', now)).toBeNull();
    expect(currentRefusal(refusal, { ...job, kind: 'test' }, done, 'kimi', now)).toBeNull();
    expect(currentRefusal(refusal, job, { ...done, error: 'not_logged_in' }, 'kimi', now)).toBeNull();
    expect(currentRefusal(refusal, job, done, 'kimi', now - 1)).toBeNull();
    expect(currentRefusal(refusal, { ...job, startedAt: new Date(now + 1) }, done, 'kimi', now + 1)).toBeNull();
  });
});
