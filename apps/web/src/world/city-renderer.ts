/* Pack-agnostic 2:1 isometric placeholder renderer for Stage 4 live cities.
   Draws roads, bridges, optional outer city walls, empty-lot construction stakes,
   depth-sorted geometric placeholder structures (residence, goal monuments, departments,
   machine hubs, supply silos with fullness levels, statue alleys, agent homes, flophouses),
   and pending God's Word relocation overlays. Contains zero theme-specific words. */

import type { WorldMode } from '@hornhoof/protocol/world';
import type { Graphics } from 'pixi.js';
import { artFootprintCentre, resolveBuildingArt, type BuildingArt } from './art';
import { parseArtTint, type DisplayRunPool, type WorldArtLibrary } from './art-runtime';
import type { CityBuilding, CityState, RoadTier } from './city-layout';
import {
  resolveStageSpecForBuilding,
  type BuildingConstructionState,
} from './construction';
import {
  tileCenterToWorld,
  tileDiamondVertices,
  tileTopVertexToWorld,
  type TileCoord,
} from './coords';
import { resolveConstructionPalette, type WorldPackManifest } from './manifest';

export type RelocationTargetPreview = Readonly<{
  col: number;
  row: number;
  spanCol: number;
  spanRow: number;
  valid: boolean;
}>;

export type TileWindow = Readonly<{
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
}>;

/* Artist pictures for buildings: drawn as sprites in the pool, with placeholders between them in depth order. */
export type CityArtContext = Readonly<{
  library: WorldArtLibrary;
  pool: DisplayRunPool;
  upgradingHouseIds?: ReadonlySet<string>;
}>;

const DEPARTMENT_BANNER_COLOR = '#5CA6E6';

export type CityRenderState = Readonly<{
  city: CityState;
  worldMode: WorldMode;
  emptyLotStakes?: readonly TileCoord[];
  districtColors?: Readonly<Record<string, string>>;
  relocationPreview?: RelocationTargetPreview | null;
  constructionJobs?: ReadonlyMap<string, BuildingConstructionState>;
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
  withStroke = true,
): void {
  /* Ground drop shadow toward bottom-right (sun from top-left). */
  const shOff = Math.min(18, height * 0.22);
  g.moveTo(q.right.x, q.right.y)
    .lineTo(q.right.x + shOff, q.right.y + shOff * 0.45)
    .lineTo(q.bottom.x + shOff, q.bottom.y + shOff * 0.45)
    .lineTo(q.bottom.x, q.bottom.y)
    .closePath()
    .fill({ color: 0x100c08, alpha: 0.22 });

  /* Left vertical wall (brighter sun-facing side). */
  g.moveTo(q.left.x, q.left.y)
    .lineTo(q.bottom.x, q.bottom.y)
    .lineTo(q.bottom.x, q.bottom.y - height)
    .lineTo(q.left.x, q.left.y - height)
    .closePath()
    .fill({ color: leftColor, alpha: 1 });
  if (withStroke) g.stroke({ color: outlineColor, alpha: outlineAlpha, width: 1.0 });

  /* Right vertical wall (shaded side). */
  g.moveTo(q.bottom.x, q.bottom.y)
    .lineTo(q.right.x, q.right.y)
    .lineTo(q.right.x, q.right.y - height)
    .lineTo(q.bottom.x, q.bottom.y - height)
    .closePath()
    .fill({ color: rightColor, alpha: 1 });
  if (withStroke) g.stroke({ color: outlineColor, alpha: outlineAlpha, width: 1.0 });

  /* Top roof face. */
  g.moveTo(q.top.x, q.top.y - height)
    .lineTo(q.right.x, q.right.y - height)
    .lineTo(q.bottom.x, q.bottom.y - height)
    .lineTo(q.left.x, q.left.y - height)
    .closePath()
    .fill({ color: topColor, alpha: 1 });
  if (withStroke) g.stroke({ color: outlineColor, alpha: outlineAlpha, width: 1.0 });
}

function drawIsoPyramidPixi(
  g: Graphics,
  q: IsoQuad,
  baseHeight: number,
  apexHeight: number,
  leftColor: number,
  rightColor: number,
  reached: boolean,
  capstoneColor = 0xffdc66,
  rampColor = 0xc9ad7f,
  tierCount = 5,
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

    /* Gleaming apex capstone + celebratory glowing halo. */
    const capFrac = 0.24;
    const lx = cx + (q.left.x - cx) * capFrac;
    const ly = apexY + (q.left.y - baseHeight - apexY) * capFrac;
    const bx = cx + (q.bottom.x - cx) * capFrac;
    const by = apexY + (q.bottom.y - baseHeight - apexY) * capFrac;
    const rx = cx + (q.right.x - cx) * capFrac;
    const ry = apexY + (q.right.y - baseHeight - apexY) * capFrac;

    g.moveTo(lx, ly).lineTo(bx, by).lineTo(cx, apexY).closePath().fill({ color: capstoneColor, alpha: 1 });
    g.moveTo(bx, by).lineTo(rx, ry).lineTo(cx, apexY).closePath().fill({ color: shadeHex(capstoneColor, 0.84), alpha: 1 });
    g.circle(cx, apexY - 6, 12).fill({ color: capstoneColor, alpha: 0.34 });
    g.circle(cx, apexY - 6, 5).fill({ color: 0xfff7cc, alpha: 0.96 });
  } else {
    /* Stepped masonry tiers proportional to progress (1..10 tiers) + earthen haul ramp on front face. */
    const tiers = Math.max(1, Math.min(10, tierCount));
    const tierH = apexHeight / Math.max(1, tiers);
    let topEdgeX = q.bottom.x;
    let topEdgeY = q.bottom.y - baseHeight;
    for (let t = 0; t < tiers; t++) {
      const f0 = (t / (Math.max(2, tiers) + 1.1)) * 0.72;
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
      topEdgeX = (tq.bottom.x + tq.right.x) * 0.5;
      topEdgeY = (tq.bottom.y + tq.right.y) * 0.5 - tierH;
    }

    /* Sloped earthen construction ramp hugging the front-right face up to the active top tier. */
    const rampFootX = (q.bottom.x + q.right.x) * 0.5 + 14;
    const rampFootY = (q.bottom.y + q.right.y) * 0.5 + 8;
    g.moveTo(rampFootX - 10, rampFootY + 4)
      .lineTo(rampFootX + 10, rampFootY - 4)
      .lineTo(topEdgeX + 7, topEdgeY - 2)
      .lineTo(topEdgeX - 7, topEdgeY + 4)
      .closePath()
      .fill({ color: rampColor, alpha: 0.95 });
    g.moveTo(rampFootX - 10, rampFootY + 4)
      .lineTo(topEdgeX - 7, topEdgeY + 4)
      .lineTo(topEdgeX - 7, topEdgeY + 12)
      .lineTo(rampFootX - 10, rampFootY + 10)
      .closePath()
      .fill({ color: shadeHex(rampColor, 0.78), alpha: 0.95 });
  }
}

/* Draws timber/iron scaffolding frame + optional earthen haul ramp around a structure under construction. */
function drawScaffoldAndRampPixi(
  g: Graphics,
  q: IsoQuad,
  height: number,
  woodHex: number,
  rampHex: number,
  withRamp: boolean,
): void {
  const scH = Math.max(16, height + 6);
  for (const pt of [q.left, q.bottom, q.right]) {
    g.rect(pt.x - 1.8, pt.y - scH, 3.6, scH + 2).fill({ color: shadeHex(woodHex, 0.85), alpha: 0.96 });
  }
  const levels = scH > 32 ? [0.38, 0.74, 0.96] : [0.5, 0.92];
  for (const frac of levels) {
    const yOff = scH * frac;
    g.moveTo(q.left.x, q.left.y - yOff)
      .lineTo(q.bottom.x, q.bottom.y - yOff)
      .lineTo(q.right.x, q.right.y - yOff)
      .stroke({ color: woodHex, alpha: 0.96, width: 2.5 });
  }
  /* Diagonal structural cross-braces on both front faces. */
  g.moveTo(q.left.x, q.left.y - 3)
    .lineTo(q.bottom.x, q.bottom.y - scH * 0.85)
    .moveTo(q.bottom.x, q.bottom.y - 3)
    .lineTo(q.right.x, q.right.y - scH * 0.85)
    .stroke({ color: shadeHex(woodHex, 0.78), alpha: 0.84, width: 1.5 });

  if (withRamp) {
    const midX = (q.bottom.x + q.right.x) * 0.5;
    const midY = (q.bottom.y + q.right.y) * 0.5;
    const footX = midX + 22;
    const footY = midY + 12;
    g.moveTo(footX - 8, footY + 3)
      .lineTo(footX + 8, footY - 3)
      .lineTo(midX + 6, midY - height * 0.78 - 2)
      .lineTo(midX - 6, midY - height * 0.78 + 3)
      .closePath()
      .fill({ color: rampHex, alpha: 0.96 });
    g.moveTo(footX - 8, footY + 3)
      .lineTo(midX - 6, midY - height * 0.78 + 3)
      .lineTo(midX - 6, midY + 2)
      .lineTo(footX - 8, footY + 7)
      .closePath()
      .fill({ color: shadeHex(rampHex, 0.76), alpha: 0.94 });
  }
}

/* Draws all 10 pack-driven Stage 6 construction stages for a building (stakes & rope -> foundation ->
   open interior room walls -> waist walls with scaffold & ramp -> full walls -> roof beams -> roof ->
   finishing -> complete -> upgraded annex). */
function drawBuildingConstructionStagesPixi(
  g: Graphics,
  b: CityBuilding,
  job: BuildingConstructionState,
  pack: WorldPackManifest,
  districtColor: number,
  providerColor: number,
  tileW: number,
  tileH: number,
): void {
  const pal = resolveConstructionPalette(pack);
  const woodHex = parseHex(pal.scaffoldWood, 0xb9874a);
  const rampHex = parseHex(pal.rampEarth, 0xc9ad7f);
  const spec = resolveStageSpecForBuilding(b, job, pack);
  const q = footprintQuad(b.col, b.row, b.spanCol, b.spanRow, tileW, tileH, b.spanCol >= 3 ? 0.08 : 0.12);
  const cx = (q.top.x + q.bottom.x) * 0.5;
  const cy = (q.top.y + q.bottom.y) * 0.5;
  const maxWallH = 26 + b.spanCol * 6;
  const wallBase = b.kind === 'department' ? 0xd3c4a7 : 0xd5be9b;

  /* Stage 1: Stakes and taut survey rope around cleared building pad. */
  if (spec.id === 'stakes_and_rope') {
    g.moveTo(q.top.x, q.top.y)
      .lineTo(q.right.x, q.right.y)
      .lineTo(q.bottom.x, q.bottom.y)
      .lineTo(q.left.x, q.left.y)
      .closePath()
      .fill({ color: rampHex, alpha: 0.45 });
    g.moveTo(q.top.x, q.top.y - 11)
      .lineTo(q.right.x, q.right.y - 11)
      .lineTo(q.bottom.x, q.bottom.y - 11)
      .lineTo(q.left.x, q.left.y - 11)
      .closePath()
      .stroke({ color: 0xe6cfa0, alpha: 0.94, width: 2 });
    for (const pt of [q.top, q.right, q.bottom, q.left]) {
      g.rect(pt.x - 1.6, pt.y - 18, 3.2, 19).fill({ color: 0x6b4728, alpha: 1 });
      g.moveTo(pt.x, pt.y - 18)
        .lineTo(pt.x + 8, pt.y - 15)
        .lineTo(pt.x, pt.y - 11)
        .closePath()
        .fill({ color: 0xe26245, alpha: 0.95 });
    }
    return;
  }

  /* Stage 2: Leveled site & masonry foundation slab with corner plinth blocks. */
  if (spec.id === 'foundation') {
    drawIsoPrismPixi(g, q, 8, 0xcabca0, 0xb2a387, 0x8f826a);
    const pad = footprintQuad(b.col, b.row, b.spanCol, b.spanRow, tileW, tileH, 0.2);
    g.moveTo(pad.top.x, pad.top.y - 8)
      .lineTo(pad.right.x, pad.right.y - 8)
      .lineTo(pad.bottom.x, pad.bottom.y - 8)
      .lineTo(pad.left.x, pad.left.y - 8)
      .closePath()
      .fill({ color: 0x9c8e77, alpha: 0.65 });
    return;
  }

  const wallH = Math.round(maxWallH * Math.min(1, spec.heightRatio));

  /* Stage 3 & 4: Open-top walls where interior rooms & partition walls are clearly visible from above! */
  if (spec.openInteriorVisible) {
    drawIsoPrismPixi(g, q, wallH, shadeHex(wallBase, 1.06), wallBase, shadeHex(wallBase, 0.78));
    /* Recessed interior floor showing divided room bays from above. */
    const inset = Math.min(0.28, b.spanCol * 0.14);
    const roomQ = footprintQuad(b.col, b.row, b.spanCol, b.spanRow, tileW, tileH, inset);
    const floorDrop = Math.max(4, wallH - 6);
    g.moveTo(roomQ.top.x, roomQ.top.y - floorDrop)
      .lineTo(roomQ.right.x, roomQ.right.y - floorDrop)
      .lineTo(roomQ.bottom.x, roomQ.bottom.y - floorDrop)
      .lineTo(roomQ.left.x, roomQ.left.y - floorDrop)
      .closePath()
      .fill({ color: 0x6c5e4b, alpha: 0.96 });

    /* Interior cross-partition walls dividing visible rooms inside the open shell! */
    const midTL = { x: (roomQ.top.x + roomQ.left.x) * 0.5, y: (roomQ.top.y + roomQ.left.y) * 0.5 - floorDrop };
    const midBR = { x: (roomQ.bottom.x + roomQ.right.x) * 0.5, y: (roomQ.bottom.y + roomQ.right.y) * 0.5 - floorDrop };
    const midTR = { x: (roomQ.top.x + roomQ.right.x) * 0.5, y: (roomQ.top.y + roomQ.right.y) * 0.5 - floorDrop };
    const midBL = { x: (roomQ.bottom.x + roomQ.left.x) * 0.5, y: (roomQ.bottom.y + roomQ.left.y) * 0.5 - floorDrop };
    g.moveTo(midTL.x, midTL.y)
      .lineTo(midBR.x, midBR.y)
      .moveTo(midTR.x, midTR.y)
      .lineTo(midBL.x, midBL.y)
      .stroke({ color: shadeHex(wallBase, 1.04), alpha: 0.96, width: 4.5 });

    if (spec.hasScaffolding) {
      drawScaffoldAndRampPixi(g, q, wallH, woodHex, rampHex, spec.hasRamp);
    }
    return;
  }

  /* Stage 5..10: Full walls -> Roof beams -> Roof -> Finishing -> Complete -> Upgraded Annex. */
  drawIsoPrismPixi(g, q, wallH, shadeHex(wallBase, 1.07), wallBase, shadeHex(wallBase, 0.79));

  /* Recessed front doorway portal on full walls. */
  const doorX = (q.left.x + q.bottom.x) * 0.5;
  const doorY = (q.left.y + q.bottom.y) * 0.5;
  g.rect(doorX - 6, doorY - 17, 12, 17).fill({ color: 0x3b2f23, alpha: 0.9 });

  if (spec.hasRoofBeams) {
    /* Stage 6: Exposed dark interior + parallel timber/iron roof beams spanning top! */
    const insetQ = footprintQuad(b.col, b.row, b.spanCol, b.spanRow, tileW, tileH, 0.22);
    g.moveTo(insetQ.top.x, insetQ.top.y - wallH)
      .lineTo(insetQ.right.x, insetQ.right.y - wallH)
      .lineTo(insetQ.bottom.x, insetQ.bottom.y - wallH)
      .lineTo(insetQ.left.x, insetQ.left.y - wallH)
      .closePath()
      .fill({ color: 0x4b3f33, alpha: 0.94 });
    const beams = 5;
    for (let i = 1; i <= beams; i++) {
      const t = i / (beams + 1);
      const ax = q.top.x + (q.left.x - q.top.x) * t;
      const ay = q.top.y + (q.left.y - q.top.y) * t - wallH;
      const bx = q.right.x + (q.bottom.x - q.right.x) * t;
      const by = q.right.y + (q.bottom.y - q.right.y) * t - wallH;
      g.moveTo(ax, ay).lineTo(bx, by).stroke({ color: woodHex, alpha: 1, width: 4.0 });
    }
  }

  if (spec.hasRoof) {
    const roofColor = b.kind === 'department' ? 0x5d84a6 : providerColor;
    const roofQ = footprintQuad(b.col, b.row, b.spanCol, b.spanRow, tileW, tileH, 0.28);
    const rq: IsoQuad = {
      top: { x: roofQ.top.x, y: roofQ.top.y - wallH },
      right: { x: roofQ.right.x, y: roofQ.right.y - wallH },
      bottom: { x: roofQ.bottom.x, y: roofQ.bottom.y - wallH },
      left: { x: roofQ.left.x, y: roofQ.left.y - wallH },
    };
    drawIsoPrismPixi(
      g,
      rq,
      spec.hasFinishing ? 10 : 6,
      shadeHex(roofColor, 1.12),
      roofColor,
      shadeHex(roofColor, 0.78),
    );
  }

  if (spec.hasFinishing) {
    /* Painted decorative frieze band along front walls. */
    const bandY = wallH * 0.74;
    g.moveTo(q.left.x, q.left.y - bandY)
      .lineTo(q.bottom.x, q.bottom.y - bandY)
      .lineTo(q.right.x, q.right.y - bandY)
      .stroke({ color: 0xebc254, alpha: 0.92, width: 3.2 });
  }

  if (spec.hasUpgrades) {
    /* Stage 10: Elevated upper pavilion terrace + gilded trim + prominent banner. */
    const upQ = footprintQuad(b.col, b.row, b.spanCol, b.spanRow, tileW, tileH, Math.min(0.65, b.spanCol * 0.26));
    const uq: IsoQuad = {
      top: { x: upQ.top.x, y: upQ.top.y - wallH - 10 },
      right: { x: upQ.right.x, y: upQ.right.y - wallH - 10 },
      bottom: { x: upQ.bottom.x, y: upQ.bottom.y - wallH - 10 },
      left: { x: upQ.left.x, y: upQ.left.y - wallH - 10 },
    };
    drawIsoPrismPixi(g, uq, 16, 0xf5e8c8, 0xe4d2a8, 0xc4b082);
    drawFlagMastPixi(g, cx, cy - wallH - 26, 22, 0xf2c14e);
  } else if (!spec.hasScaffolding) {
    drawFlagMastPixi(g, cx, cy - wallH - 10, 18, b.kind === 'department' ? 0x5ca6e6 : districtColor);
  }

  if (spec.hasScaffolding) {
    drawScaffoldAndRampPixi(g, q, wallH, woodHex, rampHex, spec.hasRamp);
  }
}

/* Draws all 20 sculptural stages of a department statue (1..20): survey plinth -> rough carved legs ->
   torso & arms -> head/crown -> fine gilded trim -> gleaming finished colossus at stage 20. */
function drawStatue20StagesPixi(
  g: Graphics,
  b: CityBuilding,
  stage: number,
  maxStage: number,
  pack: WorldPackManifest,
  tileW: number,
  tileH: number,
): void {
  const pal = resolveConstructionPalette(pack);
  const woodHex = parseHex(pal.scaffoldWood, 0xb9874a);
  const baseHex = parseHex(pal.statueBaseColor, 0xc8bca4);
  const finishHex = parseHex(pal.statueFinishedColor, 0xeecc64);
  const q = footprintQuad(b.col, b.row, b.spanCol, b.spanRow, tileW, tileH, 0.14);
  const cx = (q.top.x + q.bottom.x) * 0.5;
  const cy = (q.top.y + q.bottom.y) * 0.5;
  const clampedStage = Math.max(1, Math.min(maxStage, stage));
  const ratio = clampedStage / Math.max(1, maxStage);
  const finished = clampedStage >= maxStage || Boolean(b.reached);
  const stoneHex = finished ? finishHex : clampedStage >= 17 ? shadeHex(baseHex, 1.09) : baseHex;

  /* Stage 1..2: Surveyed pedestal pad & foundation stones. */
  const plinthH = 8 + b.spanCol * 4;
  if (clampedStage <= 2) {
    drawIsoPrismPixi(g, q, Math.round(plinthH * (clampedStage / 2)), shadeHex(baseHex, 1.06), baseHex, shadeHex(baseHex, 0.8));
    return;
  }

  /* Stepped plinth base. */
  drawIsoPrismPixi(g, q, plinthH, 0xd8ceb9, 0xbfb39c, 0x9b8f7a);

  const scale = 0.85 + b.spanCol * 0.42;
  const bodyMaxH = 38 * scale;
  const carvedH = Math.round(bodyMaxH * Math.min(1, (clampedStage - 2) / 14));

  /* Lower sculpted pedestal & legs block (stages 3..9). */
  const legH = Math.min(carvedH, Math.round(bodyMaxH * 0.48));
  const legQ = footprintQuad(b.col, b.row, b.spanCol, b.spanRow, tileW, tileH, 0.32);
  const lq: IsoQuad = {
    top: { x: legQ.top.x, y: legQ.top.y - plinthH },
    right: { x: legQ.right.x, y: legQ.right.y - plinthH },
    bottom: { x: legQ.bottom.x, y: legQ.bottom.y - plinthH },
    left: { x: legQ.left.x, y: legQ.left.y - plinthH },
  };
  drawIsoPrismPixi(g, lq, legH, shadeHex(stoneHex, 1.1), stoneHex, shadeHex(stoneHex, 0.78));

  /* Sculpted upper torso & arms emerging (stages 10..16). */
  if (clampedStage >= 10) {
    const torsoH = Math.round(bodyMaxH * 0.42 * Math.min(1, (clampedStage - 9) / 5));
    const torsoBaseY = plinthH + legH;
    const torsoQ = footprintQuad(b.col, b.row, b.spanCol, b.spanRow, tileW, tileH, 0.36);
    const tq: IsoQuad = {
      top: { x: torsoQ.top.x, y: torsoQ.top.y - torsoBaseY },
      right: { x: torsoQ.right.x, y: torsoQ.right.y - torsoBaseY },
      bottom: { x: torsoQ.bottom.x, y: torsoQ.bottom.y - torsoBaseY },
      left: { x: torsoQ.left.x, y: torsoQ.left.y - torsoBaseY },
    };
    drawIsoPrismPixi(g, tq, torsoH, shadeHex(stoneHex, 1.12), stoneHex, shadeHex(stoneHex, 0.8));

    /* Carved head & ceremonial headdress/crown (stages 14..20). */
    if (clampedStage >= 14) {
      const headY = cy - torsoBaseY - torsoH - 9 * scale;
      g.circle(cx, headY, 8 * scale).fill({ color: stoneHex, alpha: 1 });
      if (clampedStage >= 16) {
        g.moveTo(cx - 7 * scale, headY - 4 * scale)
          .lineTo(cx, headY - 19 * scale)
          .lineTo(cx + 7 * scale, headY - 4 * scale)
          .closePath()
          .fill({ color: clampedStage >= 18 ? 0xffdc64 : shadeHex(stoneHex, 1.08), alpha: 1 });
      }
    }

    /* Fine gilded collar & emblem trim (stages 17..20). */
    if (clampedStage >= 17) {
      const trimY = cy - torsoBaseY - torsoH * 0.72;
      g.rect(cx - 10 * scale, trimY, 20 * scale, 4 * scale).fill({ color: 0xf6cf58, alpha: 0.96 });
    }
  }

  /* Active timber scaffolding around stages 4..19; cleanly removed at gleaming stage 20! */
  if (!finished && clampedStage >= 4) {
    const scH = plinthH + Math.round(bodyMaxH * ratio) + 12;
    drawScaffoldAndRampPixi(g, q, scH, woodHex, 0xc9ad7f, false);
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
  job: BuildingConstructionState | null = null,
): void {
  if (job && job.phase === 'cleared') return;

  const q = footprintQuad(b.col, b.row, b.spanCol, b.spanRow, tileW, tileH, b.spanCol >= 3 ? 0.08 : 0.12);
  const cx = (q.top.x + q.bottom.x) * 0.5;
  const cy = (q.top.y + q.bottom.y) * 0.5;
  const providerColor = b.provider ? parseHex(pack.palette.providers[b.provider], 0xc96a4b) : 0xb89b6a;
  const districtColor = b.districtId ? parseHex(districtColors[b.districtId], 0x4b8ca6) : 0xc8943a;
  const pal = resolveConstructionPalette(pack);

  if (b.kind === 'monument') {
    const activeStage = job ? job.currentStage : b.stage;
    const maxS = Math.max(1, job ? job.maxStage : b.maxStage);
    const reached = job ? job.phase === 'complete' && activeStage >= maxS : Boolean(b.reached);
    const progress = job
      ? Math.max(0.1, Math.min(1, activeStage / maxS))
      : Math.max(0.12, Math.min(1, b.progress ?? activeStage / maxS));
    const maxApex = 38 + b.spanCol * 22;
    const apexH = maxApex * (reached ? 1 : progress);
    const tierCount = Math.max(1, Math.min(10, Math.round(progress * 10)));
    drawIsoPyramidPixi(
      g,
      q,
      10,
      apexH,
      0xdec48f,
      0xb89c68,
      reached,
      parseHex(pal.capstoneColor, 0xffdc66),
      parseHex(pal.rampEarth, 0xc9ad7f),
      tierCount,
    );
    return;
  }

  if (b.kind === 'statue') {
    const activeStage = job ? job.currentStage : b.stage;
    const maxS = Math.max(1, job ? job.maxStage : b.maxStage);
    drawStatue20StagesPixi(g, b, activeStage, maxS, pack, tileW, tileH);
    return;
  }

  /* Any non-monument/non-statue structure tracked by a Stage 6 construction/demolition job
     renders its exact pack-driven 10-stage architecture cleanly through completion & upgrades. */
  if (job) {
    drawBuildingConstructionStagesPixi(g, b, job, pack, districtColor, providerColor, tileW, tileH);
    return;
  }

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
    const maxH = 40;
    const emptyShell = 0x9c8e7a;
    /* Outer granary/basin frame. */
    drawIsoPrismPixi(g, q, 14, 0xc3b49b, emptyShell, 0x7c705f);
    /* Dark inner rim so fill height vs empty cavity reads clearly at a glance. */
    const cavity = footprintQuad(b.col, b.row, b.spanCol, b.spanRow, tileW, tileH, 0.24);
    g.moveTo(cavity.top.x, cavity.top.y - 14)
      .lineTo(cavity.right.x, cavity.right.y - 14)
      .lineTo(cavity.bottom.x, cavity.bottom.y - 14)
      .lineTo(cavity.left.x, cavity.left.y - 14)
      .closePath()
      .fill({ color: 0x2c241d, alpha: 0.72 });
    /* Live fullness level rising inside the supply basin. */
    if (fullness > 0.02) {
      const fillH = Math.max(6, Math.round(fullness * maxH));
      const inner = footprintQuad(b.col, b.row, b.spanCol, b.spanRow, tileW, tileH, 0.3);
      const innerQ: IsoQuad = {
        top: { x: inner.top.x, y: inner.top.y - 14 },
        right: { x: inner.right.x, y: inner.right.y - 14 },
        bottom: { x: inner.bottom.x, y: inner.bottom.y - 14 },
        left: { x: inner.left.x, y: inner.left.y - 14 },
      };
      drawIsoPrismPixi(g, innerQ, fillH, shadeHex(providerColor, 1.18), providerColor, shadeHex(providerColor, 0.78));
    } else {
      /* Empty supply emblem (dry basin). */
      g.circle(cx, cy - 16, 7).fill({ color: 0x3b2c26, alpha: 0.9 }).stroke({ color: 0xe26a5a, alpha: 0.95, width: 1.8 });
    }
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

/* Rebuilds the cached static isometric city geometry layer inside a PixiJS Graphics object,
   strictly frustum-culled to cullWindow so off-screen walls/roads/buildings never inflate GPU triangle counts. */
/* Draws one building from its pictures; false while any texture is still loading. */
function drawBuildingArtPixi(
  ctx: CityArtContext,
  art: BuildingArt,
  b: CityBuilding,
  tileW: number,
  tileH: number,
): boolean {
  const textures = art.layers.map(l => ctx.library.frame(l.path, l.frame));
  if (textures.some(t => !t)) return false;
  const centre = artFootprintCentre(b, tileW, tileH);
  const s = tileW / art.artPxPerTile;
  art.layers.forEach((layer, i) => {
    const sprite = ctx.pool.sprite(textures[i]!);
    sprite.anchor.set(layer.anchor.x / layer.frame.w, layer.anchor.y / layer.frame.h);
    sprite.scale.set(s);
    sprite.position.set(centre.x + layer.offset.x * s, centre.y + layer.offset.y * s);
    if (layer.tint) sprite.tint = parseArtTint(layer.tint);
  });
  if (b.resting) {
    const top = art.passport.topAnchor ?? { x: art.passport.groundAnchor.x, y: 0 };
    drawRestingBadgePixi(
      ctx.pool.graphics(),
      centre.x + (top.x - art.passport.groundAnchor.x) * s + 12,
      centre.y + (top.y - art.passport.groundAnchor.y) * s + 10,
    );
  }
  ctx.library.stats.buildingsDrawn++;
  return true;
}

export function renderCityToPixi(
  g: Graphics,
  state: CityRenderState,
  pack: WorldPackManifest,
  tileW: number,
  tileH: number,
  cullWindow?: TileWindow | null,
  art?: CityArtContext | null,
): void {
  g.clear();
  art?.pool.begin();
  if (art) art.library.stats.buildingsDrawn = 0;
  const artIndex = art?.library.index ?? null;
  const { city } = state;
  const districtColors = state.districtColors ?? {};

  const tileInWindow = (col: number, row: number): boolean => {
    if (!cullWindow) return true;
    return (
      col >= cullWindow.minCol &&
      col <= cullWindow.maxCol &&
      row >= cullWindow.minRow &&
      row <= cullWindow.maxRow
    );
  };

  const rectInWindow = (col: number, row: number, spanCol: number, spanRow: number): boolean => {
    if (!cullWindow) return true;
    return (
      col + spanCol - 1 >= cullWindow.minCol &&
      col <= cullWindow.maxCol &&
      row + spanRow - 1 >= cullWindow.minRow &&
      row <= cullWindow.maxRow
    );
  };

  /* 1. Roads and bridges (viewport-culled, fill-only without heavy per-tile stroke triangulation). */
  for (const road of city.roads.values()) {
    if (!tileInWindow(road.col, road.row)) continue;
    const pts = tileDiamondVertices(road.col, road.row, tileW, tileH);
    const style = road.bridge
      ? { fill: 0x9b6d3f, stroke: 0x593a1d, alpha: 0.96 }
      : ROAD_COLORS[road.tier];
    g.moveTo(pts[0].x, pts[0].y)
      .lineTo(pts[1].x, pts[1].y)
      .lineTo(pts[2].x, pts[2].y)
      .lineTo(pts[3].x, pts[3].y)
      .closePath()
      .fill({ color: style.fill, alpha: style.alpha });
  }

  /* 2. Optional outer city wall (empty for packs with outerWallMode: 'none'; strictly viewport-culled). */
  if (city.wallTiles.size > 0) {
    const wallCoords: TileCoord[] = [];
    for (const key of city.wallTiles) {
      const [cStr, rStr] = key.split(',');
      const col = Number(cStr);
      const row = Number(rStr);
      if (!tileInWindow(col, row)) continue;
      wallCoords.push({ col, row });
    }
    wallCoords.sort((a, b) => a.col + a.row - (b.col + b.row));
    for (const pt of wallCoords) {
      const wq = footprintQuad(pt.col, pt.row, 1, 1, tileW, tileH, 0.06);
      drawIsoPrismPixi(g, wq, 18, 0xbab09f, 0x9c9281, 0x7c7364, 0x3b342b, 0.55, false);
    }
  }

  /* 3. Empty-lot survey stakes & plank stacks for brand-new companies without a template. */
  if (state.worldMode === 'empty_lot' && state.emptyLotStakes && state.emptyLotStakes.length > 0) {
    drawEmptyLotPropsPixi(g, state.emptyLotStakes, city.center, tileW, tileH);
  }

  /* 4. Depth-sorted structures + relocating old-site demolition ghosts (viewport-culled). */
  const jobs = state.constructionJobs;
  const renderItems: Array<{ building: CityBuilding; job: BuildingConstructionState | null }> = [];
  const seenIds = new Set<string>();
  for (const b of city.buildings) {
    seenIds.add(b.id);
    const job = jobs?.get(b.id) ?? null;
    if (job && job.phase === 'cleared') continue;
    if (!rectInWindow(b.col, b.row, b.spanCol, b.spanRow)) continue;
    renderItems.push({ building: b, job });
  }
  if (jobs) {
    for (const job of jobs.values()) {
      if (seenIds.has(job.buildingId) || job.phase === 'cleared') continue;
      const snap = job.buildingSnapshot;
      if (!rectInWindow(snap.col, snap.row, snap.spanCol, snap.spanRow)) continue;
      renderItems.push({ building: snap, job });
    }
  }
  renderItems.sort((a, b) => {
    const ba = a.building;
    const bb = b.building;
    const da = ba.col + ba.row + (ba.spanCol + ba.spanRow) * 0.5;
    const db = bb.col + bb.row + (bb.spanCol + bb.spanRow) * 0.5;
    return da - db || ba.col - bb.col;
  });
  for (const item of renderItems) {
    if (art && artIndex) {
      const b = item.building;
      const resolved = resolveBuildingArt(pack, artIndex, b, item.job, {
        upgrading: b.kind === 'house' && Boolean(art.upgradingHouseIds?.has(b.id)),
        districtColor: b.districtId ? districtColors[b.districtId] : undefined,
        departmentColor: DEPARTMENT_BANNER_COLOR,
      });
      if (!resolved || !drawBuildingArtPixi(art, resolved, b, tileW, tileH)) {
        drawBuildingPixi(art.pool.graphics(), b, pack, districtColors, tileW, tileH, item.job);
      }
      continue;
    }
    drawBuildingPixi(g, item.building, pack, districtColors, tileW, tileH, item.job);
  }

  /* 5. Pending God's Word relocation destination markers (building itself stays at old tile!). */
  const markerG = art && artIndex ? art.pool.graphics() : g;
  for (const b of city.buildings) {
    const pend = b.pendingRelocation;
    if (!pend) continue;
    if (
      !rectInWindow(b.col, b.row, b.spanCol, b.spanRow) &&
      !rectInWindow(pend.toCol, pend.toRow, b.spanCol, b.spanRow)
    ) {
      continue;
    }
    const fromPt = tileCenterToWorld(b.col + b.spanCol * 0.5 - 0.5, b.row + b.spanRow * 0.5 - 0.5, tileW, tileH);
    const toPt = tileCenterToWorld(pend.toCol + b.spanCol * 0.5 - 0.5, pend.toRow + b.spanRow * 0.5 - 0.5, tileW, tileH);
    const tq = footprintQuad(pend.toCol, pend.toRow, b.spanCol, b.spanRow, tileW, tileH, 0.05);
    markerG.moveTo(tq.top.x, tq.top.y)
      .lineTo(tq.right.x, tq.right.y)
      .lineTo(tq.bottom.x, tq.bottom.y)
      .lineTo(tq.left.x, tq.left.y)
      .closePath()
      .fill({ color: 0xffd166, alpha: 0.25 })
      .stroke({ color: 0xffd166, alpha: 0.96, width: 2.4 });
    markerG.moveTo(fromPt.x, fromPt.y - 24)
      .lineTo(toPt.x, toPt.y - 8)
      .stroke({ color: 0xffd166, alpha: 0.9, width: 2.2 });
    markerG.circle(toPt.x, toPt.y - 8, 5).fill({ color: 0xffd166, alpha: 1 });
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
