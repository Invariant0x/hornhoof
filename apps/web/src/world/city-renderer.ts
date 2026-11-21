/* Pack-agnostic 2:1 isometric placeholder renderer for Stage 4 live cities.
   Draws roads, bridges, optional outer city walls, empty-lot construction stakes,
   depth-sorted geometric placeholder structures (residence, goal monuments, departments,
   machine hubs, supply silos with fullness levels, statue alleys, agent homes, flophouses),
   and pending God's Word relocation overlays. Contains zero theme-specific words. */

import type { WorldMode } from '@hornhoof/protocol/world';
import type { Graphics } from 'pixi.js';
import type { CityBuilding, CityState, RoadTier } from './city-layout';
import {
  tileCenterToWorld,
  tileDiamondVertices,
  tileTopVertexToWorld,
  type TileCoord,
} from './coords';
import type { WorldPackManifest } from './manifest';

export type RelocationTargetPreview = Readonly<{
  col: number;
  row: number;
  spanCol: number;
  spanRow: number;
  valid: boolean;
}>;

export type CityRenderState = Readonly<{
  city: CityState;
  worldMode: WorldMode;
  emptyLotStakes?: readonly TileCoord[];
  districtColors?: Readonly<Record<string, string>>;
  relocationPreview?: RelocationTargetPreview | null;
}>;

function parseHex(color: string | undefined, fallback: number): number {
  if (!color) return fallback;
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  return m ? Number.parseInt(m[1]!, 16) : fallback;
}

function shadeHex(hex: number, factor: number): number {
  const r = Math.min(255, Math.max(0, Math.round(((hex >> 16) & 0xff) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(((hex >> 8) & 0xff) * factor)));
  const b = Math.min(255, Math.max(0, Math.round((hex & 0xff) * factor)));
  return (r << 16) | (g << 8) | b;
}

function hexToCss(hex: number, alpha = 1): string {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return alpha >= 0.999 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}

const ROAD_COLORS: Readonly<Record<RoadTier, { fill: number; stroke: number; alpha: number }>> = {
  trail: { fill: 0xb79b72, stroke: 0x8e7450, alpha: 0.62 },
  dirt: { fill: 0xc2a376, stroke: 0x92754d, alpha: 0.78 },
  brick: { fill: 0xbd8861, stroke: 0x7f563a, alpha: 0.88 },
  stone: { fill: 0xc8c2b6, stroke: 0x80796d, alpha: 0.93 },
};

type IsoQuad = {
  top: { x: number; y: number };
  right: { x: number; y: number };
  bottom: { x: number; y: number };
  left: { x: number; y: number };
};

function footprintQuad(
  col: number,
  row: number,
  spanCol: number,
  spanRow: number,
  tileW: number,
  tileH: number,
  inset = 0.08,
): IsoQuad {
  const c0 = col + inset;
  const r0 = row + inset;
  const c1 = col + spanCol - inset;
  const r1 = row + spanRow - inset;
  return {
    top: tileTopVertexToWorld(c0, r0, tileW, tileH),
    right: tileTopVertexToWorld(c1, r0, tileW, tileH),
    bottom: tileTopVertexToWorld(c1, r1, tileW, tileH),
    left: tileTopVertexToWorld(c0, r1, tileW, tileH),
  };
}

function drawIsoPrismPixi(
  g: Graphics,
  q: IsoQuad,
  height: number,
  topColor: number,
  leftColor: number,
  rightColor: number,
  outlineColor = 0x241d16,
  outlineAlpha = 0.55,
): void {
  /* Ground drop shadow toward bottom-right (sun from top-left). */
  const shOff = Math.min(18, height * 0.22);
  g.moveTo(q.right.x, q.right.y)
    .lineTo(q.right.x + shOff, q.right.y + shOff * 0.45)
    .lineTo(q.bottom.x + shOff, q.bottom.y + shOff * 0.45)
    .lineTo(q.bottom.x, q.bottom.y)
    .closePath()
    .fill({ color: 0x100c08, alpha: 0.24 });

  /* Left vertical wall (brighter sun-facing side). */
  g.moveTo(q.left.x, q.left.y)
    .lineTo(q.bottom.x, q.bottom.y)
    .lineTo(q.bottom.x, q.bottom.y - height)
    .lineTo(q.left.x, q.left.y - height)
    .closePath()
    .fill({ color: leftColor, alpha: 1 })
    .stroke({ color: outlineColor, alpha: outlineAlpha, width: 1.1 });

  /* Right vertical wall (shaded side). */
  g.moveTo(q.bottom.x, q.bottom.y)
    .lineTo(q.right.x, q.right.y)
    .lineTo(q.right.x, q.right.y - height)
    .lineTo(q.bottom.x, q.bottom.y - height)
    .closePath()
    .fill({ color: rightColor, alpha: 1 })
    .stroke({ color: outlineColor, alpha: outlineAlpha, width: 1.1 });

  /* Top roof face. */
  g.moveTo(q.top.x, q.top.y - height)
    .lineTo(q.right.x, q.right.y - height)
    .lineTo(q.bottom.x, q.bottom.y - height)
    .lineTo(q.left.x, q.left.y - height)
    .closePath()
    .fill({ color: topColor, alpha: 1 })
    .stroke({ color: outlineColor, alpha: outlineAlpha, width: 1.1 });
}

function drawIsoPyramidPixi(
  g: Graphics,
  q: IsoQuad,
  baseHeight: number,
  apexHeight: number,
  leftColor: number,
  rightColor: number,
  reached: boolean,
): void {
  const cx = (q.top.x + q.bottom.x) * 0.5;
  const cy = (q.top.y + q.bottom.y) * 0.5;
  const apexY = cy - baseHeight - apexHeight;

  /* Base plinth. */
  drawIsoPrismPixi(g, q, baseHeight, shadeHex(leftColor, 1.05), leftColor, rightColor);

  /* Sloped left & right faces rising to truncated plateau or finished apex. */
  if (reached) {
    g.moveTo(q.left.x, q.left.y - baseHeight)
      .lineTo(q.bottom.x, q.bottom.y - baseHeight)
      .lineTo(cx, apexY)
      .closePath()
      .fill({ color: leftColor, alpha: 1 })
      .stroke({ color: 0x3a2c1c, alpha: 0.55, width: 1.1 });

    g.moveTo(q.bottom.x, q.bottom.y - baseHeight)
      .lineTo(q.right.x, q.right.y - baseHeight)
      .lineTo(cx, apexY)
      .closePath()
      .fill({ color: rightColor, alpha: 1 })
      .stroke({ color: 0x3a2c1c, alpha: 0.55, width: 1.1 });

    /* Golden capstone at peak + celebratory glowing ring. */
    const capFrac = 0.24;
    const lx = cx + (q.left.x - cx) * capFrac;
    const ly = apexY + (q.left.y - baseHeight - apexY) * capFrac;
    const bx = cx + (q.bottom.x - cx) * capFrac;
    const by = apexY + (q.bottom.y - baseHeight - apexY) * capFrac;
    const rx = cx + (q.right.x - cx) * capFrac;
    const ry = apexY + (q.right.y - baseHeight - apexY) * capFrac;

    g.moveTo(lx, ly).lineTo(bx, by).lineTo(cx, apexY).closePath().fill({ color: 0xffdc66, alpha: 1 });
    g.moveTo(bx, by).lineTo(rx, ry).lineTo(cx, apexY).closePath().fill({ color: 0xdca428, alpha: 1 });
    g.circle(cx, apexY - 6, 12).fill({ color: 0xffe88c, alpha: 0.34 });
    g.circle(cx, apexY - 6, 5).fill({ color: 0xfff5c0, alpha: 0.95 });
  } else {
    /* Stepped construction tiers proportional to progress. */
    const tiers = Math.max(2, Math.min(6, Math.round((apexHeight / 28) + 1)));
    for (let t = 0; t < tiers; t++) {
      const f0 = (t / (tiers + 0.6)) * 0.62;
      const tierH = apexHeight / tiers;
      const yOff = baseHeight + t * tierH;
      const tq: IsoQuad = {
        top: { x: q.top.x + (cx - q.top.x) * f0, y: q.top.y + (cy - q.top.y) * f0 - yOff },
        right: { x: q.right.x + (cx - q.right.x) * f0, y: q.right.y + (cy - q.right.y) * f0 - yOff },
        bottom: { x: q.bottom.x + (cx - q.bottom.x) * f0, y: q.bottom.y + (cy - q.bottom.y) * f0 - yOff },
        left: { x: q.left.x + (cx - q.left.x) * f0, y: q.left.y + (cy - q.left.y) * f0 - yOff },
      };
      drawIsoPrismPixi(
        g,
        tq,
        tierH,
        shadeHex(leftColor, 1.08),
        shadeHex(leftColor, 0.96),
        shadeHex(rightColor, 0.95),
      );
    }
  }
}

function drawFlagMastPixi(g: Graphics, x: number, y: number, poleH: number, flagColor: number): void {
  g.moveTo(x, y)
    .lineTo(x, y - poleH)
    .stroke({ color: 0x3b2c1d, alpha: 0.95, width: 2 });
  g.moveTo(x, y - poleH)
    .lineTo(x + 15, y - poleH + 5)
    .lineTo(x, y - poleH + 11)
    .closePath()
    .fill({ color: flagColor, alpha: 0.98 })
    .stroke({ color: 0x221911, alpha: 0.7, width: 1 });
}

function drawRestingBadgePixi(g: Graphics, x: number, y: number): void {
  g.circle(x, y, 8).fill({ color: 0x263244, alpha: 0.88 }).stroke({ color: 0x99b8e0, alpha: 0.9, width: 1.4 });
  g.circle(x - 1.5, y, 4.2).fill({ color: 0xcbe0ff, alpha: 0.95 });
  g.circle(x + 1.2, y - 0.8, 3.6).fill({ color: 0x263244, alpha: 1 });
}

function drawEmptyLotPropsPixi(
  g: Graphics,
  stakes: readonly TileCoord[],
  center: TileCoord,
  tileW: number,
  tileH: number,
): void {
  if (stakes.length === 0) return;
  /* Survey rope connecting perimeter stakes. */
  const pts = stakes.map(s => tileCenterToWorld(s.col, s.row, tileW, tileH));
  g.moveTo(pts[0]!.x, pts[0]!.y - 12);
  for (let i = 1; i < pts.length; i++) {
    g.lineTo(pts[i]!.x, pts[i]!.y - 12);
  }
  g.closePath().stroke({ color: 0xd9be8a, alpha: 0.88, width: 2 });

  /* Wooden survey stakes with red/gold flags. */
  for (const pt of pts) {
    g.moveTo(pt.x, pt.y + 2)
      .lineTo(pt.x, pt.y - 20)
      .stroke({ color: 0x5c3e24, alpha: 1, width: 3.2 });
    g.moveTo(pt.x, pt.y - 20)
      .lineTo(pt.x + 10, pt.y - 16)
      .lineTo(pt.x, pt.y - 12)
      .closePath()
      .fill({ color: 0xe05d44, alpha: 0.95 });
  }

  /* Timber board stacks beside the starter camp. */
  for (const [dc, dr] of [
    [-2, 1],
    [2, -1],
  ] as const) {
    const q = footprintQuad(center.col + dc, center.row + dr, 1, 1, tileW, tileH, 0.24);
    drawIsoPrismPixi(g, q, 6, 0xc99c62, 0xa87c45, 0x845d31);
    const q2 = footprintQuad(center.col + dc, center.row + dr, 1, 1, tileW, tileH, 0.31);
    drawIsoPrismPixi(g, q2, 11, 0xd8ae74, 0xb5884f, 0x906839);
  }
}

function drawBuildingPixi(
  g: Graphics,
  b: CityBuilding,
  pack: WorldPackManifest,
  districtColors: Readonly<Record<string, string>>,
  tileW: number,
  tileH: number,
): void {
  const q = footprintQuad(b.col, b.row, b.spanCol, b.spanRow, tileW, tileH, b.spanCol >= 3 ? 0.08 : 0.12);
  const cx = (q.top.x + q.bottom.x) * 0.5;
  const cy = (q.top.y + q.bottom.y) * 0.5;
  const providerColor = b.provider ? parseHex(pack.palette.providers[b.provider], 0xc96a4b) : 0xb89b6a;
  const districtColor = b.districtId ? parseHex(districtColors[b.districtId], 0x4b8ca6) : 0xc8943a;

  if (b.kind === 'residence') {
    if (b.stage <= 1) {
      /* Stage 1 starter camp tent (pitched triangular roof over low ground sheet). */
      drawIsoPrismPixi(g, q, 6, 0xcab082, 0xa98d62, 0x8a704b);
      const peakH = b.resting ? 26 : 36;
      g.moveTo(q.left.x, q.left.y - 6)
        .lineTo(q.bottom.x, q.bottom.y - 6)
        .lineTo(cx, cy - peakH)
        .closePath()
        .fill({ color: 0xe6d3a7, alpha: 1 })
        .stroke({ color: 0x4d3a24, alpha: 0.7, width: 1.2 });
      g.moveTo(q.bottom.x, q.bottom.y - 6)
        .lineTo(q.right.x, q.right.y - 6)
        .lineTo(cx, cy - peakH)
        .closePath()
        .fill({ color: 0xc2ab7d, alpha: 1 })
        .stroke({ color: 0x4d3a24, alpha: 0.7, width: 1.2 });
      drawFlagMastPixi(g, cx, cy - peakH, 16, 0xe8b948);
    } else {
      const h = 22 + b.stage * 11;
      const baseColor = b.stage >= 4 ? 0xe7d6b1 : b.stage >= 3 ? 0xd9c7a3 : 0xcbb086;
      drawIsoPrismPixi(g, q, h, shadeHex(baseColor, 1.07), baseColor, shadeHex(baseColor, 0.8));
      /* Upper royal tier + golden crown trim on Stages 3..5. */
      const inner = footprintQuad(b.col, b.row, b.spanCol, b.spanRow, tileW, tileH, Math.min(0.45, b.spanCol * 0.22));
      const innerQ: IsoQuad = {
        top: { x: inner.top.x, y: inner.top.y - h },
        right: { x: inner.right.x, y: inner.right.y - h },
        bottom: { x: inner.bottom.x, y: inner.bottom.y - h },
        left: { x: inner.left.x, y: inner.left.y - h },
      };
      drawIsoPrismPixi(g, innerQ, 14 + b.stage * 4, 0xf3e4c2, 0xe3cf9f, 0xc3aa79);
      drawFlagMastPixi(g, cx, cy - h - 14 - b.stage * 4, 22, 0xf2c14e);
    }
    if (b.resting) drawRestingBadgePixi(g, cx, cy - 54);
    return;
  }

  if (b.kind === 'monument') {
    const progress = Math.max(0.12, Math.min(1, b.progress ?? b.stage / Math.max(1, b.maxStage)));
    const maxApex = 38 + b.spanCol * 22;
    const apexH = maxApex * (b.reached ? 1 : progress);
    drawIsoPyramidPixi(g, q, 10, apexH, 0xdec48f, 0xb89c68, Boolean(b.reached));
    return;
  }

  if (b.kind === 'department') {
    const h = 24 + b.stage * 5;
    drawIsoPrismPixi(g, q, h, 0xdfd3be, 0xc8b99e, 0xa5957a);
    /* Stepped civic hall roof cap + banner. */
    const roof = footprintQuad(b.col, b.row, b.spanCol, b.spanRow, tileW, tileH, 0.35);
    const roofQ: IsoQuad = {
      top: { x: roof.top.x, y: roof.top.y - h },
      right: { x: roof.right.x, y: roof.right.y - h },
      bottom: { x: roof.bottom.x, y: roof.bottom.y - h },
      left: { x: roof.left.x, y: roof.left.y - h },
    };
    drawIsoPrismPixi(g, roofQ, 12, 0x5d84a6, 0x456989, 0x32506b);
    drawFlagMastPixi(g, cx, cy - h - 12, 20, 0x5ca6e6);
    if (b.resting) drawRestingBadgePixi(g, cx + 14, cy - h - 24);
    return;
  }

  if (b.kind === 'district_hub') {
    const h = 20 + b.spanCol * 7;
    const wall = b.resting ? 0x6f7582 : 0x99a6b5;
    drawIsoPrismPixi(g, q, h, shadeHex(wall, 1.12), wall, shadeHex(wall, 0.78));
    /* District colour stripe band across top cap + flag pole. */
    const cap = footprintQuad(b.col, b.row, b.spanCol, b.spanRow, tileW, tileH, 0.34);
    const capQ: IsoQuad = {
      top: { x: cap.top.x, y: cap.top.y - h },
      right: { x: cap.right.x, y: cap.right.y - h },
      bottom: { x: cap.bottom.x, y: cap.bottom.y - h },
      left: { x: cap.left.x, y: cap.left.y - h },
    };
    drawIsoPrismPixi(g, capQ, 10, shadeHex(districtColor, 1.14), districtColor, shadeHex(districtColor, 0.76));
    drawFlagMastPixi(g, cx, cy - h - 10, 24, districtColor);
    if (b.resting) drawRestingBadgePixi(g, cx + 16, cy - h - 22);
    return;
  }

  if (b.kind === 'supply') {
    const fullness = Math.max(0, Math.min(1, b.fullness ?? 0.5));
    const maxH = 38;
    const emptyShell = 0x9c8e7a;
    /* Outer silo frame. */
    drawIsoPrismPixi(g, q, 14, 0xc3b49b, emptyShell, 0x7c705f);
    /* Live fullness level rising inside the granary/well basin. */
    if (fullness > 0.02) {
      const fillH = Math.max(6, Math.round(fullness * maxH));
      const inner = footprintQuad(b.col, b.row, b.spanCol, b.spanRow, tileW, tileH, 0.28);
      const innerQ: IsoQuad = {
        top: { x: inner.top.x, y: inner.top.y - 12 },
        right: { x: inner.right.x, y: inner.right.y - 12 },
        bottom: { x: inner.bottom.x, y: inner.bottom.y - 12 },
        left: { x: inner.left.x, y: inner.left.y - 12 },
      };
      drawIsoPrismPixi(g, innerQ, fillH, shadeHex(providerColor, 1.18), providerColor, shadeHex(providerColor, 0.78));
    } else {
      /* Empty supply emblem (dry basin). */
      g.circle(cx, cy - 16, 7).fill({ color: 0x3b2c26, alpha: 0.85 }).stroke({ color: 0xe26a5a, alpha: 0.95, width: 1.6 });
    }
    return;
  }

  if (b.kind === 'statue') {
    const ratio = Math.max(0.08, Math.min(1, b.stage / Math.max(1, b.maxStage)));
    const plinthH = 8 + b.spanCol * 3;
    drawIsoPrismPixi(g, q, plinthH, 0xd0c6b3, 0xb8ad98, 0x928772);
    const colH = Math.round((20 + b.spanCol * 18) * ratio);
    const mono = footprintQuad(b.col, b.row, b.spanCol, b.spanRow, tileW, tileH, 0.34);
    const monoQ: IsoQuad = {
      top: { x: mono.top.x, y: mono.top.y - plinthH },
      right: { x: mono.right.x, y: mono.right.y - plinthH },
      bottom: { x: mono.bottom.x, y: mono.bottom.y - plinthH },
      left: { x: mono.left.x, y: mono.left.y - plinthH },
    };
    const statueColor = b.reached ? 0xe8c468 : 0xc6baa6;
    drawIsoPrismPixi(g, monoQ, colH, shadeHex(statueColor, 1.1), statueColor, shadeHex(statueColor, 0.78));
    return;
  }

  if (b.kind === 'flophouse') {
    const h = 16 + b.stage * 4;
    drawIsoPrismPixi(g, q, h, 0xb5916b, 0x98744f, 0x78593a);
    drawFlagMastPixi(g, cx, cy - h, 14, 0xd69652);
    return;
  }

  /* Agent home ('house'): grows in height, footprint & upper terrace with canonical agent level. */
  const stageH = 14 + Math.min(10, b.stage) * 3.5 + (b.floors - 1) * 7;
  const wallColor = b.level >= 6 ? 0xe4d2b4 : b.level >= 3 ? 0xd5be9b : 0xc4aa85;
  drawIsoPrismPixi(g, q, stageH, shadeHex(wallColor, 1.07), wallColor, shadeHex(wallColor, 0.8));

  /* Provider-coloured roof awning / trim band. */
  const trim = footprintQuad(b.col, b.row, b.spanCol, b.spanRow, tileW, tileH, 0.24);
  const trimQ: IsoQuad = {
    top: { x: trim.top.x, y: trim.top.y - stageH },
    right: { x: trim.right.x, y: trim.right.y - stageH },
    bottom: { x: trim.bottom.x, y: trim.bottom.y - stageH },
    left: { x: trim.left.x, y: trim.left.y - stageH },
  };
  drawIsoPrismPixi(g, trimQ, 4 + Math.min(8, Math.floor(b.level / 2)), shadeHex(providerColor, 1.15), providerColor, shadeHex(providerColor, 0.78));
  drawFlagMastPixi(g, cx + 6, cy - stageH - 4, 13, districtColor);
  if (b.resting) {
    drawRestingBadgePixi(g, cx - 8, cy - stageH - 14);
  }
}

/* Rebuilds the cached static isometric city geometry layer inside a PixiJS Graphics object.
   Called ONLY when city state changes (never per pan/zoom frame). */
export function renderCityToPixi(
  g: Graphics,
  state: CityRenderState,
  pack: WorldPackManifest,
  tileW: number,
  tileH: number,
): void {
  g.clear();
  const { city } = state;
  const districtColors = state.districtColors ?? {};

  /* 1. Roads and bridges. */
  for (const road of city.roads.values()) {
    const pts = tileDiamondVertices(road.col, road.row, tileW, tileH);
    const style = road.bridge
      ? { fill: 0x9b6d3f, stroke: 0x593a1d, alpha: 0.96 }
      : ROAD_COLORS[road.tier];
    g.moveTo(pts[0].x, pts[0].y)
      .lineTo(pts[1].x, pts[1].y)
      .lineTo(pts[2].x, pts[2].y)
      .lineTo(pts[3].x, pts[3].y)
      .closePath()
      .fill({ color: style.fill, alpha: style.alpha })
      .stroke({ color: style.stroke, alpha: 0.42, width: 1 });
  }

  /* 2. Optional outer city wall (empty for packs with outerWallMode: 'none'). */
  if (city.wallTiles.size > 0) {
    const wallCoords: TileCoord[] = [];
    for (const key of city.wallTiles) {
      const [cStr, rStr] = key.split(',');
      wallCoords.push({ col: Number(cStr), row: Number(rStr) });
    }
    wallCoords.sort((a, b) => a.col + a.row - (b.col + b.row));
    for (const pt of wallCoords) {
      const wq = footprintQuad(pt.col, pt.row, 1, 1, tileW, tileH, 0.06);
      drawIsoPrismPixi(g, wq, 18, 0xbab09f, 0x9c9281, 0x7c7364, 0x3b342b, 0.65);
    }
  }

  /* 3. Empty-lot survey stakes & plank stacks for brand-new companies without a template. */
  if (state.worldMode === 'empty_lot' && state.emptyLotStakes && state.emptyLotStakes.length > 0) {
    drawEmptyLotPropsPixi(g, state.emptyLotStakes, city.center, tileW, tileH);
  }

  /* 4. Depth-sorted placeholder structures. */
  const sorted = [...city.buildings].sort((a, b) => {
    const da = a.col + a.row + (a.spanCol + a.spanRow) * 0.5;
    const db = b.col + b.row + (b.spanCol + b.spanRow) * 0.5;
    return da - db || a.col - b.col;
  });
  for (const b of sorted) {
    drawBuildingPixi(g, b, pack, districtColors, tileW, tileH);
  }

  /* 5. Pending God's Word relocation destination markers (building itself stays at old tile!). */
  for (const b of sorted) {
    const pend = b.pendingRelocation;
    if (!pend) continue;
    const fromPt = tileCenterToWorld(b.col + b.spanCol * 0.5 - 0.5, b.row + b.spanRow * 0.5 - 0.5, tileW, tileH);
    const toPt = tileCenterToWorld(pend.toCol + b.spanCol * 0.5 - 0.5, pend.toRow + b.spanRow * 0.5 - 0.5, tileW, tileH);
    const tq = footprintQuad(pend.toCol, pend.toRow, b.spanCol, b.spanRow, tileW, tileH, 0.05);
    g.moveTo(tq.top.x, tq.top.y)
      .lineTo(tq.right.x, tq.right.y)
      .lineTo(tq.bottom.x, tq.bottom.y)
      .lineTo(tq.left.x, tq.left.y)
      .closePath()
      .fill({ color: 0xffd166, alpha: 0.25 })
      .stroke({ color: 0xffd166, alpha: 0.96, width: 2.4 });
    g.moveTo(fromPt.x, fromPt.y - 24)
      .lineTo(toPt.x, toPt.y - 8)
      .stroke({ color: 0xffd166, alpha: 0.9, width: 2.2 });
    g.circle(toPt.x, toPt.y - 8, 5).fill({ color: 0xffd166, alpha: 1 });
  }
}

/* Canvas 2D fallback renderer for environments without WebGL. */
export function renderCityFallback2D(
  ctx: CanvasRenderingContext2D,
  state: CityRenderState,
  pack: WorldPackManifest,
  tileW: number,
  tileH: number,
): void {
  const { city } = state;
  const districtColors = state.districtColors ?? {};

  for (const road of city.roads.values()) {
    const pts = tileDiamondVertices(road.col, road.row, tileW, tileH);
    const style = road.bridge ? { fill: 0x9b6d3f, alpha: 0.96 } : ROAD_COLORS[road.tier];
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.lineTo(pts[2].x, pts[2].y);
    ctx.lineTo(pts[3].x, pts[3].y);
    ctx.closePath();
    ctx.fillStyle = hexToCss(style.fill, style.alpha);
    ctx.fill();
  }

  const sorted = [...city.buildings].sort((a, b) => a.col + a.row - (b.col + b.row));
  for (const b of sorted) {
    const q = footprintQuad(b.col, b.row, b.spanCol, b.spanRow, tileW, tileH, 0.1);
    const h = 18 + b.stage * 4;
    const baseHex =
      b.kind === 'monument'
        ? 0xdec48f
        : b.kind === 'department'
          ? 0x5d84a6
          : b.kind === 'district_hub'
            ? parseHex(b.districtId ? districtColors[b.districtId] : undefined, 0x4b8ca6)
            : b.kind === 'supply'
              ? parseHex(b.provider ? pack.palette.providers[b.provider] : undefined, 0x3fa796)
              : 0xd5be9b;

    ctx.beginPath();
    ctx.moveTo(q.left.x, q.left.y);
    ctx.lineTo(q.bottom.x, q.bottom.y);
    ctx.lineTo(q.bottom.x, q.bottom.y - h);
    ctx.lineTo(q.left.x, q.left.y - h);
    ctx.closePath();
    ctx.fillStyle = hexToCss(baseHex);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(q.bottom.x, q.bottom.y);
    ctx.lineTo(q.right.x, q.right.y);
    ctx.lineTo(q.right.x, q.right.y - h);
    ctx.lineTo(q.bottom.x, q.bottom.y - h);
    ctx.closePath();
    ctx.fillStyle = hexToCss(shadeHex(baseHex, 0.78));
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(q.top.x, q.top.y - h);
    ctx.lineTo(q.right.x, q.right.y - h);
    ctx.lineTo(q.bottom.x, q.bottom.y - h);
    ctx.lineTo(q.left.x, q.left.y - h);
    ctx.closePath();
    ctx.fillStyle = hexToCss(shadeHex(baseHex, 1.1));
    ctx.fill();
  }
}
