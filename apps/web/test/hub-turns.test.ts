import { describe, expect, it } from 'vitest';
import { arcEnd, hubSectors, litSquares, sectorFill, sharePercent, workingTurns, type HubSector } from '../src/hub-turns';
import type { Department } from '../src/types';

const dept = (d: Partial<Department> & { id: string }): Department => ({ name: null, templateKey: null, roleCode: 'SAL', about: '', agents: { total: 0, working: 0 }, products: [], teams: [], people: [], employees: [], roles: [], ...d });
const angle = ([x, y]: [number, number]) => (Math.atan2(y - 120, x - 120) * 180) / Math.PI;
const radius = ([x, y]: [number, number]) => Math.hypot(x - 120, y - 120);

describe('litSquares', () => {
  it('lights squares from the left by the share of tasks done, and all twenty only when every task is done', () => {
    expect(litSquares(0, 17)).toBe(0);
    expect(litSquares(3, 17)).toBe(4);
    expect(litSquares(4, 17)).toBe(5);
    expect(litSquares(33, 96)).toBe(7);
    expect(litSquares(1, 1000)).toBe(1);
    expect(litSquares(99, 100)).toBe(19);
    expect(litSquares(17, 17)).toBe(20);
    expect(litSquares(1000, 1000)).toBe(20);
    expect(litSquares(0, 0)).toBe(0);
  });

  it('counts the same way on a sector with fewer segments', () => {
    expect(litSquares(3, 17, 6)).toBe(1);
    expect(litSquares(16, 17, 6)).toBe(5);
    expect(litSquares(17, 17, 6)).toBe(6);
    expect(litSquares(5, 10, 1)).toBe(0);
    expect(litSquares(10, 10, 1)).toBe(1);
  });
});

describe('sharePercent', () => {
  it('rounds the share of tasks done to a whole percent', () => {
    expect(sharePercent(3, 17)).toBe(18);
    expect(sharePercent(4, 17)).toBe(24);
    expect(sharePercent(1000, 1000)).toBe(100);
    expect(sharePercent(0, 0)).toBe(0);
  });
});

describe('workingTurns', () => {
  it('keeps the departments with tasks in the open turn, in the order of their cards', () => {
    const departments = [
      dept({ id: 'ops', roleCode: 'OPS', turnProgress: null }),
      dept({ id: 'dev', roleCode: 'CTO', turnProgress: { turnNumber: 8, done: 33, total: 96 } }),
      dept({ id: 'mkt', roleCode: 'CMO', turnProgress: { turnNumber: 8, done: 0, total: 0 } }),
      dept({ id: 'old', roleCode: 'OLD' }),
      dept({ id: 'sal', roleCode: 'CRO', turnProgress: { turnNumber: 8, done: 0, total: 4 } }),
    ];
    expect(workingTurns(departments)).toEqual([
      { id: 'dev', roleCode: 'CTO', turnNumber: 8, done: 33, total: 96 },
      { id: 'sal', roleCode: 'CRO', turnNumber: 8, done: 0, total: 4 },
    ]);
  });
});

describe('hubSectors', () => {
  const spans = (s: HubSector[]) => s.map(x => +(x.from - x.to).toFixed(2));

  it('draws no lower arc while no department works in the turn', () => {
    expect(hubSectors(0)).toEqual([]);
  });

  it('runs one department along the whole lower half in twenty segments, without separators', () => {
    expect(hubSectors(1)).toEqual([{ from: 174, to: 6, segments: 20, separator: null }]);
  });

  it.each([
    [2, 8, 12],
    [3, 6, 12],
    [5, 4, 9],
  ])('splits the lower half into %i sectors of %i segments with %i degrees between them', (n, segments, gap) => {
    const sectors = hubSectors(n);
    expect(sectors).toHaveLength(n);
    expect(sectors.every(s => s.segments === segments)).toBe(true);
    const span = (168 - gap * (n - 1)) / n;
    expect(spans(sectors)).toEqual(Array(n).fill(+span.toFixed(2)));
    expect(sectors[0]!.from).toBe(174);
    expect(sectors[n - 1]!.to).toBeCloseTo(6, 6);
    sectors.slice(1).forEach((s, i) => expect(sectors[i]!.to - s.from).toBeCloseTo(gap, 6));
  });

  it('puts a short radial separator in the middle of every gap, across the arc', () => {
    const sectors = hubSectors(3);
    expect(sectors.map(s => s.separator === null)).toEqual([false, false, true]);
    for (const [i, s] of sectors.slice(0, -1).entries()) {
      const [a, b] = s.separator!;
      const middle = (s.to + sectors[i + 1]!.from) / 2;
      expect(angle(a)).toBeCloseTo(middle, 6);
      expect(angle(b)).toBeCloseTo(middle, 6);
      expect(radius(a)).toBeCloseTo(95, 6);
      expect(radius(b)).toBeCloseTo(111, 6);
    }
  });

  it('keeps twelve departments readable: each sector apart, inside the lower half, at least one segment of five degrees', () => {
    for (let n = 2; n <= 12; n++) {
      const sectors = hubSectors(n);
      expect(sectors).toHaveLength(n);
      for (const [i, s] of sectors.entries()) {
        expect(s.from).toBeLessThanOrEqual(174);
        expect(s.to).toBeGreaterThanOrEqual(6 - 1e-9);
        expect(s.segments).toBeGreaterThanOrEqual(1);
        expect((s.from - s.to) / s.segments).toBeGreaterThanOrEqual(5);
        if (i) expect(sectors[i - 1]!.to).toBeGreaterThan(s.from);
      }
    }
    expect(hubSectors(12).every(s => s.segments >= 2)).toBe(true);
  });

  it('still gives each of many departments a sector of its own', () => {
    const sectors = hubSectors(40);
    expect(sectors).toHaveLength(40);
    expect(sectors.every(s => s.segments === 1 && s.from > s.to)).toBe(true);
  });
});

describe('sectorFill', () => {
  it('fills a sector from its left end by the lit segments, ending at the last lit one', () => {
    const [one] = hubSectors(1);
    expect(sectorFill(one!, 0, 17)).toBeNull();
    const fill = sectorFill(one!, 3, 17)!;
    expect(fill.length).toBeCloseTo(3.72, 6);
    expect(fill.d.startsWith(`M ${arcEnd(174)}`)).toBe(true);
    expect(fill.d.endsWith(arcEnd(174 - (168 * 3.72) / 19.72))).toBe(true);
    const full = sectorFill(one!, 17, 17)!;
    expect(full.length).toBeCloseTo(19.72, 6);
    expect(full.d.endsWith(arcEnd(6))).toBe(true);
  });

  it('fills only its own sector when several departments work', () => {
    const sectors = hubSectors(3);
    const fill = sectorFill(sectors[1]!, 6, 6)!;
    expect(fill.d.startsWith(`M ${arcEnd(sectors[1]!.from)}`)).toBe(true);
    expect(fill.d.endsWith(arcEnd(sectors[1]!.to))).toBe(true);
    expect(fill.length).toBeCloseTo(5.72, 6);
  });
});
