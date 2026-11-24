import { describe, expect, it } from 'vitest';
import { CLOTH_SWAY_PX, resolveBuildingArt, validateArtIndex, type ArtIndex, type BuildingPicturePassport } from '../src/world/art';
import type { CityBuilding } from '../src/world/city-layout';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

describe('Building layers over a picture (contract 2)', () => {
  it('draws a home with a yard as the pilot passport orders its layers: the house, its shadow, the yard fence (props), then the awning, swaying by its cloth mask alone', () => {
    const at = 'buildings/house/mudbrick/v01/';
    const corners = { top: { x: 360, y: 599 }, right: { x: 720, y: 779 }, bottom: { x: 360, y: 959 }, left: { x: 0, y: 779 } };
    const layers = [
      { file: 'shadow.png', blend: 'multiply' as const },
      { file: 'props.png' },
      { file: 'awning.png' },
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
    /* No cloth mask beside the awning: nothing sways, the posts in it least of all (#1983). */
    expect(art.layers.map(l => Boolean(l.sway))).toEqual([false, false, false, false]);

    /* With awning_w.png beside it the awning sways by that mask, a little, or by the amplitude its own passport names. */
    const masked: ArtIndex = { ...index, files: { ...index.files, [`${at}awning_w.png`]: { w: 720, h: 960 } } };
    expect(validateArtIndex(EGYPT_WORLD_PACK, masked)).toMatchObject({ errors: [], warnings: [] });
    expect(resolveBuildingArt(EGYPT_WORLD_PACK, masked, house, null)!.layers.map(l => l.sway ?? null)).toEqual([
      null,
      null,
      null,
      { mask: `${at}awning_w.png`, amplitude: CLOTH_SWAY_PX },
    ]);
    const own: ArtIndex = { ...masked, files: { ...masked.files, [`${at}awning.png`]: { w: 720, h: 960, passport: { amplitude: 5 } as never } } };
    expect(resolveBuildingArt(EGYPT_WORLD_PACK, own, house, null)!.layers[3]!.sway).toEqual({ mask: `${at}awning_w.png`, amplitude: 5 });
  });

  it('refuses layers missing from the folder or of another canvas, a cloth mask of another size and a large amplitude', () => {
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
        [`${at}complete.png`]: picture([{ file: 'shadow.png', blend: 'multiply' }, { file: 'awning.png' }]),
        [`${at}shadow.png`]: { w: 720, h: 960 },
        [`${at}awning.png`]: { w: 720, h: 960, passport: { amplitude: 4 } as never },
        [`${at}awning_w.png`]: { w: 720, h: 960 },
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
          { file: 'awning.png' },
          { file: '../escape.png' },
        ]),
        [`${at}shadow.png`]: { w: 700, h: 960 },
        [`${at}awning.png`]: { w: 720, h: 960, passport: { amplitude: 40 } as never },
        [`${at}awning_w.png`]: { w: 360, h: 480 },
      }),
    );
    expect(bad.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('shadow.png blend must be multiply'),
        expect.stringContaining('layer gone.png is not in the folder'),
        expect.stringContaining('shadow.png: a layer must be the same size'),
        expect.stringContaining('awning_w.png: a cloth mask must be the same size'),
        expect.stringContaining('awning.png: amplitude must be above 0 and at most 8 px'),
        expect.stringContaining('every layer needs a file'),
      ]),
    );
  });
});
