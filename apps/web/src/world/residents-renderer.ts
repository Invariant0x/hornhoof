/* Pack-agnostic 2:1 isometric renderer for Stage 5 live residents and city-state overlays:
   draws viewport-culled depth-sorted residents (canonical scale, provider cloaks, level outfit tiers 1..5,
   role headgear/insignia, carried stones, returned rework stones, scrolls, water jars, gongs,
   spears/shields, directing staffs, praying/broken-tool/sleeping postures), God's Altar shrine,
   home-upgrade timber scaffolding, offline machine nighttime district tint, and rising department
   failure smoke plumes. Uses low-poly filled geometry (no heavy per-entity curve/stroke tessellation)
   so 150 simultaneous residents stay well within a 60 FPS frame budget. Contains zero theme-specific words. */

import type { Graphics } from 'pixi.js';
import {
  ALTAR_PICTURE,
  masterTileW,
  residentLayerPlacement,
  resolveResidentArt,
  type ArtIndex,
  type BuildingPicturePassport,
  type ResidentArt,
} from './art';
import { parseArtTint, type DisplayRunPool, type WorldArtLibrary } from './art-runtime';
import type { CityBuilding, CityState } from './city-layout';
import { tileCenterToWorld, tileTopVertexToWorld } from './coords';
import type { AnimationDetailLevel, WorldPackManifest } from './manifest';
import type { ResidentEntity, ResidentSimulation } from './residents';

/* Artist sheets for residents and the altar picture, drawn in the pool in depth order. */
export type ResidentArtContext = Readonly<{
  library: WorldArtLibrary;
  pool: DisplayRunPool;
}>;

export type WorldVisibleRect = Readonly<{
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
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

function buildingCenterWorld(b: CityBuilding, tileW: number, tileH: number): { x: number; y: number } {
  return tileCenterToWorld(b.col + (b.spanCol - 1) * 0.5, b.row + (b.spanRow - 1) * 0.5, tileW, tileH);
}

function inRect(x: number, y: number, rect: WorldVisibleRect, pad: number): boolean {
  return x >= rect.minX - pad && x <= rect.maxX + pad && y >= rect.minY - pad && y <= rect.maxY + pad;
}

/* Fast 8-vertex oval/circle helper: ~4x faster to triangulate than Graphics.circle/ellipse across 150 residents. */
function fillOctagon(
  g: Graphics,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  color: number,
  alpha = 1,
): void {
  const k = 0.7071;
  const ox = rx * k;
  const oy = ry * k;
  g.moveTo(cx, cy - ry)
    .lineTo(cx + ox, cy - oy)
    .lineTo(cx + rx, cy)
    .lineTo(cx + ox, cy + oy)
    .lineTo(cx, cy + ry)
    .lineTo(cx - ox, cy + oy)
    .lineTo(cx - rx, cy)
    .lineTo(cx - ox, cy - oy)
    .closePath()
    .fill({ color, alpha });
}

/* Fast filled line segment quad: avoids Graphics.stroke miter triangulation inside hot resident loops. */
function fillSegment(
  g: Graphics,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  color: number,
  alpha = 1,
): void {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 0.01) return;
  const hw = width * 0.5;
  const nx = (-dy / len) * hw;
  const ny = (dx / len) * hw;
  g.moveTo(x1 + nx, y1 + ny)
    .lineTo(x2 + nx, y2 + ny)
    .lineTo(x2 - nx, y2 - ny)
    .lineTo(x1 - nx, y1 - ny)
    .closePath()
    .fill({ color, alpha });
}

/* Draws the pack-anchored sanctuary shrine where agents waiting on human decisions stand with scrolls. */
function drawAltarPixi(
  g: Graphics,
  sim: ResidentSimulation,
  pack: WorldPackManifest,
  tileW: number,
  tileH: number,
  detail: AnimationDetailLevel,
): void {
  const accent = parseHex(pack.palette.selectStroke, 0xffd166);
  const c = sim.altarTile.col;
  const r = sim.altarTile.row;
  const ctr = tileCenterToWorld(c, r, tileW, tileH);

  /* Soft sanctuary ground halo pulsing gently. */
  const pulse = 0.2 + 0.08 * Math.sin(sim.timeSec * 2.4);
  fillOctagon(g, ctr.x, ctr.y + 1, tileW * 0.52, tileH * 0.52, accent, pulse);

  /* Stepped 2-tier isometric plinth. */
  const drawPlinth = (inset: number, baseH: number, topH: number, colTop: number, colL: number, colR: number) => {
    const top = tileTopVertexToWorld(c + inset, r + inset, tileW, tileH);
    const right = tileTopVertexToWorld(c + 1 - inset, r + inset, tileW, tileH);
    const bottom = tileTopVertexToWorld(c + 1 - inset, r + 1 - inset, tileW, tileH);
    const left = tileTopVertexToWorld(c + inset, r + 1 - inset, tileW, tileH);

    g.moveTo(left.x, left.y - baseH)
      .lineTo(bottom.x, bottom.y - baseH)
      .lineTo(bottom.x, bottom.y - topH)
      .lineTo(left.x, left.y - topH)
      .closePath()
      .fill({ color: colL, alpha: 1 });

    g.moveTo(bottom.x, bottom.y - baseH)
      .lineTo(right.x, right.y - baseH)
      .lineTo(right.x, right.y - topH)
      .lineTo(bottom.x, bottom.y - topH)
      .closePath()
      .fill({ color: colR, alpha: 1 });

    g.moveTo(top.x, top.y - topH)
      .lineTo(right.x, right.y - topH)
      .lineTo(bottom.x, bottom.y - topH)
      .lineTo(left.x, left.y - topH)
      .closePath()
      .fill({ color: colTop, alpha: 1 });
  };

  drawPlinth(0.14, 0, 10, 0xe4d7bc, 0xcab996, 0xa89673);
  drawPlinth(0.28, 10, 19, 0xeee2c9, 0xd4c39f, 0xb5a27d);

  /* Central carved sanctuary pillar & glowing crown crystal. */
  const baseY = ctr.y - 19;
  const spireH = 38;
  g.moveTo(ctr.x - 7, baseY)
    .lineTo(ctr.x, baseY + 4)
    .lineTo(ctr.x, baseY - spireH)
    .lineTo(ctr.x - 5, baseY - spireH + 3)
    .closePath()
    .fill({ color: 0xe6d6b5, alpha: 1 });
  g.moveTo(ctr.x, baseY + 4)
    .lineTo(ctr.x + 7, baseY)
    .lineTo(ctr.x + 5, baseY - spireH + 3)
    .lineTo(ctr.x, baseY - spireH)
    .closePath()
    .fill({ color: 0xbfa981, alpha: 1 });

  /* Glowing golden apex diamond. */
  const tipY = baseY - spireH - 10;
  g.moveTo(ctr.x, tipY)
    .lineTo(ctr.x + 6, baseY - spireH + 2)
    .lineTo(ctr.x, baseY - spireH + 6)
    .lineTo(ctr.x - 6, baseY - spireH + 2)
    .closePath()
    .fill({ color: accent, alpha: 1 });

  if (detail !== 'reduced') {
    const glowR = 11 + Math.sin(sim.timeSec * 3.1) * 2.5;
    fillOctagon(g, ctr.x, tipY + 4, glowR, glowR, accent, 0.28);
    fillOctagon(g, ctr.x, tipY + 4, 4.5, 4.5, 0xfff8d6, 0.96);
  }
}

/* Draws cool nighttime district wash over offline machines' buildings and crescent markers on their hubs. */
function drawOfflineNightDistrictsPixi(
  g: Graphics,
  sim: ResidentSimulation,
  city: CityState,
  rect: WorldVisibleRect,
  tileW: number,
  tileH: number,
): void {
  if (sim.nightDistrictIds.size === 0) return;

  for (const b of city.buildings) {
    if (!b.districtId || !sim.nightDistrictIds.has(b.districtId)) continue;
    const ctr = buildingCenterWorld(b, tileW, tileH);
    if (!inRect(ctr.x, ctr.y, rect, 260)) continue;

    const pad = 0.85;
    const top = tileTopVertexToWorld(b.col - pad, b.row - pad, tileW, tileH);
    const right = tileTopVertexToWorld(b.col + b.spanCol + pad, b.row - pad, tileW, tileH);
    const bottom = tileTopVertexToWorld(b.col + b.spanCol + pad, b.row + b.spanRow + pad, tileW, tileH);
    const left = tileTopVertexToWorld(b.col - pad, b.row + b.spanRow + pad, tileW, tileH);

    g.moveTo(top.x, top.y)
      .lineTo(right.x, right.y)
      .lineTo(bottom.x, bottom.y)
      .lineTo(left.x, left.y)
      .closePath()
      .fill({ color: 0x0a1536, alpha: 0.44 });

    /* Crescent night moon badge + stars above offline machine hub. */
    if (b.kind === 'district_hub') {
      const mx = ctr.x;
      const my = ctr.y - 68;
      fillOctagon(g, mx, my, 14, 14, 0x0f1c3b, 0.94);
      fillOctagon(g, mx - 2.4, my, 7.2, 7.2, 0xdcebff, 0.98);
      fillOctagon(g, mx + 2.4, my - 1.4, 6.2, 6.2, 0x0f1c3b, 1);
      fillOctagon(g, mx - 18, my - 12, 2.2, 2.2, 0xe4f0ff, 0.9);
      fillOctagon(g, mx + 17, my - 16, 1.9, 1.9, 0xe4f0ff, 0.82);
    }
  }
}

/* Draws timber scaffolding framing around houses currently being upgraded after a resident leveled up. */
function drawHomeScaffoldingPixi(
  g: Graphics,
  sim: ResidentSimulation,
  city: CityState,
  rect: WorldVisibleRect,
  tileW: number,
  tileH: number,
): void {
  if (sim.scaffoldingHouseIds.size === 0) return;

  for (const b of city.buildings) {
    if (!sim.scaffoldingHouseIds.has(b.id)) continue;
    const ctr = buildingCenterWorld(b, tileW, tileH);
    if (!inRect(ctr.x, ctr.y, rect, 180)) continue;

    const top = tileTopVertexToWorld(b.col + 0.04, b.row + 0.04, tileW, tileH);
    const right = tileTopVertexToWorld(b.col + b.spanCol - 0.04, b.row + 0.04, tileW, tileH);
    const bottom = tileTopVertexToWorld(b.col + b.spanCol - 0.04, b.row + b.spanRow - 0.04, tileW, tileH);
    const left = tileTopVertexToWorld(b.col + 0.04, b.row + b.spanRow - 0.04, tileW, tileH);
    const scH = 38 + Math.min(20, b.spanCol * 8);

    /* Vertical timber poles on the front three corners. */
    for (const pt of [left, bottom, right]) {
      g.rect(pt.x - 1.8, pt.y - scH, 3.6, scH + 2).fill({ color: 0x9b6b36, alpha: 0.95 });
    }
    /* Horizontal catwalk beams & cross-braces on left and right visible faces. */
    for (const frac of [0.46, 0.86]) {
      const yOff = scH * frac;
      fillSegment(g, left.x, left.y - yOff, bottom.x, bottom.y - yOff, 2.6, 0xd09f5e, 0.95);
      fillSegment(g, bottom.x, bottom.y - yOff, right.x, right.y - yOff, 2.6, 0xd09f5e, 0.95);
    }
    fillSegment(g, left.x, left.y - 4, bottom.x, bottom.y - scH * 0.86, 1.7, 0xa6743d, 0.85);
    fillSegment(g, bottom.x, bottom.y - 4, right.x, right.y - scH * 0.86, 1.7, 0xa6743d, 0.85);

    /* Small golden level-up star glint above roof. */
    const starY = top.y - scH * 0.5 + Math.sin(sim.timeSec * 3.5) * 3;
    fillOctagon(g, ctr.x, starY, 5, 5, 0xffe072, 0.88);
  }
}

/* Draws rising smoke columns above departments with a failed turn and alert rings on stuck builds. */
function drawDepartmentAlertsPixi(
  g: Graphics,
  sim: ResidentSimulation,
  city: CityState,
  rect: WorldVisibleRect,
  tileW: number,
  tileH: number,
  detail: AnimationDetailLevel,
): void {
  if (sim.smokingDepartmentIds.size === 0 && sim.stuckDepartmentIds.size === 0) return;

  for (const b of city.buildings) {
    if (b.kind !== 'department' || !b.departmentId) continue;
    const ctr = buildingCenterWorld(b, tileW, tileH);
    if (!inRect(ctr.x, ctr.y, rect, 220)) continue;

    if (sim.stuckDepartmentIds.has(b.departmentId) && detail !== 'reduced') {
      const ringPhase = (sim.timeSec * 0.85) % 1;
      const radX = tileW * (0.45 + ringPhase * 0.72);
      const radY = tileH * (0.45 + ringPhase * 0.72);
      fillOctagon(g, ctr.x, ctr.y + 8, radX, radY, 0xf4b942, (1 - ringPhase) * 0.2);
    }

    if (sim.smokingDepartmentIds.has(b.departmentId)) {
      const puffs = detail === 'reduced' ? 4 : 6;
      const baseX = ctr.x;
      const baseY = ctr.y - 54;
      for (let i = 0; i < puffs; i++) {
        const life = (sim.timeSec * 0.42 + i / puffs) % 1;
        const px = baseX + Math.sin(life * 5.2 + i) * 9 + life * 26;
        const py = baseY - life * 76;
        const radius = 10 + life * 17;
        const alpha = Math.sin(life * Math.PI) * 0.66;
        const tone = life < 0.35 ? 0x34363d : life < 0.7 ? 0x525661 : 0x767a86;
        fillOctagon(g, px, py, radius, radius * 0.9, tone, alpha);
      }
      /* Warm ember glow at smoke source so failure reads clearly against bright roofs. */
      fillOctagon(g, baseX, baseY + 2, 7, 7, 0xe86c36, 0.48);
    }
  }
}

/* Draws a single geometric isometric resident scaled to the canonical human height (~60 world units at 100%). */
function drawResidentPixi(
  g: Graphics,
  r: ResidentEntity,
  timeSec: number,
  tileW: number,
  tileH: number,
  detail: AnimationDetailLevel,
  selected: boolean,
): void {
  const pos = tileCenterToWorld(r.col, r.row, tileW, tileH);
  const x = pos.x;
  const y = pos.y + 2;

  const scale =
    r.roleClass === 'ruler'
      ? 1.12
      : r.roleClass === 'head'
        ? 1.06
        : r.roleClass === 'day_laborer'
          ? 0.92
          : 1.0;

  const cloakHex = parseHex(r.cloakColor, 0xb89b5e);
  const tunicHex = parseHex(r.look.tunicColor, 0xd8cdb2);
  const trimHex = parseHex(r.look.trimColor, 0xa8823c);
  const skinHex = 0xd7a479;
  const dirX = r.facing === 'W' || r.facing === 'SW' || r.facing === 'NW' ? -1 : 1;

  /* Selection highlight ellipse under feet. */
  if (selected) {
    fillOctagon(g, x, y + 1, 23 * scale, 11.5 * scale, 0xffe484, 0.55);
    fillOctagon(g, x, y + 1, 18 * scale, 9 * scale, 0xfff5c2, 0.34);
  }

  /* Soft ground shadow anchored right under resident. */
  fillOctagon(g, x + 2, y + 2, 13 * scale, 6.2 * scale, 0x100c08, 0.28);

  /* Reclined sleeping pose (offline machine night district). */
  if (r.pose === 'sleeping') {
    g.rect(x - 15 * scale, y - 9 * scale, 26 * scale, 11 * scale).fill({ color: cloakHex, alpha: 0.96 });
    g.rect(x - 10 * scale, y - 8 * scale, 14 * scale, 8 * scale).fill({ color: tunicHex, alpha: 0.95 });
    fillOctagon(g, x - 14 * scale, y - 5 * scale, 5.2 * scale, 5.2 * scale, skinHex, 1);
    if (detail !== 'reduced') {
      const bob = Math.sin(timeSec * 2.2 + r.walkPhase) * 3;
      fillOctagon(g, x - 4, y - 19 + bob, 3.2, 3.2, 0xb7d7ff, 0.85);
      fillOctagon(g, x + 3, y - 26 + bob * 0.7, 2.3, 2.3, 0xb7d7ff, 0.62);
    }
    return;
  }

  /* Exhausted praying / prostrate pose beside empty supply silo/well. */
  if (r.pose === 'praying') {
    fillOctagon(g, x, y - 6 * scale, 13 * scale, 8 * scale, cloakHex, 0.96);
    fillOctagon(g, x + dirX * 3 * scale, y - 8 * scale, 9 * scale, 6.5 * scale, tunicHex, 1);
    fillOctagon(g, x + dirX * 11 * scale, y - 10 * scale, 5.2 * scale, 5.2 * scale, skinHex, 1);
    g.rect(x + (dirX > 0 ? 13 : -20) * scale, y - 7 * scale, 7 * scale, 3.5 * scale).fill({
      color: skinHex,
      alpha: 0.95,
    });
    if (detail !== 'reduced') {
      const auraR = 6 + Math.sin(timeSec * 3 + r.walkPhase) * 1.6;
      fillOctagon(g, x + dirX * 11 * scale, y - 21 * scale, auraR, auraR, 0x9fc9ff, 0.34);
    }
    return;
  }

  /* Failed turn: sitting hunched with visibly broken tool next to them. */
  if (r.pose === 'broken_tool') {
    g.rect(x - 9 * scale, y - 20 * scale, 18 * scale, 18 * scale).fill({ color: cloakHex, alpha: 0.96 });
    g.rect(x - 7 * scale, y - 19 * scale, 14 * scale, 15 * scale).fill({ color: tunicHex, alpha: 1 });
    fillOctagon(g, x, y - 25 * scale, 6 * scale, 6 * scale, skinHex, 1);
    /* Two snapped wooden tool handle halves lying on ground. */
    fillSegment(g, x + 9, y - 1, x + 17, y - 5, 2.6, 0x87582e, 0.98);
    fillSegment(g, x + 19, y - 3, x + 25, y + 1, 2.6, 0x87582e, 0.98);
    g.rect(x + 23, y - 2, 5, 5).fill({ color: 0x767b84, alpha: 1 });
    /* Amber failure spark above head. */
    fillOctagon(g, x, y - 38 * scale, 4.4, 4.4, 0xf07842, 0.92);
    return;
  }

  /* Standing / walking / working figure (~58 world units tall at scale 1.0 -> ~62px at 100% zoom). */
  const isMoving =
    r.pose === 'walking' ||
    r.pose === 'carrying_stone' ||
    r.pose === 'returning_stone' ||
    r.pose === 'idle';
  const stride = isMoving ? Math.sin(r.walkPhase) * 4.8 * scale : 0;
  const bob = isMoving ? Math.abs(Math.sin(r.walkPhase)) * 2.6 * scale : 0;
  const footY = y - bob;

  /* 1. Provider cloak behind shoulders (immediately identifies claude/codex/antigravity/kimi/glm/api). */
  const cloakTopY = footY - 39 * scale;
  const cloakBotY = footY - 10 * scale;
  g.moveTo(x - 9 * scale, cloakTopY)
    .lineTo(x + 9 * scale, cloakTopY)
    .lineTo(x + (12 - dirX * 3) * scale, cloakBotY)
    .lineTo(x - (12 + dirX * 3) * scale, cloakBotY)
    .closePath()
    .fill({ color: cloakHex, alpha: 0.96 });

  /* 2. Legs with walking stride. */
  const legColor = shadeHex(skinHex, 0.84);
  g.rect(x - 5.5 * scale + stride * 0.5, footY - 16 * scale, 4.2 * scale, 16 * scale).fill({
    color: legColor,
    alpha: 1,
  });
  g.rect(x + 1.3 * scale - stride * 0.5, footY - 16 * scale, 4.2 * scale, 16 * scale).fill({
    color: shadeHex(legColor, 0.9),
    alpha: 1,
  });

  /* 3. Tunic body (two-tone light left / shaded right to match top-left sun). */
  const torsoTopY = footY - 39 * scale;
  const torsoH = 24 * scale;
  g.rect(x - 8 * scale, torsoTopY, 8 * scale, torsoH).fill({ color: tunicHex, alpha: 1 });
  g.rect(x, torsoTopY, 8 * scale, torsoH).fill({ color: shadeHex(tunicHex, 0.86), alpha: 1 });

  /* 4. Provider cloak front shoulder clasp & mantle lapel. */
  g.rect(x - 9 * scale, torsoTopY, 18 * scale, 5.5 * scale).fill({ color: cloakHex, alpha: 1 });

  /* 5. Outfit tier progression (1..5 from level 1..30). */
  if (r.outfitTier >= 2) {
    g.rect(x - 8 * scale, torsoTopY + 14 * scale, 16 * scale, 3.2 * scale).fill({ color: trimHex, alpha: 1 });
  }
  if (r.outfitTier >= 3 && detail !== 'reduced') {
    fillOctagon(g, x, torsoTopY + 4.5 * scale, 8.5 * scale, 3.6 * scale, trimHex, 0.95);
  }
  if (r.outfitTier >= 4) {
    g.rect(x - 11 * scale, torsoTopY, 4.5 * scale, 5.5 * scale).fill({ color: 0xebc254, alpha: 1 });
    g.rect(x + 6.5 * scale, torsoTopY, 4.5 * scale, 5.5 * scale).fill({ color: 0xd4a638, alpha: 1 });
    g.rect(x - 8 * scale, torsoTopY + torsoH - 3 * scale, 16 * scale, 2.8 * scale).fill({ color: 0xebc254, alpha: 1 });
  }
  if (r.outfitTier >= 5) {
    g.moveTo(x, torsoTopY + 6 * scale)
      .lineTo(x + 4.2 * scale, torsoTopY + 10.5 * scale)
      .lineTo(x, torsoTopY + 15 * scale)
      .lineTo(x - 4.2 * scale, torsoTopY + 10.5 * scale)
      .closePath()
      .fill({ color: 0xffe478, alpha: 1 });
  }

  /* 6. Head & Headgear. */
  const headY = torsoTopY - 7.5 * scale;
  fillOctagon(g, x, headY, 6.8 * scale, 6.8 * scale, skinHex, 1);

  switch (r.look.headgear) {
    case 'cap':
      fillOctagon(g, x, headY - 4.2 * scale, 7.2 * scale, 4 * scale, trimHex, 1);
      break;
    case 'hood':
      fillOctagon(g, x, headY - 1.5 * scale, 7.6 * scale, 7.6 * scale, cloakHex, 0.94);
      fillOctagon(g, x + dirX * 1.5 * scale, headY + 0.5 * scale, 4.8 * scale, 4.8 * scale, skinHex, 1);
      break;
    case 'helm':
      fillOctagon(g, x, headY - 3.6 * scale, 7.6 * scale, 5.2 * scale, 0xc2bbb0, 1);
      g.rect(x - 1.5 * scale, headY - 11.5 * scale, 3 * scale, 5.5 * scale).fill({ color: trimHex, alpha: 1 });
      break;
    case 'circlet':
      g.rect(x - 6.8 * scale, headY - 4.8 * scale, 13.6 * scale, 2.8 * scale).fill({ color: 0xf7cf60, alpha: 1 });
      g.rect(x + dirX * 1 * scale, headY - 5.2 * scale, 3 * scale, 3 * scale).fill({ color: 0xfff5c2, alpha: 1 });
      break;
    case 'crown':
      g.moveTo(x - 7 * scale, headY - 4 * scale)
        .lineTo(x - 5.5 * scale, headY - 14.5 * scale)
        .lineTo(x, headY - 17 * scale)
        .lineTo(x + 5.5 * scale, headY - 14.5 * scale)
        .lineTo(x + 7 * scale, headY - 4 * scale)
        .closePath()
        .fill({ color: 0xffdc64, alpha: 1 });
      g.rect(x - 2 * scale, headY - 11 * scale, 4 * scale, 4 * scale).fill({ color: 0xd94436, alpha: 1 });
      break;
    case 'none':
      break;
  }

  /* 7. Rank insignia marker for heads, ruler and turnkey generalists. */
  if (r.look.insignia) {
    const badgeY = headY - (r.look.headgear === 'crown' ? 23 : 15) * scale;
    g.moveTo(x, badgeY - 4.5 * scale)
      .lineTo(x + 4.5 * scale, badgeY)
      .lineTo(x, badgeY + 4.5 * scale)
      .lineTo(x - 4.5 * scale, badgeY)
      .closePath()
      .fill({ color: 0xffe06b, alpha: 0.96 });
  }

  /* 8. Held items & animated role/state props. */
  const handX = x + dirX * 10 * scale;
  const handY = torsoTopY + 11 * scale;

  if (r.carrying === 'stone' || r.carrying === 'returned_stone') {
    const isReturned = r.carrying === 'returned_stone';
    const topC = isReturned ? 0xeb987e : 0xf2e6cc;
    const leftC = isReturned ? 0xd4765b : 0xdac8a4;
    const rightC = isReturned ? 0xb4583f : 0xbba67e;
    const bx = x + dirX * 10 * scale;
    const by = torsoTopY + 13 * scale;
    const w = 13 * scale;
    const h = 10 * scale;
    g.moveTo(bx, by - h)
      .lineTo(bx + w * 0.6, by - h + 3.5 * scale)
      .lineTo(bx, by - h + 7 * scale)
      .lineTo(bx - w * 0.6, by - h + 3.5 * scale)
      .closePath()
      .fill({ color: topC, alpha: 1 });
    g.moveTo(bx - w * 0.6, by - h + 3.5 * scale)
      .lineTo(bx, by - h + 7 * scale)
      .lineTo(bx, by + 3 * scale)
      .lineTo(bx - w * 0.6, by - 0.5 * scale)
      .closePath()
      .fill({ color: leftC, alpha: 1 });
    g.moveTo(bx, by - h + 7 * scale)
      .lineTo(bx + w * 0.6, by - h + 3.5 * scale)
      .lineTo(bx + w * 0.6, by - 0.5 * scale)
      .lineTo(bx, by + 3 * scale)
      .closePath()
      .fill({ color: rightC, alpha: 1 });
    if (isReturned) {
      g.rect(bx - 2.2 * scale, by - h + 1.5 * scale, 4.4 * scale, 4.4 * scale).fill({ color: 0x7d1c16, alpha: 0.95 });
    }
  } else if (
    r.carrying === 'scroll' ||
    r.pose === 'holding_scroll' ||
    r.pose === 'inspecting' ||
    r.pose === 'surveying' ||
    r.pose === 'writing'
  ) {
    if (r.pose === 'holding_scroll') {
      fillOctagon(g, handX, handY - 4 * scale, 10 * scale, 10 * scale, 0xffe27a, 0.34);
    }
    g.rect(handX - 5 * scale, handY - 7 * scale, 10 * scale, 13 * scale).fill({ color: 0xfbf2d6, alpha: 1 });
    g.rect(handX - 6 * scale, handY - 8 * scale, 12 * scale, 2.2 * scale).fill({ color: 0x9b6e39, alpha: 1 });
    g.rect(handX - 6 * scale, handY + 5 * scale, 12 * scale, 2.2 * scale).fill({ color: 0x9b6e39, alpha: 1 });
    if (detail !== 'reduced') {
      g.rect(handX - 3 * scale, handY - 3.5 * scale, 6 * scale, 1.2 * scale).fill({ color: 0x5c4630, alpha: 0.8 });
      g.rect(handX - 3 * scale, handY - 0.5 * scale, 5 * scale, 1.2 * scale).fill({ color: 0x5c4630, alpha: 0.8 });
    }
  } else if (r.carrying === 'water_jar' || r.pose === 'extinguishing') {
    fillOctagon(g, handX, handY, 5.2 * scale, 6.8 * scale, 0xc97342, 1);
    g.rect(handX - 2.6 * scale, handY - 8 * scale, 5.2 * scale, 2.6 * scale).fill({ color: 0xa6582e, alpha: 1 });
    if (r.pose === 'extinguishing') {
      const sp = (timeSec * 3.5) % 1;
      fillOctagon(g, handX + dirX * (7 + sp * 11), handY - 6 - sp * 7, 3, 3, 0x62cbff, 1 - sp);
      fillOctagon(g, handX + dirX * (5 + sp * 8), handY - 2 - sp * 10, 2.4, 2.4, 0x9de1ff, 1 - sp);
    }
  } else if (r.pose === 'directing') {
    /* Department head / ruler directing with gilded staff + animation-only poke gesture arc (never stones). */
    const wave = Math.sin(timeSec * 5.2 + r.walkPhase) * 5 * scale;
    const tipX = handX + dirX * 9 * scale;
    const tipY = torsoTopY - 12 * scale + wave;
    fillSegment(g, handX - dirX * 2 * scale, footY - 4 * scale, tipX, tipY, 2.6 * scale, 0xdeb54e, 1);
    fillOctagon(g, tipX, tipY, 3.2 * scale, 3.2 * scale, 0xffe98e, 1);
    if (r.pokeAnimTimer > 0 && detail !== 'reduced') {
      fillOctagon(g, tipX + dirX * 7 * scale, tipY + 2 * scale, 6 * scale, 6 * scale, 0xffdc64, 0.36);
    }
  } else if (r.pose === 'ringing_gong' || r.look.prop === 'gong') {
    const gx = handX + dirX * 2 * scale;
    const gy = handY - 4 * scale;
    fillOctagon(g, gx, gy, 6.5 * scale, 6.5 * scale, 0xf4c74e, 1);
    fillOctagon(g, gx, gy, 3 * scale, 3 * scale, 0xfff0aa, 0.9);
    if (r.pose === 'ringing_gong' && detail !== 'reduced') {
      const pulse = (timeSec * 2.2) % 1;
      fillOctagon(g, gx, gy, (7 + pulse * 14) * scale, (7 + pulse * 14) * scale, 0xffdf78, (1 - pulse) * 0.34);
    }
  } else if (r.pose === 'guarding' || r.look.prop === 'spear_shield') {
    /* Spear + shield scaling visibly with outfit tier (wood at tier 1 -> bronze/gold at tier 4-5). */
    const spearTipColor = r.outfitTier >= 4 ? 0xf3cc5a : r.outfitTier >= 2 ? 0xc8ccd4 : 0x8a6036;
    const shieldColor = r.outfitTier >= 4 ? 0xd9ad46 : r.outfitTier >= 2 ? 0x9f7948 : 0x8d6c44;
    const sx = x + dirX * 11 * scale;
    g.rect(sx - 1.1 * scale, torsoTopY - 20 * scale, 2.2 * scale, footY - (torsoTopY - 20 * scale)).fill({
      color: 0x7b552f,
      alpha: 1,
    });
    g.moveTo(sx, torsoTopY - 27 * scale)
      .lineTo(sx + 3.2 * scale, torsoTopY - 19 * scale)
      .lineTo(sx - 3.2 * scale, torsoTopY - 19 * scale)
      .closePath()
      .fill({ color: spearTipColor, alpha: 1 });
    g.rect(x - dirX * 12 * scale - 4 * scale, torsoTopY + 5 * scale, 8 * scale, 15 * scale).fill({
      color: shieldColor,
      alpha: 1,
    });
    g.rect(x - dirX * 12 * scale - 1.8 * scale, torsoTopY + 10.8 * scale, 3.6 * scale, 3.6 * scale).fill({
      color: 0xffe07a,
      alpha: 0.9,
    });
  } else if (r.pose === 'building' || r.pose === 'building_home' || r.pose === 'carving') {
    const swing = Math.sin(timeSec * 8.5 + r.walkPhase) * 6 * scale;
    fillSegment(
      g,
      handX - dirX * 2 * scale,
      handY + 2 * scale,
      handX + dirX * 7 * scale,
      handY - 8 * scale + swing,
      2.4 * scale,
      0x8b5e32,
      1,
    );
    g.rect(handX + dirX * 5 * scale, handY - 11 * scale + swing, 6 * scale, 4.5 * scale).fill({
      color: 0xaeb5bf,
      alpha: 1,
    });
  } else if (r.look.prop === 'staff') {
    fillSegment(g, handX, footY, handX + dirX * 2 * scale, torsoTopY - 11 * scale, 2.2 * scale, 0xcfa44a, 1);
  } else if (r.look.prop === 'key') {
    fillOctagon(g, handX, handY - 2 * scale, 3.6 * scale, 3.6 * scale, 0xf5cd5c, 1);
    g.rect(handX - 1 * scale, handY + 1 * scale, 2 * scale, 6 * scale).fill({ color: 0xf5cd5c, alpha: 1 });
  } else if (r.look.prop === 'banner') {
    g.rect(handX - 1 * scale, torsoTopY - 16 * scale, 2 * scale, footY - (torsoTopY - 16 * scale)).fill({
      color: 0x7b5630,
      alpha: 1,
    });
    g.moveTo(handX, torsoTopY - 16 * scale)
      .lineTo(handX + dirX * 12 * scale, torsoTopY - 12 * scale)
      .lineTo(handX, torsoTopY - 7 * scale)
      .closePath()
      .fill({ color: trimHex, alpha: 0.96 });
  }
}

/* Reused scratch arrays avoid per-frame allocations when rendering 150 active residents. */
const visibleScratch: ResidentEntity[] = [];

type BuildingOcclusionBox = {
  minCol: number;
  maxCol: number;
  minRow: number;
  maxRow: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

const visibleBuildingBoxes: BuildingOcclusionBox[] = [];

function buildingExtrudedHeight(b: CityBuilding): number {
  switch (b.kind) {
    case 'monument':
      return 30 + Math.round((b.progress ?? 0.5) * (b.spanCol >= 6 ? 120 : 84));
    case 'residence':
      return 28 + b.stage * 10;
    case 'department':
      return 34 + b.stage * 4;
    case 'district_hub':
      return 26 + b.stage * 5;
    case 'supply':
      return 24 + b.stage * 6;
    case 'statue':
      return 16 + Math.min(28, b.stage * 2);
    case 'flophouse':
      return 22 + b.stage * 4;
    case 'house':
      return 16 + Math.min(28, b.stage * 4);
  }
}

function isOccludedByFrontBuilding(r: ResidentEntity, posX: number, posY: number): boolean {
  const sampleY = posY - 18;
  for (let i = 0; i < visibleBuildingBoxes.length; i++) {
    const b = visibleBuildingBoxes[i]!;
    /* In 2:1 isometric painter's order, building b sits in front of (r.col, r.row) iff
       r.col < b.maxCol and r.row < b.maxRow (not strictly South or East of the footprint). */
    if (r.col < b.maxCol - 0.15 && r.row < b.maxRow - 0.15) {
      if (posX > b.minX + 6 && posX < b.maxX - 6 && sampleY > b.minY + 4 && sampleY < b.maxY - 6) {
        return true;
      }
    }
  }
  return false;
}

function drawResidentArtPixi(
  ctx: ResidentArtContext,
  art: ResidentArt,
  r: ResidentEntity,
  pack: WorldPackManifest,
  tileW: number,
  tileH: number,
  selected: boolean,
): boolean {
  const textures = art.layers.map(l => ctx.library.frame(l.path, l.frame));
  if (textures.some(t => !t)) return false;
  const pos = tileCenterToWorld(r.col, r.row, tileW, tileH);
  const x = pos.x;
  const y = pos.y + 2;
  const g = ctx.pool.graphics();
  if (selected) {
    fillOctagon(g, x, y + 1, 23, 11.5, 0xffe484, 0.55);
    fillOctagon(g, x, y + 1, 18, 9, 0xfff5c2, 0.34);
  }
  fillOctagon(g, x + 2, y + 2, 13, 6.2, 0x100c08, 0.28);
  const s = tileW / masterTileW(pack);
  art.layers.forEach((layer, i) => {
    const sprite = ctx.pool.sprite(textures[i]!);
    const place = residentLayerPlacement(layer, art.mirror, s, x, y);
    sprite.anchor.set(layer.anchor.x / layer.frame.w, layer.anchor.y / layer.frame.h);
    sprite.scale.set(place.scaleX, s);
    sprite.position.set(place.x, place.y);
    if (layer.tint) sprite.tint = parseArtTint(layer.tint);
  });
  ctx.library.stats.residentsDrawn++;
  return true;
}

/* The altar picture sits on its tile like a 1x1 building; false keeps the placeholder shrine. */
function drawAltarArtPixi(ctx: ResidentArtContext, index: ArtIndex, sim: ResidentSimulation, tileW: number, tileH: number): boolean {
  const entry = index.files[ALTAR_PICTURE];
  const p = entry?.passport as BuildingPicturePassport | undefined;
  if (!entry || !p || !('groundAnchor' in p)) return false;
  const tex = ctx.library.frame(ALTAR_PICTURE, { x: 0, y: 0, w: entry.w, h: entry.h });
  if (!tex) return false;
  const ctr = tileCenterToWorld(sim.altarTile.col, sim.altarTile.row, tileW, tileH);
  const s = tileW / Math.max(1, p.corners.right.x - p.corners.left.x);
  const sprite = ctx.pool.sprite(tex);
  sprite.anchor.set(p.groundAnchor.x / entry.w, p.groundAnchor.y / entry.h);
  sprite.scale.set(s);
  sprite.position.set(ctr.x, ctr.y);
  return true;
}

export function renderResidentsToPixi(
  g: Graphics,
  sim: ResidentSimulation,
  city: CityState | null,
  pack: WorldPackManifest,
  visibleRect: WorldVisibleRect,
  tileW: number,
  tileH: number,
  detail: AnimationDetailLevel,
  selectedResidentId: string | null,
  outDrawnIds?: Set<string>,
  art?: ResidentArtContext | null,
): void {
  g.clear();
  outDrawnIds?.clear();
  art?.pool.begin();
  if (art) art.library.stats.residentsDrawn = 0;
  const artIndex = art?.library.index ?? null;

  visibleBuildingBoxes.length = 0;
  if (city) {
    for (let i = 0; i < city.buildings.length; i++) {
      const b = city.buildings[i]!;
      const ctr = buildingCenterWorld(b, tileW, tileH);
      if (!inRect(ctr.x, ctr.y, visibleRect, 260)) continue;
      const top = tileTopVertexToWorld(b.col, b.row, tileW, tileH);
      const right = tileTopVertexToWorld(b.col + b.spanCol, b.row, tileW, tileH);
      const bottom = tileTopVertexToWorld(b.col + b.spanCol, b.row + b.spanRow, tileW, tileH);
      const left = tileTopVertexToWorld(b.col, b.row + b.spanRow, tileW, tileH);
      const h = buildingExtrudedHeight(b);
      visibleBuildingBoxes.push({
        minCol: b.col,
        maxCol: b.col + b.spanCol,
        minRow: b.row,
        maxRow: b.row + b.spanRow,
        minX: left.x,
        maxX: right.x,
        minY: top.y - h,
        maxY: bottom.y,
      });
    }

    drawOfflineNightDistrictsPixi(g, sim, city, visibleRect, tileW, tileH);
    drawHomeScaffoldingPixi(g, sim, city, visibleRect, tileW, tileH);
    if (city.buildings.length > 0) {
      const altarPos = tileCenterToWorld(sim.altarTile.col, sim.altarTile.row, tileW, tileH);
      if (inRect(altarPos.x, altarPos.y, visibleRect, 140)) {
        if (art) art.pool.depth = altarPos.y;
        if (!(art && artIndex && drawAltarArtPixi(art, artIndex, sim, tileW, tileH))) {
          drawAltarPixi(g, sim, pack, tileW, tileH, detail);
        }
      }
    }
  }

  /* Viewport-cull, skip passersby occluded behind tall front buildings, and depth-sort visible residents. */
  visibleScratch.length = 0;
  for (let i = 0; i < sim.residents.length; i++) {
    const r = sim.residents[i]!;
    const pos = tileCenterToWorld(r.col, r.row, tileW, tileH);
    if (!inRect(pos.x, pos.y, visibleRect, 120)) continue;
    if (r.id !== selectedResidentId && isOccludedByFrontBuilding(r, pos.x, pos.y)) continue;
    visibleScratch.push(r);
  }
  visibleScratch.sort((a, b) => a.col + a.row - (b.col + b.row));

  for (let i = 0; i < visibleScratch.length; i++) {
    const r = visibleScratch[i]!;
    outDrawnIds?.add(r.id);
    const selected = r.id === selectedResidentId;
    if (art) {
      /* Through the pool, art or placeholder, at the depth of the feet among buildings and plants. */
      art.pool.depth = tileCenterToWorld(r.col, r.row, tileW, tileH).y;
      const resolved = artIndex ? resolveResidentArt(pack, artIndex, r, sim.timeSec) : null;
      if (!resolved || !drawResidentArtPixi(art, resolved, r, pack, tileW, tileH, selected)) {
        drawResidentPixi(art.pool.graphics(), r, sim.timeSec, tileW, tileH, detail, selected);
      }
      continue;
    }
    drawResidentPixi(g, r, sim.timeSec, tileW, tileH, detail, selected);
  }

  if (city) {
    if (art) art.pool.depth = Number.MAX_SAFE_INTEGER;
    drawDepartmentAlertsPixi(art ? art.pool.graphics() : g, sim, city, visibleRect, tileW, tileH, detail);
  }
}

/* Minimal Canvas 2D fallback renderer so headless / non-WebGL browsers show residents cleanly too. */
export function renderResidentsFallback2D(
  ctx: CanvasRenderingContext2D,
  sim: ResidentSimulation,
  city: CityState | null,
  pack: WorldPackManifest,
  visibleRect: WorldVisibleRect,
  tileW: number,
  tileH: number,
  selectedResidentId: string | null,
): void {
  if (city && city.buildings.length > 0) {
    const altar = tileCenterToWorld(sim.altarTile.col, sim.altarTile.row, tileW, tileH);
    if (inRect(altar.x, altar.y, visibleRect, 120)) {
      ctx.fillStyle = hexToCss(parseHex(pack.palette.selectStroke, 0xffd166), 0.35);
      ctx.beginPath();
      ctx.ellipse(altar.x, altar.y, tileW * 0.45, tileH * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#E6D6B5';
      ctx.fillRect(altar.x - 6, altar.y - 44, 12, 34);
    }
  }

  const vis = sim.residents
    .filter(r => {
      const p = tileCenterToWorld(r.col, r.row, tileW, tileH);
      return inRect(p.x, p.y, visibleRect, 110);
    })
    .sort((a, b) => a.col + a.row - (b.col + b.row));

  for (const r of vis) {
    const p = tileCenterToWorld(r.col, r.row, tileW, tileH);
    if (r.id === selectedResidentId) {
      ctx.strokeStyle = '#FFE484';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + 2, 20, 10, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = r.cloakColor;
    ctx.fillRect(p.x - 9, p.y - 38, 18, 26);
    ctx.fillStyle = r.look.tunicColor;
    ctx.fillRect(p.x - 7, p.y - 36, 14, 22);
    ctx.fillStyle = '#D7A479';
    ctx.beginPath();
    ctx.arc(p.x, p.y - 45, 6.5, 0, Math.PI * 2);
    ctx.fill();
  }
}
