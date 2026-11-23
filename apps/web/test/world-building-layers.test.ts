import { Matrix, type Sprite } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { resolveBuildingArt, validateArtIndex, type ArtIndex, type BuildingPicturePassport } from '../src/world/art';
import type { CityBuilding } from '../src/world/city-layout';
import { swayBuildingLayers, type SwayingLayer } from '../src/world/city-renderer';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

/* A sprite stand-in that keeps the last matrix the wind pass gave it. */
function fakeSprite(): { sprite: Sprite; matrix: () => Matrix } {
  let last = new Matrix();
  const sprite = { destroyed: false, setFromMatrix: (m: Matrix) => (last = m.clone()) } as unknown as Sprite;
  return { sprite, matrix: () => last };
}

describe('Building layers over a picture (contract 2)', () => {
  it('sways a layer about its fixed line: the line stays put, the free edge lifts and drops with the wind', () => {
    const { sprite, matrix } = fakeSprite();
    /* The awning's fixed line of the delivered workshop, and its normal toward the free (lower) side. */
    const a = { x: 210, y: 542 };
    const b = { x: 426, y: 650 };
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const layer: SwayingLayer = { sprite, scale: 0.25, originX: 100, originY: 200, ax: a.x, ay: a.y, nx: -(b.y - a.y) / len, ny: (b.x - a.x) / len, amplitude: 0.03, phase: 0 };
    const free = { x: 260, y: 860 };
    const ys: number[] = [];
    for (let t = 0; t < 4; t += 0.1) {
      swayBuildingLayers([layer], t);
      const m = matrix();
      for (const p of [a, b, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }]) {
        const w = m.apply(p);
        expect(w.x).toBeCloseTo(100 + p.x * 0.25, 6);
        expect(w.y).toBeCloseTo(200 + p.y * 0.25, 6);
      }
      const f = m.apply(free);
      expect(f.x).toBeCloseTo(100 + free.x * 0.25, 6);
      ys.push(f.y - (200 + free.y * 0.25));
    }
    const dist = layer.nx * (free.x - a.x) + layer.ny * (free.y - a.y);
    /* Up and down, never more than the amplitude allows at that distance from the line. */
    expect(Math.max(...ys)).toBeGreaterThan(0.5);
    expect(Math.min(...ys)).toBeLessThan(-0.5);
    for (const dy of ys) expect(Math.abs(dy)).toBeLessThanOrEqual(0.03 * dist * 0.25 + 1e-9);
  });

  it('draws a home with a yard as the pilot passport orders its layers: the house, its shadow, the yard fence (props), then the swaying awning', () => {
    const at = 'buildings/house/mudbrick/v01/';
    const corners = { top: { x: 360, y: 599 }, right: { x: 720, y: 779 }, bottom: { x: 360, y: 959 }, left: { x: 0, y: 779 } };
    const layers = [
      { file: 'shadow.png', blend: 'multiply' as const },
      { file: 'props.png' },
      { file: 'awning.png', sway: { pivot: [{ x: 378, y: 680 }, { x: 503, y: 618 }] as const } },
    ];
    const index: ArtIndex = {
      contract: 2,
      pack: 'egypt',
      files: {
        [`${at}complete.png`]: { w: 720, h: 960, passport: { groundAnchor: { x: 360, y: 779 }, corners, layers } },
        [`${at}shadow.png`]: { w: 720, h: 960 },
        [`${at}props.png`]: { w: 720, h: 960 },
        [`${at}awning.png`]: { w: 720, h: 960 },
      },
    };
    const report = validateArtIndex(EGYPT_WORLD_PACK, index);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
    const house = {
      id: 'h1', kind: 'house', label: 'h1', col: 40, row: 40, spanCol: 3, spanRow: 3, lot: { col: 39, row: 39, spanCol: 4, spanRow: 4 },
      door: { col: 43, row: 42 }, stage: 10, maxStage: 10, floors: 1, level: 5, residentIds: [], mergedFromIds: [], goalCount: 0, placedAtStep: 0,
    } as CityBuilding;
    const art = resolveBuildingArt(EGYPT_WORLD_PACK, index, house, null)!;
    expect(art.layers.map(l => l.path)).toEqual([`${at}complete.png`, `${at}shadow.png`, `${at}props.png`, `${at}awning.png`]);
    expect(art.layers.map(l => l.blend ?? null)).toEqual([null, 'multiply', null, null]);
    expect(art.layers.map(l => Boolean(l.sway))).toEqual([false, false, false, true]);
  });

  it('refuses layers missing from the folder, of another canvas, or with a broken sway line', () => {
    const at = 'buildings/district_hub/workshop/';
    const picture = (layers: unknown) => ({
      w: 720,
      h: 960,
      passport: {
        groundAnchor: { x: 360, y: 779 },
        corners: { top: { x: 360, y: 599 }, right: { x: 720, y: 779 }, bottom: { x: 360, y: 959 }, left: { x: 0, y: 779 } },
        /* Deliberately loose: the check must refuse what a careless passport holds. */
        layers: layers as BuildingPicturePassport['layers'],
      },
    });
    const index = (files: ArtIndex['files']): ArtIndex => ({ contract: 2, pack: 'egypt', files });
    const ok = validateArtIndex(
      EGYPT_WORLD_PACK,
      index({
        [`${at}complete.png`]: picture([{ file: 'shadow.png', blend: 'multiply' }, { file: 'awning.png', sway: { pivot: [{ x: 210, y: 542 }, { x: 426, y: 650 }] } }]),
        [`${at}shadow.png`]: { w: 720, h: 960 },
        [`${at}awning.png`]: { w: 720, h: 960 },
      }),
    );
    expect(ok.errors).toEqual([]);
    expect(ok.warnings).toEqual([]);

    const bad = validateArtIndex(
      EGYPT_WORLD_PACK,
      index({
        [`${at}complete.png`]: picture([
          { file: 'shadow.png', blend: 'screen' },
          { file: 'gone.png' },
          { file: 'awning.png', sway: { pivot: [{ x: 210, y: 542 }, { x: 210, y: 542 }] } },
          { file: '../escape.png' },
        ]),
        [`${at}shadow.png`]: { w: 700, h: 960 },
        [`${at}awning.png`]: { w: 720, h: 960 },
      }),
    );
    expect(bad.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('shadow.png blend must be multiply'),
        expect.stringContaining('layer gone.png is not in the folder'),
        expect.stringContaining('shadow.png: a layer must be the same size'),
        expect.stringContaining('sway pivot points must differ'),
        expect.stringContaining('every layer needs a file'),
      ]),
    );
  });
});
