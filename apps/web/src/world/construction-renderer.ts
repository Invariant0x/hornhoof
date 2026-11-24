/* Pack-agnostic building loops for live cities (#1947 item 11): each loop of a building (crane, dust, smoke, water,
   awning, celebration) is drawn from its artist sheet, loops/<kind>.png, at the attach point its picture's passport
   names. A loop without its sheet, or on a building still shown by its placeholder, draws nothing: the engine keeps
   no home-made cranes, dust, smoke or workers. Contains zero theme-specific words. */

import {
  masterTileW,
  resolveBuildingArt,
  type ArtPoint,
  type BuildingPicturePassport,
  type LoopAttachPoint,
  type SheetPassport,
} from './art';
import type { DisplayRunPool, WorldArtLibrary } from './art-runtime';
import { cityDepthY, type CityBuilding, type CityState } from './city-layout';
import { buildingLoopsFor, type BuildingConstructionState, type ConstructionSimulation } from './construction';
import { tileCenterToWorld } from './coords';
import type { WorldPackManifest } from './manifest';
import type { WorldVisibleRect } from './residents-renderer';

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

/* Whether a loop is drawn over a picture with this passport: the awning loop only where the passport asks for it with
   awningLoop and names its awningAnchor, since a house with its own awning painted in would show two (Ivan AI, 24.11). */
export function loopDrawsOn(kind: string, p: BuildingPicturePassport): boolean {
  return kind !== 'awning' || (p.awningLoop === true && p.awningAnchor !== undefined);
}

/* Where the top loops (smoke, celebration, a sleeper's Z) attach on a picture, in its own pixels: its topAnchor; else the
   foot of its flag pole, since a finished house names neither a top nor a roof line (Ivan AI, 24.11); else its roof line,
   then its wall top, then the back ground corner of its lot, above the lot centre. */
export function loopTopPoint(p: BuildingPicturePassport): ArtPoint {
  return p.topAnchor ?? p.flagAnchor ?? { x: p.groundAnchor.x, y: p.roofLine ?? p.wallTopLine ?? p.corners.top.y };
}

/* Where loops attach on a building drawn from its picture, with the picture's passport; null for placeholders. */
function artLoopAnchors(
  art: LoopArtContext,
  building: CityBuilding,
  state: BuildingConstructionState | null,
  pack: WorldPackManifest,
  ctr: { x: number; y: number },
  tileW: number,
): { points: LoopAnchors; passport: BuildingPicturePassport } | null {
  const index = art.library.index;
  if (!index) return null;
  const resolved = resolveBuildingArt(pack, index, building, state, { variant: art.variants.get(building.id) });
  if (!resolved || resolved.layers.some(l => !art.library.frame(l.path, l.frame))) return null;
  const p = resolved.passport;
  const s = tileW / resolved.artPxPerTile;
  const at = (pt: ArtPoint) => ({ x: ctr.x + (pt.x - p.groundAnchor.x) * s, y: ctr.y + (pt.y - p.groundAnchor.y) * s });
  const top = at(loopTopPoint(p));
  const points: LoopAnchors = {
    top,
    awning: p.awningAnchor ? at(p.awningAnchor) : top,
    door: p.door ? at(p.door) : ctr,
    ground: ctr,
    /* A resident's point (the sleeper's Z): on a building it goes where the top loops go. */
    head: top,
  };
  return { points, passport: p };
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

export function renderConstructionLoopsToPixi(
  sim: ConstructionSimulation,
  city: CityState | null,
  pack: WorldPackManifest,
  visibleRect: WorldVisibleRect,
  tileW: number,
  tileH: number,
  art: LoopArtContext,
): void {
  art.pool.begin();
  if (!city || !art.library.index) return;
  const loopScale = tileW / masterTileW(pack);

  /* Active buildings, and any relocating old-site demolition ghosts still on the map. */
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
    const anchors = artLoopAnchors(art, building, state, pack, ctr, tileW);
    if (!anchors) continue;
    /* With a depth-sorted pool the loops sit just over their own building, so a building in front hides them too. */
    art.pool.depth = cityDepthY(building, tileH) + 0.5;
    for (const loop of buildingLoopsFor(building, state, pack)) {
      if (!loopDrawsOn(loop.kind, anchors.passport)) continue;
      drawLoopSheet(art, loop.kind, anchors.points, sim.timeSec, loop.phaseOffset, loop.intensity, loopScale);
    }
  }
}
