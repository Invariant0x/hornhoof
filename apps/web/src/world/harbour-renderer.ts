/* Draws the harbour the work comes from (#2006) from the artists' pictures and sheets only: the quay and pier pieces
   along the bank, the yard at its fill, and each boat (or caravan) where harbourAt puts it, with the blocks it brings.
   There is no placeholder (#105, #107): until the art folder holds the set a harbour needs, nothing is drawn, and the
   residents bring their stones from home as before. Contains zero theme-specific words. */

import {
  CARAVAN_SHEET,
  YARD_FILL_PICTURES,
  artFootprintKey,
  boatCargoPath,
  boatSheetPath,
  harbourGatePath,
  harbourPiecePath,
  masterTileW,
  quayEndPath,
  yardFillPath,
  type ArtIndex,
  type BuildingPicturePassport,
  type SheetPassport,
} from './art';
import { tileCenterToWorld, type TileCoord } from './coords';
import { harbourAt, type CarrierState, type HarbourPlan } from './harbour';
import type { WorldPackManifest } from './manifest';
import type { ResidentArtContext, WorldVisibleRect } from './residents-renderer';
import type { ResidentHarbour } from './residents';

/* The files a harbour cannot be shown without; quay ends, the unload sheet and longer piers' spans are extras. */
export function harbourArtNeeds(plan: HarbourPlan, cargoMax: number): string[] {
  const yard = Array.from({ length: YARD_FILL_PICTURES }, (_, stage) => yardFillPath(artFootprintKey(plan.yard.span), stage));
  if (plan.kind === 'gate') return [harbourGatePath(plan.side), CARAVAN_SHEET, ...yard];
  const spans = plan.piers.some(p => p.tiles.length > 2) ? [harbourPiecePath('pier', plan.side)] : [];
  return [
    harbourPiecePath('quay', plan.side),
    harbourPiecePath('pier_root', plan.side),
    harbourPiecePath('pier_head', plan.side),
    ...spans,
    boatSheetPath('sail'),
    boatSheetPath('moored'),
    ...Array.from({ length: cargoMax }, (_, i) => boatCargoPath(i + 1)),
    ...yard,
  ];
}

/* True when the art folder holds every file the harbour needs. */
export function harbourArtReady(pack: WorldPackManifest, index: ArtIndex | null, plan: HarbourPlan, cargoMax: number): boolean {
  if (!index || !pack.art?.harbour) return false;
  return harbourArtNeeds(plan, cargoMax).every(path => Boolean(index.files[path]));
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

function sheetFor(index: ArtIndex, carrier: CarrierState): string {
  if (carrier.kind === 'caravan') return CARAVAN_SHEET;
  if (carrier.state === 'unload' && index.files[boatSheetPath('unload')]) return boatSheetPath('unload');
  return boatSheetPath(carrier.state === 'sail' ? 'sail' : 'moored');
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
    plan.quay.forEach((q, i) => {
      const end = i === 0 ? quayEndPath(plan.side, 1) : i === plan.quay.length - 1 ? quayEndPath(plan.side, 2) : null;
      piece(end && index.files[end] ? end : harbourPiecePath('quay', plan.side), q);
    });
    for (const pier of plan.piers) {
      pier.tiles.forEach((t, k) => {
        const kind = k === 0 ? 'pier_root' : k === pier.tiles.length - 1 ? 'pier_head' : 'pier';
        piece(harbourPiecePath(kind, plan.side), t);
      });
    }
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
    drawPicture(ctx, index, yardFillPath(artFootprintKey(yard.span), state.yardStage), yc.x, yc.y, yc.y, yard.span, tileW);
  }

  const scale = tileW / masterTileW(pack);
  for (const carrier of state.carriers) {
    const c = tileCenterToWorld(carrier.col, carrier.row, tileW, tileH);
    if (!inRect(c.x, c.y, visibleRect, tileW * 3)) continue;
    ctx.pool.depth = c.y;
    const sheet = sheetFor(index, carrier);
    if (!drawSheetFrame(ctx, index, sheet, carrier, timeSec * fpsOf(index, sheet), c.x, c.y, scale)) continue;
    if (carrier.kind === 'boat' && carrier.cargo > 0) drawSheetFrame(ctx, index, boatCargoPath(carrier.cargo), carrier, 0, c.x, c.y, scale);
  }
}
