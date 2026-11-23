/* Per-frame layout of the plant layer: which plants are in view, how the wind bends each one and where its shadow
   falls. Pure arithmetic over numbers, shared by the WebGL and canvas painters, with no drawing in it.
   Draw order is back to front by the plant's root y (the same key buildings and people sort by); shadows come first,
   so no shadow ever lies over a plant. */

import type { WorldRect } from './coords';
import type { LightingSpec, WorldPackManifest } from './manifest';
import type { PlantField } from './plants';
import { visiblePlants } from './plants';
import type { PlantSpriteInfo } from './plant-sprites';
import { sampleWind } from './wind';

/* Floats per draw item: atlas frame, the affine matrix a, b, c, d, tx, ty (world pixels), then for a painted plant
   bent by its wind weights: the sideways push of a fully free pixel (picture pixels), the leaf flutter in picture pixels
   and the flutter's phase (zero for everything else), and for a plant's own parts the world y of its root: the depth
   it sorts by among buildings and people. */
export const ITEM_STRIDE = 11;
/* Share of a painted plant's height its free tips move per unit of wind lean (README of the painted set: about 3 to
   4% of the height from side to side in an ordinary wind). */
const PAINTED_SWAY = 0.11;
/* Leaf flutter of a painted plant at flutter 1, picture pixels, and how much faster than the main sway it shivers. */
const PAINTED_FLUTTER_PX = 2;
const FLUTTER_SPEEDUP = 4;
/* Reflections are a little shorter than the plant and lean with it at half the strength. */
const REFLECTION_SQUASH = 0.85;
/* The shadow picture is stored at a third of the plant's resolution (see makeShadow). */
export const SHADOW_DOWNSCALE = 3;

export type PlantDrawList = {
  data: Float32Array;
  /* Flat ground details are items [0, flatCount); shadows follow up to shadowCount; the plants' own parts up to count. */
  flatCount: number;
  shadowCount: number;
  count: number;
};

export function createDrawList(): PlantDrawList {
  return { data: new Float32Array(ITEM_STRIDE * 1024), flatCount: 0, shadowCount: 0, count: 0 };
}

function ensureCapacity(list: PlantDrawList, items: number): void {
  if (list.data.length >= items * ITEM_STRIDE) return;
  const next = new Float32Array(Math.max(items * ITEM_STRIDE, list.data.length * 2));
  next.set(list.data);
  list.data = next;
}

/* Direction a shadow is cast on screen, from the sun: x right, y down, y squashed by the 2:1 ground foreshortening. */
export function shadowDirection(azimuthDeg: number): { x: number; y: number } {
  const az = (azimuthDeg * Math.PI) / 180;
  return { x: -Math.sin(az), y: Math.cos(az) * 0.5 };
}

export type PlantLayoutOptions = Readonly<{
  pack: WorldPackManifest;
  field: PlantField;
  sprites: readonly (readonly PlantSpriteInfo[])[];
  /* Windless and shadowless packs pass nothing for these. */
  lighting?: LightingSpec;
}>;

export class PlantLayout {
  private readonly pack: WorldPackManifest;
  private readonly field: PlantField;
  private readonly sprites: readonly (readonly PlantSpriteInfo[])[];
  private readonly shadowDir: { x: number; y: number };
  private readonly shadowLength: number;
  private readonly reach: number;
  /* Lowest and highest lean among the plants laid out by the last build: how differently the grove is moving. */
  leanMin = 0;
  leanMax = 0;

  constructor(options: PlantLayoutOptions) {
    this.pack = options.pack;
    this.field = options.field;
    this.sprites = options.sprites;
    this.shadowDir = shadowDirection(options.pack.projection.sun.azimuthDeg);
    this.shadowLength = options.lighting?.shadowLength ?? 0;
    this.reach = Math.max(120, options.field.maxHeightPx * (1 + this.shadowLength));
  }

  /* Whether shadows are drawn at all: a pack with no lighting casts none. */
  get castsShadows(): boolean {
    return this.shadowLength > 0;
  }

  /* Fills `out` for the plants inside `view` at `timeSec`, and `reflections` (when given) with the mirrored plants that
     stand by the water. Returns the number of plants in view. */
  build(view: WorldRect, timeSec: number, out: PlantDrawList, reflections?: PlantDrawList): number {
    const plants = visiblePlants(this.field, view, this.reach);
    const kinds = this.pack.plants ?? [];
    const wind = this.pack.wind;
    const shadows = this.castsShadows;
    ensureCapacity(out, plants.length * 3 + 8);
    if (reflections) ensureCapacity(reflections, plants.length * 2 + 8);
    const data = out.data;

    /* Flat details first, then the shadows, then the bodies: lay each range out in its own place and close the gaps. */
    let flats = 0;
    for (const p of plants) if (kinds[p.kindIndex]?.flat) flats++;
    const shadowBase = flats;
    const bodyBase = shadowBase + (shadows ? plants.length : 0);
    let flatN = 0;
    let shadowN = 0;
    let bodyN = 0;
    let reflN = 0;
    let leanMin = Infinity;
    let leanMax = -Infinity;

    for (const p of plants) {
      const kind = kinds[p.kindIndex]!;
      const info = this.sprites[p.kindIndex]?.[p.variant];
      if (!info) continue;
      const m = info.pxToWorld !== undefined ? info.pxToWorld * p.scale : p.heightPx / info.heightPx;
      const fx = p.flip ? -1 : 1;
      const w = wind ? sampleWind(wind, kind.sway, p.col, p.row, timeSec, p.phase) : { lean: 0, flutter: 0, gust: 0 };

      if (kind.flat) {
        /* A flat detail lies at its spot, centred on it, and never moves. */
        const bp = info.base;
        const o = flatN++ * ITEM_STRIDE;
        data.fill(0, o, o + ITEM_STRIDE);
        data[o] = bp.frame;
        data[o + 1] = fx * m;
        data[o + 4] = m;
        data[o + 5] = p.x - fx * m * bp.pivotX;
        data[o + 6] = p.y - m * (bp.pivotY - info.heightPx * 0.5);
        continue;
      }

      if (kind.sway.amplitude > 0) {
        leanMin = Math.min(leanMin, w.lean / kind.sway.amplitude);
        leanMax = Math.max(leanMax, w.lean / kind.sway.amplitude);
      }
      const bent = info.meshWeights !== undefined;
      const twoPart = info.crown !== undefined;
      const baseLean = bent ? 0 : twoPart ? w.lean * 0.45 : w.lean;
      const a = fx * m;
      const c = -baseLean * m;
      const d = m;
      const bp = info.base;
      let o = (bodyBase + bodyN++) * ITEM_STRIDE;
      data[o] = bp.frame;
      data[o + 1] = a;
      data[o + 2] = 0;
      data[o + 3] = c;
      data[o + 4] = d;
      data[o + 5] = p.x - (a * bp.pivotX + c * bp.pivotY);
      data[o + 6] = p.y - d * bp.pivotY;
      /* A painted plant bends by its weights: the push is in picture pixels and turns with the picture when it is flipped. */
      data[o + 7] = bent ? w.lean * PAINTED_SWAY * info.heightPx * fx : 0;
      data[o + 8] = bent ? PAINTED_FLUTTER_PX * kind.sway.flutter : 0;
      data[o + 9] = bent ? timeSec * Math.PI * 2 * kind.sway.frequency * FLUTTER_SPEEDUP + p.phase : 0;
      data[o + 10] = p.y;

      if (reflections && p.nearWater) {
        /* The plant mirrored about the line through its root: it hangs below the root, over the water. */
        const r = reflN++ * ITEM_STRIDE;
        const rd = reflections.data;
        const rc = -w.lean * 0.5 * m;
        rd.fill(0, r, r + ITEM_STRIDE);
        rd[r] = bp.frame;
        rd[r + 1] = a;
        rd[r + 3] = rc;
        rd[r + 4] = -d * REFLECTION_SQUASH;
        rd[r + 5] = p.x - (a * bp.pivotX + rc * bp.pivotY);
        rd[r + 6] = p.y + d * REFLECTION_SQUASH * bp.pivotY;
      }

      if (info.crown) {
        const cp = info.crown;
        const hubX = p.x + a * info.hubX + c * info.hubY;
        const hubY = p.y + d * info.hubY;
        const shear = w.lean * 0.9;
        const th = w.flutter + w.lean * 0.5;
        const cos = Math.cos(th);
        const sin = Math.sin(th);
        const ca = cos * fx * m;
        const cb = sin * fx * m;
        const cc = -(cos * shear + sin) * m;
        const cd = (-sin * shear + cos) * m;
        o = (bodyBase + bodyN++) * ITEM_STRIDE;
        data.fill(0, o, o + ITEM_STRIDE);
        data[o] = cp.frame;
        data[o + 1] = ca;
        data[o + 2] = cb;
        data[o + 3] = cc;
        data[o + 4] = cd;
        data[o + 5] = hubX - (ca * cp.pivotX + cc * cp.pivotY);
        data[o + 6] = hubY - (cb * cp.pivotX + cd * cp.pivotY);
        data[o + 10] = p.y;
      }

      if (shadows) {
        const sp = info.shadow;
        const m3 = m * SHADOW_DOWNSCALE;
        const sa = fx * m3;
        const sc = -(w.lean * (bent ? 0.2 : 0.9) + this.shadowDir.x * this.shadowLength) * m3;
        const sd = -this.shadowDir.y * this.shadowLength * m3;
        o = (shadowBase + shadowN++) * ITEM_STRIDE;
        data.fill(0, o, o + ITEM_STRIDE);
        data[o] = sp.frame;
        data[o + 1] = sa;
        data[o + 2] = 0;
        data[o + 3] = sc;
        data[o + 4] = sd;
        data[o + 5] = p.x - (sa * sp.pivotX + sc * sp.pivotY);
        data[o + 6] = p.y - sd * sp.pivotY;
      }
    }

    /* Close the gap between the shadow range and the body range when some plants had no picture or lay flat. */
    const shadowEnd = shadowBase + shadowN;
    if (shadows && shadowEnd < bodyBase) {
      data.copyWithin(shadowEnd * ITEM_STRIDE, bodyBase * ITEM_STRIDE, (bodyBase + bodyN) * ITEM_STRIDE);
    }
    if (flatN < shadowBase) {
      data.copyWithin(flatN * ITEM_STRIDE, shadowBase * ITEM_STRIDE, (shadowEnd + bodyN) * ITEM_STRIDE);
    }
    this.leanMin = leanMin === Infinity ? 0 : leanMin;
    this.leanMax = leanMax === -Infinity ? 0 : leanMax;
    out.flatCount = flatN;
    out.shadowCount = flatN + (shadows ? shadowN : 0);
    out.count = out.shadowCount + bodyN;
    if (reflections) {
      reflections.flatCount = 0;
      reflections.shadowCount = 0;
      reflections.count = reflN;
    }
    return plants.length;
  }
}
