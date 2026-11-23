/* The static map viewer's own rules, apart from the page so they can be tested: where the art sits beside the page,
   which art files a build copies, the overview from above, and the camera under two fingers and the wheel.
   Lives outside engine core (src/world-packs/) and only reads the engine's types and helpers. */

import { clamp, clampCameraPosition, type CameraState, type ViewportSize } from '../world/camera';
import { screenToWorld, type MapWorldBounds, type Point2D } from '../world/coords';
import type { WorldPackManifest } from '../world/manifest';

/* own: the pack's own art address (the dev server serves public/); relative: world-art/<pack>/ beside the page, as a
   build ships it; none: the build ships no art and nothing is asked for. */
export type ViewerArtMode = 'own' | 'relative' | 'none';

export type ViewerLang = 'ru' | 'en';

/* The map Ivan accepted. */
export const DEFAULT_VIEWER_SEED = 'hornhoof';

const MAX_SEED_LENGTH = 64;

export function viewerPack(pack: WorldPackManifest, mode: ViewerArtMode, pageUrl: string): WorldPackManifest {
  if (mode === 'own') return pack;
  if (mode === 'none') {
    return { ...pack, art: undefined, terrainArt: undefined, plants: pack.plants?.map(kind => ({ ...kind, art: undefined })) };
  }
  if (!pack.art) return pack;
  /* An absolute address built from the page's own, so the page works under whatever folder a host puts it in. */
  return { ...pack, art: { ...pack.art, baseUrl: new URL(`world-art/${pack.id}/`, pageUrl).href } };
}

/* Every ground, water, path, street and plant file the pack names, relative to its art folder, sorted, each once. */
export function packArtFiles(pack: WorldPackManifest): string[] {
  const files = new Set<string>();
  const add = (path: string | undefined) => {
    if (path) files.add(path);
  };
  const spec = pack.terrainArt;
  if (spec) {
    Object.values(spec.ground).forEach(add);
    Object.values(spec.edges ?? {}).forEach(add);
    add(spec.defaultEdge);
    add(spec.shoreEdge);
    add(spec.liquid?.bed);
    add(spec.liquid?.ripples);
    add(spec.liquid?.surface);
    add(spec.pathStrip);
    Object.values(spec.roads ?? {}).forEach(add);
  }
  for (const kind of pack.plants ?? []) {
    for (const art of kind.art ?? []) {
      add(art.image);
      add(art.windMask);
      add(art.passport);
    }
  }
  return [...files].sort();
}

/* The whole map seen from above as the same 2:1 diamond the camera shows, fitted in the middle of a box.
   unit: overview pixels per half tile width. */
export type OverviewLayout = Readonly<{
  mapSize: number;
  unit: number;
  left: number;
  top: number;
  width: number;
  height: number;
}>;

export function overviewLayout(mapSize: number, box: ViewportSize): OverviewLayout {
  const unit = Math.max(0, Math.min(box.width / (2 * mapSize), box.height / mapSize));
  const width = 2 * mapSize * unit;
  const height = mapSize * unit;
  return { mapSize, unit, width, height, left: (box.width - width) / 2, top: (box.height - height) / 2 };
}

export function worldToOverview(o: OverviewLayout, tileH: number, p: Point2D): Point2D {
  const f = o.unit / tileH;
  return { x: o.left + o.width / 2 + p.x * f, y: o.top + p.y * f };
}

/* The world point under an overview point, or null outside the map diamond. */
export function overviewToWorld(o: OverviewLayout, tileH: number, p: Point2D): Point2D | null {
  if (o.unit <= 0) return null;
  /* In tiles: across is col - row, down is col + row. */
  const across = (p.x - o.left - o.width / 2) / o.unit;
  const down = (2 * (p.y - o.top)) / o.unit;
  if (Math.abs(across) + Math.abs(down - o.mapSize) > o.mapSize) return null;
  const f = o.unit / tileH;
  return { x: (p.x - o.left - o.width / 2) / f, y: (p.y - o.top) / f };
}

type Pair = readonly [Point2D, Point2D];

const middle = (pair: Pair): Point2D => ({ x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 });
const spread = (pair: Pair): number => Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y);

/* Two fingers from where they touched down to where they are now: the distance between them scales the map and the
   spot between them stays under them. */
export function pinchCamera(
  start: CameraState,
  from: Pair,
  to: Pair,
  viewport: ViewportSize,
  limits: Readonly<{ minZoom: number; maxZoom: number }>,
  bounds: MapWorldBounds,
): CameraState {
  const before = spread(from);
  const factor = before < 1 ? 1 : spread(to) / before;
  const zoom = clamp(start.zoom * factor, limits.minZoom, limits.maxZoom);
  const anchor = screenToWorld(middle(from).x, middle(from).y, start, viewport);
  const now = middle(to);
  return clampCameraPosition(
    { x: anchor.x - (now.x - viewport.width / 2) / zoom, y: anchor.y - (now.y - viewport.height / 2) / zoom, zoom },
    bounds,
  );
}

const LINE_PX = 33;
const PAGE_PX = 800;
/* One notch of a mouse wheel (100 px) is one zoom step of 1.15. */
const WHEEL_RATE = Math.log(1.15) / 100;
const WHEEL_MAX_PX = 400;
/* A trackpad pinch reaches the page as a wheel with ctrlKey, in many small steps. */
const PINCH_RATE = 0.01;
const PINCH_MAX_PX = 50;

export function wheelZoomFactor(e: Readonly<{ deltaY: number; deltaMode: number; ctrlKey: boolean }>): number {
  const px = e.deltaY * (e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? PAGE_PX : 1);
  if (px === 0) return 1;
  const [rate, max] = e.ctrlKey ? [PINCH_RATE, PINCH_MAX_PX] : [WHEEL_RATE, WHEEL_MAX_PX];
  return Math.exp(-clamp(px, -max, max) * rate);
}

export function readViewerQuery(search: string, language: string): { seed: string; lang: ViewerLang } {
  const params = new URLSearchParams(search);
  const seed = (params.get('seed') ?? '').trim();
  const asked = params.get('lang');
  const lang: ViewerLang = asked === 'ru' || asked === 'en' ? asked : language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
  return { seed: seed && seed.length <= MAX_SEED_LENGTH ? seed : DEFAULT_VIEWER_SEED, lang };
}
