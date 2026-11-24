import { describe, expect, it } from 'vitest';
import { ART_CONTRACT_VERSION, declaredArtFiles, masterTileW, validateArtIndex, type ArtIndex } from '../src/world/art';
import { bridgePieceTiles, bridgeSite, BRIDGE_LENGTH, bridgeTiles, hasBridgeArt, residentDepthY, sameBridge, type BridgeSite } from '../src/world/bridge-site';
import { displayedWaterDistance } from '../src/world/smooth-terrain-baker';
import { applyBridgeRule, cityDepthY, deserializeCityLayout, keepMapBridge, serializeCityLayout, type CityState } from '../src/world/city-layout';
import { drawBridgePieces, roadMarks, type CityArtContext } from '../src/world/city-renderer';
import { tileCenterToWorld } from '../src/world/coords';
import { DEFAULT_ISOMETRIC_PROJECTION } from '../src/world/manifest';
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

  it('reaches the bank as the water is drawn: each end piece meets drawn land, on the bank tile where the water spills over it', () => {
    /* The drawn waterline bends past the water tiles; land below about 0.08 of drawn water distance shows as water. */
    const LAND = 0.08;
    const ends: Record<string, readonly [boolean, boolean]> = {};
    for (const seed of SEEDS) {
      const map = mapOf(seed);
      const site = bridgeSite(map)!;
      const [dc, dr] = site.axis === 'u' ? [1, 0] : [0, 1];
      const drawn = bridgePieceTiles(site);
      const first = drawn[0]!;
      const last = drawn.at(-1)!;
      /* The middle of each end piece's outer edge, where the deck comes down to the bank. */
      const outer = (t: { col: number; row: number }, side: number) => displayedWaterDistance(map.cornerFields, t.col + 0.5 + (dc * side) / 2, t.row + 0.5 + (dr * side) / 2);
      expect(outer(first, -1), `${seed} far end on land`).toBeGreaterThanOrEqual(LAND);
      expect(outer(last, 1), `${seed} near end on land`).toBeGreaterThanOrEqual(LAND);
      /* Every water tile is under a piece, and a piece stands on the bank only where the water's own edge is drawn as water. */
      for (const t of bridgeTiles(site)) expect(drawn, seed).toContainEqual(t);
      expect(drawn.length - site.length, seed).toBeLessThanOrEqual(2);
      ends[seed] = [first.col !== site.col || first.row !== site.row, drawn.length - site.length - (first.col !== site.col || first.row !== site.row ? 1 : 0) === 1];
    }
    /* The three maps today: hornhoof's water spills over both banks, solar-labs' only over the far one. */
    expect(ends.hornhoof).toEqual([true, true]);
    expect(ends['solar-labs']).toEqual([true, false]);
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

const PIECES = ['bridge/u_start.png', 'bridge/u_span.png', 'bridge/u_end.png', 'bridge/v_start.png', 'bridge/v_span.png', 'bridge/v_end.png'];
const piece = { w: 320, h: 400, passport: { groundAnchor: { x: 160, y: 330 }, corners: { top: { x: 160, y: 270 }, right: { x: 280, y: 330 }, bottom: { x: 160, y: 390 }, left: { x: 40, y: 330 } } } };
const indexOf = (paths: readonly string[]): ArtIndex => ({ contract: ART_CONTRACT_VERSION, pack: EGYPT_WORLD_PACK.id, files: Object.fromEntries(paths.map(p => [p, piece])) });

describe("a map's bridge in the pictures", () => {

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
    const drawn = bridgePieceTiles(site);
    const pieces = ['start', ...Array.from({ length: drawn.length - 2 }, () => 'span'), 'end'].map(p => `bridge/${site.axis}_${p}.png`);
    expect(marks.bridge.map(m => m.path)).toEqual(pieces);
    expect(marks.bridge.map(m => `${m.road.col},${m.road.row}`)).toEqual(drawn.map(t => `${t.col},${t.row}`));
    expect(roadMarks(city, false).streets.length).toBe(city.roads.size - site.length);
  });
});

describe('the bridge on the shown map', () => {
  it('comes when all its pictures are there and goes when they are not, its street laid and taken away with it', () => {
    const map = mapOf('hornhoof');
    const site = bridgeSite(map)!;
    const { city } = runFiveYearSimulation(EGYPT_WORLD_PACK, { seed: 'hornhoof', mapSize: EGYPT_WORLD_PACK.mapSize, orderChaos: 0.5, recordSnapshots: false, bridge: null });
    const state = { city };
    keepMapBridge(state, map, false);
    expect(city.bridge ?? null).toBeNull();
    expect(waterRoads(city, map)).toEqual([]);
    keepMapBridge(state, map, true);
    expect(sameBridge(city.bridge, site)).toBe(true);
    expect(waterRoads(city, map).sort()).toEqual(bridgeTiles(site).map(t => `${t.col},${t.row}`).sort());
    const roads = city.roads.size;
    keepMapBridge(state, map, true);
    expect(city.roads.size).toBe(roads);
    keepMapBridge(state, map, false);
    expect(waterRoads(city, map)).toEqual([]);
    expect(() => keepMapBridge(null, map, true)).not.toThrow();
    keepMapBridge(state, undefined, true);
    expect(city.bridge ?? null).toBeNull();
  });

  it('puts each piece with its ground anchor on its tile centre at its tile depth, and leaves out a piece still loading', () => {
    const site: BridgeSite = { axis: 'v', col: 10, row: 20, length: 3 };
    const roads = new Map(bridgeTiles(site).map(t => [`${t.col},${t.row}`, { col: t.col, row: t.row, tier: 'dirt' as const, traffic: 4, bridge: true, wasOldWall: false, grandAvenue: false }]));
    const marks = roadMarks({ roads, bridge: site }, true).bridge;
    type Placed = { path: string; depth: number; anchor: number[]; scale: number; at: number[] };
    const placed: Placed[] = [];
    const pool = {
      depth: 0,
      sprite(tex: { path: string }) {
        const p: Placed = { path: tex.path, depth: pool.depth, anchor: [], scale: 0, at: [] };
        placed.push(p);
        return { anchor: { set: (x: number, y: number) => (p.anchor = [x, y]) }, scale: { set: (s: number) => (p.scale = s) }, position: { set: (x: number, y: number) => (p.at = [x, y]) } };
      },
    };
    const library = { index: indexOf(PIECES), texture: (path: string) => (path.endsWith('_span.png') ? null : { path, width: 320, height: 400 }) };
    const { defaultTileW: W, defaultTileH: H } = DEFAULT_ISOMETRIC_PROJECTION;
    drawBridgePieces({ library, pool } as unknown as CityArtContext, EGYPT_WORLD_PACK, marks, W, H);
    expect(placed.map(p => p.path)).toEqual(['bridge/v_start.png', 'bridge/v_end.png']);
    const centre = tileCenterToWorld(10, 22, W, H);
    expect(placed[1]).toEqual({ path: 'bridge/v_end.png', depth: (10 + 22 + 1) * (H / 2), anchor: [0.5, 330 / 400], scale: W / masterTileW(EGYPT_WORLD_PACK), at: [centre.x, centre.y] });
    placed.length = 0;
    drawBridgePieces({ library: { ...library, index: null }, pool } as unknown as CityArtContext, EGYPT_WORLD_PACK, marks, W, H);
    expect(placed).toEqual([]);
  });
  it('draws the crossing from its far end to its near end, and a resident on it over the deck it walks on', () => {
    const { defaultTileW: W, defaultTileH: H } = DEFAULT_ISOMETRIC_PROJECTION;
    for (const axis of ['u', 'v'] as const) {
      const site: BridgeSite = { axis, col: 10, row: 20, length: 4 };
      const roads = new Map(bridgeTiles(site).map(t => [`${t.col},${t.row}`, { col: t.col, row: t.row, tier: 'dirt' as const, traffic: 4, bridge: true, wasOldWall: false, grandAvenue: false }]));
      const depths: number[] = [];
      const pool = { depth: 0, sprite: () => (depths.push(pool.depth), { anchor: { set: () => undefined }, scale: { set: () => undefined }, position: { set: () => undefined } }) };
      const library = { index: indexOf(PIECES), texture: (path: string) => ({ path, width: 320, height: 400 }) };
      drawBridgePieces({ library, pool } as unknown as CityArtContext, EGYPT_WORLD_PACK, roadMarks({ roads, bridge: site }, true).bridge, W, H);
      /* Each later piece lies over the one before it: the overlap each piece carries is covered by the next. */
      expect(depths, axis).toHaveLength(site.length);
      for (let i = 1; i < depths.length; i++) expect(depths[i]!, `${axis} piece ${i}`).toBeGreaterThan(depths[i - 1]!);

      const [dc, dr] = axis === 'u' ? [1, 0] : [0, 1];
      const tileDepth = (i: number) => cityDepthY({ col: site.col + dc * i, row: site.row + dr * i, spanCol: 1, spanRow: 1 }, H);
      /* From the far bank onto the start, over every piece, and off the end onto the near bank, both ways. */
      for (let i = -1; i < site.length; i++) {
        for (const t of [0, 0.1, 0.5, 0.9]) {
          if (i === -1 && t === 0) continue;
          const depth = residentDepthY(site, site.col + dc * (i + t), site.row + dr * (i + t), H);
          const under = t > 0 ? i + 1 : i;
          if (under < site.length) expect(depth, `${axis} at ${i + t}`).toBeGreaterThan(tileDepth(under));
          if (under + 1 < site.length) expect(depth, `${axis} at ${i + t}, under the piece after`).toBeLessThan(tileDepth(under + 1));
        }
      }
      /* Anywhere else a resident keeps the depth of its feet. */
      const feet = (col: number, row: number) => (col + row + 1) * (H / 2);
      expect(residentDepthY(site, 3.4, 7.2, H)).toBe(feet(3.4, 7.2));
      expect(residentDepthY(site, site.col + dr * 2 + 0.5 * dc, site.row + dc * 2 + 0.5 * dr, H), `${axis} beside the bridge`).toBe(feet(site.col + dr * 2 + 0.5 * dc, site.row + dc * 2 + 0.5 * dr));
      expect(residentDepthY(null, 10.5, 20, H)).toBe(feet(10.5, 20));

      /* Where the water spills over a bank, the end piece stands on the bank tile, the street's tile there. */
      const over: BridgeSite = { ...site, overBank: [true, true] };
      const bank = (i: number) => ({ col: site.col + dc * i, row: site.row + dr * i });
      const withBanks = new Map(roads);
      for (const t of [bank(-1), bank(site.length)]) withBanks.set(`${t.col},${t.row}`, { col: t.col, row: t.row, tier: 'dirt' as const, traffic: 4, bridge: false, wasOldWall: false, grandAvenue: false });
      const marks = roadMarks({ roads: withBanks, bridge: over }, true).bridge;
      expect(marks.map(m => [m.road.col, m.road.row, m.path]), axis).toEqual([
        [bank(-1).col, bank(-1).row, `bridge/${axis}_start.png`],
        ...bridgeTiles(site).map(t => [t.col, t.row, `bridge/${axis}_span.png`]),
        [bank(site.length).col, bank(site.length).row, `bridge/${axis}_end.png`],
      ]);
      const stepOn = residentDepthY(over, site.col + dc * -1.5, site.row + dr * -1.5, H);
      expect(stepOn, `${axis} stepping onto the start on the bank`).toBeGreaterThan(tileDepth(-1));
      expect(stepOn).toBeLessThan(tileDepth(0));
      expect(residentDepthY(over, site.col + dc * (site.length + 0.5), site.row + dr * (site.length + 0.5), H)).toBeGreaterThan(tileDepth(site.length + 1));
    }
  });
});
