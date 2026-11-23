/* The static map viewer: only the world of one pack and a camera, for a plain static host under any sub-path.
   No server, no sign-in, no app screens: the map is generated in the page from its seed. The engine draws; this page
   owns the input (drag, pinch, wheel) so no tile gets picked or highlighted, and adds an overview from above.
   Built into one folder by scripts/build-world-viewer.ts. */

import { zoomCameraAt, type CameraState, type ViewportSize } from '../world/camera';
import { mapWorldBounds, type Point2D } from '../world/coords';
import { IsometricWorldEngine, type WorldEngineStats } from '../world/renderer';
import { GALLERY_SEEDS, generateWorldTerrain, type GeneratedWorldMap } from '../world/terrain-engine';
import { renderProceduralMapPreview } from '../world/terrain-preview';
import { EGYPT_WORLD_PACK } from './egypt/pack';
import {
  overviewLayout,
  overviewToWorld,
  pinchCamera,
  readViewerQuery,
  viewerPack,
  wheelZoomFactor,
  worldToOverview,
  type ViewerArtMode,
  type ViewerLang,
} from './viewer-core';

const COPY: Record<
  ViewerLang,
  { title: string; zoomIn: string; zoomOut: string; reset: string; overview: string; overviewHint: string; close: string; seed: string; hint: string; loading: string }
> = {
  ru: {
    title: 'Карта Египта',
    zoomIn: 'Приблизить',
    zoomOut: 'Отдалить',
    reset: 'Масштаб 100%',
    overview: 'Вид сверху',
    overviewHint: 'Нажмите на место, куда перейти',
    close: 'Закрыть',
    seed: 'Карта',
    hint: 'Тяните карту мышью или пальцем. Колесо или щипок меняет масштаб, стрелки и WASD двигают карту.',
    loading: 'Карта строится…',
  },
  en: {
    title: 'Egypt map',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    reset: 'Zoom to 100%',
    overview: 'Overview',
    overviewHint: 'Tap the place to go to',
    close: 'Close',
    seed: 'Map',
    hint: 'Drag the map with the mouse or a finger. The wheel or a pinch zooms, arrows and WASD move the map.',
    loading: 'Building the map…',
  },
};

const ART_MODE = (import.meta.env.VITE_WORLD_VIEWER_ART as ViewerArtMode | undefined) ?? 'own';
const PACK = viewerPack(EGYPT_WORLD_PACK, ART_MODE, window.location.href);
const TILE_W = PACK.projection.defaultTileW;
const TILE_H = PACK.projection.defaultTileH;
const BOUNDS = mapWorldBounds(PACK.mapSize, TILE_W, TILE_H);
const PREVIEW_PX_PER_TILE = 3;

/* Safari's trackpad pinch: not in the DOM typings. */
type GestureLike = Event & { scale: number; clientX: number; clientY: number };

export type WorldViewerHandle = {
  ready: boolean;
  seed: string;
  getStats: () => WorldEngineStats | null;
  setCamera: (camera: CameraState) => void;
  setWindClock: (seconds: number | null) => void;
  flushVisibleBakes: () => void;
  openOverview: () => void;
  closeOverview: () => void;
};

declare global {
  interface Window {
    __WORLD_VIEWER__?: WorldViewerHandle;
  }
}

type Props = Readonly<{ className?: string; textContent?: string; title?: string; hidden?: boolean }>;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...kids);
  return node;
}

function button(text: string, label: string, testId: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { textContent: text, title: label });
  b.type = 'button';
  b.setAttribute('aria-label', label);
  b.dataset.testid = testId;
  b.addEventListener('click', onClick);
  return b;
}

class WorldViewer {
  private readonly t: (typeof COPY)[ViewerLang];
  private readonly host = el('div', { className: 'world' });
  private readonly loading = el('div', { className: 'loading' });
  private readonly zoomLabel: HTMLButtonElement;
  private readonly zoomInButton: HTMLButtonElement;
  private readonly zoomOutButton: HTMLButtonElement;
  private readonly overview = el('div', { className: 'overview', hidden: true });
  private readonly overviewCanvas = el('canvas');
  private readonly overviewRoom = el('div', { className: 'room' });
  private readonly preview = document.createElement('canvas');
  private engine: IsometricWorldEngine | null = null;
  private map: GeneratedWorldMap | null = null;
  private previewSeed: string | null = null;
  private seed: string;
  private generation = 0;
  private readonly pointers = new Map<number, Point2D>();
  private pinch: { from: readonly [Point2D, Point2D]; ids: readonly [number, number]; camera: CameraState } | null = null;
  private gesture: { zoom: number } | null = null;

  constructor(lang: ViewerLang, seed: string) {
    this.t = COPY[lang];
    this.seed = seed;
    document.documentElement.lang = lang;
    document.title = this.t.title;
    this.host.dataset.testid = 'viewer-world';
    this.loading.textContent = this.t.loading;

    this.zoomOutButton = button('−', this.t.zoomOut, 'viewer-zoom-out', () => this.engine?.zoomOut());
    this.zoomLabel = button('100%', this.t.reset, 'viewer-zoom-reset', () => this.engine?.resetZoom());
    this.zoomLabel.className = 'zoom';
    this.zoomInButton = button('+', this.t.zoomIn, 'viewer-zoom-in', () => this.engine?.zoomIn());
    const select = el('select');
    select.dataset.testid = 'viewer-seed';
    const seeds = GALLERY_SEEDS.includes(seed) ? GALLERY_SEEDS : [seed, ...GALLERY_SEEDS];
    for (const s of seeds) select.append(new Option(s, s, s === seed, s === seed));
    select.addEventListener('change', () => void this.open(select.value));
    const bar = el(
      'div',
      { className: 'bar' },
      this.zoomOutButton,
      this.zoomLabel,
      this.zoomInButton,
      button(this.t.overview, this.t.overview, 'viewer-overview', () => this.openOverview()),
      el('label', {}, this.t.seed, select),
      el('span', { className: 'hint' }, this.t.hint),
    );
    bar.dataset.testid = 'viewer-bar';

    this.overview.dataset.testid = 'viewer-overview-panel';
    this.overviewCanvas.dataset.testid = 'viewer-overview-map';
    this.overviewRoom.append(this.overviewCanvas);
    this.overview.append(
      el('header', {}, el('span', {}, this.t.overviewHint), button('×', this.t.close, 'viewer-overview-close', () => this.closeOverview())),
      this.overviewRoom,
    );
    this.overviewCanvas.addEventListener('click', e => this.jumpFromOverview(e));

    document.body.append(this.host, bar, this.overview, this.loading);
    this.listen();
  }

  private listen(): void {
    /* Capture on the host, before the engine's own canvas listeners: they would pick and highlight tiles. */
    const opts = { capture: true, passive: false } as const;
    this.host.addEventListener('pointerdown', this.onPointerDown, opts);
    this.host.addEventListener('pointermove', this.onPointerMove, opts);
    this.host.addEventListener('pointerup', this.onPointerUp, opts);
    this.host.addEventListener('pointercancel', this.onPointerUp, opts);
    this.host.addEventListener('pointerleave', this.swallow, opts);
    this.host.addEventListener('wheel', this.onWheel, opts);
    this.host.addEventListener('gesturestart', this.onGestureStart, opts);
    this.host.addEventListener('gesturechange', this.onGestureChange, opts);
    this.host.addEventListener('gestureend', this.swallow, opts);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('resize', () => {
      if (!this.overview.hidden) this.drawOverview();
    });
  }

  private viewport(): ViewportSize {
    const r = this.host.getBoundingClientRect();
    return { width: Math.max(1, r.width), height: Math.max(1, r.height) };
  }

  private local(e: { clientX: number; clientY: number }): Point2D {
    const r = this.host.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private readonly swallow = (e: Event): void => {
    e.stopPropagation();
    e.preventDefault();
  };

  private zoomAt(factor: number, at: Point2D): void {
    const engine = this.engine;
    if (!engine) return;
    const s = engine.getStats();
    engine.setCamera(zoomCameraAt(s.camera, factor, at, this.viewport(), s.minZoom, s.maxZoom, BOUNDS));
  }

  private startPinch(): void {
    const engine = this.engine;
    const ids = [...this.pointers.keys()].slice(0, 2);
    if (!engine || ids.length < 2) return;
    const [a, b] = ids as [number, number];
    this.pinch = { ids: [a, b], from: [this.pointers.get(a)!, this.pointers.get(b)!], camera: engine.getStats().camera };
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.swallow(e);
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try {
      this.host.setPointerCapture(e.pointerId);
    } catch {
      /* A synthetic event may hold no active pointer. */
    }
    this.pointers.set(e.pointerId, this.local(e));
    if (this.pointers.size >= 2) this.startPinch();
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    this.swallow(e);
    const last = this.pointers.get(e.pointerId);
    const engine = this.engine;
    if (!last || !engine) return;
    const now = this.local(e);
    this.pointers.set(e.pointerId, now);
    const pinch = this.pinch;
    if (pinch) {
      if (!pinch.ids.includes(e.pointerId)) return;
      const s = engine.getStats();
      const to = [this.pointers.get(pinch.ids[0])!, this.pointers.get(pinch.ids[1])!] as const;
      engine.setCamera(pinchCamera(pinch.camera, pinch.from, to, this.viewport(), s, BOUNDS));
      return;
    }
    engine.panByScreen(now.x - last.x, now.y - last.y);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    this.swallow(e);
    this.pointers.delete(e.pointerId);
    try {
      this.host.releasePointerCapture(e.pointerId);
    } catch {
      /* Already released. */
    }
    /* From two fingers to one: the one left goes on dragging from where it is. */
    this.pinch = null;
    if (this.pointers.size >= 2) this.startPinch();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    this.swallow(e);
    this.zoomAt(wheelZoomFactor(e), this.local(e));
  };

  private readonly onGestureStart = (e: Event): void => {
    this.swallow(e);
    /* iOS sends gestures beside the touches the pinch already follows. */
    this.gesture = this.pointers.size === 0 && this.engine ? { zoom: this.engine.getStats().zoom } : null;
  };

  private readonly onGestureChange = (e: Event): void => {
    this.swallow(e);
    const g = e as GestureLike;
    const engine = this.engine;
    if (!this.gesture || !engine || !(g.scale > 0)) return;
    this.zoomAt((this.gesture.zoom * g.scale) / engine.getStats().zoom, this.local(g));
  };

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') this.closeOverview();
    else if (e.key === '+' || e.key === '=') this.engine?.zoomIn();
    else if (e.key === '-' || e.key === '_') this.engine?.zoomOut();
    else if (e.key === '0') this.engine?.resetZoom();
    else if (e.code === 'KeyO') {
      if (this.overview.hidden) this.openOverview();
      else this.closeOverview();
    }
  };

  private readonly onStats = (s: WorldEngineStats): void => {
    const text = `${s.zoomPercent}%`;
    if (this.zoomLabel.textContent !== text) this.zoomLabel.textContent = text;
    this.zoomInButton.disabled = s.zoom >= s.maxZoom - 1e-4;
    this.zoomOutButton.disabled = s.zoom <= s.minZoom + 1e-4;
  };

  async open(seed: string): Promise<void> {
    const generation = ++this.generation;
    this.seed = seed;
    this.publish(false);
    this.loading.hidden = false;
    this.engine?.destroy();
    this.engine = null;
    this.pointers.clear();
    this.pinch = null;
    const url = new URL(window.location.href);
    url.searchParams.set('seed', seed);
    window.history.replaceState(null, '', url);
    /* Let the loading note paint before the map is generated. */
    await new Promise(resolve => setTimeout(resolve, 0));
    if (generation !== this.generation) return;
    const map = generateWorldTerrain(PACK, { seed, mapSize: PACK.mapSize });
    this.map = map;
    const engine = await IsometricWorldEngine.create({
      host: this.host,
      pack: PACK,
      terrainMap: map,
      showBuildGrid: false,
      initialZoom: 1,
      initialCenterTile: map.startCenter,
      markerTile: null,
      resolveTileId: (col, row) => map.tileAt(col, row) ?? PACK.defaultTileId,
      onStats: this.onStats,
    });
    if (generation !== this.generation) {
      engine.destroy();
      return;
    }
    this.engine = engine;
    this.onStats(engine.getStats());
    this.loading.hidden = true;
    this.publish(true);
  }

  private publish(ready: boolean): void {
    window.__WORLD_VIEWER__ = {
      ready,
      seed: this.seed,
      getStats: () => this.engine?.getStats() ?? null,
      setCamera: camera => this.engine?.setCamera(camera),
      setWindClock: seconds => this.engine?.setWindClock(seconds),
      flushVisibleBakes: () => this.engine?.flushVisibleBakes(),
      openOverview: () => this.openOverview(),
      closeOverview: () => this.closeOverview(),
    };
  }

  openOverview(): void {
    if (!this.map) return;
    this.overview.hidden = false;
    this.drawOverview();
  }

  closeOverview(): void {
    this.overview.hidden = true;
  }

  private overviewBox(): ViewportSize {
    const r = this.overviewRoom.getBoundingClientRect();
    return { width: Math.max(1, r.width), height: Math.max(1, r.height) };
  }

  private drawOverview(): void {
    const map = this.map;
    if (!map) return;
    if (this.previewSeed !== map.seed) {
      /* The preview pins the start of the map; here the frame of the view marks the map, so the pin goes off the canvas. */
      const unpinned = Object.create(map, { startCenter: { value: { col: -1e6, row: -1e6 } } }) as GeneratedWorldMap;
      renderProceduralMapPreview(this.preview, unpinned, PACK, PREVIEW_PX_PER_TILE);
      this.previewSeed = map.seed;
    }
    const box = this.overviewBox();
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const canvas = this.overviewCanvas;
    canvas.width = Math.round(box.width * dpr);
    canvas.height = Math.round(box.height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const o = overviewLayout(PACK.mapSize, box);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    /* The square preview (a column per x, a row per y) turned into the camera's diamond. */
    const k = (o.unit / PREVIEW_PX_PER_TILE) * dpr;
    ctx.setTransform(k, k / 2, -k, k / 2, (o.left + o.width / 2) * dpr, o.top * dpr);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.preview, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = this.engine?.getStats();
    if (!s) return;
    const view = this.viewport();
    const a = worldToOverview(o, TILE_H, { x: s.camera.x - view.width / (2 * s.zoom), y: s.camera.y - view.height / (2 * s.zoom) });
    const b = worldToOverview(o, TILE_H, { x: s.camera.x + view.width / (2 * s.zoom), y: s.camera.y + view.height / (2 * s.zoom) });
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(17, 14, 10, 0.9)';
    ctx.strokeRect(a.x - 1, a.y - 1, b.x - a.x + 2, b.y - a.y + 2);
    ctx.strokeStyle = '#ffd27a';
    ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
  }

  private jumpFromOverview(e: MouseEvent): void {
    const map = this.map;
    const engine = this.engine;
    if (!map || !engine) return;
    const r = this.overviewCanvas.getBoundingClientRect();
    const o = overviewLayout(PACK.mapSize, { width: r.width, height: r.height });
    const at = overviewToWorld(o, TILE_H, { x: e.clientX - r.left, y: e.clientY - r.top });
    if (!at) return;
    engine.setCamera({ ...at, zoom: engine.getStats().zoom });
    this.closeOverview();
  }
}

const query = readViewerQuery(window.location.search, navigator.language || 'en');
void new WorldViewer(query.lang, query.seed).open(query.seed);
