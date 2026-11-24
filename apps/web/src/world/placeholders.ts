/* Placeholders where a pack has no picture yet (#1947 item 11). Each is one flat, one-colour diamond on the ground:
   a building or lot fills its own lot, a resident a small one at its feet, the altar its tile. No outline, no second
   layer, no animation; when the art arrives it simply replaces the placeholder. Contains zero theme-specific words. */

import type { Graphics } from 'pixi.js';
import type { BuildingConstructionState } from './construction';
import type { CityBuilding } from './city-layout';
import { tileTopVertexToWorld, type Point2D } from './coords';
import type { WorldPackManifest } from './manifest';

export type FlatDiamond = readonly [Point2D, Point2D, Point2D, Point2D];

/* The ground diamond of a lot, pulled in by `inset` tiles on each side. */
export function lotDiamond(
  col: number,
  row: number,
  spanCol: number,
  spanRow: number,
  tileW: number,
  tileH: number,
  inset: number,
): FlatDiamond {
  const c0 = col + inset;
  const r0 = row + inset;
  const c1 = col + spanCol - inset;
  const r1 = row + spanRow - inset;
  return [
    tileTopVertexToWorld(c0, r0, tileW, tileH),
    tileTopVertexToWorld(c1, r0, tileW, tileH),
    tileTopVertexToWorld(c1, r1, tileW, tileH),
    tileTopVertexToWorld(c0, r1, tileW, tileH),
  ];
}

/* A small diamond on the ground, centred on a world point (a resident's feet). */
export function pointDiamond(x: number, y: number, tileW: number, tileH: number, size = 0.18): FlatDiamond {
  const hw = tileW * size;
  const hh = tileH * size;
  return [
    { x, y: y - hh },
    { x: x + hw, y },
    { x, y: y + hh },
    { x: x - hw, y },
  ];
}

export function fillDiamondPixi(g: Graphics, d: FlatDiamond, color: number, alpha: number): void {
  g.moveTo(d[0].x, d[0].y).lineTo(d[1].x, d[1].y).lineTo(d[2].x, d[2].y).lineTo(d[3].x, d[3].y).closePath().fill({ color, alpha });
}

export function fillDiamond2D(ctx: CanvasRenderingContext2D, d: FlatDiamond, color: number, alpha: number): void {
  ctx.beginPath();
  ctx.moveTo(d[0].x, d[0].y);
  ctx.lineTo(d[1].x, d[1].y);
  ctx.lineTo(d[2].x, d[2].y);
  ctx.lineTo(d[3].x, d[3].y);
  ctx.closePath();
  ctx.fillStyle = cssColor(color, alpha);
  ctx.fill();
}

export function parseHexColor(color: string | undefined, fallback: number): number {
  if (!color) return fallback;
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  return m ? Number.parseInt(m[1]!, 16) : fallback;
}

function cssColor(hex: number, alpha: number): string {
  return `rgba(${(hex >> 16) & 0xff},${(hex >> 8) & 0xff},${hex & 0xff},${alpha.toFixed(3)})`;
}

const KIND_COLOR: Readonly<Record<CityBuilding['kind'], number>> = {
  residence: 0xe8b948,
  monument: 0xdec48f,
  statue: 0xcfc6b4,
  department: 0x5d84a6,
  district_hub: 0x4b8ca6,
  supply: 0x3fa796,
  flophouse: 0xb5916b,
  house: 0xd5be9b,
};

/* Finished buildings are near opaque; one being built or torn down is fainter, so the lot reads as work in progress. */
const BUILT_ALPHA = 0.85;
const WORK_ALPHA = 0.45;

export type BuildingPlaceholder = Readonly<{ diamond: FlatDiamond; color: number; alpha: number }>;

/* The single placeholder of a building: its lot, in the colour of its kind (a hub in its district's, a supply and an
   agent home in their provider's). */
export function buildingPlaceholder(
  b: CityBuilding,
  pack: WorldPackManifest,
  districtColors: Readonly<Record<string, string>>,
  job: BuildingConstructionState | null,
  tileW: number,
  tileH: number,
): BuildingPlaceholder {
  const base = KIND_COLOR[b.kind];
  const color =
    b.kind === 'district_hub'
      ? parseHexColor(b.districtId ? districtColors[b.districtId] : undefined, base)
      : b.kind === 'supply' || b.kind === 'house'
        ? parseHexColor(b.provider ? pack.palette.providers[b.provider] : undefined, base)
        : base;
  const working = job !== null && job.phase !== 'complete';
  return {
    diamond: lotDiamond(b.col, b.row, b.spanCol, b.spanRow, tileW, tileH, b.spanCol >= 3 ? 0.08 : 0.12),
    color,
    alpha: working ? WORK_ALPHA : BUILT_ALPHA,
  };
}
