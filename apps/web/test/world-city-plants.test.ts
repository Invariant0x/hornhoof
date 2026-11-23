import { describe, expect, it } from 'vitest';
import { cityDepthY, cityPlantCover, placeBuilding, tileKey, type CityBuilding } from '../src/world/city-layout';
import { createHornhoofLiveFixture, syncLiveSnapshotToCity } from '../src/world/live-sync';
import { clearPlantsFromCity, generatePlants } from '../src/world/plants';
import { generateWorldTerrain } from '../src/world/terrain-engine';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

const TILE_H = EGYPT_WORLD_PACK.projection.defaultTileH;

describe('The painted map under the city', () => {
  it('keeps plants off every footprint, street and wall of the live city and leaves the rest where they grew', () => {
    const live = createHornhoofLiveFixture();
    const map = generateWorldTerrain(EGYPT_WORLD_PACK, { seed: live.company.seed, mapSize: 150 });
    const { city } = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, map, live);
    const field = generatePlants(EGYPT_WORLD_PACK, map);
    const cover = cityPlantCover(city);
    const cleared = clearPlantsFromCity(field, cover);

    const onCity = (col: number, row: number): boolean => {
      const k = tileKey(Math.floor(col), Math.floor(row));
      return city.footprintOccupant.has(k) || city.roads.has(k) || city.wallTiles.has(k);
    };
    const before = field.plants.filter(p => onCity(p.col, p.row)).length;
    expect(before, 'the live city stands where plants grow').toBeGreaterThan(20);
    expect(cleared.plants.filter(p => onCity(p.col, p.row))).toEqual([]);
    /* Off the city nothing moves: the same plants in the same order. */
    expect(cleared.plants).toEqual(field.plants.filter(p => !cover(p.col, p.row)));
    expect(cleared.plants.length).toBeGreaterThan(field.plants.length * 0.5);
    expect(cleared.countsByKind.reduce((a, b) => a + b, 0)).toBe(cleared.plants.length);

    /* A building placed later clears the plants on its own tiles. */
    const placed = placeBuilding(city, { id: 'later', kind: 'supply' }, map)!;
    const again = clearPlantsFromCity(field, cityPlantCover(city));
    const onPlaced = (p: { col: number; row: number }): boolean =>
      p.col >= placed.col && p.col < placed.col + placed.spanCol && p.row >= placed.row && p.row < placed.row + placed.spanRow;
    expect(again.plants.filter(onPlaced)).toEqual([]);
  });

  it('gives every building a depth that puts what stands in front of its front walls after it and what stands behind it before it', () => {
    const ys = (col: number, row: number): number => (col + row) * (TILE_H / 2);
    let checked = 0;
    for (const span of [1, 2, 3, 4, 5, 6]) {
      const b = { col: 20, row: 30, spanCol: span, spanRow: span } as CityBuilding;
      const depth = cityDepthY(b, TILE_H);
      for (let i = 0; i <= 40; i++) {
        for (let j = 0; j <= 40; j++) {
          const col = b.col - 3 + (i / 40) * (span + 6);
          const row = b.row - 3 + (j / 40) * (span + 6);
          const inside = col > b.col && col < b.col + span && row > b.row && row < b.row + span;
          if (inside) continue;
          const inFront =
            (col > b.col + span && row > b.row) || (row > b.row + span && col > b.col);
          const behind = (col < b.col && row < b.row + span) || (row < b.row && col < b.col + span);
          if (inFront) {
            expect(ys(col, row), `in front of ${span}x${span} at ${col},${row}`).toBeGreaterThan(depth);
            checked++;
          } else if (behind) {
            expect(ys(col, row), `behind ${span}x${span} at ${col},${row}`).toBeLessThan(depth);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });
});
