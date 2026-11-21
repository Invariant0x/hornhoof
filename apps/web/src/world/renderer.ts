/* PixiJS v8 chunked isometric world renderer with bounded per-frame baking, frustum culling,
   pan/zoom/click interaction and automatic Canvas 2D fallback when WebGL is unavailable. */

import { Application, Container, Graphics, Sprite, Texture } from 'pixi.js';
import {
  activeZoomTier,
  computeBirdEyeZoom,
  createInitialCamera,
  MAX_CAMERA_ZOOM,
  panCamera,
  visibleWorldRect,
  zoomCameraAt,
  zoomForTier,
  type CameraState,
  type ViewportSize,
} from './camera';
import { bakeChunkCanvas, buildTileLookup, type BakedChunk } from './chunk-baker';
import { buildChunkGrid, ChunkLruCache, cullVisibleChunks, type ChunkCoord, type ChunkGrid } from './chunks';
import {
  mapWorldBounds,
  pickAtScreen,
  screenToTile,
  tileDiamondVertices,
  tileTopVertexToWorld,
  type MapWorldBounds,
  type PickableObject,
  type PickResult,
  type TileCoord,
} from './coords';
import type { ResolutionTierId, TileSlotSpec, WorldPackManifest } from './manifest';

export type RendererKind = 'webgl' | 'canvas2d';

export type WorldEngineStats = Readonly<{
  fps: number;
  frameTimeMs: number;
  zoom: number;
  tier: ResolutionTierId;
  visibleChunks: number;
  totalChunks: number;
  cachedChunks: number;
  pendingBakes: number;
  mapSize: number;
  chunkSize: number;
  rendererKind: RendererKind;
  hoveredTile: TileCoord | null;
  selectedPick: PickResult | null;
  camera: CameraState;
}>;

export type WorldEngineOptions = Readonly<{
  host: HTMLElement;
  pack: WorldPackManifest;
  initialTier?: ResolutionTierId;
  objects?: readonly PickableObject[];
  resolveTileId?: (col: number, row: number) => string;
  onStats?: (stats: WorldEngineStats) => void;
  onSelect?: (pick: PickResult | null) => void;
}>;

type CachedChunkEntry = {
  baked: BakedChunk;
  texture: Texture | null;
  sprite: Sprite | null;
};

/* Per-frame baking budget (ms) so lazy LOD texture bakes keep interactive pan/zoom near 60 FPS. */
const BAKE_BUDGET_MS = 7;
const DRAG_THRESHOLD_PX = 5;
const KEY_PAN_PX_PER_SEC = 540;
const OVERVIEW_CACHE_CAP = 420;
const DETAIL_CACHE_CAP = 96;

function parseHexColor(color: string, fallback = 0x141b24): number {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  return m ? Number.parseInt(m[1]!, 16) : fallback;
}

function parseColorAndAlpha(color: string, fallbackHex: number, fallbackAlpha = 1): { color: number; alpha: number } {
  const trimmed = color.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(trimmed);
  if (hex) return { color: Number.parseInt(hex[1]!, 16), alpha: fallbackAlpha };
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(trimmed);
  if (rgba) {
    const r = Math.min(255, Math.max(0, Math.round(Number(rgba[1]))));
    const g = Math.min(255, Math.max(0, Math.round(Number(rgba[2]))));
    const b = Math.min(255, Math.max(0, Math.round(Number(rgba[3]))));
    const a = rgba[4] !== undefined ? Number(rgba[4]) : fallbackAlpha;
    return { color: (r << 16) | (g << 8) | b, alpha: a };
  }
  return { color: fallbackHex, alpha: fallbackAlpha };
}

export class IsometricWorldEngine {
  private readonly host: HTMLElement;
  private readonly pack: WorldPackManifest;
  private readonly tileW: number;
  private readonly tileH: number;
  private readonly bounds: MapWorldBounds;
  private readonly chunkGrid: ChunkGrid;
  private readonly tileLookup: ReadonlyMap<string, TileSlotSpec>;
  private readonly resolveTileId?: (col: number, row: number) => string;
  private readonly onStats?: (stats: WorldEngineStats) => void;
  private readonly onSelect?: (pick: PickResult | null) => void;

  private objects: readonly PickableObject[];
  private viewport: ViewportSize;
  private camera: CameraState;
  private hoveredTile: TileCoord | null = null;
  private selectedPick: PickResult | null = null;

  private app: Application | null = null;
  private worldContainer: Container | null = null;
  private chunkLayer: Container | null = null;
  private borderGraphic: Graphics | null = null;
  private overlayGraphic: Graphics | null = null;

  private fallbackCanvas: HTMLCanvasElement | null = null;
  private fallbackCtx: CanvasRenderingContext2D | null = null;
  private rendererKind: RendererKind = 'webgl';

  private readonly overviewCache = new ChunkLruCache<CachedChunkEntry>(OVERVIEW_CACHE_CAP);
  private readonly detailCache = new ChunkLruCache<CachedChunkEntry>(DETAIL_CACHE_CAP);
  private visibleChunkList: ChunkCoord[] = [];
  private pendingBakeCount = 0;

  private destroyed = false;
  private dirtyScene = true;
  private rafId = 0;
  private lastFrameTs = 0;
  private fpsSamples: number[] = [];
  private lastFps = 60;
  private lastFrameMs = 16.67;
  private lastStatsPushTs = 0;

  private dragPointerId: number | null = null;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragLastX = 0;
  private dragLastY = 0;
  private dragMoved = false;
  private readonly pressedKeys = new Set<string>();
  private resizeObserver: ResizeObserver | null = null;
  private canvasElement: HTMLCanvasElement | null = null;

  private constructor(options: WorldEngineOptions) {
    this.host = options.host;
    this.pack = options.pack;
    this.tileW = options.pack.projection.tiers.classic1x.tileW;
    this.tileH = options.pack.projection.tiers.classic1x.tileH;
    this.bounds = mapWorldBounds(options.pack.mapSize, this.tileW, this.tileH);
    this.chunkGrid = buildChunkGrid(options.pack.mapSize, options.pack.params.chunkSize, this.tileW, this.tileH);
    this.tileLookup = buildTileLookup(options.pack);
    this.resolveTileId = options.resolveTileId;
    this.objects = options.objects ?? [];
    this.onStats = options.onStats;
    this.onSelect = options.onSelect;

    this.viewport = this.readHostSize();
    this.camera = createInitialCamera(
      options.pack.mapSize,
      this.tileW,
      this.tileH,
      this.viewport,
      options.initialTier ?? '1x',
      options.pack.params.overviewMarginPx,
    );
  }

  static async create(options: WorldEngineOptions): Promise<IsometricWorldEngine> {
    const engine = new IsometricWorldEngine(options);
    await engine.mount();
    return engine;
  }

  private readHostSize(): ViewportSize {
    const rect = this.host.getBoundingClientRect();
    return {
      width: Math.max(1, Math.round(rect.width || this.host.clientWidth || window.innerWidth || 1280)),
      height: Math.max(1, Math.round(rect.height || this.host.clientHeight || window.innerHeight || 720)),
    };
  }

  private async mount(): Promise<void> {
    this.host.innerHTML = '';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    try {
      const app = new Application();
      await app.init({
        width: this.viewport.width,
        height: this.viewport.height,
        backgroundColor: parseHexColor(this.pack.palette.backdrop),
        antialias: true,
        resolution: dpr,
        autoDensity: true,
        preference: 'webgl',
      });
      if (this.destroyed) {
        app.destroy(true, { children: true, texture: true });
        return;
      }
      this.app = app;
      this.rendererKind = 'webgl';
      this.canvasElement = app.canvas;
      app.canvas.style.display = 'block';
      app.canvas.style.width = '100%';
      app.canvas.style.height = '100%';
      app.canvas.style.touchAction = 'none';
      this.host.appendChild(app.canvas);

      const worldContainer = new Container();
      const chunkLayer = new Container();
      const borderGraphic = new Graphics();
      const overlayGraphic = new Graphics();
      worldContainer.addChild(chunkLayer);
      worldContainer.addChild(borderGraphic);
      worldContainer.addChild(overlayGraphic);
      app.stage.addChild(worldContainer);

      this.worldContainer = worldContainer;
      this.chunkLayer = chunkLayer;
      this.borderGraphic = borderGraphic;
      this.overlayGraphic = overlayGraphic;
      this.drawMapBorderPixi();
    } catch {
      this.mountFallbackCanvas(dpr);
    }

    this.attachEvents();
    this.lastFrameTs = performance.now();
    this.stepFrame(this.lastFrameTs);
    this.rafId = requestAnimationFrame(this.onAnimationFrame);
  }

  private mountFallbackCanvas(dpr: number): void {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(this.viewport.width * dpr);
    canvas.height = Math.round(this.viewport.height * dpr);
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    this.host.appendChild(canvas);
    this.fallbackCanvas = canvas;
    this.fallbackCtx = canvas.getContext('2d');
    this.canvasElement = canvas;
    this.rendererKind = 'canvas2d';
  }

  private drawMapBorderPixi(): void {
    if (!this.borderGraphic) return;
    const g = this.borderGraphic;
    g.clear();
    const n = this.pack.mapSize;
    const top = tileTopVertexToWorld(0, 0, this.tileW, this.tileH);
    const right = tileTopVertexToWorld(n, 0, this.tileW, this.tileH);
    const bottom = tileTopVertexToWorld(n, n, this.tileW, this.tileH);
    const left = tileTopVertexToWorld(0, n, this.tileW, this.tileH);
    const stroke = parseColorAndAlpha(this.pack.palette.border, 0x5e7c9e, 0.85);
    g.moveTo(top.x, top.y)
      .lineTo(right.x, right.y)
      .lineTo(bottom.x, bottom.y)
      .lineTo(left.x, left.y)
      .closePath()
      .stroke({ color: stroke.color, alpha: stroke.alpha, width: 2 / Math.max(this.camera.zoom, 0.15) });
  }

  private attachEvents(): void {
    const el = this.canvasElement;
    if (!el) return;

    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerup', this.onPointerUp);
    el.addEventListener('pointercancel', this.onPointerUp);
    el.addEventListener('pointerleave', this.onPointerLeave);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(this.host);
    } else {
      window.addEventListener('resize', this.handleResize);
    }
  }

  private readonly handleResize = (): void => {
    if (this.destroyed) return;
    const next = this.readHostSize();
    if (next.width === this.viewport.width && next.height === this.viewport.height) return;
    this.viewport = next;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.app) {
      this.app.renderer.resize(next.width, next.height);
    } else if (this.fallbackCanvas) {
      this.fallbackCanvas.width = Math.round(next.width * dpr);
      this.fallbackCanvas.height = Math.round(next.height * dpr);
    }
    this.dirtyScene = true;
    this.emitStats(true);
  };

  private pointerLocalPos(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.canvasElement?.getBoundingClientRect();
    if (!rect) return { x: e.clientX, y: e.clientY };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const pt = this.pointerLocalPos(e);
    this.dragPointerId = e.pointerId;
    this.dragStartX = pt.x;
    this.dragStartY = pt.y;
    this.dragLastX = pt.x;
    this.dragLastY = pt.y;
    this.dragMoved = false;
    try {
      this.canvasElement?.setPointerCapture(e.pointerId);
    } catch {
      /* Synthetic test events may not hold an active pointer capture id. */
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const pt = this.pointerLocalPos(e);
    if (this.dragPointerId === e.pointerId) {
      const dx = pt.x - this.dragLastX;
      const dy = pt.y - this.dragLastY;
      this.dragLastX = pt.x;
      this.dragLastY = pt.y;
      if (Math.hypot(pt.x - this.dragStartX, pt.y - this.dragStartY) >= DRAG_THRESHOLD_PX) {
        this.dragMoved = true;
      }
      if (this.dragMoved) {
        this.camera = panCamera(this.camera, dx, dy, this.bounds);
        this.dirtyScene = true;
      }
    }

    const nextHover = screenToTile(
      pt.x,
      pt.y,
      this.camera,
      this.viewport,
      this.tileW,
      this.tileH,
      this.pack.mapSize,
    );
    if (nextHover?.col !== this.hoveredTile?.col || nextHover?.row !== this.hoveredTile?.row) {
      this.hoveredTile = nextHover;
      this.dirtyScene = true;
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.dragPointerId !== e.pointerId) return;
    const wasClick = !this.dragMoved;
    this.dragPointerId = null;
    this.dragMoved = false;
    try {
      this.canvasElement?.releasePointerCapture(e.pointerId);
    } catch {
      /* Ignore release errors on synthetic events. */
    }
    if (wasClick) {
      const pt = this.pointerLocalPos(e);
      this.pickScreenPoint(pt.x, pt.y);
    }
  };

  private readonly onPointerLeave = (): void => {
    if (this.hoveredTile !== null) {
      this.hoveredTile = null;
      this.dirtyScene = true;
    }
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const pt = this.pointerLocalPos(e);
    const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
    const minZoom = this.getBirdEyeZoom();
    this.camera = zoomCameraAt(this.camera, factor, pt, this.viewport, minZoom, MAX_CAMERA_ZOOM, this.bounds);
    this.dirtyScene = true;
    this.emitStats(true);
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd', 'W', 'A', 'S', 'D'].includes(e.key)) {
      this.pressedKeys.add(e.key.toLowerCase());
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.pressedKeys.delete(e.key.toLowerCase());
  };

  getBirdEyeZoom(): number {
    return computeBirdEyeZoom(
      this.pack.mapSize,
      this.tileW,
      this.tileH,
      this.viewport,
      this.pack.params.overviewMarginPx,
    );
  }

  setZoomTier(tier: ResolutionTierId): void {
    const zoom = zoomForTier(
      tier,
      this.pack.mapSize,
      this.tileW,
      this.tileH,
      this.viewport,
      this.pack.params.overviewMarginPx,
    );
    if (tier === 'overview') {
      this.camera = { x: this.bounds.centerX, y: this.bounds.centerY, zoom };
    } else {
      this.camera = { ...this.camera, zoom };
    }
    this.dirtyScene = true;
    this.emitStats(true);
  }

  setCamera(camera: CameraState): void {
    const minZoom = this.getBirdEyeZoom();
    this.camera = {
      x: Math.max(this.bounds.minX, Math.min(this.bounds.maxX, camera.x)),
      y: Math.max(this.bounds.minY, Math.min(this.bounds.maxY, camera.y)),
      zoom: Math.max(minZoom, Math.min(MAX_CAMERA_ZOOM, camera.zoom)),
    };
    this.dirtyScene = true;
    this.emitStats(true);
  }

  panByScreen(dx: number, dy: number): void {
    this.camera = panCamera(this.camera, dx, dy, this.bounds);
    this.dirtyScene = true;
  }

  setObjects(objects: readonly PickableObject[]): void {
    this.objects = objects;
    this.dirtyScene = true;
  }

  pickScreenPoint(sx: number, sy: number): PickResult | null {
    const pick = pickAtScreen(
      sx,
      sy,
      this.camera,
      this.viewport,
      this.objects,
      this.tileW,
      this.tileH,
      this.pack.mapSize,
    );
    this.selectedPick = pick;
    this.dirtyScene = true;
    this.onSelect?.(pick);
    this.emitStats(true);
    return pick;
  }

  /* Synchronously finishes baking all currently visible chunks (useful for deterministic screenshot capture). */
  flushVisibleBakes(): void {
    const tier = activeZoomTier(this.camera.zoom);
    const rect = visibleWorldRect(this.camera, this.viewport, this.tileW);
    const visible = cullVisibleChunks(this.chunkGrid, rect);
    for (const chunk of visible) {
      this.ensureChunkBaked(chunk, tier);
    }
    this.dirtyScene = true;
    this.syncScene(Infinity);
  }

  getStats(): WorldEngineStats {
    return {
      fps: Math.round(this.lastFps),
      frameTimeMs: Math.round(this.lastFrameMs * 10) / 10,
      zoom: Math.round(this.camera.zoom * 1000) / 1000,
      tier: activeZoomTier(this.camera.zoom),
      visibleChunks: this.visibleChunkList.length,
      totalChunks: this.chunkGrid.chunks.length,
      cachedChunks: this.overviewCache.size + this.detailCache.size,
      pendingBakes: this.pendingBakeCount,
      mapSize: this.pack.mapSize,
      chunkSize: this.pack.params.chunkSize,
      rendererKind: this.rendererKind,
      hoveredTile: this.hoveredTile,
      selectedPick: this.selectedPick,
      camera: this.camera,
    };
  }

  private cacheForTier(tier: ResolutionTierId): ChunkLruCache<CachedChunkEntry> {
    return tier === 'overview' ? this.overviewCache : this.detailCache;
  }

  private cacheKey(chunk: ChunkCoord, tier: ResolutionTierId): string {
    return `${chunk.key}@${tier}`;
  }

  private disposeEntry = (entry: CachedChunkEntry): void => {
    if (entry.sprite) {
      entry.sprite.removeFromParent();
      entry.sprite.destroy();
    }
    if (entry.texture) {
      entry.texture.destroy(true);
    }
  };

  private ensureChunkBaked(chunk: ChunkCoord, tier: ResolutionTierId): CachedChunkEntry {
    const cache = this.cacheForTier(tier);
    const key = this.cacheKey(chunk, tier);
    const existing = cache.get(key);
    if (existing) return existing;

    const baked = bakeChunkCanvas(chunk, this.pack, this.tileLookup, tier, this.resolveTileId);
    let texture: Texture | null = null;
    let sprite: Sprite | null = null;
    if (this.app) {
      texture = Texture.from(baked.canvas);
      sprite = new Sprite(texture);
      sprite.x = baked.worldX;
      sprite.y = baked.worldY;
      sprite.scale.set(1 / baked.scale);
    }
    const entry: CachedChunkEntry = { baked, texture, sprite };
    cache.set(key, entry);
    return entry;
  }

  private readonly onAnimationFrame = (ts: number): void => {
    if (this.destroyed) return;
    this.stepFrame(ts);
    this.rafId = requestAnimationFrame(this.onAnimationFrame);
  };

  private stepFrame(ts: number): void {
    const dtMs = Math.max(1, Math.min(100, ts - this.lastFrameTs || 16.67));
    this.lastFrameTs = ts;
    this.lastFrameMs = dtMs;
    this.fpsSamples.push(1000 / dtMs);
    if (this.fpsSamples.length > 30) this.fpsSamples.shift();
    this.lastFps = this.fpsSamples.reduce((acc, v) => acc + v, 0) / this.fpsSamples.length;

    /* Smooth keyboard camera panning. */
    if (this.pressedKeys.size > 0) {
      const step = KEY_PAN_PX_PER_SEC * (dtMs / 1000);
      let dx = 0;
      let dy = 0;
      if (this.pressedKeys.has('arrowleft') || this.pressedKeys.has('a')) dx += step;
      if (this.pressedKeys.has('arrowright') || this.pressedKeys.has('d')) dx -= step;
      if (this.pressedKeys.has('arrowup') || this.pressedKeys.has('w')) dy += step;
      if (this.pressedKeys.has('arrowdown') || this.pressedKeys.has('s')) dy -= step;
      if (dx !== 0 || dy !== 0) {
        this.camera = panCamera(this.camera, dx, dy, this.bounds);
        this.dirtyScene = true;
      }
    }

    if (this.dirtyScene || this.pendingBakeCount > 0) {
      this.syncScene(BAKE_BUDGET_MS);
    }

    if (ts - this.lastStatsPushTs >= 180) {
      this.lastStatsPushTs = ts;
      this.emitStats(false);
    }
  }

  private syncScene(bakeBudgetMs: number): void {
    const tier = activeZoomTier(this.camera.zoom);
    const visibleRect = visibleWorldRect(this.camera, this.viewport, this.tileW);
    const visible = cullVisibleChunks(this.chunkGrid, visibleRect);
    this.visibleChunkList = visible;

    const primaryCache = this.cacheForTier(tier);
    const protectedPrimary = new Set<string>();
    const protectedOverview = new Set<string>();
    const drawEntries: CachedChunkEntry[] = [];

    const bakeStart = performance.now();
    let pending = 0;

    for (const chunk of visible) {
      const primaryKey = this.cacheKey(chunk, tier);
      protectedPrimary.add(primaryKey);
      let entry = primaryCache.get(primaryKey);
      if (!entry) {
        if (performance.now() - bakeStart < bakeBudgetMs) {
          entry = this.ensureChunkBaked(chunk, tier);
        } else {
          pending++;
          /* Show cached overview chunk as instant placeholder until this detail chunk finishes baking. */
          const ovKey = this.cacheKey(chunk, 'overview');
          protectedOverview.add(ovKey);
          entry = this.overviewCache.get(ovKey);
          if (!entry && performance.now() - bakeStart < bakeBudgetMs + 2) {
            entry = this.ensureChunkBaked(chunk, 'overview');
          }
        }
      }
      if (entry) drawEntries.push(entry);
    }

    this.pendingBakeCount = pending;
    this.dirtyScene = pending > 0;

    if (tier === 'overview') {
      this.overviewCache.evictIfNeeded(protectedPrimary, this.disposeEntry);
    } else {
      this.detailCache.evictIfNeeded(protectedPrimary, this.disposeEntry);
      this.overviewCache.evictIfNeeded(protectedOverview, this.disposeEntry);
    }

    if (this.app && this.worldContainer && this.chunkLayer) {
      this.worldContainer.position.set(
        this.viewport.width / 2 - this.camera.x * this.camera.zoom,
        this.viewport.height / 2 - this.camera.y * this.camera.zoom,
      );
      this.worldContainer.scale.set(this.camera.zoom);

      this.chunkLayer.removeChildren();
      for (const entry of drawEntries) {
        if (entry.sprite) this.chunkLayer.addChild(entry.sprite);
      }

      this.drawMapBorderPixi();
      this.drawOverlayPixi();
    } else {
      this.renderFallback2D(drawEntries);
    }
  }

  private drawOverlayPixi(): void {
    if (!this.overlayGraphic) return;
    const g = this.overlayGraphic;
    g.clear();
    const strokeW = Math.max(1, 2 / this.camera.zoom);

    if (this.hoveredTile) {
      const fill = parseColorAndAlpha(this.pack.palette.hoverFill, 0x68ceff, 0.24);
      const stroke = parseColorAndAlpha(this.pack.palette.hoverStroke, 0x7ed6ff, 0.95);
      const pts = tileDiamondVertices(this.hoveredTile.col, this.hoveredTile.row, this.tileW, this.tileH);
      g.moveTo(pts[0].x, pts[0].y)
        .lineTo(pts[1].x, pts[1].y)
        .lineTo(pts[2].x, pts[2].y)
        .lineTo(pts[3].x, pts[3].y)
        .closePath()
        .fill({ color: fill.color, alpha: fill.alpha })
        .stroke({ color: stroke.color, alpha: stroke.alpha, width: strokeW });
    }

    if (this.selectedPick) {
      const fill = parseColorAndAlpha(this.pack.palette.selectFill, 0xffca58, 0.34);
      const stroke = parseColorAndAlpha(this.pack.palette.selectStroke, 0xffd166, 1);
      const spanC = this.selectedPick.kind === 'object' ? this.selectedPick.object.spanCol : 1;
      const spanR = this.selectedPick.kind === 'object' ? this.selectedPick.object.spanRow : 1;
      const top = tileTopVertexToWorld(this.selectedPick.col, this.selectedPick.row, this.tileW, this.tileH);
      const right = tileTopVertexToWorld(this.selectedPick.col + spanC, this.selectedPick.row, this.tileW, this.tileH);
      const bottom = tileTopVertexToWorld(
        this.selectedPick.col + spanC,
        this.selectedPick.row + spanR,
        this.tileW,
        this.tileH,
      );
      const left = tileTopVertexToWorld(this.selectedPick.col, this.selectedPick.row + spanR, this.tileW, this.tileH);
      g.moveTo(top.x, top.y)
        .lineTo(right.x, right.y)
        .lineTo(bottom.x, bottom.y)
        .lineTo(left.x, left.y)
        .closePath()
        .fill({ color: fill.color, alpha: fill.alpha })
        .stroke({ color: stroke.color, alpha: stroke.alpha, width: strokeW * 1.25 });
    }
  }

  private renderFallback2D(entries: readonly CachedChunkEntry[]): void {
    const ctx = this.fallbackCtx;
    const canvas = this.fallbackCanvas;
    if (!ctx || !canvas) return;

    const dpr = canvas.width / Math.max(1, this.viewport.width);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.pack.palette.backdrop;
    ctx.fillRect(0, 0, this.viewport.width, this.viewport.height);

    ctx.save();
    ctx.translate(
      this.viewport.width / 2 - this.camera.x * this.camera.zoom,
      this.viewport.height / 2 - this.camera.y * this.camera.zoom,
    );
    ctx.scale(this.camera.zoom, this.camera.zoom);

    for (const entry of entries) {
      const b = entry.baked;
      ctx.drawImage(b.canvas, b.worldX, b.worldY, b.pixelWidth / b.scale, b.pixelHeight / b.scale);
    }

    const n = this.pack.mapSize;
    const top = tileTopVertexToWorld(0, 0, this.tileW, this.tileH);
    const right = tileTopVertexToWorld(n, 0, this.tileW, this.tileH);
    const bottom = tileTopVertexToWorld(n, n, this.tileW, this.tileH);
    const left = tileTopVertexToWorld(0, n, this.tileW, this.tileH);
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(right.x, right.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.lineTo(left.x, left.y);
    ctx.closePath();
    ctx.strokeStyle = this.pack.palette.border;
    ctx.lineWidth = 2 / Math.max(this.camera.zoom, 0.15);
    ctx.stroke();

    const drawHighlight = (col: number, row: number, spanC: number, spanR: number, fill: string, stroke: string) => {
      const t = tileTopVertexToWorld(col, row, this.tileW, this.tileH);
      const r = tileTopVertexToWorld(col + spanC, row, this.tileW, this.tileH);
      const bt = tileTopVertexToWorld(col + spanC, row + spanR, this.tileW, this.tileH);
      const l = tileTopVertexToWorld(col, row + spanR, this.tileW, this.tileH);
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.lineTo(r.x, r.y);
      ctx.lineTo(bt.x, bt.y);
      ctx.lineTo(l.x, l.y);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(1, 2 / this.camera.zoom);
      ctx.stroke();
    };

    if (this.hoveredTile) {
      drawHighlight(
        this.hoveredTile.col,
        this.hoveredTile.row,
        1,
        1,
        this.pack.palette.hoverFill,
        this.pack.palette.hoverStroke,
      );
    }
    if (this.selectedPick) {
      const spanC = this.selectedPick.kind === 'object' ? this.selectedPick.object.spanCol : 1;
      const spanR = this.selectedPick.kind === 'object' ? this.selectedPick.object.spanRow : 1;
      drawHighlight(
        this.selectedPick.col,
        this.selectedPick.row,
        spanC,
        spanR,
        this.pack.palette.selectFill,
        this.pack.palette.selectStroke,
      );
    }
    ctx.restore();
  }

  private emitStats(force: boolean): void {
    if (!this.onStats) return;
    if (force) this.lastStatsPushTs = performance.now();
    this.onStats(this.getStats());
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafId) cancelAnimationFrame(this.rafId);

    const el = this.canvasElement;
    if (el) {
      el.removeEventListener('pointerdown', this.onPointerDown);
      el.removeEventListener('pointermove', this.onPointerMove);
      el.removeEventListener('pointerup', this.onPointerUp);
      el.removeEventListener('pointercancel', this.onPointerUp);
      el.removeEventListener('pointerleave', this.onPointerLeave);
      el.removeEventListener('wheel', this.onWheel);
    }
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('resize', this.handleResize);
    this.resizeObserver?.disconnect();

    this.overviewCache.clear(this.disposeEntry);
    this.detailCache.clear(this.disposeEntry);

    if (this.app) {
      this.app.destroy(true, { children: true, texture: true });
      this.app = null;
    }
    if (this.fallbackCanvas) {
      this.fallbackCanvas.remove();
      this.fallbackCanvas = null;
      this.fallbackCtx = null;
    }
    this.canvasElement = null;
  }
}
