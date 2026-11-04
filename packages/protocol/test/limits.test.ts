import { describe, expect, it } from 'vitest';
import { currentLimits, type Limits } from '../src/index.js';

const NOW = Date.parse('2026-11-04T22:00:00.000Z');
const FRESH = '2026-11-04T21:55:00.000Z';
const FULL = { name: 'five_hour', utilization: 1, resetsAt: '2026-11-03T00:53:03.947Z' };
const OPEN = { name: 'seven_day', utilization: 0.4, resetsAt: '2026-11-10T00:41:44.000Z' };

const rejected = (windows: Limits['windows']): Limits => ({ status: 'rejected', windows, complete: true });

describe('currentLimits', () => {
  it('expires a window whose reset passed and clears a rejection caused by it', () => {
    expect(currentLimits(rejected([FULL, OPEN]), FRESH, NOW)).toEqual({
      status: 'allowed',
      windows: [OPEN],
      complete: false,
    });
  });

  it('keeps a rejection while another full window has not reset', () => {
    const unknownReset = { name: 'seven_day', utilization: null, resetsAt: null };
    expect(currentLimits(rejected([FULL, unknownReset]), FRESH, NOW)).toEqual({ ...rejected([unknownReset]), complete: false });
  });

  it('keeps a rejection with no blocking window because it gives no reset that could clear it', () => {
    expect(currentLimits(rejected([OPEN]), FRESH, NOW)).toEqual(rejected([OPEN]));
  });

  it('withholds a stale snapshot instead of treating its old rejection as current', () => {
    const stale = '2026-11-04T21:44:59.999Z';
    expect(currentLimits(rejected([OPEN]), stale, NOW)).toEqual({ status: 'allowed', windows: [], complete: false });
    expect(currentLimits(rejected([OPEN]), null, NOW)).toEqual({ status: 'allowed', windows: [], complete: false });
  });

  it('uses a snapshot at the freshness boundary and accepts a Date timestamp', () => {
    const atBoundary = new Date('2026-11-04T21:45:00.000Z');
    expect(currentLimits(rejected([OPEN]), atBoundary, NOW)).toEqual(rejected([OPEN]));
  });

  it('keeps the absence of any snapshot distinct from a stale one', () => {
    expect(currentLimits(null, null, NOW)).toBeNull();
  });
});
