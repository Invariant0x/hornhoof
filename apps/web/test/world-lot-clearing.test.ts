/* Cleared ground under building lots (#1958, Ivan's word of 23.11.2026), for every theme pack: on a lot there are no
   fields, grass or plants, only the pack's lot ground; its edge eases into the land around; the clearing comes with the
   first construction stage and stays after a demolition until the lot is built on again or the pack's regrowth time
   has passed, and plants stay off it all that time. */

import type { WorldLiveSnapshot } from '@hornhoof/protocol/world';
import { describe, expect, it } from 'vitest';
import { cityPlantCover, type CityBuilding, type CityState } from '../src/world/city-layout';
import { canRelocateBuildingTo, createHornhoofLiveFixture, syncLiveSnapshotToCity } from '../src/world/live-sync';
import { cityGround, cityGroundKey } from '../src/world/city-ground';
import { ChunkLotKeys, cityLotClearing, lotClearingAt, lotClearingNear, vacatedLotsFromRelocations, type LotClearing } from '../src/world/lot-clearing';
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
      /* A lot with no other lot beside its front right side for twice the edge, so only its own edge is walked. */
      const reach = 2 * edge + 1;
      const alone = (x: CityBuilding) =>
        ![...city.buildings.filter(o => o !== x), ...city.vacatedLots].some(
          o => o.col < x.col + x.spanCol + reach && o.col + o.spanCol > x.col + x.spanCol && o.row < x.row + x.spanRow / 2 + reach && o.row + o.spanRow > x.row + x.spanRow / 2 - reach,
        );
      const b = city.buildings.find(x => x.stage >= 1 && x.spanCol >= 2 && alone(x))!;
      expect(b, pack.id).toBeDefined();
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

describe('The rules and keys of cleared lots', () => {
  it('checks a pack lot ground: needed with blended grounds, one of them, an edge of up to two tiles, a positive regrowth time', () => {
    const errorsOf = (pack: WorldPackManifest) => {
      const verdict = validateWorldPack(pack);
      return verdict.ok ? [] : verdict.errors;
    };
    const spec = EGYPT_WORLD_PACK.lotGround!;
    expect(errorsOf({ ...EGYPT_WORLD_PACK, lotGround: undefined })).toContain('lotGround is required with smooth ground materials');
    expect(errorsOf({ ...EGYPT_WORLD_PACK, materials: undefined, lotGround: undefined })).not.toContain('lotGround is required with smooth ground materials');
    for (const edgeTiles of [0, 2.5]) expect(errorsOf({ ...EGYPT_WORLD_PACK, lotGround: { ...spec, edgeTiles } })).toContain('lotGround.edgeTiles must be in (0, 2]');
    expect(errorsOf({ ...EGYPT_WORLD_PACK, lotGround: { ...spec, edgeTiles: 2 } })).toEqual([]);
    expect(errorsOf({ ...EGYPT_WORLD_PACK, lotGround: { ...spec, regrowthHours: 0 } })).toContain('lotGround.regrowthHours must be positive');
    /* Without a recipe the pack's own grounds are the ones it blends. */
    expect(errorsOf({ ...EGYPT_WORLD_PACK, terrainRecipe: undefined })).not.toContain(`lotGround references material "${spec.material}" the ground does not blend`);
  });

  it('keeps no lot a building left in a pack with no lot ground', () => {
    const base = liveCity(EGYPT_WORLD_PACK);
    const left = Date.parse('2026-11-22T08:00:00Z');
    const { snapshot } = withMovedHouse(base, new Date(left).toISOString(), new Date(left + HOUR_MS).toISOString());
    const moved = syncLiveSnapshotToCity(EGYPT_WORLD_PACK, base.map, snapshot, null).city;
    const now = left + HOUR_MS;
    expect(vacatedLotsFromRelocations(snapshot.relocations, moved.buildings, EGYPT_WORLD_PACK.lotGround, now)).toHaveLength(1);
    expect(vacatedLotsFromRelocations(snapshot.relocations, moved.buildings, undefined, now)).toEqual([]);
  });

  it('finds the lots whose cleared edge reaches into an area, the edge widened by its wobble', () => {
    const clearing: LotClearing = { lots: [{ col: 10, row: 10, spanCol: 2, spanRow: 2 }, { col: 30, row: 30, spanCol: 1, spanRow: 1 }], edge: 0.5 };
    const near = lotClearingNear(clearing, { colStart: 12, colEnd: 16, rowStart: 8, rowEnd: 12 });
    expect(near?.lots).toEqual([clearing.lots[0]]);
    expect(near!.edge).toBeGreaterThan(clearing.edge);
    expect(lotClearingNear(clearing, { colStart: 13, colEnd: 16, rowStart: 8, rowEnd: 12 })).toBeNull();
    expect(lotClearingNear(clearing, { colStart: 0, colEnd: 9, rowStart: 0, rowEnd: 40 })).toBeNull();
    expect(lotClearingNear(clearing, { colStart: 20, colEnd: 40, rowStart: 31, rowEnd: 40 })?.lots).toEqual([clearing.lots[1]]);
  });

  it('keys a chunk picture by the lots reaching it, and finds the picture last baked under another clearing', () => {
    const chunk = { key: '0,0', colStart: 0, colEnd: 8, rowStart: 0, rowEnd: 8 };
    const far = { key: '2,2', colStart: 16, colEnd: 24, rowStart: 16, rowEnd: 24 };
    const keys = new ChunkLotKeys();
    expect(keys.keyOf(chunk)).toBe('');
    keys.reset({ lots: [{ col: 3, row: 4, spanCol: 2, spanRow: 1 }], edge: 0.4 });
    expect(keys.keyOf(chunk)).toBe('#3,4,2,1');
    expect(keys.keyOf(chunk), 'kept for the chunk').toBe('#3,4,2,1');
    expect(keys.keyOf(far)).toBe('');
    keys.reset({ lots: [{ col: 5, row: 4, spanCol: 2, spanRow: 1 }], edge: 0.4 });
    expect(keys.keyOf(chunk), 'worked out again under the new clearing').toBe('#5,4,2,1');

    const pictures = new Map([['0,0@lod1#3,4,2,1', 'old fine'], ['0,0@lod0#3,4,2,1', 'old coarse']]);
    keys.baked('0,0@lod0#3,4,2,1');
    keys.baked('0,0@lod1#3,4,2,1');
    expect(keys.lastBakedHit('0,0', ['lod0', 'lod1'], k => pictures.get(k))).toEqual({ key: '0,0@lod1#3,4,2,1', entry: 'old fine' });
    pictures.delete('0,0@lod1#3,4,2,1');
    expect(keys.lastBakedHit('0,0', ['lod0', 'lod1'], k => pictures.get(k)), 'one the cache dropped is passed over').toEqual({ key: '0,0@lod0#3,4,2,1', entry: 'old coarse' });
    expect(keys.lastBakedHit('2,2', ['lod0', 'lod1'], k => pictures.get(k))).toBeNull();
  });

  it('keys the city ground by its lots, and clears the surveyed plot of an empty lot with no plants on it', () => {
    const base = liveCity(EGYPT_WORLD_PACK);
    expect(cityGroundKey(null)).toBe('none');
    expect(cityGround(null, EGYPT_WORLD_PACK)).toEqual({ clearing: null, cover: null });
    const live = { city: base.city, worldMode: 'active' as const };
    const key = cityGroundKey(live);
    expect(cityGroundKey({ ...live }), 'the same ground, the same key').toBe(key);
    const b = base.city.buildings.find(x => x.stage >= 1)!;
    const unstarted = { ...live, city: { ...base.city, buildings: base.city.buildings.map(x => (x.id === b.id ? { ...x, stage: 0 } : x)) } };
    expect(cityGroundKey(unstarted), 'a lot before its first stage').not.toBe(key);
    /* The ground also carries the city's streets (#1985). */
    const streets = [...base.city.roads.values()].map(t => ({ col: t.col, row: t.row, tier: t.tier, bridge: t.bridge }));
    expect(cityGround(live, EGYPT_WORLD_PACK).clearing).toEqual({ ...cityLotClearing(base.city, EGYPT_WORLD_PACK), streets });
    const roads = new Map(base.city.roads);
    const [firstKey, first] = [...roads][0]!;
    roads.set(firstKey, { ...first, tier: first.tier === 'stone' ? 'dirt' : 'stone' });
    const upgraded = { ...live, city: { ...base.city, roads } };
    expect(cityGroundKey(upgraded), 'a street that changed its tier').not.toBe(key);

    const stakes = [{ col: 40, row: 40 }, { col: 43, row: 40 }, { col: 40, row: 42 }, { col: 43, row: 42 }];
    const empty = { city: base.city, worldMode: 'empty_lot' as const, emptyLotStakes: stakes };
    expect(cityGroundKey(empty), 'the surveyed plot is part of the ground').not.toBe(key);
    const ground = cityGround(empty, EGYPT_WORLD_PACK);
    expect(ground.clearing!.lots).toContainEqual({ col: 40, row: 40, spanCol: 4, spanRow: 3 });
    expect(ground.cover!(41.5, 41), 'no plant inside the rope').toBe(true);
    expect(ground.cover!(60, 60)).toBe(cityPlantCover(base.city)(60, 60));
    expect(cityGround({ ...empty, emptyLotStakes: undefined }, EGYPT_WORLD_PACK).clearing).toEqual({ ...cityLotClearing(base.city, EGYPT_WORLD_PACK), streets });
  });
});
