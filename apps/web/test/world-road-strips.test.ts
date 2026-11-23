import { describe, expect, it } from 'vitest';
import type { RoadTile, RoadTier } from '../src/world/city-layout';
import { roadStripSegments, STRIP_TEXELS_PER_TILE } from '../src/world/road-strips';

function roads(tiles: readonly [number, number, RoadTier?, boolean?][]): Map<string, RoadTile> {
  const m = new Map<string, RoadTile>();
  for (const [col, row, tier = 'dirt', bridge = false] of tiles) {
    m.set(`${col},${row}`, { col, row, tier, traffic: 1, bridge, wasOldWall: false, grandAvenue: false });
  }
  return m;
}

const widths: Record<RoadTier, number> = { trail: 0.4, dirt: 0.8, brick: 1, stone: 1 };

describe('Painted streets: strip segments between the centres of neighbouring street tiles', () => {
  it('runs a straight street as one strip whose columns continue from tile to tile', () => {
    const segs = roadStripSegments(roads([[10, 5], [11, 5], [12, 5]]), widths);
    expect(segs).toHaveLength(2);
    expect(segs.every(s => s.axis === 'u' && s.across === 5.5)).toBe(true);
    const [a, b] = [...segs].sort((x, y) => x.from - y.from);
    /* The street ends at the outer tiles' centres extended by half its width; inside it meets with no overlap. */
    expect(a!.from).toBeCloseTo(10.5 - 0.4);
    expect(a!.to).toBeCloseTo(11.5);
    expect(b!.from).toBeCloseTo(11.5);
    expect(b!.to).toBeCloseTo(12.5 + 0.4);
    expect(b!.texelX - a!.texelX).toBeCloseTo((b!.from - a!.from) * STRIP_TEXELS_PER_TILE);
  });

  it('closes a turn and a dead end, and gives a lone tile a stub', () => {
    const turn = roadStripSegments(roads([[3, 3], [4, 3], [4, 4]]), widths);
    const u = turn.find(s => s.axis === 'u')!;
    const v = turn.find(s => s.axis === 'v')!;
    expect(u.to).toBeCloseTo(4.5 + 0.4);
    expect(v.from).toBeCloseTo(3.5 - 0.4);
    const lone = roadStripSegments(roads([[7, 7, 'trail']]), widths);
    expect(lone).toHaveLength(1);
    expect(lone[0]!.to - lone[0]!.from).toBeCloseTo(2 * 0.2);
  });

  it('takes the lower tier where two streets meet, and leaves bridges to their own look', () => {
    const segs = roadStripSegments(roads([[0, 0, 'stone'], [1, 0, 'trail'], [2, 0, 'dirt', true]]), widths);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.tier).toBe('trail');
    /* The street stops short of the bridge tile; it reaches the bridge's edge. */
    expect(segs[0]!.to).toBeCloseTo(2);
  });
});
