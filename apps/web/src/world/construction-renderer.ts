/* Stage 6 pack-agnostic dynamic building animation loop & work-slot renderer:
   renders pivoting jib cranes, hoisted stone blocks on ropes, construction/demolition dust clouds,
   hearth/workshop smoke wisps, supply water ripples, fluttering fabric awnings, monument capstone
   celebration sparks/pennants, and animated resident work slots (open-room interior masons,
   elevated scaffold hammerers, ramp carriers, 2-worker wooden sled haulers, statue carvers and
   demolition crews). Uses low-poly filled geometry strictly viewport-culled for 60 FPS speed.
   Contains zero theme-specific words. */

import type { Graphics } from 'pixi.js';
import { masterTileW, resolveBuildingArt, type ArtPoint, type LoopAttachPoint, type SheetPassport } from './art';
import type { DisplayRunPool, WorldArtLibrary } from './art-runtime';
import { cityDepthY, type CityBuilding, type CityState } from './city-layout';
import {
  buildingLoopsFor,
  resolveStageSpecForBuilding,
  workSlotsForBuilding,
  type BuildingConstructionState,
  type ConstructionSimulation,
  type WorkSlot,
} from './construction';
import { tileCenterToWorld, tileTopVertexToWorld } from './coords';
import {
  resolveConstructionPalette,
  type AnimationDetailLevel,
  type WorldPackManifest,
} from './manifest';
import type { WorldVisibleRect } from './residents-renderer';

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

function inRect(x: number, y: number, rect: WorldVisibleRect, pad: number): boolean {
  return x >= rect.minX - pad && x <= rect.maxX + pad && y >= rect.minY - pad && y <= rect.maxY + pad;
}

/* Artist loop sheets, and the attach points of buildings drawn from artist pictures. */
export type LoopArtContext = Readonly<{
  library: WorldArtLibrary;
  pool: DisplayRunPool;
  /* The drawn variant of each building's step, so loops sit on the variant's own anchors. */
  variants: ReadonlyMap<string, number>;
}>;

type LoopAnchors = Readonly<Record<LoopAttachPoint, { x: number; y: number }>>;

/* Where loops attach on a building drawn from its picture, from the picture's passport; null for placeholders. */
function artLoopAnchors(
  art: LoopArtContext,
  building: CityBuilding,
  state: BuildingConstructionState | null,
  pack: WorldPackManifest,
  ctr: { x: number; y: number },
  tileW: number,
): LoopAnchors | null {
  const index = art.library.index;
  if (!index) return null;
  const resolved = resolveBuildingArt(pack, index, building, state, { variant: art.variants.get(building.id) });
  if (!resolved || resolved.layers.some(l => !art.library.frame(l.path, l.frame))) return null;
  const p = resolved.passport;
  const s = tileW / resolved.artPxPerTile;
  const at = (pt: ArtPoint) => ({ x: ctr.x + (pt.x - p.groundAnchor.x) * s, y: ctr.y + (pt.y - p.groundAnchor.y) * s });
  const top = p.topAnchor
    ? at(p.topAnchor)
    : at({ x: p.groundAnchor.x, y: p.roofLine ?? p.wallTopLine ?? p.corners.top.y });
  return {
    top,
    awning: p.awningAnchor ? at(p.awningAnchor) : top,
    door: p.door ? at(p.door) : ctr,
    ground: ctr,
  };
}

function drawLoopSheet(
  art: LoopArtContext,
  kind: string,
  anchors: LoopAnchors,
  timeSec: number,
  phaseOffset: number,
  intensity: number,
  scale: number,
): boolean {
  const path = `loops/${kind}.png`;
  const entry = art.library.index?.files[path];
  const sheet = entry?.passport as SheetPassport | undefined;
  if (!entry || !sheet || !('frames' in sheet)) return false;
  const frameIdx = Math.floor((timeSec + phaseOffset) * sheet.fps) % sheet.frames;
  const tex = art.library.frame(path, { x: frameIdx * sheet.frameW, y: 0, w: sheet.frameW, h: sheet.frameH });
  if (!tex) return false;
  const at = anchors[sheet.attach ?? 'top'];
  const sprite = art.pool.sprite(tex);
  sprite.anchor.set(sheet.anchor.x / sheet.frameW, sheet.anchor.y / sheet.frameH);
  sprite.scale.set(scale);
  sprite.position.set(at.x, at.y);
  sprite.alpha = Math.max(0.2, Math.min(1, intensity));
  return true;
}

function buildingCenter(b: CityBuilding, tileW: number, tileH: number): { x: number; y: number } {
  return tileCenterToWorld(b.col + (b.spanCol - 1) * 0.5, b.row + (b.spanRow - 1) * 0.5, tileW, tileH);
}

function roofElevationPx(
  b: CityBuilding,
  state: BuildingConstructionState | null,
  pack: WorldPackManifest,
): number {
  if (b.kind === 'monument') {
    const progress = state
      ? Math.max(0.12, state.currentStage / Math.max(1, state.maxStage))
      : Math.max(0.12, Math.min(1, b.progress ?? b.stage / Math.max(1, b.maxStage)));
    const maxApex = 38 + b.spanCol * 22;
    return 10 + Math.round(maxApex * (b.reached && !state ? 1 : progress));
  }
  if (b.kind === 'statue') {
    const st = state ? state.currentStage : b.stage;
    const maxS = Math.max(1, state ? state.maxStage : b.maxStage);
    const ratio = Math.max(0.08, Math.min(1, st / maxS));
    return 10 + b.spanCol * 3 + Math.round((32 + b.spanCol * 24) * ratio);
  }
  if (state) {
    const spec = resolveStageSpecForBuilding(b, state, pack);
    return Math.round(10 + spec.heightRatio * (34 + b.spanCol * 7));
  }
  if (b.kind === 'department') return 36 + b.stage * 5;
  if (b.kind === 'residence') return 30 + b.stage * 11;
  if (b.kind === 'district_hub') return 30 + b.spanCol * 7;
  if (b.kind === 'supply') return 18;
  return 20 + Math.min(10, b.stage) * 3.5;
}

/* Draws a 3D isometric stone block suspended by rope or carried on a sled. */
function drawStoneBlock(g: Graphics, cx: number, cy: number, size: number, topColor = 0xf2e6cc): void {
  const w = size;
  const h = size * 0.72;
  g.moveTo(cx, cy - h)
    .lineTo(cx + w * 0.65, cy - h + w * 0.32)
    .lineTo(cx, cy - h + w * 0.64)
    .lineTo(cx - w * 0.65, cy - h + w * 0.32)
    .closePath()
    .fill({ color: topColor, alpha: 1 });
  g.moveTo(cx - w * 0.65, cy - h + w * 0.32)
    .lineTo(cx, cy - h + w * 0.64)
    .lineTo(cx, cy + w * 0.28)
    .lineTo(cx - w * 0.65, cy - w * 0.04)
    .closePath()
    .fill({ color: shadeHex(topColor, 0.87), alpha: 1 });
  g.moveTo(cx, cy - h + w * 0.64)
    .lineTo(cx + w * 0.65, cy - h + w * 0.32)
    .lineTo(cx + w * 0.65, cy - w * 0.04)
    .lineTo(cx, cy + w * 0.28)
    .closePath()
    .fill({ color: shadeHex(topColor, 0.74), alpha: 1 });
}

/* Draws a pivoting timber jib crane + optional hoisted stone block on rope atop a construction site. */
function drawCraneLoop(
  g: Graphics,
  cx: number,
  baseY: number,
  timeSec: number,
  phase: number,
  woodHex: number,
  withHoistBlock: boolean,
  scale = 1,
): void {
  const mastH = 34 * scale;
  const boomLen = 36 * scale;
  const swing = Math.sin(timeSec * 1.15 + phase) * 9 * scale;
  const tipX = cx + boomLen * 0.72 + swing;
  const tipY = baseY - mastH - 12 * scale + Math.cos(timeSec * 1.15 + phase) * 3 * scale;
  const counterX = cx - 12 * scale - swing * 0.25;
  const counterY = baseY - mastH + 6 * scale;

  /* Vertical mast + angled support brace. */
  fillSegment(g, cx, baseY, cx, baseY - mastH, 4.2 * scale, woodHex, 1);
  fillSegment(g, cx - 10 * scale, baseY + 2, cx, baseY - mastH * 0.65, 2.8 * scale, shadeHex(woodHex, 0.82), 1);
  fillSegment(g, cx + 9 * scale, baseY + 2, cx, baseY - mastH * 0.65, 2.8 * scale, shadeHex(woodHex, 0.76), 1);

  /* Pivoting boom jib + counterweight stone. */
  fillSegment(g, counterX, counterY, tipX, tipY, 3.6 * scale, shadeHex(woodHex, 1.12), 1);
  fillSegment(g, cx, baseY - mastH - 4 * scale, tipX, tipY, 1.6 * scale, 0xd8c39b, 0.9);
  g.rect(counterX - 4 * scale, counterY, 8 * scale, 7 * scale).fill({ color: 0x8b8172, alpha: 1 });

  if (withHoistBlock) {
    /* Taut rope lowering & lifting a cut masonry block smoothly. */
    const liftCycle = (Math.sin(timeSec * 1.8 + phase) + 1) * 0.5;
    const ropeLen = (14 + liftCycle * 22) * scale;
    const blockY = tipY + ropeLen;
    fillSegment(g, tipX, tipY, tipX, blockY - 6 * scale, 1.6 * scale, 0xded0ae, 0.95);
    drawStoneBlock(g, tipX, blockY, 13 * scale, 0xf3e7cc);
  }
}

/* Draws construction or demolition dust clouds puffing around active walls & rubble. */
function drawDustLoop(
  g: Graphics,
  cx: number,
  cy: number,
  spanPx: number,
  timeSec: number,
  phase: number,
  dustHex: number,
  intensity: number,
  detail: AnimationDetailLevel,
): void {
  const count = detail === 'reduced' ? 3 : Math.round(4 + intensity * 2);
  for (let i = 0; i < count; i++) {
    const life = (timeSec * (0.48 + intensity * 0.16) + phase + i / count) % 1;
    const spread = ((i % 2 === 0 ? 1 : -1) * (0.22 + (i * 0.17) % 0.45)) * spanPx;
    const px = cx + spread + Math.sin(life * 4.5 + i) * 6;
    const py = cy + 6 - life * (22 + intensity * 16);
    const rad = (6 + life * 11) * Math.min(1.4, intensity);
    const alpha = Math.sin(life * Math.PI) * 0.52;
    fillOctagon(g, px, py, rad, rad * 0.72, dustHex, alpha);
  }
}

/* Draws soft rising hearth/workshop smoke wisps. */
function drawSmokeLoop(
  g: Graphics,
  cx: number,
  topY: number,
  timeSec: number,
  phase: number,
  smokeHex: number,
  intensity: number,
  detail: AnimationDetailLevel,
): void {
  const count = detail === 'reduced' ? 2 : 4;
  for (let i = 0; i < count; i++) {
    const life = (timeSec * 0.34 + phase + i / count) % 1;
    const px = cx + 10 + Math.sin(life * 4 + i) * 5 + life * 22;
    const py = topY - 4 - life * 48;
    const rad = 5 + life * 10;
    const alpha = Math.sin(life * Math.PI) * 0.34 * intensity;
    fillOctagon(g, px, py, rad, rad * 0.85, smokeHex, alpha);
  }
}

/* Draws shimmering water ripples & dipping bucket droplets over supply basins & courtyard pools. */
function drawWaterLoop(
  g: Graphics,
  cx: number,
  topY: number,
  timeSec: number,
  phase: number,
  waterHex: number,
  intensity: number,
): void {
  const p1 = (timeSec * 0.9 + phase) % 1;
  const p2 = (timeSec * 0.9 + phase + 0.5) % 1;
  fillOctagon(g, cx, topY, 8 + p1 * 18, 4 + p1 * 9, waterHex, (1 - p1) * 0.48 * intensity);
  fillOctagon(g, cx, topY, 8 + p2 * 18, 4 + p2 * 9, 0xd4f4ff, (1 - p2) * 0.4 * intensity);
  /* Animated water shimmer droplets rising from basin/well. */
  const drop = (timeSec * 2.1 + phase) % 1;
  fillOctagon(g, cx + (drop - 0.5) * 14, topY - 4 - Math.sin(drop * Math.PI) * 12, 2.5, 2.5, 0x9ce7ff, 0.85);
}

/* Draws a gently fluttering striped fabric canopy/awning along the front sunlit facade. */
function drawAwningLoop(
  g: Graphics,
  b: CityBuilding,
  roofY: number,
  timeSec: number,
  phase: number,
  primaryHex: number,
  secondaryHex: number,
  tileW: number,
  tileH: number,
): void {
  const left = tileTopVertexToWorld(b.col + 0.14, b.row + b.spanRow - 0.12, tileW, tileH);
  const bottom = tileTopVertexToWorld(b.col + b.spanCol - 0.14, b.row + b.spanRow - 0.12, tileW, tileH);
  const midX = (left.x + bottom.x) * 0.5;
  const midY = (left.y + bottom.y) * 0.5 - Math.min(20, roofY * 0.45);
  const flutter = Math.sin(timeSec * 3.2 + phase) * 2.4;

  const awW = Math.min(34, (bottom.x - left.x) * 0.45);
  const awDrop = 9 + flutter * 0.35;

  g.moveTo(midX - awW * 0.6, midY - 6)
    .lineTo(midX + awW * 0.6, midY + 4)
    .lineTo(midX + awW * 0.6 - 10, midY + 4 + awDrop)
    .lineTo(midX - awW * 0.6 - 10, midY - 6 + awDrop)
    .closePath()
    .fill({ color: primaryHex, alpha: 0.94 });

  /* Alternating light stripe across awning fabric. */
  g.moveTo(midX - awW * 0.16, midY - 2)
    .lineTo(midX + awW * 0.22, midY + 1)
    .lineTo(midX + awW * 0.22 - 10, midY + 1 + awDrop)
    .lineTo(midX - awW * 0.16 - 10, midY - 2 + awDrop)
    .closePath()
    .fill({ color: secondaryHex, alpha: 0.92 });
}

/* Draws golden capstone sunburst & rising festive celebration sparkles/pennants on completed monuments. */
function drawCelebrationLoop(
  g: Graphics,
  cx: number,
  apexY: number,
  baseY: number,
  spanCol: number,
  timeSec: number,
  phase: number,
  primaryHex: number,
  secondaryHex: number,
  intensity: number,
  detail: AnimationDetailLevel,
): void {
  /* Pulsing golden sunburst halo around the apex capstone. */
  const pulse = 1 + Math.sin(timeSec * 3.4 + phase) * 0.22;
  fillOctagon(g, cx, apexY - 4, 22 * pulse * intensity, 22 * pulse * intensity, primaryHex, 0.26);
  fillOctagon(g, cx, apexY - 4, 10 * pulse * intensity, 10 * pulse * intensity, 0xfff8cf, 0.72);

  if (detail === 'reduced') return;

  /* Rising celebratory light sparks & confetti flecks. */
  const sparkCount = Math.round(6 + intensity * 6);
  for (let i = 0; i < sparkCount; i++) {
    const life = (timeSec * 0.72 + phase + i / sparkCount) % 1;
    const ang = (i * 2.3999) + timeSec * 0.6;
    const spread = (14 + life * 44) * Math.min(1.4, spanCol * 0.35);
    const sx = cx + Math.cos(ang) * spread;
    const sy = apexY + 12 - life * 58 + Math.sin(life * 5) * 4;
    const color = i % 3 === 0 ? primaryHex : i % 3 === 1 ? secondaryHex : 0xfff7c4;
    const r = (2.6 + (1 - life) * 2.2) * intensity;
    fillOctagon(g, sx, sy, r, r, color, Math.sin(life * Math.PI) * 0.92);
  }

  /* Festival pennants fluttering along the base front edge when full celebration (monument). */
  if (intensity >= 0.85) {
    for (const side of [-1, 1]) {
      const px = cx + side * (spanCol * 26);
      const py = baseY + 6;
      const wave = Math.sin(timeSec * 5 + side) * 3;
      fillSegment(g, px, py, px, py - 24, 2.2, 0x7c542c, 1);
      g.moveTo(px, py - 24)
        .lineTo(px + 14, py - 20 + wave)
        .lineTo(px, py - 14)
        .closePath()
        .fill({ color: side < 0 ? primaryHex : secondaryHex, alpha: 0.96 });
    }
  }
}

/* Draws an active worker occupying a concrete construction work slot (scaffolding, open interior room,
   haul ramp, 2-worker heavy stone sled team, statue carving, or reverse-demolition rubble crew). */
function drawWorkSlotWorker(
  g: Graphics,
  slot: WorkSlot,
  timeSec: number,
  tileW: number,
  tileH: number,
  woodHex: number,
  dustHex: number,
): void {
  const base = tileCenterToWorld(slot.col, slot.row, tileW, tileH);
  const dirX = slot.facing === 'W' || slot.facing === 'N' ? -1 : 1;

  if (slot.action === 'pull_sled') {
    /* Heavy wooden sled carrying a cut stone block pulled rhythmically by 2 hauling workers! */
    const cycle = ((timeSec * 0.32) % 1) - 0.5;
    const sx = base.x + cycle * 42;
    const sy = base.y + cycle * 21;

    /* Ground shadow + trailing sled dust. */
    fillOctagon(g, sx - 12, sy + 4, 9, 4.5, dustHex, 0.42);
    /* Twin wooden sled runners. */
    fillSegment(g, sx - 16, sy - 2, sx + 12, sy + 10, 3.2, woodHex, 1);
    fillSegment(g, sx - 10, sy - 8, sx + 18, sy + 4, 3.2, shadeHex(woodHex, 0.86), 1);
    /* Heavy dressed stone block strapped to the sled. */
    drawStoneBlock(g, sx + 1, sy - 4, 17, 0xf0e3c6);

    /* Two hauling workers leaning forward pulling taut sled ropes. */
    for (let w = 0; w < 2; w++) {
      const wx = sx + 22 + w * 14;
      const wy = sy + 9 + w * 7;
      const bob = Math.abs(Math.sin(timeSec * 6.5 + w)) * 2.2;
      fillSegment(g, sx + 12, sy + 4, wx - 3, wy - 14 - bob, 1.5, 0xd8c39b, 0.92);
      fillOctagon(g, wx, wy + 2, 7, 3.5, 0x120d08, 0.25);
      g.rect(wx - 4, wy - 24 - bob, 8, 16).fill({ color: 0xdcc498, alpha: 1 });
      g.rect(wx - 4.5, wy - 24 - bob, 9, 4).fill({ color: w === 0 ? 0xc96a4b : 0x3fa796, alpha: 1 });
      fillOctagon(g, wx, wy - 29 - bob, 4.5, 4.5, 0xd7a479, 1);
    }
    return;
  }

  let wx = base.x;
  let wy = base.y - slot.elevationPx;
  if (slot.action === 'carry_ramp') {
    const rampT = (Math.sin(timeSec * 1.9) + 1) * 0.5;
    wx -= rampT * 18;
    wy -= rampT * 16;
  }

  const swing = Math.sin(timeSec * 9.0 + (slot.col + slot.row)) * 6;
  fillOctagon(g, wx, wy + 2, 7, 3.5, 0x100c08, 0.25);
  /* Tunic + shoulder mantle + head. */
  g.rect(wx - 4.5, wy - 24, 9, 17).fill({ color: 0xdec69c, alpha: 1 });
  const mantleColor =
    slot.action === 'demolish_rubble'
      ? 0xc95f44
      : slot.action === 'carve_statue'
        ? 0x4b8ca6
        : slot.action === 'interior_mason'
          ? 0x4da167
          : 0xc98a3b;
  g.rect(wx - 5, wy - 24, 10, 4.5).fill({ color: mantleColor, alpha: 1 });
  fillOctagon(g, wx, wy - 29.5, 4.6, 4.6, 0xd7a479, 1);

  if (slot.action === 'carry_ramp') {
    drawStoneBlock(g, wx + dirX * 7, wy - 15, 10, 0xf2e6cc);
  } else {
    /* Swinging mallet / chisel / pickaxe + work spark fleck! */
    const hx = wx + dirX * 10;
    const hy = wy - 21 + swing;
    fillSegment(g, wx + dirX * 3, wy - 14, hx, hy, 2.2, 0x7e542a, 1);
    g.rect(hx - 2.5, hy - 2.5, 5, 4).fill({
      color: slot.action === 'demolish_rubble' ? 0xd96846 : 0xb4bcc8,
      alpha: 1,
    });
    if (swing < -2.5) {
      fillOctagon(g, hx + dirX * 3, hy + 2, 3.2, 3.2, 0xfff0b2, 0.8);
    }
  }
}

export function renderConstructionLoopsToPixi(
  g: Graphics,
  sim: ConstructionSimulation,
  city: CityState | null,
  pack: WorldPackManifest,
  visibleRect: WorldVisibleRect,
  tileW: number,
  tileH: number,
  detail: AnimationDetailLevel,
  art?: LoopArtContext | null,
): void {
  g.clear();
  art?.pool.begin();
  if (!city) return;
  const loopScale = tileW / masterTileW(pack);

  const pal = resolveConstructionPalette(pack);
  const woodHex = parseHex(pal.scaffoldWood, 0xb9874a);
  const dustHex = parseHex(pal.dustColor, 0xdfcfaf);
  const smokeHex = parseHex(pal.smokeColor, 0x6d717c);
  const waterHex = parseHex(pal.waterColor, 0x56bde8);
  const awning1Hex = parseHex(pal.awningPrimary, 0xc96a4b);
  const awning2Hex = parseHex(pal.awningSecondary, 0xf2e5c4);
  const celeb1Hex = parseHex(pal.celebrationPrimary, 0xffe270);
  const celeb2Hex = parseHex(pal.celebrationSecondary, 0x5fd1a8);

  /* Gather active buildings + any relocating old-site demolition ghosts still on the map. */
  const entries: Array<{ building: CityBuilding; state: BuildingConstructionState | null }> = [];
  const seen = new Set<string>();
  for (const b of city.buildings) {
    const job = sim.jobs.get(b.id) ?? null;
    seen.add(b.id);
    if (job && job.phase === 'cleared') continue;
    entries.push({ building: b, state: job });
  }
  for (const job of sim.jobs.values()) {
    if (seen.has(job.buildingId) || job.phase === 'cleared') continue;
    entries.push({ building: job.buildingSnapshot, state: job });
  }

  for (const { building, state } of entries) {
    const ctr = buildingCenter(building, tileW, tileH);
    if (!inRect(ctr.x, ctr.y, visibleRect, 240)) continue;

    const loops = buildingLoopsFor(building, state, pack);
    const anchors = art ? artLoopAnchors(art, building, state, pack, ctr, tileW) : null;
    /* With a depth-sorted pool the loops sit just over their own building, so a building in front hides them too. */
    if (art) art.pool.depth = cityDepthY(building, tileH) + 0.5;
    const lg = art ? art.pool.graphics() : g;
    const roofH = anchors ? Math.max(0, ctr.y - anchors.top.y) : roofElevationPx(building, state, pack);
    const spanPx = Math.max(tileW * 0.6, building.spanCol * tileW * 0.42);
    const hasHoist = loops.some(l => l.kind === 'hoist_block');

    for (const loop of loops) {
      if (art && anchors && drawLoopSheet(art, loop.kind, anchors, sim.timeSec, loop.phaseOffset, loop.intensity, loopScale)) {
        continue;
      }
      /* A painted building brings its own awning (a picture layer) or has none: no stand-in canopy over the art. */
      if (anchors && loop.kind === 'awning') continue;
      switch (loop.kind) {
        case 'water':
          drawWaterLoop(lg, ctr.x, ctr.y - 16, sim.timeSec, loop.phaseOffset, waterHex, loop.intensity);
          break;
        case 'awning':
          drawAwningLoop(
            lg,
            building,
            roofH,
            sim.timeSec,
            loop.phaseOffset,
            awning1Hex,
            awning2Hex,
            tileW,
            tileH,
          );
          break;
        case 'dust':
          drawDustLoop(
            lg,
            ctr.x,
            ctr.y,
            spanPx,
            sim.timeSec,
            loop.phaseOffset,
            dustHex,
            loop.intensity,
            detail,
          );
          break;
        case 'crane':
          drawCraneLoop(
            lg,
            ctr.x + (building.spanCol >= 4 ? 14 : 4),
            ctr.y - roofH + 4,
            sim.timeSec,
            loop.phaseOffset,
            woodHex,
            hasHoist,
            building.spanCol >= 4 ? 1.15 : 0.85,
          );
          break;
        case 'hoist_block':
          /* Rendered integrated with the crane jib above when crane is active. */
          break;
        case 'smoke':
          drawSmokeLoop(
            lg,
            ctr.x,
            ctr.y - roofH,
            sim.timeSec,
            loop.phaseOffset,
            smokeHex,
            loop.intensity,
            detail,
          );
          break;
        case 'celebration':
          drawCelebrationLoop(
            lg,
            ctr.x,
            ctr.y - roofH,
            ctr.y + building.spanRow * tileH * 0.35,
            building.spanCol,
            sim.timeSec,
            loop.phaseOffset,
            celeb1Hex,
            celeb2Hex,
            loop.intensity,
            detail,
          );
          break;
      }
    }

    /* Draw work-slot workers (open interior rooms, scaffolds, ramps, sled teams, sculptors, demolition). */
    const slots = workSlotsForBuilding(building, state, pack, city.footprintOccupant);
    for (const slot of slots) {
      drawWorkSlotWorker(lg, slot, sim.timeSec, tileW, tileH, woodHex, dustHex);
    }
  }
}

/* Lightweight Canvas 2D fallback for Stage 6 construction animations. */
export function renderConstructionLoopsFallback2D(
  ctx: CanvasRenderingContext2D,
  sim: ConstructionSimulation,
  city: CityState | null,
  pack: WorldPackManifest,
  visibleRect: WorldVisibleRect,
  tileW: number,
  tileH: number,
): void {
  if (!city) return;
  const pal = resolveConstructionPalette(pack);
  for (const b of city.buildings) {
    const job = sim.jobs.get(b.id) ?? null;
    if (job && job.phase === 'cleared') continue;
    const ctr = buildingCenter(b, tileW, tileH);
    if (!inRect(ctr.x, ctr.y, visibleRect, 200)) continue;
    const loops = buildingLoopsFor(b, job, pack);
    const roofH = roofElevationPx(b, job, pack);
    if (loops.some(l => l.kind === 'crane')) {
      ctx.strokeStyle = pal.scaffoldWood;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(ctr.x, ctr.y - roofH);
      ctx.lineTo(ctr.x, ctr.y - roofH - 32);
      ctx.lineTo(ctr.x + 26, ctr.y - roofH - 42);
      ctx.stroke();
    }
    if (loops.some(l => l.kind === 'celebration')) {
      ctx.fillStyle = pal.celebrationPrimary;
      ctx.beginPath();
      ctx.arc(ctr.x, ctr.y - roofH - 8, 9, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
