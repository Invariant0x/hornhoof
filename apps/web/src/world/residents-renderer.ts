/* Pack-agnostic 2:1 isometric renderer for live residents: viewport-culled, depth-sorted residents and the altar from
   their artist sheets, and the offline machines' night wash. A resident or the altar with no art yet shows one flat
   placeholder on the ground (placeholders.ts, #1947 item 11). Contains zero theme-specific words. */

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
import type { WorldPackManifest } from './manifest';
import { fillDiamond2D, fillDiamondPixi, lotDiamond, parseHexColor, pointDiamond } from './placeholders';
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
  /* The resident's ground point on the grid of tile edges the boxes use: a tile's centre lies half a tile in. */
  const x = r.col + 0.5;
  const y = r.row + 0.5;
  for (let i = 0; i < visibleBuildingBoxes.length; i++) {
    const b = visibleBuildingBoxes[i]!;
    /* A resident on a building's own lot, or stepping onto it, stands at its front edge at work there (#2001): in
       front of it, not behind. */
    if (x >= b.minCol && x <= b.maxCol && y >= b.minRow && y <= b.maxRow) continue;
    /* In 2:1 isometric painter's order, building b sits in front of the resident iff its ground point is short of
       the footprint's south-east and south-west edges. */
    if (x < b.maxCol - 0.15 && y < b.maxRow - 0.15) {
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

const PLACEHOLDER_ALPHA = 0.9;

/* A resident with no art: a small flat diamond at its feet in its cloak colour, the pack's select colour if picked. */
function residentPlaceholder(r: ResidentEntity, pack: WorldPackManifest, tileW: number, tileH: number, selected: boolean) {
  const pos = tileCenterToWorld(r.col, r.row, tileW, tileH);
  return {
    diamond: pointDiamond(pos.x, pos.y + 2, tileW, tileH),
    color: selected ? parseHexColor(pack.palette.selectStroke, 0xffd166) : parseHexColor(r.cloakColor, 0xc96a4b),
  };
}

function drawResidentPlaceholderPixi(
  g: Graphics,
  r: ResidentEntity,
  pack: WorldPackManifest,
  tileW: number,
  tileH: number,
  selected: boolean,
): void {
  const p = residentPlaceholder(r, pack, tileW, tileH, selected);
  fillDiamondPixi(g, p.diamond, p.color, PLACEHOLDER_ALPHA);
}

/* The altar with no picture: its tile, flat, in the pack's select colour. */
function altarPlaceholder(sim: ResidentSimulation, tileW: number, tileH: number) {
  return lotDiamond(sim.altarTile.col, sim.altarTile.row, 1, 1, tileW, tileH, 0.15);
}

function altarColor(pack: WorldPackManifest): number {
  return parseHexColor(pack.palette.selectStroke, 0xffd166);
}

export function renderResidentsToPixi(
  g: Graphics,
  sim: ResidentSimulation,
  city: CityState | null,
  pack: WorldPackManifest,
  visibleRect: WorldVisibleRect,
  tileW: number,
  tileH: number,
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
    if (city.buildings.length > 0) {
      const altarPos = tileCenterToWorld(sim.altarTile.col, sim.altarTile.row, tileW, tileH);
      if (inRect(altarPos.x, altarPos.y, visibleRect, 140)) {
        if (art) art.pool.depth = altarPos.y;
        if (!(art && artIndex && drawAltarArtPixi(art, artIndex, sim, tileW, tileH))) {
          fillDiamondPixi(art ? art.pool.graphics() : g, altarPlaceholder(sim, tileW, tileH), altarColor(pack), PLACEHOLDER_ALPHA);
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
        drawResidentPlaceholderPixi(art.pool.graphics(), r, pack, tileW, tileH, selected);
      }
      continue;
    }
    drawResidentPlaceholderPixi(g, r, pack, tileW, tileH, selected);
  }
}

/* Canvas 2D fallback renderer for browsers without WebGL: the same flat placeholders as the Pixi path. */
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
      fillDiamond2D(ctx, altarPlaceholder(sim, tileW, tileH), altarColor(pack), PLACEHOLDER_ALPHA);
    }
  }

  const vis = sim.residents
    .filter(r => {
      const p = tileCenterToWorld(r.col, r.row, tileW, tileH);
      return inRect(p.x, p.y, visibleRect, 110);
    })
    .sort((a, b) => a.col + a.row - (b.col + b.row));

  for (const r of vis) {
    const p = residentPlaceholder(r, pack, tileW, tileH, r.id === selectedResidentId);
    fillDiamond2D(ctx, p.diamond, p.color, PLACEHOLDER_ALPHA);
  }
}
