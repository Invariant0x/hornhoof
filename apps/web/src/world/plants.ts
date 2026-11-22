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
const DRAWN_SHORE_CLEARANCE = 0.14;
const DRAWN_SHORE_CLEARANCE_BELOW = 1.35;

const SALT = { draw: 101, jitterU: 211, jitterV: 223, score: 307, variant: 401, size: 503, flip: 601, phase: 701, height: 809, bedU: 911, bedV: 929, bedPick: 947 } as const;

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
  /* The drawn shoreline wiggles around the field's zero line; keep roots clear of the water and foam that are painted. */
  if (s.signedWaterDist < DRAWN_SHORE_CLEARANCE_BELOW && displayedWaterDistance(map.cornerFields, u, v) < DRAWN_SHORE_CLEARANCE) return 0;
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
  }));
}

/* The best candidate of any kind at one tile, or null. */
function candidateAt(map: GeneratedWorldMap, kinds: readonly Prepared[], col: number, row: number): Candidate | null {
  let best: Candidate | null = null;
  for (let k = 0; k < kinds.length; k++) {
    const p = kinds[k]!;
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

function placed(pack: WorldPackManifest, p: Prepared, kindIndex: number, u: number, v: number, salt: number, c: number, r: number): PlacedPlant {
  const h = (s: number) => hash2i(c + salt * 1031, r - salt * 577, p.seed + s);
  const world = tileTopVertexToWorld(u, v, pack.projection.defaultTileW, pack.projection.defaultTileH);
  const scale = 0.88 + 0.24 * h(SALT.size);
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

      plants.push(placed(pack, p, c.kind, c.u, c.v, 0, col, row));
      counts[c.kind]!++;

      /* A bed (reeds, tufts) spreads more plants around the chosen one, each checked at its own exact spot. */
      const bed = p.spec.clusterSize;
      if (bed && (p.spec.clusterRadius ?? 0) > 0) {
        const n = Math.round(lerp(bed, hash2i(col, row, p.seed + SALT.bedPick))) - 1;
        const radius = p.spec.clusterRadius!;
        for (let i = 1; i <= n; i++) {
          const ang = hash2i(col + i * 1031, row - i * 577, p.seed + SALT.bedU) * TAU;
          const dist = radius * Math.sqrt(hash2i(col + i * 1031, row - i * 577, p.seed + SALT.bedV));
          const u = c.u + Math.cos(ang) * dist;
          const v = c.v + Math.sin(ang) * dist;
          if (u < minCol || u >= maxCol || v < minRow || v >= maxRow) continue;
          if (suitability(map, p, u, v) <= 0) continue;
          plants.push(placed(pack, p, c.kind, u, v, i, col, row));
          counts[c.kind]!++;
        }
      }
    }
  }

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
    if (plants[mid]!.y < rect.minY) lo = mid + 1;
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

/* Reads the passport file that comes with an artist's plant image (root_point, crown_center, crown_hub, height,
   crown_width); null when anything is missing or not a number. */
export function parsePlantPassport(raw: unknown): PlantPassport | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const j = raw as Record<string, unknown>;
  const rootPoint = point(j.root_point);
  const crownCenter = point(j.crown_center);
  const crownHub = point(j.crown_hub);
  const heightPx = j.height;
  const crownWidthPx = j.crown_width;
  if (!rootPoint || !crownCenter || !crownHub) return null;
  if (typeof heightPx !== 'number' || typeof crownWidthPx !== 'number') return null;
  if (!(heightPx > 0) || !(crownWidthPx > 0)) return null;
  return { rootPoint, crownCenter, crownHub, heightPx, crownWidthPx };
}
