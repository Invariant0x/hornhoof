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

/* Floats per draw item: atlas frame, then the affine matrix a, b, c, d, tx, ty (world pixels). */
export const ITEM_STRIDE = 7;
/* The shadow picture is stored at a third of the plant's resolution (see makeShadow). */
export const SHADOW_DOWNSCALE = 3;

export type PlantDrawList = {
  data: Float32Array;
  /* Shadows are items [0, shadowCount); the plants' own parts follow up to count. */
  shadowCount: number;
  count: number;
};

export function createDrawList(): PlantDrawList {
  return { data: new Float32Array(ITEM_STRIDE * 1024), shadowCount: 0, count: 0 };
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

  /* Fills `out` for the plants inside `view` at `timeSec`. Returns the number of plants in view. */
  build(view: WorldRect, timeSec: number, out: PlantDrawList): number {
    const plants = visiblePlants(this.field, view, this.reach);
    const kinds = this.pack.plants ?? [];
    const wind = this.pack.wind;
    const shadows = this.castsShadows;
    ensureCapacity(out, plants.length * 3 + 8);
    const data = out.data;

    /* Bodies are written after the shadows, so lay the shadows out first in their own range. */
    const bodyBase = shadows ? plants.length : 0;
    let shadowN = 0;
    let bodyN = 0;

    for (const p of plants) {
      const kind = kinds[p.kindIndex]!;
      const info = this.sprites[p.kindIndex]?.[p.variant];
      if (!info) continue;
      const m = p.heightPx / info.heightPx;
      const fx = p.flip ? -1 : 1;
      const w = wind ? sampleWind(wind, kind.sway, p.col, p.row, timeSec, p.phase) : { lean: 0, flutter: 0, gust: 0 };

      const twoPart = info.crown !== undefined;
      const baseLean = twoPart ? w.lean * 0.45 : w.lean;
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
        data[o] = cp.frame;
        data[o + 1] = ca;
        data[o + 2] = cb;
        data[o + 3] = cc;
        data[o + 4] = cd;
        data[o + 5] = hubX - (ca * cp.pivotX + cc * cp.pivotY);
        data[o + 6] = hubY - (cb * cp.pivotX + cd * cp.pivotY);
      }

      if (shadows) {
        const sp = info.shadow;
        const m3 = m * SHADOW_DOWNSCALE;
        const sa = fx * m3;
        const sc = -(w.lean * 0.9 + this.shadowDir.x * this.shadowLength) * m3;
        const sd = -this.shadowDir.y * this.shadowLength * m3;
        o = shadowN++ * ITEM_STRIDE;
        data[o] = sp.frame;
        data[o + 1] = sa;
        data[o + 2] = 0;
        data[o + 3] = sc;
        data[o + 4] = sd;
        data[o + 5] = p.x - (sa * sp.pivotX + sc * sp.pivotY);
        data[o + 6] = p.y - sd * sp.pivotY;
      }
    }

    /* Close the gap between the shadow range and the body range when some plants had no picture. */
    if (shadows && shadowN < bodyBase) {
      data.copyWithin(shadowN * ITEM_STRIDE, bodyBase * ITEM_STRIDE, (bodyBase + bodyN) * ITEM_STRIDE);
    }
    out.shadowCount = shadows ? shadowN : 0;
    out.count = out.shadowCount + bodyN;
    return plants.length;
  }
}
