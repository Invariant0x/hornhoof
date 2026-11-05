import { describe, expect, it } from 'vitest';
import { inLane } from '../src/lane.js';

const later = () => {
  let done!: (value?: unknown) => void;
  const held = new Promise(resolve => { done = resolve; });
  return { held, done };
};

describe('one thing at a time per key', () => {
  it('starts each call only when the one before it under the key ended', async () => {
    const lanes = new Map<string, Promise<unknown>>();
    const seen: string[] = [];
    const first = later();
    const a = inLane(lanes, 'k', async () => { seen.push('a start'); await first.held; seen.push('a end'); return 'a'; });
    const b = inLane(lanes, 'k', async () => { seen.push('b'); return 'b'; });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(['a start']);
    first.done();
    expect(await Promise.all([a, b])).toEqual(['a', 'b']);
    expect(seen).toEqual(['a start', 'a end', 'b']);
  });

  it('lets another key go on meanwhile', async () => {
    const lanes = new Map<string, Promise<unknown>>();
    const first = later();
    const a = inLane(lanes, 'k', () => first.held);
    expect(await inLane(lanes, 'other', async () => 'free')).toBe('free');
    first.done();
    await a;
  });

  it('hands the failure to its caller and goes on with the next call', async () => {
    const lanes = new Map<string, Promise<unknown>>();
    const broken = inLane(lanes, 'k', async () => { throw new Error('broke'); });
    const next = inLane(lanes, 'k', async () => 'went on');
    await expect(broken).rejects.toThrow('broke');
    expect(await next).toBe('went on');
  });

  it('forgets a key once nothing is left in its lane, and not before', async () => {
    const lanes = new Map<string, Promise<unknown>>();
    const [first, second] = [later(), later()];
    const a = inLane(lanes, 'k', () => first.held);
    const b = inLane(lanes, 'k', () => second.held);
    first.done();
    await a;
    await new Promise(resolve => setImmediate(resolve));
    expect(lanes.has('k')).toBe(true);
    second.done();
    await b;
    await new Promise(resolve => setImmediate(resolve));
    expect(lanes.size).toBe(0);
  });
});
