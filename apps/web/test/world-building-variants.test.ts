import { describe, expect, it } from 'vitest';
import { declaredArtFiles, resolveBuildingArt, variantStepOf, type ArtIndex, type ArtIndexEntry } from '../src/world/art';
import { chooseBuildingVariants } from '../src/world/building-variants';
import type { CityBuilding } from '../src/world/city-layout';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

/* A home on a 4x4 lot at (col, row), its house standing at the lot's front corner. */
function home(id: string, col: number, row: number, level = 1, placedAtStep = 0): CityBuilding {
  const span = level >= 4 ? 3 : 2;
  return {
    id,
    kind: 'house',
    label: id,
    col: col + 4 - span,
    row: row + 4 - span,
    spanCol: span,
    spanRow: span,
    lot: { col, row, spanCol: 4, spanRow: 4 },
    door: { col: col + 4, row: row + 3 },
    stage: 1,
    maxStage: 10,
    floors: 1,
    level,
    residentIds: [],
    mergedFromIds: [],
    goalCount: 0,
    placedAtStep,
  };
}

/* A street of homes on 4x4 lots with one-tile lanes between them, rows of `perRow`. */
function street(n: number, perRow = 5, level = 1): CityBuilding[] {
  return Array.from({ length: n }, (_, i) => home(`house-agent-${i + 1}`, 40 + (i % perRow) * 5, 40 + Math.floor(i / perRow) * 5, level, i));
}

const byStep = (count: number) => (b: CityBuilding) => (b.kind === 'house' ? { key: `house/${b.spanCol}`, count } : null);

function neighbours(a: CityBuilding, b: CityBuilding): boolean {
  const gapC = Math.max(b.lot.col - (a.lot.col + a.lot.spanCol), a.lot.col - (b.lot.col + b.lot.spanCol));
  const gapR = Math.max(b.lot.row - (a.lot.row + a.lot.spanRow), a.lot.row - (b.lot.row + b.lot.spanRow));
  return a.id !== b.id && gapC <= 1 && gapR <= 1;
}

describe('Drawn variants of a building step (#1975)', () => {
  it('gives every home the same variant on two loads, whatever order the city lists its buildings in', () => {
    const first = chooseBuildingVariants(street(20), byStep(15));
    const second = chooseBuildingVariants([...street(20)].reverse(), byStep(15));
    expect(first.size).toBe(20);
    expect([...second.entries()].sort()).toEqual([...first.entries()].sort());
    for (const v of first.values()) expect(v >= 0 && v < 15).toBe(true);
  });

  it('never repeats a variant next door while another one is free, and uses more than one', () => {
    const homes = street(25);
    const chosen = chooseBuildingVariants(homes, byStep(15));
    for (const a of homes) for (const b of homes) if (neighbours(a, b)) expect(chosen.get(a.id), `${a.id} ${b.id}`).not.toBe(chosen.get(b.id));
    expect(new Set(chosen.values()).size).toBeGreaterThan(5);
  });

  it('keeps an older home as it is when a newer one is built next door', () => {
    const homes = street(9, 3);
    const before = chooseBuildingVariants(homes, byStep(4));
    const after = chooseBuildingVariants([...homes, home('house-agent-new', 40 + 3 * 5, 40, 1, 99)], byStep(4));
    for (const h of homes) expect(after.get(h.id), h.id).toBe(before.get(h.id));
  });

  it('gives every home the only variant when a step has one, and leaves kinds without variants out', () => {
    const chosen = chooseBuildingVariants(street(6), byStep(1));
    expect([...chosen.values()]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(chooseBuildingVariants(street(3), () => null).size).toBe(0);
  });
});

describe('Variant folders in the art (#1975)', () => {
  const corners = { top: { x: 240, y: 439 }, right: { x: 480, y: 559 }, bottom: { x: 240, y: 679 }, left: { x: 0, y: 559 } };
  const picture: ArtIndexEntry = { w: 480, h: 680, passport: { groundAnchor: { x: 240, y: 559 }, corners } };
  const index = (variants: readonly string[]): ArtIndex => ({
    contract: 2,
    pack: 'egypt',
    files: Object.fromEntries(variants.map(v => [`buildings/house/hut/${v}/complete.png`, picture])),
  });
  const hut = home('house-agent-7', 40, 40, 1);

  it('declares the pack’s house variants: v01 of each step required, the others optional', () => {
    const files = declaredArtFiles(EGYPT_WORLD_PACK);
    const hutComplete = files.filter(f => /^buildings\/house\/hut\/v\d\d\/complete\.png$/.test(f.path));
    expect(hutComplete.map(f => f.path)).toHaveLength(15);
    expect(hutComplete.filter(f => f.required).map(f => f.path)).toEqual(['buildings/house/hut/v01/complete.png']);
    expect(files.some(f => f.path === 'buildings/house/hut/complete.png')).toBe(false);
    expect(variantStepOf(EGYPT_WORLD_PACK, hut)).toEqual({ key: 'house/hut', count: 15 });
    expect(variantStepOf(EGYPT_WORLD_PACK, { ...hut, kind: 'district_hub', stage: 1 })).toBeNull();
  });

  it('draws the chosen variant, the next delivered one when it is missing, and nothing without art', () => {
    const path = (art: ReturnType<typeof resolveBuildingArt>) => art?.layers[0]?.path ?? null;
    expect(path(resolveBuildingArt(EGYPT_WORLD_PACK, index(['v01', 'v03', 'v04']), hut, null, { variant: 2 }))).toBe('buildings/house/hut/v03/complete.png');
    expect(path(resolveBuildingArt(EGYPT_WORLD_PACK, index(['v01', 'v03', 'v04']), hut, null, { variant: 1 }))).toBe('buildings/house/hut/v03/complete.png');
    expect(path(resolveBuildingArt(EGYPT_WORLD_PACK, index(['v01', 'v03']), hut, null, { variant: 13 }))).toBe('buildings/house/hut/v01/complete.png');
    expect(path(resolveBuildingArt(EGYPT_WORLD_PACK, index(['v01']), hut, null))).toBe('buildings/house/hut/v01/complete.png');
    expect(resolveBuildingArt(EGYPT_WORLD_PACK, index([]), hut, null, { variant: 0 })).toBeNull();
  });
});
