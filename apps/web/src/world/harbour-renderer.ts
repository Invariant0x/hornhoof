/* Draws the harbour the work comes from (#2006) from the artists' pictures only: the quay and jetty pieces along the
   bank, the yard at its fill, and each boat (or caravan) where harbourAt puts it, with the blocks it brings.
   There is no placeholder (#105, #107): until the art folder holds the set a harbour needs, nothing is drawn, and the
   residents bring their stones from home as before. Contains zero theme-specific words. */

import {
  BOAT_BLOCK,
  BOAT_HEADINGS,
  CARAVAN_SHEET,
  YARD_FILL_PICTURES,
  artLayerPath,
  boatMooredPath,
  boatSailPath,
  harbourGatePath,
  harbourPiecePath,
  masterTileW,
  yardFillPath,
  type ArtIndex,
  type ArtPoint,
  type BlockPassport,
  type BoatPassport,
  type BuildingPicturePassport,
  type HarbourPiece,
  type SheetPassport,
} from './art';
import { tileCenterToWorld, type TileCoord } from './coords';
import { harbourAt, jettyAxis, quayAxis, type CarrierState, type HarbourPlan } from './harbour';
import type { WorldPackManifest } from './manifest';
import type { ResidentArtContext, WorldVisibleRect } from './residents-renderer';
import type { ResidentHarbour } from './residents';

/* The piece of a line of tiles at position i: the first, the last, or a span between them. */
function pieceAt(i: number, length: number): HarbourPiece {
  return i === 0 ? 'start' : i === length - 1 ? 'end' : 'span';
}

/* The files a harbour cannot be shown without: every piece its quay and jetties use, the boat in each way it shows,
   the block and the yard's fill; the land gate's caravan instead of boats. */
export function harbourArtNeeds(plan: HarbourPlan): string[] {
  const yard = Array.from({ length: YARD_FILL_PICTURES }, (_, stage) => yardFillPath(stage));
  if (plan.kind === 'gate') return [harbourGatePath(plan.side), CARAVAN_SHEET, ...yard];
  const quay = quayAxis(plan.side);
  const jetty = jettyAxis(plan.side);
  const pieces = new Set<string>();
  plan.quay.forEach((_, i) => pieces.add(harbourPiecePath('quay', quay, pieceAt(i, plan.quay.length))));
  for (const pier of plan.piers) pier.tiles.forEach((_, i) => pieces.add(harbourPiecePath('jetty', jetty, pieceAt(i, pier.tiles.length))));
  return [...pieces, ...BOAT_HEADINGS.map(boatSailPath), boatMooredPath(jetty, true), boatMooredPath(jetty, false), BOAT_BLOCK, ...yard];
}

/* True when the art folder holds every file the harbour needs. */
export function harbourArtReady(pack: WorldPackManifest, index: ArtIndex | null, plan: HarbourPlan): boolean {
  if (!index || !pack.art?.harbour) return false;
  return harbourArtNeeds(plan).every(path => Boolean(index.files[path]));
}

function inRect(x: number, y: number, rect: WorldVisibleRect, pad: number): boolean {
  return x >= rect.minX - pad && x <= rect.maxX + pad && y >= rect.minY - pad && y <= rect.maxY + pad;
}

/* A picture standing on a lot whose ground centre is at (x, y), as a building's does; false when it cannot be drawn. */
function drawPicture(ctx: ResidentArtContext, index: ArtIndex, path: string, x: number, y: number, depth: number, tilesWide: number, tileW: number): boolean {
  const entry = index.files[path];
  const p = entry?.passport as BuildingPicturePassport | undefined;
  if (!entry || !p || !('groundAnchor' in p)) return false;
  const tex = ctx.library.frame(path, { x: 0, y: 0, w: entry.w, h: entry.h });
  if (!tex) return false;
  ctx.pool.depth = depth;
  const sprite = ctx.pool.sprite(tex);
  const s = (tileW * tilesWide) / Math.max(1, p.corners.right.x - p.corners.left.x);
  sprite.anchor.set(p.groundAnchor.x / entry.w, p.groundAnchor.y / entry.h);
  sprite.scale.set(s);
  sprite.position.set(x, y);
  /* Its own layers on the same canvas, such as the yard's multiplied shadow. */
  for (const layer of Array.isArray(p.layers) ? p.layers : []) {
    const lp = typeof layer?.file === 'string' ? artLayerPath(path, layer.file) : null;
    const le = lp ? index.files[lp] : undefined;
    const lt = lp && le ? ctx.library.frame(lp, { x: 0, y: 0, w: le.w, h: le.h }) : null;
    if (!lt) continue;
    const over = ctx.pool.sprite(lt);
    over.anchor.set(p.groundAnchor.x / entry.w, p.groundAnchor.y / entry.h);
    over.scale.set(s);
    over.position.set(x, y);
    if (layer.blend === 'multiply') over.blendMode = 'multiply';
  }
  return true;
}

/* One frame of a sheet in the row of a facing, its anchor at (x, y). */
function drawSheetFrame(
  ctx: ResidentArtContext,
  index: ArtIndex,
  path: string,
  carrier: CarrierState,
  frameAt: number,
  x: number,
  y: number,
  scale: number,
): boolean {
  const entry = index.files[path];
  const s = entry?.passport as SheetPassport | undefined;
  if (!entry || !s || !('frameW' in s)) return false;
  const row = (s.directions ?? []).indexOf(carrier.facing);
  if (row < 0) return false;
  const frame = Math.max(0, Math.floor(frameAt)) % Math.max(1, s.frames);
  const tex = ctx.library.frame(path, { x: frame * s.frameW, y: row * s.frameH, w: s.frameW, h: s.frameH });
  if (!tex) return false;
  const sprite = ctx.pool.sprite(tex);
  sprite.anchor.set(s.anchor.x / s.frameW, s.anchor.y / s.frameH);
  sprite.scale.set(scale);
  sprite.position.set(x, y);
  return true;
}

function fpsOf(index: ArtIndex, path: string): number {
  return (index.files[path]?.passport as SheetPassport | undefined)?.fps ?? 0;
}

/* A still picture by its anchor at (x, y); false when it cannot be drawn. */
function drawAnchored(ctx: ResidentArtContext, index: ArtIndex, path: string, x: number, y: number, scale: number): boolean {
  const entry = index.files[path];
  const p = entry?.passport as BlockPassport | undefined;
  if (!entry || !p?.anchor) return false;
  const tex = ctx.library.frame(path, { x: 0, y: 0, w: entry.w, h: entry.h });
  if (!tex) return false;
  const sprite = ctx.pool.sprite(tex);
  sprite.anchor.set(p.anchor.x / entry.w, p.anchor.y / entry.h);
  sprite.scale.set(scale);
  sprite.position.set(x, y);
  return true;
}

/* The boat's picture: under sail in its heading, or at its jetty along the jetty's axis, loaded or empty. */
function boatPath(plan: HarbourPlan, carrier: CarrierState): string {
  if (carrier.state === 'sail') return boatSailPath(carrier.facing);
  return boatMooredPath(jettyAxis(plan.side), carrier.cargo > 0);
}

/* The blocks aboard, one stack per cargo point in turn, each block on the stack top of the one below; without a stack
   top no block goes higher than the deck. Drawn just in front of the hull. */
function drawCargo(ctx: ResidentArtContext, index: ArtIndex, boat: string, cargo: number, x: number, y: number, depth: number, scale: number): void {
  const hull = index.files[boat];
  const points = ((hull?.passport as BoatPassport | undefined)?.cargoPoints ?? []) as readonly ArtPoint[];
  const block = index.files[BOAT_BLOCK]?.passport as BlockPassport | undefined;
  if (!hull || !block || points.length === 0) return;
  const lift = block.stackTop ? { x: block.stackTop.x - block.anchor.x, y: block.stackTop.y - block.anchor.y } : null;
  const anchor = (hull.passport as BoatPassport).anchor;
  const shown = lift ? cargo : Math.min(cargo, points.length);
  for (let i = 0; i < shown; i++) {
    const at = points[i % points.length]!;
    const level = Math.floor(i / points.length);
    ctx.pool.depth = depth + 0.01 * (i + 1);
    const bx = x + (at.x - anchor.x + (lift?.x ?? 0) * level) * scale;
    const by = y + (at.y - anchor.y + (lift?.y ?? 0) * level) * scale;
    drawAnchored(ctx, index, BOAT_BLOCK, bx, by, scale);
  }
}

/* Draws the harbour at the moment it shows; call only while harbourArtReady holds. */
export function drawHarbourArtPixi(
  ctx: ResidentArtContext,
  pack: WorldPackManifest,
  index: ArtIndex,
  harbour: ResidentHarbour,
  timeSec: number,
  visibleRect: WorldVisibleRect,
  tileW: number,
  tileH: number,
): void {
  const { plan } = harbour;
  const piece = (path: string, at: TileCoord) => {
    const c = tileCenterToWorld(at.col, at.row, tileW, tileH);
    if (inRect(c.x, c.y, visibleRect, tileW * 2)) drawPicture(ctx, index, path, c.x, c.y, c.y, 1, tileW);
  };

  if (plan.kind === 'river') {
    const quay = quayAxis(plan.side);
    const jetty = jettyAxis(plan.side);
    plan.quay.forEach((q, i) => piece(harbourPiecePath('quay', quay, pieceAt(i, plan.quay.length)), q));
    for (const pier of plan.piers) pier.tiles.forEach((t, i) => piece(harbourPiecePath('jetty', jetty, pieceAt(i, pier.tiles.length)), t));
  } else {
    const g = tileCenterToWorld(plan.gate.col + 0.5, plan.gate.row + 0.5, tileW, tileH);
    if (inRect(g.x, g.y, visibleRect, tileW * 3)) drawPicture(ctx, index, harbourGatePath(plan.side), g.x, g.y, g.y + tileH / 2, 2, tileW);
  }

  const state = harbourAt(plan, harbour.trips, harbour.flow, harbour.nowMs);
  const yard = plan.yard;
  const mid = (yard.span - 1) / 2;
  const yc = tileCenterToWorld(yard.col + mid, yard.row + mid, tileW, tileH);
  if (inRect(yc.x, yc.y, visibleRect, tileW * yard.span)) {
    /* At the depth of the yard's back half, so a resident at a spot on its front edge stands in front of the stones. */
    drawPicture(ctx, index, yardFillPath(state.yardStage), yc.x, yc.y, yc.y, yard.span, tileW);
  }

  const scale = tileW / masterTileW(pack);
  for (const carrier of state.carriers) {
    const c = tileCenterToWorld(carrier.col, carrier.row, tileW, tileH);
    if (!inRect(c.x, c.y, visibleRect, tileW * 3)) continue;
    ctx.pool.depth = c.y;
    if (carrier.kind === 'caravan') {
      drawSheetFrame(ctx, index, CARAVAN_SHEET, carrier, timeSec * fpsOf(index, CARAVAN_SHEET), c.x, c.y, scale);
      continue;
    }
    const boat = boatPath(plan, carrier);
    if (drawAnchored(ctx, index, boat, c.x, c.y, scale) && carrier.cargo > 0) drawCargo(ctx, index, boat, carrier.cargo, c.x, c.y, c.y, scale);
  }
}
