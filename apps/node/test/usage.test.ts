import { parseNodeMessage, type Limits, type NodeMessage } from '@hornhoof/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { markOutbox, UsageSampler } from '../src/usage.js';

const epoch = '00000000-0000-4000-8000-000000000062';
const limits: Limits = { status: 'allowed', complete: true, windows: [{ name: 'five_hour', utilization: 0.1, resetsAt: null }] };

describe('usage collection provenance', () => {
  it('keeps the sequence monotonic when the same epoch is delivered twice', async () => {
    const sampling = new UsageSampler();
    sampling.setEpoch(epoch);
    const first = await sampling.collect(async () => limits);
    sampling.setEpoch(epoch);
    const second = await sampling.collect(async () => limits);
    expect(second.observation.seq).toBeGreaterThan(first.observation.seq);
  });

  it('samples an actual unchanged response again without sharing mutable provider windows', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => { vi.useRealTimers(); });
    const sampling = new UsageSampler();
    sampling.setEpoch(epoch);
    const read = vi.fn(async () => structuredClone(limits));
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const first = await sampling.collect(read);
    vi.setSystemTime(new Date('2030-01-01T00:00:01Z'));
    const second = await sampling.collect(read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(first.observation.sampledAt).toBe('2030-01-01T00:00:00.000Z');
    expect(second.observation.sampledAt).toBe('2030-01-01T00:00:01.000Z');
    second.limits!.windows[0]!.utilization = 1;
    expect(second.observation.windows[0]!.utilization).toBe(0.1);
  });

  it('keeps a fetch that spans reconnect in its original epoch', async () => {
    const sampling = new UsageSampler();
    sampling.setEpoch(epoch);
    let finish!: (value: Limits) => void;
    const pending = sampling.collect(() => new Promise(resolve => { finish = resolve; }));
    sampling.setEpoch('00000000-0000-4000-8000-000000000063');
    const fresh = await sampling.collect(async () => limits);
    finish(limits);
    expect((await pending).observation.epoch).toBe(epoch);
    expect(fresh.observation.epoch).toBe(sampling.epoch);
  });

  it('marks failed delivery permanently on cached sample references without changing their sampling time', async () => {
    const sampling = new UsageSampler();
    sampling.setEpoch(epoch);
    const { observation } = await sampling.collect(async () => limits);
    const before = { ...observation };
    const status: NodeMessage = { type: 'status', loggedIn: true, limits, usageObservation: observation };
    markOutbox(status);
    markOutbox(status);
    expect(observation).toEqual({ ...before, delivery: 'outbox' });
  });

  it('does not invent a sampling time for an unavailable fetch', async () => {
    const sampling = new UsageSampler();
    sampling.setEpoch(epoch);
    const failed = await sampling.collect(async () => { throw new Error('Synthetic unavailable fetch'); });
    expect(failed.observation).toMatchObject({ outcome: 'unavailable', sampledAt: null, status: null, complete: false, windows: [] });
  });

  it('keeps completion content while marking both offline observations as ineligible for recovery', async () => {
    const sampling = new UsageSampler();
    sampling.setEpoch(epoch);
    const { observation } = await sampling.collect(async () => limits);
    const done: NodeMessage = { type: 'job.done', jobId: 'synthetic-job', ok: false, sessionId: 'session', result: 'Saved progress', tail: 'Saved diagnostic', error: 'agent_failed', usageObservation: observation, quotaRefusal: { kind: 'provider_quota', provider: 'kimi', epoch, seq: 2, observedAt: new Date().toISOString(), delivery: 'live', source: { format: 'kimi_wire', version: 'synthetic' }, native: { sessionId: 'session', turnId: '1', cursor: { start: 10, end: 20 } } } };
    markOutbox(done);
    expect(parseNodeMessage(JSON.stringify(done))).toMatchObject({ result: 'Saved progress', tail: 'Saved diagnostic', error: 'agent_failed', usageObservation: { delivery: 'outbox', sampledAt: observation.sampledAt }, quotaRefusal: { delivery: 'outbox' } });
  });

  it('discards a completed collection from the previous epoch without retagging it', async () => {
    const sampling = new UsageSampler();
    sampling.setEpoch(epoch);
    let finish!: (value: Limits) => void;
    const pending = sampling.update(() => null, () => new Promise(resolve => { finish = resolve; }), (_known, news) => news);
    sampling.setEpoch('00000000-0000-4000-8000-000000000063');
    finish(limits);
    expect(await pending).toBeNull();
    expect(sampling.metadata()).toEqual({});
  });

  it('merges a fetched partial response with the latest cache rather than the cache before the await', async () => {
    const sampling = new UsageSampler();
    sampling.setEpoch(epoch);
    let known: Limits | null = null;
    let finish!: (value: Limits) => void;
    const pending = sampling.update(() => known, () => new Promise(resolve => { finish = resolve; }), (before, news) => ({ ...news, windows: [...(before?.windows ?? []), ...news.windows] }));
    known = { status: 'allowed', windows: [{ name: 'seven_day', utilization: 0.3, resetsAt: null }] };
    finish(limits);
    expect((await pending)?.limits?.windows.map(w => w.name)).toEqual(['seven_day', 'five_hour']);
  });
});
