import { describe, expect, it } from 'vitest';
import { ART_CONTRACT_VERSION, declaredArtFiles, validateArtIndex, type ArtIndex } from '../src/world/art';
import { bridgeSite, BRIDGE_LENGTH, bridgeTiles, hasBridgeArt, type BridgeSite } from '../src/world/bridge-site';
import { applyBridgeRule, deserializeCityLayout, serializeCityLayout, type CityState } from '../src/world/city-layout';
import { roadMarks } from '../src/world/city-renderer';
import { runFiveYearSimulation } from '../src/world/simulator';
import { generateWorldTerrain, type GeneratedWorldMap } from '../src/world/terrain-engine';
import { EGYPT_WORLD_PACK } from '../src/world-packs/egypt/pack';

/* The reference seed and two more companies (#1985). */
const SEEDS = ['hornhoof', 'acme-corp', 'solar-labs'];
const mapOf = (seed: string) => generateWorldTerrain(EGYPT_WORLD_PACK, { seed, mapSize: EGYPT_WORLD_PACK.mapSize });

describe("a map's bridge", () => {
  it('stands in the same place on every load of one seed', () => {
    for (const seed of SEEDS) {
      const site = bridgeSite(mapOf(seed));
      expect(site, seed).not.toBeNull();
      expect(bridgeSite(mapOf(seed)), seed).toEqual(site);
    }
  });

  it('crosses a straight run of water along one tile axis, from a dry bank to a dry bank', () => {
    for (const seed of SEEDS) {
      const map = mapOf(seed);
      const site = bridgeSite(map)!;
      const [dc, dr] = site.axis === 'u' ? [1, 0] : [0, 1];
      expect(site.length, seed).toBeGreaterThanOrEqual(BRIDGE_LENGTH.min);
      expect(site.length, seed).toBeLessThanOrEqual(BRIDGE_LENGTH.max);
      for (let i = 0; i < site.length; i++) expect(map.isLiquid(site.col + dc * i, site.row + dr * i), `${seed} tile ${i}`).toBe(true);
      const bank = (c: number, r: number) => map.isWalkable(c, r) && !map.isLiquid(c, r);
      expect(bank(site.col - dc, site.row - dr), `${seed} near bank`).toBe(true);
      expect(bank(site.col + dc * site.length, site.row + dr * site.length), `${seed} far bank`).toBe(true);
    }
  });

  it('is the crossing nearest the city centre, the shorter one first', () => {
    const map = mapOf('hornhoof');
    const site = bridgeSite(map)!;
    const middle = (s: typeof site) => (s.axis === 'u' ? { col: s.col + s.length / 2, row: s.row + 0.5 } : { col: s.col + 0.5, row: s.row + s.length / 2 });
    const reach = Math.hypot(middle(site).col - map.startCenter.col, middle(site).row - map.startCenter.row);
    expect(reach).toBeLessThan(20);
  });

  it('is absent from a map without water', () => {
    const dry = { ...mapOf('hornhoof'), isLiquid: () => false };
    expect(bridgeSite(dry)).toBeNull();
  });
});

const waterRoads = (city: CityState, map: GeneratedWorldMap) => [...city.roads.values()].filter(road => map.isLiquid(road.col, road.row)).map(road => `${road.col},${road.row}`);

/* The road tiles joined to the city's first building by roads, four-connected. */
function reachable(city: CityState): Set<string> {
  const start = [...city.roads.values()][0]!;
  const seen = new Set([`${start.col},${start.row}`]);
  const queue = [start];
  while (queue.length) {
    const at = queue.pop()!;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const key = `${at.col + dc},${at.row + dr}`;
      const next = city.roads.get(key);
      if (next && !seen.has(key)) {
        seen.add(key);
        queue.push(next);
      }
    }
  }
  return seen;
}

describe("a city's roads over water", () => {
  /* With no bridge pictures, residents never walk on water: they walk on road tiles only, and no road lies on water. */
  it('lie nowhere while the pack has no bridge pictures, however the city grows', () => {
    for (const seed of SEEDS) {
      const { city, map } = runFiveYearSimulation(EGYPT_WORLD_PACK, { seed, mapSize: EGYPT_WORLD_PACK.mapSize, orderChaos: 0.5, recordSnapshots: false, bridge: null });
      expect(waterRoads(city, map), seed).toEqual([]);
      expect(city.metrics.bridgeTiles, seed).toBe(0);
    }
  });

  it('lie only on the bridge, in its fixed place and joined to the streets at both banks, when the pack has its pictures', () => {
    for (const seed of SEEDS) {
      const map = mapOf(seed);
      const site = bridgeSite(map)!;
      const { city } = runFiveYearSimulation(EGYPT_WORLD_PACK, { seed, mapSize: EGYPT_WORLD_PACK.mapSize, orderChaos: 0.5, recordSnapshots: false, bridge: site });
      const onBridge = bridgeTiles(site).map(t => `${t.col},${t.row}`);
      expect(waterRoads(city, map).sort(), seed).toEqual([...onBridge].sort());
      const joined = reachable(city);
      for (const key of onBridge) expect(joined.has(key), `${seed} ${key}`).toBe(true);
    }
  });

  it('a city saved under the old rule keeps only what the bridge allows', () => {
    const map = mapOf('hornhoof');
    const site: BridgeSite = bridgeSite(map)!;
    const { city } = runFiveYearSimulation(EGYPT_WORLD_PACK, { seed: 'hornhoof', mapSize: EGYPT_WORLD_PACK.mapSize, orderChaos: 0.5, recordSnapshots: false, bridge: site });
    const saved = serializeCityLayout(city);
    /* A road the old rule laid over the river wherever a door's way needed one: a water tile beside the bridge. */
    const onBridge = new Set(bridgeTiles(site).map(t => `${t.col},${t.row}`));
    const near = [-3, -2, 2, 3].flatMap(dr => [-3, -2, 2, 3].map(dc => ({ col: site.col + dc, row: site.row + dr })));
    const stray = near.find(t => map.isLiquid(t.col, t.row) && !onBridge.has(`${t.col},${t.row}`))!;
    expect(stray).toBeDefined();
    const old = { ...saved, roads: [...saved.roads, { col: stray.col, row: stray.row, tier: 'dirt' as const, traffic: 4, bridge: true, wasOldWall: false, grandAvenue: false }] };
    const without = applyBridgeRule(deserializeCityLayout(old), map, null);
    expect(waterRoads(without, map)).toEqual([]);
    const withArt = applyBridgeRule(deserializeCityLayout(old), map, site);
    expect(waterRoads(withArt, map).sort()).toEqual(bridgeTiles(site).map(t => `${t.col},${t.row}`).sort());
  });
});

describe("a map's bridge in the pictures", () => {
  const PIECES = ['bridge/u_start.png', 'bridge/u_span.png', 'bridge/u_end.png', 'bridge/v_start.png', 'bridge/v_span.png', 'bridge/v_end.png'];
  const piece = { w: 320, h: 400, passport: { groundAnchor: { x: 160, y: 330 }, corners: { top: { x: 160, y: 270 }, right: { x: 280, y: 330 }, bottom: { x: 160, y: 390 }, left: { x: 40, y: 330 } } } };
  const indexOf = (paths: readonly string[]): ArtIndex => ({ contract: ART_CONTRACT_VERSION, pack: EGYPT_WORLD_PACK.id, files: Object.fromEntries(paths.map(p => [p, piece])) });

  it('is a slot of the pack: start, span and end pieces in both directions, each a one-tile picture with a passport', () => {
    const declared = declaredArtFiles(EGYPT_WORLD_PACK).filter(f => f.role === 'bridge');
    expect(declared.map(f => f.path).sort()).toEqual([...PIECES].sort());
    expect(declared.every(f => f.passport === 'picture' && f.required)).toBe(true);
    expect(validateArtIndex(EGYPT_WORLD_PACK, indexOf(PIECES)).errors).toEqual([]);
    const wide = { ...indexOf(PIECES), files: { ...indexOf(PIECES).files, 'bridge/u_span.png': { ...piece, passport: { ...piece.passport, corners: { ...piece.passport.corners, left: { x: 0, y: 330 }, right: { x: 320, y: 330 } } } } } };
    expect(validateArtIndex(EGYPT_WORLD_PACK, wide).errors.join('\n')).toMatch(/bridge\/u_span\.png/);
  });

  it('counts as there only when every piece is in the folder', () => {
    expect(hasBridgeArt(EGYPT_WORLD_PACK, indexOf(PIECES))).toBe(true);
    expect(hasBridgeArt(EGYPT_WORLD_PACK, indexOf(PIECES.slice(1)))).toBe(false);
    expect(hasBridgeArt(EGYPT_WORLD_PACK, null)).toBe(false);
  });

  it('draws nothing on water while there is no bridge: no stand-in, and no street tile left there', () => {
    const map = mapOf('hornhoof');
    const site = bridgeSite(map)!;
    const { city } = runFiveYearSimulation(EGYPT_WORLD_PACK, { seed: 'hornhoof', mapSize: EGYPT_WORLD_PACK.mapSize, orderChaos: 0.5, recordSnapshots: false, bridge: null });
    /* A street tile an old rule left on the water. */
    city.roads.set(`${site.col},${site.row}`, { col: site.col, row: site.row, tier: 'dirt', traffic: 4, bridge: true, wasOldWall: false, grandAvenue: false });
    for (const painted of [false, true]) {
      const marks = roadMarks(city, painted);
      expect(marks.bridge).toEqual([]);
      expect(marks.streets.filter(road => map.isLiquid(road.col, road.row))).toEqual([]);
    }
  });

  it('draws the bridge from its pieces along its axis, start, spans and end, and the painted streets in the ground only', () => {
    const map = mapOf('hornhoof');
    const site = bridgeSite(map)!;
    const { city } = runFiveYearSimulation(EGYPT_WORLD_PACK, { seed: 'hornhoof', mapSize: EGYPT_WORLD_PACK.mapSize, orderChaos: 0.5, recordSnapshots: false, bridge: site });
    const marks = roadMarks(city, true);
    expect(marks.streets).toEqual([]);
    const pieces = ['start', ...Array.from({ length: site.length - 2 }, () => 'span'), 'end'].map(p => `bridge/${site.axis}_${p}.png`);
    expect(marks.bridge.map(m => m.path)).toEqual(pieces);
    expect(marks.bridge.map(m => `${m.road.col},${m.road.row}`)).toEqual(bridgeTiles(site).map(t => `${t.col},${t.row}`));
    expect(roadMarks(city, false).streets.length).toBe(city.roads.size - site.length);
  });
});
