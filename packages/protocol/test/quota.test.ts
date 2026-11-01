import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { parseNodeMessage, parseServerMessage } from '../src/index.js';

const epoch = '00000000-0000-4000-8000-000000000001';
const usage = { epoch, seq: 1, sampledAt: '2030-01-01T00:00:00Z', delivery: 'live', source: 'usage_fetch', outcome: 'success', complete: true, status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.1, resetsAt: null }] };
const refusal = { kind: 'provider_quota', provider: 'kimi', epoch, seq: 2, observedAt: '2030-01-01T00:00:01Z', delivery: 'live', source: { format: 'kimi_wire', version: 'synthetic' }, native: { sessionId: 'synthetic-session', turnId: '1', cursor: { start: 10, end: 20 } } };
const done = { type: 'job.done', jobId: 'job-1', ok: false, sessionId: 'synthetic-session', result: 'Preserved answer', tail: 'Preserved tail', error: 'agent_failed' };
const read = (message: unknown) => parseNodeMessage(JSON.stringify(message));

describe('optional quota provenance', () => {
  it('roundtrips bounded observations, refusals and the server epoch without a new error enum', () => {
    expect(read({ ...done, usageObservation: usage, quotaRefusal: refusal })).toEqual({ ...done, usageObservation: usage, quotaRefusal: refusal });
    expect(read({ type: 'status', loggedIn: true, limits: null, usageObservation: usage })).toMatchObject({ usageObservation: usage });
    expect(parseServerMessage(JSON.stringify({ type: 'usage.epoch', epoch }))).toEqual({ type: 'usage.epoch', epoch });
    const hello = { type: 'hello', version: '0.5.0', loggedIn: true, running: [], usageObservations: true };
    expect(read(hello)).toEqual(hello);
  });

  it('keeps unavailable refreshes distinct from successful samples', () => {
    const unavailable = { ...usage, sampledAt: null, status: null, outcome: 'unavailable', complete: false, windows: [] };
    expect(read({ ...done, usageObservation: unavailable })).toMatchObject({ usageObservation: unavailable });
  });

  it.each([
    { seq: -1 }, { epoch: 'not-a-uuid' }, { seq: Number.MAX_SAFE_INTEGER + 1 },
    { sampledAt: '2030-01-01T00:00:00+03:00' }, { sampledAt: null },
    { windows: [usage.windows[0], usage.windows[0]] }, { windows: [{ ...usage.windows[0], utilization: 2 }] },
    { windows: [{ ...usage.windows[0], resetsAt: 'yesterday' }] }, { outcome: 'unavailable' },
  ])('ignores invalid usage metadata while retaining the entire completion: %j', change => {
    const result = read({ ...done, usageObservation: { ...usage, ...change } });
    expect(result).toMatchObject(done);
    expect(result).not.toHaveProperty('usageObservation', expect.anything());
  });

  it.each([
    { provider: 'codex' }, { kind: 'http_429' }, { observedAt: 'unknown' },
    { source: { format: 'screen', version: 'synthetic' } },
    { native: { ...refusal.native, cursor: { start: 20, end: 10 } } },
    { native: { ...refusal.native, turnId: '' } },
  ])('drops unqualified refusal metadata without dropping the result: %j', change => {
    const result = read({ ...done, quotaRefusal: { ...refusal, ...change } });
    expect(result).toMatchObject(done);
    expect(result).not.toHaveProperty('quotaRefusal', expect.anything());
  });

  it('keeps old nodes valid and new completions acceptable to the frozen old schema', () => {
    // The seven released completion fields at bd696b0, before optional quota evidence existed.
    const old = z.object({ type: z.literal('job.done'), jobId: z.string(), ok: z.boolean(), sessionId: z.string().nullable(), result: z.string(), tail: z.string(), error: z.enum(['timeout', 'agent_failed', 'not_logged_in', 'cancelled']).nullable() });
    expect(read(done)).toEqual(done);
    expect(old.parse({ ...done, usageObservation: usage, quotaRefusal: refusal })).toEqual(done);
  });
});
