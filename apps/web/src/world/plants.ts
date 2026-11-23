/* Deterministic plant placement from a pack's plant kinds and the generated terrain fields.
   A plant exists or not as a pure function of (seed, tile, kind): the same seed gives the same plants, plants never
   depend on the order they are scanned in, and growing the map at its edges leaves the plants inside it where they were.
   Knows no species and no world: kinds, ground rules and sizes all come from the pack. */

import type { WorldRect } from './coords';
import { tileTopVertexToWorld } from './coords';
import type { PlantKindSpec, PlantPassport, PlantRange, WorldPackManifest } from './manifest';
import { fbm2D, hash2i, hashSeed } from './prng';
import { displayedWaterDistance, sampleCornerFieldBilinear } from './smooth-terrain-baker';
import type { GeneratedWorldMap } from './terrain-engine';

export type PlacedPlant = Readonly<{
  /* Index into the pack's plants list. */
  kindIndex: number;
  /* Exact position in tile coordinates. */
  col: number;
  row: number;
  /* Where the plant's root is in world pixels at the pack's default tile size; also the depth key (larger = nearer). */
  x: number;
  y: number;
  variant: number;
  flip: boolean;
  scale: number;
  /* Wind phase in [0, 2pi). */
  phase: number;
  /* Height in world pixels at 100% zoom, scale included. */
  heightPx: number;
  /* Water lies just below the root on screen, so the plant shows a reflection there. */
  nearWater: boolean;
}>;

export type PlantField = Readonly<{
  /* Sorted back to front: smaller y first, so buildings and people can be merged in by the same key. */
  plants: readonly PlacedPlant[];
  countsByKind: readonly number[];
  maxHeightPx: number;
}>;

const EMPTY_FIELD: PlantField = { plants: [], countsByKind: [], maxHeightPx: 0 };
const TAU = Math.PI * 2;
/* A root must stand this far (tiles) from the painted water and foam; the check is only made near the shore. */
const DRAWN_SHORE_CLEARANCE = 0.2;
const DRAWN_SHORE_CLEARANCE_BELOW = 1.35;
/* A kind whose waterDist window starts this close to the water is a waterline kind. */
const WATERLINE_KIND = 0.25;
/* A plant whose root is just above a view can still cast its shadow into it: this share of the reach. */
const SHADOW_REACH = 0.4;

const SALT = { draw: 101, jitterU: 211, jitterV: 223, score: 307, variant: 401, size: 503, flip: 601, phase: 701, height: 809, bedU: 911, bedV: 929, bedPick: 947, cell: 1013, cellU: 1031, cellV: 1049 } as const;
/* Golden angle: beds and groves spread their members on a sunflower spiral, evenly, with no two on one spot. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/* Points below a root on screen (tiles along both axes) where water makes the plant show a reflection. */
const REFLECTION_PROBES = [0.35, 0.7, 1.1, 1.6, 2.2] as const;

function lerp(r: PlantRange, t: number): number {
  return r.min + (r.max - r.min) * t;
}

function smoothstep(a: number, b: number, x: number): number {
  if (b <= a) return x >= a ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/* 1 across the middle of a range, easing to 0.25 at its ends; the caller has already rejected values outside it. */
function windowWeight(value: number, range: PlantRange): number {
  const span = range.max - range.min;
  if (span <= 0) return 1;
  const edge = Math.min(value - range.min, range.max - value) / (span * 0.3);
  return 0.25 + 0.75 * smoothstep(0, 1, edge);
}

type Candidate = Readonly<{ kind: number; score: number; u: number; v: number }>;

type Prepared = Readonly<{
  spec: PlantKindSpec;
  seed: number;
  tileKinds: ReadonlySet<string>;
  /* Positions in the cornerFields material list for each capped material. */
  caps: readonly (readonly [number, number])[];
  /* Positions of the grounds the kind needs; empty when it needs none. */
  needs: readonly number[];
}>;

/* Whether a spot is fit for a kind, and how well, from the smooth fields at that exact spot. Returns 0 if unfit. */
function suitability(map: GeneratedWorldMap, p: Prepared, u: number, v: number): number {
  const tile = map.tileAt(Math.floor(u), Math.floor(v));
  if (tile === null || !p.tileKinds.has(tile)) return 0;
  if (map.kindById.get(tile)?.liquid) return 0;
  const s = sampleCornerFieldBilinear(map.cornerFields, u, v);
  const { moisture, waterDist } = p.spec;
  if (s.moisture < moisture.min || s.moisture > moisture.max) return 0;
  if (s.signedWaterDist < waterDist.min || s.signedWaterDist > waterDist.max) return 0;
  for (const [idx, cap] of p.caps) if ((s.weights[idx] ?? 0) > cap) return 0;
  if (p.needs.length > 0) {
    let on = 0;
    for (const idx of p.needs) on += s.weights[idx] ?? 0;
    if (on < 0.35) return 0;
  }
  /* The drawn shoreline wiggles around the field's zero line; keep roots clear of the water and foam that are painted.
     Waterline kinds (reeds, papyrus) may stand right on the drawn edge, so they seem to grow out of the water. */
  const clearance = p.spec.waterDist.min <= WATERLINE_KIND ? 0.02 : DRAWN_SHORE_CLEARANCE;
  if (s.signedWaterDist < DRAWN_SHORE_CLEARANCE_BELOW && displayedWaterDistance(map.cornerFields, u, v) < clearance) return 0;
  return windowWeight(s.moisture, moisture) * windowWeight(s.signedWaterDist, waterDist);
}

function prepareKinds(pack: WorldPackManifest, map: GeneratedWorldMap): Prepared[] {
  const materialIds = map.cornerFields.materialIds;
  return (pack.plants ?? []).map(spec => ({
    spec,
    seed: (map.numericSeed ^ hashSeed(spec.id)) >>> 0,
    tileKinds: new Set(spec.tileKinds),
    caps: Object.entries(spec.materialCaps ?? {})
      .map(([id, cap]) => [materialIds.indexOf(id), cap] as const)
      .filter(([idx]) => idx >= 0),
    needs: (spec.onMaterials ?? []).map(id => materialIds.indexOf(id)).filter(idx => idx >= 0),
  }));
}

/* The best candidate of any kind at one tile, or null. */
function candidateAt(map: GeneratedWorldMap, kinds: readonly Prepared[], col: number, row: number): Candidate | null {
  let best: Candidate | null = null;
  for (let k = 0; k < kinds.length; k++) {
    const p = kinds[k]!;
    if (p.spec.evenCell) continue;
    const tile = map.tileAt(col, row);
    if (tile === null || !p.tileKinds.has(tile)) continue;
    /* The cheap random draw comes first: suitability is at most 1, so a draw above density can never pass. */
    const draw = hash2i(col, row, p.seed + SALT.draw);
    if (draw >= p.spec.density) continue;
    const u = col + 0.12 + 0.76 * hash2i(col, row, p.seed + SALT.jitterU);
    const v = row + 0.12 + 0.76 * hash2i(col, row, p.seed + SALT.jitterV);
    const fit = suitability(map, p, u, v);
    if (fit <= 0) continue;
    let clump = 1;
    if (p.spec.clumping > 0) {
      const grove = smoothstep(0.4, 0.68, fbm2D(u / p.spec.clumpScale, v / p.spec.clumpScale, p.seed + 7, 3));
      clump = 1 - p.spec.clumping + p.spec.clumping * grove;
    }
    if (draw >= p.spec.density * fit * clump) continue;
    const score = p.spec.priority + hash2i(col, row, p.seed + SALT.score);
    if (best === null || score > best.score) best = { kind: k, score, u, v };
  }
  return best;
}

function nearWater(map: GeneratedWorldMap, u: number, v: number): boolean {
  if (sampleCornerFieldBilinear(map.cornerFields, u, v).signedWaterDist > 4) return false;
  return REFLECTION_PROBES.some(t => displayedWaterDistance(map.cornerFields, u + t, v + t) < -0.1);
}

function placed(map: GeneratedWorldMap, pack: WorldPackManifest, p: Prepared, kindIndex: number, u: number, v: number, salt: number, c: number, r: number): PlacedPlant {
  const h = (s: number) => hash2i(c + salt * 1031, r - salt * 577, p.seed + s);
  const world = tileTopVertexToWorld(u, v, pack.projection.defaultTileW, pack.projection.defaultTileH);
  /* Sizes vary within a kind: from three quarters to six fifths of the drawn size. */
  const scale = 0.75 + 0.45 * h(SALT.size);
  return {
    kindIndex,
    col: u,
    row: v,
    x: world.x,
    y: world.y,
    variant: Math.min(p.spec.variants - 1, Math.floor(h(SALT.variant) * p.spec.variants)),
    flip: h(SALT.flip) < 0.5,
    scale,
    phase: h(SALT.phase) * TAU,
    heightPx: lerp(p.spec.heightPx, h(SALT.height)) * scale,
    nearWater: !p.spec.flat && nearWater(map, u, v),
  };
}

export function generatePlants(pack: WorldPackManifest, map: GeneratedWorldMap): PlantField {
  const kinds = prepareKinds(pack, map);
  if (kinds.length === 0) return EMPTY_FIELD;

  const { minCol, maxCol, minRow, maxRow } = map.bounds;
  const width = maxCol - minCol;
  const height = maxRow - minRow;

  /* Pass 1: one candidate per tile, chosen only from that tile's own surroundings. */
  const cand: (Candidate | null)[] = new Array<Candidate | null>(width * height).fill(null);
  for (let row = minRow; row < maxRow; row++) {
    for (let col = minCol; col < maxCol; col++) {
      cand[(row - minRow) * width + (col - minCol)] = candidateAt(map, kinds, col, row);
    }
  }

  /* Pass 2: a candidate stays only if no better one stands within its kind's spacing. Local rule, so scan order is moot. */
  const plants: PlacedPlant[] = [];

  /* A bed (reeds, tufts, palm groups) spreads more plants around a chosen one on a Vogel spiral, each checked at its
     own exact spot. */
  const spreadBed = (p: KindPlan, kind: number, cu: number, cv: number, col: number, row: number): void => {
    const bed = p.spec.clusterSize;
    if (!bed || (p.spec.clusterRadius ?? 0) <= 0) return;
    const n = Math.round(lerp(bed, hash2i(col, row, p.seed + SALT.bedPick))) - 1;
    const radius = p.spec.clusterRadius!;
    const turn = hash2i(col, row, p.seed + SALT.bedU) * TAU;
    for (let i = 1; i <= n; i++) {
      const ang = turn + i * GOLDEN_ANGLE + (hash2i(col + i * 1031, row - i * 577, p.seed + SALT.bedU) - 0.5) * 0.5;
      const dist = radius * Math.sqrt((i + 0.15) / (n + 0.4)) * (0.88 + 0.24 * hash2i(col + i * 1031, row - i * 577, p.seed + SALT.bedV));
      const u = cu + Math.cos(ang) * dist;
      const v = cv + Math.sin(ang) * dist;
      if (u < minCol || u >= maxCol || v < minRow || v >= maxRow) continue;
      if (suitability(map, p, u, v) <= 0) continue;
      plants.push(placed(map, pack, p, kind, u, v, i, col, row));
      counts[kind]!++;
    }
  };
  const counts = kinds.map(() => 0);
  for (let row = minRow; row < maxRow; row++) {
    for (let col = minCol; col < maxCol; col++) {
      const c = cand[(row - minRow) * width + (col - minCol)];
      if (!c) continue;
      const p = kinds[c.kind]!;
      const reach = p.spec.spacing;
      let beaten = false;
      for (let dr = -reach; dr <= reach && !beaten; dr++) {
        for (let dc = -reach; dc <= reach; dc++) {
          if (dc === 0 && dr === 0) continue;
          const nc = col + dc;
          const nr = row + dr;
          if (nc < minCol || nc >= maxCol || nr < minRow || nr >= maxRow) continue;
          if (dc * dc + dr * dr > reach * reach) continue;
          const other = cand[(nr - minRow) * width + (nc - minCol)];
          if (other && (other.score > c.score || (other.score === c.score && (nr < row || (nr === row && nc < col))))) {
            beaten = true;
            break;
          }
        }
      }
      if (beaten) continue;

      plants.push(placed(map, pack, p, c.kind, c.u, c.v, 0, col, row));
      counts[c.kind]!++;
      spreadBed(p, c.kind, c.u, c.v, col, row);
    }
  }

  /* Pass 3: kinds spread evenly, one try-set per cell of evenCell tiles; cells sit on whole multiples of their size,
     so growing the map at its edges leaves the inner cells as they were. */
  kinds.forEach((p, k) => {
    const n = p.spec.evenCell;
    if (!n) return;
    for (let cy = Math.floor(minRow / n); cy * n < maxRow; cy++) {
      for (let cx = Math.floor(minCol / n); cx * n < maxCol; cx++) {
        if (hash2i(cx, cy, p.seed + SALT.cell) >= p.spec.density) continue;
        for (let t = 0; t < 4; t++) {
          const u = (cx + 0.08 + 0.84 * hash2i(cx + t * 7919, cy, p.seed + SALT.cellU)) * n;
          const v = (cy + 0.08 + 0.84 * hash2i(cx, cy + t * 7919, p.seed + SALT.cellV)) * n;
          if (u < minCol || u >= maxCol || v < minRow || v >= maxRow) continue;
          if (suitability(map, p, u, v) <= 0) continue;
          plants.push(placed(map, pack, p, k, u, v, t + 50, cx, cy));
          counts[k]!++;
          spreadBed(p, k, u, v, cx, cy);
          break;
        }
      }
    }
  });

  plants.sort((a, b) => a.y - b.y || a.x - b.x);
  let maxHeightPx = 0;
  for (const p of plants) if (p.heightPx > maxHeightPx) maxHeightPx = p.heightPx;
  return { plants, countsByKind: counts, maxHeightPx };
}

/* The plants whose body can show inside a world rectangle. `reach` is the largest plant height and half-width to allow
   for: a root below the bottom edge can still have its crown in view, and one beside the edge can lean in. */
export function visiblePlants(field: PlantField, rect: WorldRect, reach: number): PlacedPlant[] {
  const { plants } = field;
  let lo = 0;
  let hi = plants.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (plants[mid]!.y < rect.minY - reach * SHADOW_REACH) lo = mid + 1;
    else hi = mid;
  }
  const out: PlacedPlant[] = [];
  const maxY = rect.maxY + reach;
  for (let i = lo; i < plants.length; i++) {
    const p = plants[i]!;
    if (p.y > maxY) break;
    if (p.x >= rect.minX - reach && p.x <= rect.maxX + reach) out.push(p);
  }
  return out;
}

function point(raw: unknown): readonly [number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const [x, y] = raw as unknown[];
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

/* Reads the passport file that comes with an artist's plant image: root_point, crown_center, optional crown_hub (the
   crown centre stands in for it) and the height and crown width, written height_px / crown_width_px or height /
   crown_width; null when anything required is missing or not a number. */
export function parsePlantPassport(raw: unknown): PlantPassport | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const j = raw as Record<string, unknown>;
  const rootPoint = point(j.root_point);
  const crownCenter = point(j.crown_center);
  const crownHub = j.crown_hub === undefined ? crownCenter : point(j.crown_hub);
  const heightPx = j.height_px ?? j.height;
  const crownWidthPx = j.crown_width_px ?? j.crown_width;
  if (!rootPoint || !crownCenter || !crownHub) return null;
  if (typeof heightPx !== 'number' || typeof crownWidthPx !== 'number') return null;
  if (!(heightPx > 0) || !(crownWidthPx > 0)) return null;
  return { rootPoint, crownCenter, crownHub, heightPx, crownWidthPx };
}
