import { describe, expect, it } from 'vitest';
import { passes, placePins, scoreOf, settle, whyOf, type Measured, type Scored } from '../src/modules/copies/score.js';

const GIB = 2 ** 30;
/* A machine that is always there, with the best of everything. */
const BEST: Measured = { share: 1, linkRttMs: 20, linkMbps: 100, internetRttMs: 20, internetMbps: 100, fsyncP99Ms: 2, memory: 16 * GIB, cores: 8 };
const NOTHING: Measured = { share: null, linkRttMs: null, linkMbps: null, internetRttMs: null, internetMbps: null, fsyncP99Ms: null, memory: null, cores: null };
const scored = (id: string, points: number, always = false): Scored => ({ id, points, always });
const ids = (order: { id: string }[]): string => order.map(one => one.id).join('');

describe('the score of a machine that may take the server', () => {
  it('scores each part on its line', () => {
    expect(scoreOf(BEST)).toEqual({ points: 100, parts: { online: 40, link: 20, internet: 10, disk: 20, memory: 5, cores: 5 } });
    /* A round trip halfway between the best and the worst earns half of its points. */
    const halfway = scoreOf({ ...BEST, linkRttMs: 160, internetRttMs: 160 }).parts;
    expect([halfway.link, halfway.internet]).toEqual([15, 7.5]);
    const worst = scoreOf({ ...BEST, linkRttMs: 300, linkMbps: 5, internetRttMs: 300, internetMbps: 5, fsyncP99Ms: 50, memory: 4 * GIB, cores: 0 });
    expect(worst).toEqual({ points: 40, parts: { online: 40, link: 0, internet: 0, disk: 0, memory: 0, cores: 0 } });
    expect(scoreOf({ ...BEST, memory: 10 * GIB, cores: 4 }).parts).toMatchObject({ memory: 2.5, cores: 2.5 });
    /* Past the best there is no more to earn, and below the worst no less. */
    expect(scoreOf({ ...BEST, linkRttMs: 1, linkMbps: 900, fsyncP99Ms: 0.5, memory: 64 * GIB, cores: 32 }).points).toBe(100);
    expect(scoreOf({ ...BEST, linkRttMs: 900, fsyncP99Ms: 200 }).parts).toMatchObject({ link: 10, disk: 0 });
  });

  it('scores missing measures', () => {
    /* How fast the leader sends to a machine is known only after it sent something: none yet is half. */
    expect(scoreOf(NOTHING)).toEqual({ points: 5, parts: { online: 0, link: 5, internet: 0, disk: 0, memory: 0, cores: 0 } });
    expect(scoreOf({ ...NOTHING, share: 0.5 }).points).toBe(25);
  });

  it('does not swap within 5 points', () => {
    expect(passes(scored('b', 75), scored('a', 70))).toBe(false);
    expect(passes(scored('b', 76), scored('a', 70))).toBe(true);
    expect(ids(settle([scored('a', 70), scored('b', 75)]))).toBe('ab');
    expect(ids(settle([scored('a', 70), scored('b', 76)]))).toBe('ba');
  });

  it('puts the 95% class first', () => {
    expect(ids(settle([scored('often', 90), scored('always', 60, true)]))).toBe('alwaysoften');
    /* Never the other way, whatever the points. */
    expect(ids(settle([scored('always', 10, true), scored('often', 100)]))).toBe('alwaysoften');
  });

  it('settles a whole order', () => {
    /* The last one has to climb past every other, which one pass over the list does not do. */
    const order = [scored('a', 50), scored('b', 58, true), scored('c', 60), scored('d', 70), scored('e', 90, true)];
    const settled = settle(order);
    expect(ids(settled)).toBe('ebdca');
    for (let at = 1; at < settled.length; at++) expect(passes(settled[at]!, settled[at - 1]!)).toBe(false);
    expect(ids(order)).toBe('abcde');
  });

  it('places the pins', () => {
    const [a, b, c, d, e] = ['A', 'B', 'C', 'D', 'E'].map(id => ({ id }));
    expect(ids(placePins([a!, b!, c!], [{ item: d!, pin: 2 }]))).toBe('DABC');
    /* A pin above the last place there is takes the last free one. */
    expect(ids(placePins([a!, b!], [{ item: d!, pin: 3 }, { item: e!, pin: 9 }]))).toBe('ADBE');
    /* Two such pins keep their order among themselves. */
    expect(ids(placePins([a!], [{ item: e!, pin: 9 }, { item: d!, pin: 7 }]))).toBe('ADE');
    expect(placePins([], [])).toEqual([]);
  });

  it('words why', () => {
    /* Every part of its own at nine tenths, and the link a little above them. */
    const even: Measured = { share: 1, linkRttMs: 34, linkMbps: 95.25, internetRttMs: 48, internetMbps: 90.5, fsyncP99Ms: 6.8, memory: 14.8 * GIB, cores: 7.2 };
    const link = scoreOf(even).parts.link / 20;
    expect(link).toBeCloseTo(0.95, 2);
    expect(whyOf(even, { leastMemory: 8 * GIB, bestLink: link })).toBe('always.best_link');
    expect(whyOf(even, { leastMemory: 8 * GIB, bestLink: 1 })).toBe('always.good_link');
    /* A slow disk is what the line names, whatever else is good. */
    expect(whyOf({ ...BEST, share: 0.8, fsyncP99Ms: 40.4 }, { leastMemory: null, bestLink: 1 })).toBe('mostly.slow_disk');
    /* Little memory: the least of the numbered machines, or just little. */
    expect(whyOf({ ...BEST, share: 0.5, memory: 5 * GIB }, { leastMemory: 5 * GIB, bestLink: 1 })).toBe('often_off.small');
    expect(whyOf({ ...BEST, share: 0.5, memory: 5 * GIB }, { leastMemory: 4.5 * GIB, bestLink: 1 })).toBe('often_off.little');
    /* The link at half and every other part full: the first of the full ones is named. */
    expect(whyOf({ ...BEST, linkRttMs: 300, linkMbps: 100 }, { leastMemory: null, bestLink: 1 })).toBe('always.fast_disk');
    expect(whyOf({ ...BEST, cores: 2 }, { leastMemory: null, bestLink: 1 })).toBe('always.few_cores');
    expect(whyOf({ ...BEST, internetRttMs: 300, internetMbps: 20 }, { leastMemory: null, bestLink: 1 })).toBe('always.slow_internet');
  });
});
