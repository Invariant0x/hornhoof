import { describe, expect, it } from 'vitest';
import { createDrawList, ITEM_STRIDE, PlantLayout, shadowDirection, SHADOW_DOWNSCALE } from '../src/world/plant-layer';
import type { PlantSpriteInfo } from '../src/world/plant-sprites';
import { generatePlants } from '../src/world/plants';
import { generateWorldTerrain } from '../src/world/terrain-engine';
import type { WorldPackManifest } from '../src/world/manifest';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

/* Pictures are not needed to check the layout: a fake atlas gives every variant a trunk, a crown and a shadow frame. */
function fakeSprites(pack: WorldPackManifest): PlantSpriteInfo[][] {
  return (pack.plants ?? []).map((k, ki) =>
    Array.from({ length: k.variants }, (_, v): PlantSpriteInfo => {
      const two = k.shape === 'fronded_tree' || k.shape === 'broad_tree';
      const base = (ki * 10 + v) * 3;
      return {
        base: { frame: base, pivotX: 20, pivotY: 200 },
        crown: two ? { frame: base + 1, pivotX: 100, pivotY: 60 } : undefined,
        shadow: { frame: base + 2, pivotX: 40, pivotY: 90 },
        hubX: two ? 4 : 0,
        hubY: two ? -150 : 0,
        heightPx: 200,
        passport: { rootPoint: [20, 200], crownCenter: [24, 40], crownHub: [24, 50], heightPx: 200, crownWidthPx: 120 },
      };
    }),
  );
}

const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: 'hornhoof', mapSize: EGYPT_WORLD_PACK.mapSize });
const field = generatePlants(EGYPT_WORLD_PACK, map);
const sprites = fakeSprites(EGYPT_WORLD_PACK);
const layout = new PlantLayout({ pack: EGYPT_WORLD_PACK, field, sprites, lighting: EGYPT_WORLD_PACK.lighting });

const anchor = field.plants[Math.floor(field.plants.length / 2)]!;
const VIEW = { minX: anchor.x - 500, maxX: anchor.x + 500, minY: anchor.y - 300, maxY: anchor.y + 300 };

function itemAt(list: ReturnType<typeof createDrawList>, i: number) {
  const o = i * ITEM_STRIDE;
  const [frame, a, b, c, d, tx, ty] = Array.from(list.data.slice(o, o + ITEM_STRIDE));
  return { frame: frame!, a: a!, b: b!, c: c!, d: d!, tx: tx!, ty: ty! };
}

describe('plant layer layout', () => {
  it('casts shadows toward the lower right, away from a sun at the upper left', () => {
    const dir = shadowDirection(EGYPT_WORLD_PACK.projection.sun.azimuthDeg);
    expect(dir.x).toBeGreaterThan(0.3);
    expect(dir.y).toBeGreaterThan(0.1);
    /* The 2:1 ground squashes the vertical share of the shadow. */
    expect(dir.y).toBeLessThan(dir.x + 1e-9);

    const list = createDrawList();
    layout.build(VIEW, 3, list);
    expect(list.shadowCount).toBeGreaterThan(0);
    for (let i = 0; i < Math.min(list.shadowCount, 40); i++) {
      const s = itemAt(list, i);
      /* The shadow picture's tip (its top row, 90 px above the root pivot) lands right of and below the root. */
      const rootX = s.a * 40 + s.c * 90 + s.tx;
      const tipX = s.a * 40 + s.c * 0 + s.tx;
      const rootY = s.b * 40 + s.d * 90 + s.ty;
      const tipY = s.b * 40 + s.d * 0 + s.ty;
      expect(tipX).toBeGreaterThan(rootX);
      expect(tipY).toBeGreaterThan(rootY);
    }
  });

  it('puts every shadow before every plant so a shadow never covers a plant', () => {
    const list = createDrawList();
    const inView = layout.build(VIEW, 3, list);
    expect(inView).toBeGreaterThan(5);
    expect(list.count).toBeGreaterThan(list.shadowCount);
    const shadowFrames = new Set<number>();
    for (let i = 0; i < list.shadowCount; i++) shadowFrames.add(itemAt(list, i).frame);
    for (let i = list.shadowCount; i < list.count; i++) expect(itemAt(list, i).frame % 3).not.toBe(2);
    for (const f of shadowFrames) expect(f % 3).toBe(2);
  });

  it('draws plants back to front by their root y', () => {
    const list = createDrawList();
    layout.build(VIEW, 3, list);
    const roots: number[] = [];
    for (let i = list.shadowCount; i < list.count; i++) {
      const it = itemAt(list, i);
      /* Trunks and single-part plants have pivot (20, 200): their root y is the translation plus d * 200. */
      if (it.frame % 3 === 0) roots.push(it.ty + it.d * 200);
    }
    expect(roots.length).toBeGreaterThan(5);
    for (let i = 1; i < roots.length; i++) expect(roots[i]!).toBeGreaterThanOrEqual(roots[i - 1]! - 1e-6);
  });

  it('bends and flutters the plants as time passes, and shrinks the work to the view', () => {
    const a = createDrawList();
    const b = createDrawList();
    layout.build(VIEW, 1, a);
    layout.build(VIEW, 2.5, b);
    expect(b.count).toBe(a.count);
    let changed = 0;
    for (let i = a.shadowCount; i < a.count; i++) {
      const x = itemAt(a, i);
      const y = itemAt(b, i);
      if (Math.abs(x.c - y.c) > 1e-4 || Math.abs(x.b - y.b) > 1e-4) changed++;
    }
    expect(changed).toBeGreaterThan((a.count - a.shadowCount) * 0.8);

    const tiny = createDrawList();
    const none = layout.build({ minX: anchor.x - 20, maxX: anchor.x + 20, minY: anchor.y - 20, maxY: anchor.y + 20 }, 1, tiny);
    expect(none).toBeLessThan(field.plants.length / 20);
  });

  it('draws no shadows for a pack without lighting and nothing for a pack without plants', () => {
    const dark = new PlantLayout({ pack: EGYPT_WORLD_PACK, field, sprites });
    const list = createDrawList();
    dark.build(VIEW, 1, list);
    expect(list.shadowCount).toBe(0);
    expect(list.count).toBeGreaterThan(0);

    const bare = new PlantLayout({ pack: { ...EGYPT_WORLD_PACK, plants: undefined }, field: { plants: [], countsByKind: [], maxHeightPx: 0 }, sprites: [] });
    const empty = createDrawList();
    expect(bare.build(VIEW, 1, empty)).toBe(0);
    expect(empty.count).toBe(0);
  });

  it('scales the downsampled shadow picture back up', () => {
    expect(SHADOW_DOWNSCALE).toBe(3);
  });
});
