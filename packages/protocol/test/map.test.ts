import { describe, expect, it } from 'vitest';
import { lineState, RETURN_MS, yellowUntil, type LineFacts } from '../src/map.js';
import { lineState as fromIndex } from '../src/index.js';

const T = Date.parse('2026-11-02T12:00:00Z');
const MINUTE = 60_000;

const quietEdge: LineFacts = { working: false, workEpoch: 0, returnedEpoch: null, returnedAt: null };

describe('lineState', () => {
  it('keeps the return light on for five minutes', () => {
    expect(RETURN_MS).toBe(300_000);
  });

  it('is blue while the work goes on, whatever came back before', () => {
    expect(lineState({ ...quietEdge, working: true }, T)).toBe('blue');
    expect(lineState({ working: true, workEpoch: 3, returnedEpoch: 3, returnedAt: T }, T + MINUTE)).toBe('blue');
    expect(lineState({ working: true, workEpoch: 4, returnedEpoch: 3, returnedAt: T }, T + MINUTE)).toBe('blue');
  });

  it('is yellow from a return in this cycle until five minutes pass, then quiet', () => {
    const returned: LineFacts = { working: false, workEpoch: 2, returnedEpoch: 2, returnedAt: T };
    expect(lineState(returned, T)).toBe('yellow');
    expect(lineState(returned, T + 2 * MINUTE)).toBe('yellow');
    expect(lineState(returned, T + RETURN_MS - 1)).toBe('yellow');
    expect(lineState(returned, T + RETURN_MS)).toBe('quiet');
    expect(lineState(returned, T + 10 * MINUTE)).toBe('quiet');
  });

  it('is quiet with no return at all', () => {
    expect(lineState(quietEdge, T)).toBe('quiet');
    expect(lineState({ ...quietEdge, workEpoch: 5 }, T)).toBe('quiet');
  });

  it('never lights a return stamped later than now', () => {
    expect(lineState({ working: false, workEpoch: 1, returnedEpoch: 1, returnedAt: T + 1 }, T)).toBe('quiet');
  });

  it('starts the five minutes again with a second return', () => {
    const first: LineFacts = { working: false, workEpoch: 1, returnedEpoch: 1, returnedAt: T };
    const second: LineFacts = { ...first, returnedAt: T + 4 * MINUTE };
    expect(lineState(first, T + 6 * MINUTE)).toBe('quiet');
    expect(lineState(second, T + 6 * MINUTE)).toBe('yellow');
    expect(lineState(second, T + 4 * MINUTE + RETURN_MS)).toBe('quiet');
  });

  it('turns blue again when new work starts after a return', () => {
    expect(lineState({ working: true, workEpoch: 2, returnedEpoch: 1, returnedAt: T }, T + MINUTE)).toBe('blue');
  });

  it('stays quiet when the new work ends without a return, even while the old return is still fresh', () => {
    // A return at T in cycle 0, new work at T+1 minute moves to cycle 1, a crash or a plain finish at T+2 minutes.
    const sequence: Array<[LineFacts, number, string]> = [
      [{ working: false, workEpoch: 0, returnedEpoch: 0, returnedAt: T }, T, 'yellow'],
      [{ working: true, workEpoch: 1, returnedEpoch: 0, returnedAt: T }, T + MINUTE, 'blue'],
      [{ working: false, workEpoch: 1, returnedEpoch: 0, returnedAt: T }, T + 2 * MINUTE, 'quiet'],
    ];
    for (const [facts, now, state] of sequence) expect(lineState(facts, now)).toBe(state);
  });

  it('lights again only with a fresh return in the new cycle', () => {
    expect(lineState({ working: false, workEpoch: 1, returnedEpoch: 1, returnedAt: T + 3 * MINUTE }, T + 3 * MINUTE)).toBe('yellow');
  });

  it('tells a start and a return in the same millisecond apart by their cycle, not their time', () => {
    expect(lineState({ working: false, workEpoch: 1, returnedEpoch: 0, returnedAt: T }, T)).toBe('quiet');
    expect(lineState({ working: false, workEpoch: 1, returnedEpoch: 1, returnedAt: T }, T)).toBe('yellow');
  });

  it('gives the same answer for the same facts and time', () => {
    const facts: LineFacts = { working: false, workEpoch: 7, returnedEpoch: 7, returnedAt: T };
    expect(lineState(facts, T + MINUTE)).toBe(lineState(facts, T + MINUTE));
  });

  it('is what the package entry point gives too', () => {
    expect(fromIndex).toBe(lineState);
  });
});

describe('yellowUntil', () => {
  it('gives when the yellow of a return in this cycle goes out, and nothing while work goes on or for an older cycle', () => {
    const returned: LineFacts = { working: false, workEpoch: 2, returnedEpoch: 2, returnedAt: T };
    expect(yellowUntil(returned)).toBe(T + RETURN_MS);
    expect(yellowUntil({ ...returned, working: true })).toBeNull();
    expect(yellowUntil({ ...returned, workEpoch: 3 })).toBeNull();
    expect(yellowUntil(quietEdge)).toBeNull();
  });
});
