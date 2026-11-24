/* Pack-agnostic 2:1 isometric city renderer for live cities. Draws roads and bridges, then every building from its
   pictures in depth order; a building with no picture yet, the outer wall and the empty-lot stakes show one flat
   placeholder each (placeholders.ts, #1947 item 11). Pending God's Word relocation overlays go on top.
   Contains zero theme-specific words. */

import type { WorldMode } from '@hornhoof/protocol/world';
import type { Graphics, MeshSimple, Texture } from 'pixi.js';
import { artFootprintCentre, resolveBuildingArt, type BuildingArt, type BuildingArtLayer } from './art';
import { parseArtTint, type DisplayRunPool, type WorldArtLibrary } from './art-runtime';
import { cityDepthY, type CityBuilding, type CityState, type RoadTier } from './city-layout';
import { clothWind, swayClothVertices } from './cloth';
import type { BuildingConstructionState } from './construction';
import { tileCenterToWorld, tileDiamondVertices, type Point2D, type TileCoord } from './coords';
import type { WorldPackManifest } from './manifest';
import {
  buildingPlaceholder,
  fillDiamond2D,
  fillDiamondPixi,
  lotDiamond,
  type FlatDiamond,
} from './placeholders';

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
  /* The drawn variant of each building's step (building-variants.ts). */
  variants: ReadonlyMap<string, number>;
  /* Streets are painted on the ground (road-strips.ts): draw only the bridges. */
  paintedRoads?: boolean;
  /* Filled with the cloth layers drawn, for the per-frame wind pass (swayCloths). */
  swaying?: ClothLayer[];
}>;

/* A cloth layer drawn as a mesh by the last city pass (cloth.ts), for the per-frame wind pass. */
export type ClothLayer = {
  mesh: MeshSimple;
  /* Vertex weights from the cloth mask, and the layer's size in picture pixels. */
  weights: Float32Array;
  w: number;
  h: number;
  amplitude: number;
  phase: number;
};

/* Lifts and drops every cloth by its mask for the wind at `timeSec`; the still parts of its mask never move. */
export function swayCloths(cloths: readonly ClothLayer[], timeSec: number): void {
  for (const c of cloths) {
    if (c.mesh.destroyed) continue;
    swayClothVertices(c.mesh.geometry.positions, c.w, c.h, c.weights, c.amplitude, clothWind(timeSec, c.phase));
    c.mesh.geometry.getBuffer('aPosition').update();
  }
}

/* A steady phase in [0, 2pi) per building, so neighbouring awnings do not flap in step. */
function hashPhase(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) / 4294967296) * Math.PI * 2;
}

const DEPARTMENT_BANNER_COLOR = '#5CA6E6';

export type CityRenderState = Readonly<{
  city: CityState;
  worldMode: WorldMode;
  emptyLotStakes?: readonly TileCoord[];
  districtColors?: Readonly<Record<string, string>>;
  relocationPreview?: RelocationTargetPreview | null;
  constructionJobs?: ReadonlyMap<string, BuildingConstructionState>;
}>;

const ROAD_COLORS: Readonly<Record<RoadTier, { fill: number; stroke: number; alpha: number }>> = {
  trail: { fill: 0xb79b72, stroke: 0x8e7450, alpha: 0.62 },
  dirt: { fill: 0xc2a376, stroke: 0x92754d, alpha: 0.78 },
  brick: { fill: 0xbd8861, stroke: 0x7f563a, alpha: 0.88 },
  stone: { fill: 0xc8c2b6, stroke: 0x80796d, alpha: 0.93 },
};

const WALL_MARK_COLOR = 0x9c9281;
const STAKE_MARK_COLOR = 0xd9be8a;
const GROUND_MARK_ALPHA = 0.7;

/* The wall's tiles and an empty lot's survey stakes, each a flat tile on the ground until their art exists. */
function groundMarks(state: CityRenderState): Array<TileCoord & { color: number; inset: number }> {
  const marks: Array<TileCoord & { color: number; inset: number }> = [];
  for (const key of state.city.wallTiles) {
    const [c, r] = key.split(',');
    marks.push({ col: Number(c), row: Number(r), color: WALL_MARK_COLOR, inset: 0.06 });
  }
  if (state.worldMode === 'empty_lot') {
    for (const s of state.emptyLotStakes ?? []) marks.push({ ...s, color: STAKE_MARK_COLOR, inset: 0.3 });
  }
  return marks;
}

function drawRestingBadgePixi(g: Graphics, x: number, y: number): void {
  g.circle(x, y, 8).fill({ color: 0x263244, alpha: 0.88 }).stroke({ color: 0x99b8e0, alpha: 0.9, width: 1.4 });
  g.circle(x - 1.5, y, 4.2).fill({ color: 0xcbe0ff, alpha: 0.95 });
  g.circle(x + 1.2, y - 0.8, 3.6).fill({ color: 0x263244, alpha: 1 });
}

/* Rebuilds the cached static isometric city geometry layer inside a PixiJS Graphics object,
   strictly frustum-culled to cullWindow so off-screen walls/roads/buildings never inflate GPU triangle counts. */
/* A layer drawn still: a sprite on the picture's registration, tinted or multiplied as the layer says. */
export function placeLayerSprite(ctx: CityArtContext, layer: BuildingArtLayer, texture: Texture, centre: Point2D, s: number): void {
  const sprite = ctx.pool.sprite(texture);
  sprite.anchor.set(layer.anchor.x / layer.frame.w, layer.anchor.y / layer.frame.h);
  sprite.scale.set(s);
  sprite.position.set(centre.x + layer.offset.x * s, centre.y + layer.offset.y * s);
  if (layer.tint) sprite.tint = parseArtTint(layer.tint);
  if (layer.blend === 'multiply') sprite.blendMode = 'multiply';
}

/* A layer with a loaded cloth mask goes in as a cloth mesh for the wind pass; false for any other, drawn still. */
export function placeCloth(ctx: CityArtContext, layer: BuildingArtLayer, centre: Point2D, s: number, buildingId: string): boolean {
  const weights = layer.sway && ctx.swaying ? ctx.library.clothWeights(layer.sway.mask) : null;
  const texture = weights ? ctx.library.texture(layer.path) : null;
  if (!weights || !texture || !layer.sway || !ctx.swaying) return false;
  const mesh = ctx.pool.cloth(texture);
  mesh.scale.set(s);
  mesh.position.set(centre.x + (layer.offset.x - layer.anchor.x) * s, centre.y + (layer.offset.y - layer.anchor.y) * s);
  const cloth: ClothLayer = { mesh, weights, w: layer.frame.w, h: layer.frame.h, amplitude: layer.sway.amplitude, phase: hashPhase(buildingId) };
  swayClothVertices(mesh.geometry.positions, cloth.w, cloth.h, weights, cloth.amplitude, 0);
  mesh.geometry.getBuffer('aPosition').update();
  ctx.swaying.push(cloth);
  return true;
}

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
    if (!placeCloth(ctx, layer, centre, s, b.id)) placeLayerSprite(ctx, layer, textures[i]!, centre, s);
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
  if (art?.swaying) art.swaying.length = 0;
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

  /* 1. Roads and bridges (viewport-culled, fill-only without heavy per-tile stroke triangulation); with painted
     streets on the ground only the bridges. */
  for (const road of city.roads.values()) {
    if (!tileInWindow(road.col, road.row)) continue;
    if (art?.paintedRoads && !road.bridge) continue;
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

  /* 2. The outer city wall and an empty lot's stakes, flat on the ground (strictly viewport-culled). */
  for (const pt of groundMarks(state)) {
    if (!tileInWindow(pt.col, pt.row)) continue;
    fillDiamondPixi(g, lotDiamond(pt.col, pt.row, 1, 1, tileW, tileH, pt.inset), pt.color, GROUND_MARK_ALPHA);
  }

  /* 3. Depth-sorted structures + relocating old-site demolition ghosts (viewport-culled). */
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
    if (art) {
      /* Through the pool, art or placeholder, each building at its own depth among the plants and people. */
      const b = item.building;
      art.pool.depth = cityDepthY(b, tileH);
      const resolved = artIndex
        ? resolveBuildingArt(pack, artIndex, b, item.job, {
            upgrading: b.kind === 'house' && Boolean(art.upgradingHouseIds?.has(b.id)),
            districtColor: b.districtId ? districtColors[b.districtId] : undefined,
            departmentColor: DEPARTMENT_BANNER_COLOR,
            variant: art.variants.get(b.id),
          })
        : null;
      if (!resolved || !drawBuildingArtPixi(art, resolved, b, tileW, tileH)) {
        const p = buildingPlaceholder(b, pack, districtColors, item.job, tileW, tileH);
        fillDiamondPixi(art.pool.graphics(), p.diamond, p.color, p.alpha);
      }
      continue;
    }
    const p = buildingPlaceholder(item.building, pack, districtColors, item.job, tileW, tileH);
    fillDiamondPixi(g, p.diamond, p.color, p.alpha);
  }

  /* 4. Pending God's Word relocation destination markers (building itself stays at old tile!), above everything. */
  let markerG: Graphics | null = null;
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
    if (!markerG) {
      if (art) art.pool.depth = Number.MAX_SAFE_INTEGER;
      markerG = art ? art.pool.graphics() : g;
    }
    const [top, right, bottom, left] = lotDiamond(pend.toCol, pend.toRow, b.spanCol, b.spanRow, tileW, tileH, 0.05);
    markerG.moveTo(top.x, top.y)
      .lineTo(right.x, right.y)
      .lineTo(bottom.x, bottom.y)
      .lineTo(left.x, left.y)
      .closePath()
      .fill({ color: 0xffd166, alpha: 0.25 })
      .stroke({ color: 0xffd166, alpha: 0.96, width: 2.4 });
    markerG.moveTo(fromPt.x, fromPt.y - 24)
      .lineTo(toPt.x, toPt.y - 8)
      .stroke({ color: 0xffd166, alpha: 0.9, width: 2.2 });
    markerG.circle(toPt.x, toPt.y - 8, 5).fill({ color: 0xffd166, alpha: 1 });
  }
}

/* Canvas 2D fallback renderer for environments without WebGL: roads, then the same flat placeholders. */
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
    fillDiamond2D(ctx, pts as unknown as FlatDiamond, style.fill, style.alpha);
  }
  for (const pt of groundMarks(state)) {
    fillDiamond2D(ctx, lotDiamond(pt.col, pt.row, 1, 1, tileW, tileH, pt.inset), pt.color, GROUND_MARK_ALPHA);
  }
  const jobs = state.constructionJobs;
  const sorted = [...city.buildings].sort((a, b) => a.col + a.row - (b.col + b.row));
  for (const b of sorted) {
    const job = jobs?.get(b.id) ?? null;
    if (job && job.phase === 'cleared') continue;
    const p = buildingPlaceholder(b, pack, districtColors, job, tileW, tileH);
    fillDiamond2D(ctx, p.diamond, p.color, p.alpha);
  }
}
