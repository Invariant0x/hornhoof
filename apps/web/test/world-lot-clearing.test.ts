/* Cleared ground under building lots (#1958, Ivan's word of 23.11.2026), for every theme pack: on a lot there are no
   fields, grass or plants, only the pack's lot ground; its edge eases into the land around; the clearing comes with the
   first construction stage and stays after a demolition until the lot is built on again or the pack's regrowth time
   has passed, and plants stay off it all that time. */

import type { WorldLiveSnapshot } from '@hornhoof/protocol/world';
import { describe, expect, it } from 'vitest';
import { cityPlantCover, type CityBuilding, type CityState } from '../src/world/city-layout';
import { canRelocateBuildingTo, createHornhoofLiveFixture, syncLiveSnapshotToCity } from '../src/world/live-sync';
import { cityLotClearing, lotClearingAt, type LotClearing } from '../src/world/lot-clearing';
import { DEFAULT_ISOMETRIC_PROJECTION, validateWorldPack, type WorldPackManifest } from '../src/world/manifest';
import { clearPlantsFromCity, generatePlants } from '../src/world/plants';
import { groundMixAt } from '../src/world/smooth-terrain-baker';
import { registerTerrainArt, type LoadedTerrainArt } from '../src/world/terrain-art';
import { generateWorldTerrain, type GeneratedWorldMap } from '../src/world/terrain-engine';
import { registeredWorldPacks } from '../src/world-packs/registry';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

const HOUR_MS = 3_600_000;
/* One screen pixel at 100% along a tile axis, in tiles. */
const PX = 1 / Math.hypot(DEFAULT_ISOMETRIC_PROJECTION.defaultTileW / 2, DEFAULT_ISOMETRIC_PROJECTION.defaultTileH / 2);

type Built = Readonly<{ pack: WorldPackManifest; map: GeneratedWorldMap; city: CityState; live: WorldLiveSnapshot }>;

const built = new Map<string, Built>();
function liveCity(pack: WorldPackManifest): Built {
  let hit = built.get(pack.id);
  if (!hit) {
    const live = createHornhoofLiveFixture();
    const map = generateWorldTerrain(pack, { seed: live.company.seed, mapSize: pack.mapSize });
    hit = { pack, map, city: syncLiveSnapshotToCity(pack, map, live).city, live };
    built.set(pack.id, hit);
  }
  return hit;
}

function clearingOf(pack: WorldPackManifest, city: CityState): LotClearing {
  const clearing = cityLotClearing(city, pack);
  if (!clearing) throw new Error(`${pack.id} clears no lots`);
  return clearing;
}

/* Painted ground as an artist delivers it: a flat picture per ground and a ragged edge mask between any two. */
function paintedGround(): LoadedTerrainArt {
  const w = 64;
  const h = 256;
  const mask = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const line = h / 2 + 14 * Math.sin((x / w) * Math.PI * 6) + 6 * Math.sin((x / w) * Math.PI * 14);
      const value = Math.max(0, Math.min(255, (line - y) * 64 + 128));
      mask.set([value, value, value, 255], (y * w + x) * 4);
    }
  }
  const flat = new Uint8ClampedArray(16 * 16 * 4).fill(200);
  const ids = EGYPT_WORLD_PACK.terrainRecipe!.materialIds;
  return {
    ground: new Map(ids.map(id => [id, { data: flat, width: 16, height: 16 }] as const)),
    texelsPerTile: 256,
    edges: new Map(),
    defaultEdge: { data: mask, width: w, height: h },
    shoreEdge: null,
    liquid: null,
    pathStrip: null,
    plants: new Map(),
  };
}

/* Points spread over a lot, its corners and edges included. */
function pointsOn(b: Pick<CityBuilding, 'col' | 'row' | 'spanCol' | 'spanRow'>): { u: number; v: number }[] {
  const out: { u: number; v: number }[] = [];
  for (let j = 0; j <= 4; j++) {
    for (let i = 0; i <= 4; i++) out.push({ u: b.col + (b.spanCol * i) / 4, v: b.row + (b.spanRow * j) / 4 });
  }
  return out;
}

function lotGroundShare(pack: WorldPackManifest, map: GeneratedWorldMap, clearing: LotClearing | null, u: number, v: number): number {
  const lot = map.cornerFields.materialIds.indexOf(pack.lotGround!.material);
  const mix = groundMixAt(map, pack, u, v, clearing);
  return (mix.a === lot ? mix.shareA : 0) + (mix.b === lot && mix.b !== mix.a ? 1 - mix.shareA : 0);
}

/* The live fixture with one house moved: the relocation the server keeps, accepted at `resolvedAt`, seen at `now`. */
function withMovedHouse(base: Built, resolvedAt: string, now: string): { snapshot: WorldLiveSnapshot; from: CityBuilding } {
  const house = base.city.buildings.find(b => b.kind === 'house' && b.entityId)!;
  let to: { col: number; row: number } | null = null;
  outer: for (let dr = -18; dr <= 18; dr++) {
    for (let dc = -18; dc <= 18; dc++) {
      if (Math.hypot(dc, dr) < 6) continue;
      if (canRelocateBuildingTo(base.city, base.map, house.id, house.col + dc, house.row + dr)) {
        to = { col: house.col + dc, row: house.row + dr };
        break outer;
      }
    }
  }
  if (!to) throw new Error('no free spot to move the house to');
  const snapshot: WorldLiveSnapshot = {
    ...base.live,
    generatedAt: now,
    relocations: [
      {
        id: 'rel-lot',
        buildingId: house.id,
        buildingKind: 'house',
        buildingLabel: house.label,
        fromCol: house.col,
        fromRow: house.row,
        toCol: to.col,
        toRow: to.row,
        taskId: 'task-lot',
        taskNumber: 1958,
        taskStatus: 'done',
        assigneeAgentId: house.entityId!,
        departmentId: house.departmentId ?? null,
        status: 'applied',
        createdAt: '2026-11-21T10:00:00Z',
        resolvedAt,
      },
    ],
  };
  return { snapshot, from: { ...house } };
}

describe('Cleared ground under building lots', () => {
  it('every theme pack names a lot ground of its own set that is no field and no grass, with a soft edge and a regrowth time', () => {
    const packs = registeredWorldPacks();
    expect(packs.length).toBeGreaterThanOrEqual(3);
    for (const pack of packs) {
      expect(validateWorldPack(pack), pack.id).toEqual({ ok: true });
      const spec = pack.lotGround;
      expect(spec, `${pack.id}: lot ground`).toBeDefined();
      const material = pack.materials?.find(m => m.id === spec!.material);
      expect(material, `${pack.id}: ${spec!.material} is one of its grounds`).toBeDefined();
      expect(material!.plots, `${pack.id}: no tilled plots on a lot`).toBeUndefined();
      expect(['grass_tufts', 'crop_rows', 'furrows'], `${pack.id}: no grass or crops on a lot`).not.toContain(material!.pattern);
      expect(spec!.edgeTiles).toBeGreaterThan(0);
      expect(spec!.regrowthHours).toBeGreaterThan(0);
    }
    const broken = { ...EGYPT_WORLD_PACK, lotGround: { ...EGYPT_WORLD_PACK.lotGround!, material: 'nowhere' } };
    const verdict = validateWorldPack(broken);
    expect(verdict.ok ? [] : verdict.errors).toContain('lotGround references material "nowhere" the ground does not blend');
  });

  it('draws only the lot ground on every lot of the live city in every theme pack, and no plant stands on one', () => {
    for (const pack of registeredWorldPacks()) {
      const { map, city } = liveCity(pack);
      const clearing = clearingOf(pack, city);
      const lots = city.buildings.filter(b => b.stage >= 1);
      expect(lots.length, pack.id).toBeGreaterThan(20);
      let natural = 0;
      for (const b of lots) {
        for (const p of pointsOn(b)) {
          expect(lotClearingAt(clearing, p.u, p.v), `${pack.id} ${b.id}`).toBe(1);
          expect(lotGroundShare(pack, map, clearing, p.u, p.v), `${pack.id} ${b.id} at ${p.u},${p.v}`).toBe(1);
          if (lotGroundShare(pack, map, null, p.u, p.v) < 1) natural++;
        }
      }
      /* Without the clearing the land under the lots would show: the check is not empty. */
      expect(natural, `${pack.id}: other ground under the lots before clearing`).toBeGreaterThan(50);

      const plants = clearPlantsFromCity(generatePlants(pack, map), cityPlantCover(city)).plants;
      const onLot = plants.filter(p => lots.some(b => p.col >= b.col && p.col <= b.col + b.spanCol && p.row >= b.row && p.row <= b.row + b.spanRow));
      expect(onLot, pack.id).toEqual([]);
    }
  });

  it('eases the lot ground into the land around over its edge, with no step at the lot line', () => {
    for (const pack of registeredWorldPacks()) {
      const { map, city } = liveCity(pack);
      const clearing = clearingOf(pack, city);
      const edge = pack.lotGround!.edgeTiles;
      const b = city.buildings.find(x => x.stage >= 1 && x.spanCol >= 2)!;
      /* Walk out of the lot's middle through its front right side, one screen pixel at a time. */
      const mid = b.row + b.spanRow / 2;
      let prev = 1;
      let biggestStep = 0;
      let firstBelowOne = Infinity;
      for (let d = 0; d <= edge + 0.5; d += PX) {
        const share = lotClearingAt(clearing, b.col + b.spanCol + d, mid);
        expect(share, `${pack.id} at ${d.toFixed(3)} tiles out`).toBeLessThanOrEqual(prev + 1e-9);
        biggestStep = Math.max(biggestStep, prev - share);
        if (share < 1) firstBelowOne = Math.min(firstBelowOne, d);
        prev = share;
      }
      expect(firstBelowOne, `${pack.id}: the lot itself is fully cleared`).toBeGreaterThan(0);
      expect(prev, `${pack.id}: no clearing beyond the edge`).toBe(0);
      /* Soft: the share falls by at most a tenth from one pixel to the next. */
      expect(biggestStep, pack.id).toBeLessThanOrEqual(0.1);
      expect(edge / PX, `${pack.id}: edge in pixels at 100%`).toBeGreaterThanOrEqual(16);
      void map;
    }
  });

  /* Where the lot ground gives way to the land, along one side of a lot: no ruler line on the footprint's edge, but a
     ragged line outside it that wanders over several pixels, drawn procedurally and with painted art alike. */
  it('draws the edge of the baked lot ground ragged outside the lot, with no straight step along the footprint', () => {
    const crossings = (pack: WorldPackManifest, map: GeneratedWorldMap, clearing: LotClearing, b: CityBuilding): number[] => {
      const out: number[] = [];
      for (let k = 0; k < 40; k++) {
        const v = b.row + ((k + 0.5) / 40) * b.spanRow;
        for (let d = 0; d <= clearing.edge + 0.3; d += PX) {
          if (lotGroundShare(pack, map, clearing, b.col + b.spanCol + d, v) < 0.5) {
            out.push(d);
            break;
          }
        }
      }
      return out;
    };
    const check = (pack: WorldPackManifest, label: string) => {
      const { map, city } = liveCity(pack);
      const clearing = clearingOf(pack, city);
      const sides = city.buildings
        .filter(b => b.stage >= 1)
        .map(b => crossings(pack, map, clearing, b))
        .filter(c => c.length >= 32);
      expect(sides.length, `${label}: lots that meet other ground`).toBeGreaterThan(2);
      /* The lot ground reaches past the footprint everywhere, so the edge never sits on the lot line. */
      for (const c of sides) expect(Math.min(...c), `${label}: the lot ground reaches past the lot`).toBeGreaterThan(0);
      /* On most sides the edge wanders by several pixels; a short side may run nearly straight for its one tile. */
      const wandering = sides.filter(c => Math.max(...c) - Math.min(...c) >= 4 * PX).length;
      expect(wandering / sides.length, `${label}: sides whose edge wanders`).toBeGreaterThanOrEqual(0.75);
    };
    for (const pack of registeredWorldPacks()) check(pack, pack.id);
    registerTerrainArt(EGYPT_WORLD_PACK, paintedGround());
    try {
      check(EGYPT_WORLD_PACK, 'egypt painted');
    } finally {
      registerTerrainArt(EGYPT_WORLD_PACK, null);
    }
  });

  it('clears a lot from its first construction stage, not before', () => {
    const base = liveCity(EGYPT_WORLD_PACK);
    const b = base.city.buildings.find(x => x.kind === 'statue') ?? base.city.buildings[0]!;
    const at = { u: b.col + b.spanCol / 2, v: b.row + b.spanRow / 2 };
    const city = (stage: number): CityState => ({ ...base.city, buildings: base.city.buildings.map(x => (x.id === b.id ? { ...x, stage } : x)) });
    expect(lotClearingAt(clearingOf(EGYPT_WORLD_PACK, city(0)), at.u, at.v)).toBe(0);
    expect(cityPlantCover(city(1))(at.u, at.v)).toBe(true);
    expect(lotClearingAt(clearingOf(EGYPT_WORLD_PACK, city(1)), at.u, at.v)).toBe(1);
  });

  it('keeps a lot a building left cleared, with no plants, until the pack regrowth time has passed', () => {
    const base = liveCity(EGYPT_WORLD_PACK);
    const regrowMs = EGYPT_WORLD_PACK.lotGround!.regrowthHours * HOUR_MS;
    const left = Date.parse('2026-11-22T08:00:00Z');
    const seen = (afterMs: number) => {
      const { snapshot, from } = withMovedHouse(base, new Date(left).toISOString(), new Date(left + afterMs).toISOString());
      const { city } = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, base.map, snapshot, null);
      expect(city.buildings.find(b => b.id === from.id)!.col, 'the house moved').not.toBe(from.col);
      return { city, from };
    };

    const soon = seen(regrowMs - 60_000);
    expect(soon.city.vacatedLots.map(l => ({ col: l.col, row: l.row }))).toEqual([{ col: soon.from.col, row: soon.from.row }]);
    const clearing = clearingOf(EGYPT_WORLD_PACK, soon.city);
    const cover = cityPlantCover(soon.city);
    for (const p of pointsOn(soon.from)) {
      expect(lotClearingAt(clearing, p.u, p.v)).toBe(1);
      expect(lotGroundShare(EGYPT_WORLD_PACK, base.map, clearing, p.u, p.v)).toBe(1);
      expect(cover(p.u, p.v), `plants stay off ${p.u},${p.v}`).toBe(true);
    }
    const wild = generatePlants(EGYPT_WORLD_PACK, base.map);
    const onOldLot = (p: { col: number; row: number }) =>
      p.col >= soon.from.col && p.col < soon.from.col + soon.from.spanCol && p.row >= soon.from.row && p.row < soon.from.row + soon.from.spanRow;
    expect(clearPlantsFromCity(wild, cover).plants.filter(onOldLot)).toEqual([]);

    const later = seen(regrowMs + 60_000);
    expect(later.city.vacatedLots).toEqual([]);
    const regrown = clearingOf(EGYPT_WORLD_PACK, later.city);
    const middle = { u: later.from.col + later.from.spanCol / 2, v: later.from.row + later.from.spanRow / 2 };
    expect(lotClearingAt(regrown, middle.u, middle.v)).toBe(0);
    /* Grown back: the wild plants of the old lot are there again. */
    const back = clearPlantsFromCity(wild, cityPlantCover(later.city)).plants.filter(onOldLot);
    expect(back).toEqual(wild.plants.filter(onOldLot));
  });

  it('drops the lot a building left as soon as another building stands on it', () => {
    const base = liveCity(EGYPT_WORLD_PACK);
    const left = Date.parse('2026-11-22T08:00:00Z');
    const { snapshot, from } = withMovedHouse(base, new Date(left).toISOString(), new Date(left + HOUR_MS).toISOString());
    const { city } = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, base.map, snapshot, null);
    expect(city.vacatedLots.length).toBe(1);
    const taken: CityState = {
      ...city,
      buildings: [...city.buildings, { ...city.buildings[0]!, id: 'newcomer', col: from.col, row: from.row, spanCol: 1, spanRow: 1, stage: 1 }],
    };
    expect(cityLotClearing(taken, EGYPT_WORLD_PACK)!.lots.filter(l => l.col === from.col && l.row === from.row && l.spanCol === from.spanCol)).toEqual([]);
  });
});
