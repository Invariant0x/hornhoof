import { describe, expect, it } from 'vitest';
import { COPY_HOURS, MAX_COPY_RTT_MS, MIN_COPY_MBPS, weakPath } from '../src/modules/copies/path.js';

const GIB = 2 ** 30;

describe('the path a copy needs', () => {
  it('calls no path weak that nothing was measured on', () => {
    expect(weakPath({}, 5 * GIB)).toBeNull();
    expect(weakPath({ linkMbps: null, linkRttMs: null }, 5 * GIB)).toBeNull();
  });

  it('calls a rate under the least slow, and one at it fit when the database is small', () => {
    expect(weakPath({ linkMbps: MIN_COPY_MBPS - 1 }, GIB / 100)).toBe('slow');
    expect(weakPath({ linkMbps: 0 }, null)).toBe('slow');
    expect(weakPath({ linkMbps: MIN_COPY_MBPS }, GIB / 100)).toBeNull();
    expect(weakPath({ linkMbps: MIN_COPY_MBPS }, null)).toBeNull();
  });

  it('calls a rate slow when the whole database would take longer than the hours a copy gets', () => {
    /* 10 GiB at 10 Mbps: 8590 s, under six hours. At 3 Mbps: 28633 s, over them. */
    expect(weakPath({ linkMbps: 10 }, 10 * GIB)).toBeNull();
    expect(weakPath({ linkMbps: 3 }, 10 * GIB)).toBe('slow');
    const edge = (10 * 1e6 * COPY_HOURS * 3600) / 8;
    expect(weakPath({ linkMbps: 10 }, edge)).toBeNull();
    expect(weakPath({ linkMbps: 10 }, edge + 1)).toBe('slow');
  });

  it('calls a round trip over what a copy keeps up with late, whatever the rate', () => {
    expect(weakPath({ linkMbps: 500, linkRttMs: MAX_COPY_RTT_MS + 1 }, GIB)).toBe('late');
    expect(weakPath({ linkMbps: 500, linkRttMs: MAX_COPY_RTT_MS }, GIB)).toBeNull();
    expect(weakPath({ linkRttMs: 4000 }, null)).toBe('late');
  });
});
