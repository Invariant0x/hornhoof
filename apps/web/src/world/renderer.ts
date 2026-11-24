/* PixiJS v8 chunked isometric world renderer with hard zoom bounds, Retina/DPR-aware LOD baking,
   frustum culling, drag pan / cursor zoom / click picking and graceful Canvas 2D fallback. */

import { Application, Container, Graphics, RenderLayer, Sprite, Texture, TilingSprite } from 'pixi.js';
import {
  animationDetailForZoom,
  clamp,
  computeEffectiveZoomBounds,
  createInitialCamera,
  lodForCamera,
  panCamera,
  visibleWorldRect,
  zoomCameraAt,
  zoomPercent,
  type CameraState,
  type EffectiveZoomBounds,
  type ViewportSize,
} from './camera';
import { DisplayRunPool, WorldArtLibrary, type WorldArtStats } from './art-runtime';
import { residentStandsStill, residentWalkSpeed } from './art';
import { bakeChunkCanvas, buildTileLookup, type BakedChunk } from './chunk-baker';
import { buildChunkGrid, ChunkLruCache, cullVisibleChunks, type ChunkCoord, type ChunkGrid } from './chunks';
import {
  mapWorldBounds,
  pickAtScreen,
  screenToTile,
  tileCenterToWorld,
  tileDiamondVertices,
  tileTopVertexToWorld,
  worldToScreen,
  worldToTileFloat,
  type MapWorldBounds,
  type PickableObject,
  type PickResult,
  type TileCoord,
} from './coords';
import type { AnimationDetailLevel, LodTierId, LodTierSpec, TileSlotSpec, WorldPackManifest } from './manifest';
import {
  renderCityFallback2D,
  renderCityToPixi,
  swayCloths,
  type CityArtContext,
  type ClothLayer,
  type CityRenderState,
  type RelocationTargetPreview,
  type TileWindow,
} from './city-renderer';
import {
  stepConstructionSimulation,
  type ConstructionSimulation,
} from './construction';
import {
  renderConstructionLoopsFallback2D,
  renderConstructionLoopsToPixi,
  type LoopArtContext,
} from './construction-renderer';
import {
  renderDepartmentFocusFallback2D,
  renderDepartmentFocusToPixi,
  type DepartmentFocusSpec,
} from './department-focus';
import { cityToPickableObjects } from './live-sync';
import { cityBuildingVariants } from './building-variants';
import { cityGround, cityGroundKey } from './city-ground';
import { ChunkLotKeys, type LotClearing } from './lot-clearing';
import { RoadStripPainter } from './road-strips';
import {
  pickResidentAtScreen,
  stepResidentSimulation,
  type ResidentEntity,
  type ResidentSimulation,
} from './residents';
import { renderResidentsFallback2D, renderResidentsToPixi, type ResidentArtContext } from './residents-renderer';
import { boatCargoMaxOf } from './harbour';
import { harbourArtReady } from './harbour-renderer';
import { PlantRenderer, type PlantStats } from './plant-renderer';
import { bakeSmoothChunkCanvas, buildLiquidSurfaceCanvas, smoothPixelsToCanvas, startSmoothChunkBake, type SmoothChunkBake } from './smooth-terrain-baker';
import { loadTerrainArt, terrainArtFor, type ArtPixels, type LoadedTerrainArt } from './terrain-art';
import type { GeneratedWorldMap } from './terrain-engine';

export type RendererKind = 'webgl' | 'canvas2d';

export type RendererDebugInfo = Readonly<{
  rendererKind: RendererKind;
  glRenderer: string | null;
  glVendor: string | null;
}>;

export type WorldEngineStats = Readonly<{
  fps: number;
  frameTimeMs: number;
  cpuStepMs: number;
  zoom: number;
  zoomPercent: number;
  minZoom: number;
  maxZoom: number;
  cappedBySource: boolean;
  cssTileW: number;
  cssTileH: number;
  lodId: LodTierId;
  lodTileW: number;
  lodTileH: number;
  dpr: number;
  animationDetail: AnimationDetailLevel;
  visibleChunks: number;
  totalChunks: number;
  cachedChunks: number;
  pendingBakes: number;
  mapSize: number;
  chunkSize: number;
  rendererKind: RendererKind;
  buildGridVisible: boolean;
  hasAnimatedLiquid: boolean;
  /* Plants on the map and in view; null for a pack without plants. */
  plants?: PlantStats | null;
  hoveredTile: TileCoord | null;
  selectedPick: PickResult | null;
  camera: CameraState;
}>;

export type WorldEngineOptions = Readonly<{
  host: HTMLElement;
  pack: WorldPackManifest;
  terrainMap?: GeneratedWorldMap;
  showBuildGrid?: boolean;
  initialZoom?: number;
  initialCenterTile?: TileCoord;
  markerTile?: TileCoord | null;
  objects?: readonly PickableObject[];
  resolveTileId?: (col: number, row: number) => string;
  onStats?: (stats: WorldEngineStats) => void;
  onSelect?: (pick: PickResult | null) => void;
  onSelectResident?: (resident: ResidentEntity | null) => void;
  onHover?: (tile: TileCoord | null) => void;
}>;

type CachedChunkEntry = {
  key: string;
  baked: BakedChunk;
  texture: Texture | null;
  sprite: Sprite | null;
};

/* Per-frame baking budget (ms) so lazy LOD texture bakes keep interactive pan/zoom near 60 FPS. */
const BAKE_BUDGET_MS = 7;
const DRAG_THRESHOLD_PX = 5;
const KEY_PAN_PX_PER_SEC = 540;
const CHUNK_CACHE_CAP = 260;
const ZOOM_STEP_FACTOR = 1.25;
/* How a world's Pixi application ends: its canvas leaves the page, and Pixi's pools shared by every application on the page
   stay. Ending with `true` would also empty those pools and break the batches of a map still drawing, as when React's
   development mode ends the first of a map's two mounts, or a skin switch ends one map while another draws. */
const APP_ENDS_ALONE = { removeView: true, releaseGlobalResources: false } as const;

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
  private readonly terrainMap?: GeneratedWorldMap;
  private readonly tileW: number;
  private readonly tileH: number;
  private readonly bounds: MapWorldBounds;
  private readonly chunkGrid: ChunkGrid;
  private readonly tileLookup: ReadonlyMap<string, TileSlotSpec>;
  private readonly resolveTileId?: (col: number, row: number) => string;
  private readonly onStats?: (stats: WorldEngineStats) => void;
  private readonly onSelect?: (pick: PickResult | null) => void;
  private readonly onSelectResident?: (resident: ResidentEntity | null) => void;
  private readonly onHover?: (tile: TileCoord | null) => void;

  private objects: readonly PickableObject[];
  private cityRenderState: CityRenderState | null = null;
  private cityDirty = false;
  private relocationPreview: RelocationTargetPreview | null = null;
  private residentSim: ResidentSimulation | null = null;
  private constructionSim: ConstructionSimulation | null = null;
  private departmentFocus: DepartmentFocusSpec | null = null;
  private lastConstructionCityVersion = -1;
  private selectedResidentId: string | null = null;
  private residentPickingEnabled = true;
  private viewport: ViewportSize;
  private dpr: number;
  private zoomBounds: EffectiveZoomBounds;
  private readonly markerTile: TileCoord | null;
  private buildGridVisible: boolean;
  private camera: CameraState;
  private hoveredTile: TileCoord | null = null;
  private selectedPick: PickResult | null = null;

  private app: Application | null = null;
  private worldContainer: Container | null = null;
  private liquidSpriteA: TilingSprite | null = null;
  private liquidSpriteB: TilingSprite | null = null;
  private liquidOrigin = { x: 0, y: 0 };
  private liquidArtTextures: Texture[] = [];
  private liquidTexture: Texture | null = null;
  private liquidCanvas: HTMLCanvasElement | null = null;
  private liquidPhaseX = 0;
  /* The drift wraps where the water picture repeats; painted layers of several sizes never wrap, so they never jump. */
  private liquidWrap = 256;
  private liquidPhaseY = 0;
  private chunkLayer: Container | null = null;
  private buildGridGraphic: Graphics | null = null;
  private cityGraphic: Graphics | null = null;
  private residentsGraphic: Graphics | null = null;
  private constructionGraphic: Graphics | null = null;
  private departmentFocusGraphic: Graphics | null = null;
  private borderGraphic: Graphics | null = null;
  private overlayGraphic: Graphics | null = null;
  private readonly drawnResidentIds = new Set<string>();
  /* Artist pictures and sheets from the pack's art folder; empty until art-index.json loads. */
  private artLibrary: WorldArtLibrary = WorldArtLibrary.none();
  private buildingArtPool: DisplayRunPool | null = null;
  private residentArtPool: DisplayRunPool | null = null;
  private loopArtPool: DisplayRunPool | null = null;
  private lastScaffoldSig = '';

  /* Dirty-tracking keys eliminate per-frame scene-graph rebuilds during smooth 60 FPS panning. */
  private lastVisibleChunkSig = '';
  private lastBorderZoom = -1;
  private lastGridKey = '';
  private lastOverlayKey = '';
  private cityCullWindow: TileWindow | null = null;

  private fallbackCanvas: HTMLCanvasElement | null = null;
  private fallbackCtx: CanvasRenderingContext2D | null = null;
  private rendererKind: RendererKind = 'webgl';

  private readonly chunkCache = new ChunkLruCache<CachedChunkEntry>(CHUNK_CACHE_CAP);
  /* Smooth chunk bakes in progress, a few rows per frame, by cache key; only chunks still in view keep theirs. */
  private readonly bakeJobs = new Map<string, SmoothChunkBake>();
  /* The painted art this engine draws with, fixed when it mounts: art that arrives later stays out of this session, so
     ground, water and plants never mix painted and procedural pictures. */
  private art: LoadedTerrainArt | null = null;
  private artPinned = false;
  private visibleChunkList: ChunkCoord[] = [];
  private pendingBakeCount = 0;

  private destroyed = false;
  private dirtyScene = true;
  private rafId = 0;
  private lastFrameTs = 0;
  private fpsSamples: number[] = [];
  private lastFps = 60;
  private lastFrameMs = 16.67;
  private lastCpuStepMs = 0;
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
  private plantRenderer: PlantRenderer | null = null;
  private cityGroundKey = 'none';
  /* Cleared ground under the city's lots, baked into the chunks; null without a city or a pack lot ground. */
  private lotClearing: LotClearing | null = null;
  /* Per chunk: the lots reaching into it as part of its cache key, and the key of its last baked picture, drawn while a
     changed clearing bakes it again. */
  private readonly chunkLotKeys = new ChunkLotKeys();
  private buildingVariants: ReadonlyMap<string, number> = new Map();
  private readonly roadPainter = new RoadStripPainter();
  /* Awnings and cloth of the building pictures drawn by the last city pass, moved every frame by the wind. */
  private readonly swayingLayers: ClothLayer[] = [];
  /* A fixed wind clock in seconds for steady shots and video; null follows real time. */
  private windClockSec: number | null = null;

  private constructor(options: WorldEngineOptions) {
    this.host = options.host;
    this.pack = options.pack;
    this.terrainMap = options.terrainMap;
    this.plantRenderer = PlantRenderer.create(options.pack, options.terrainMap);
    this.buildGridVisible = options.showBuildGrid ?? options.pack.showGridByDefault ?? true;
    this.tileW = options.pack.projection.defaultTileW;
    this.tileH = options.pack.projection.defaultTileH;
    this.bounds = mapWorldBounds(options.pack.mapSize, this.tileW, this.tileH);
    this.chunkGrid = buildChunkGrid(options.pack.mapSize, options.pack.params.chunkSize, this.tileW, this.tileH);
    this.tileLookup = buildTileLookup(options.pack);
    this.resolveTileId = options.resolveTileId;
    this.objects = options.objects ?? [];
    this.onStats = options.onStats;
    this.onSelect = options.onSelect;
    this.onSelectResident = options.onSelectResident;
    this.onHover = options.onHover;

    this.dpr = Math.min(Math.max(1, window.devicePixelRatio || 1), 2);
    this.viewport = this.readHostSize();
    this.zoomBounds = computeEffectiveZoomBounds(options.pack, this.dpr);
    const initial = createInitialCamera(options.pack, this.dpr);
    const startCenter = options.initialCenterTile
      ? tileCenterToWorld(options.initialCenterTile.col, options.initialCenterTile.row, this.tileW, this.tileH)
      : { x: initial.x, y: initial.y };
    this.markerTile = options.markerTile ?? null;
    this.camera = {
      x: clamp(startCenter.x, this.bounds.minX, this.bounds.maxX),
      y: clamp(startCenter.y, this.bounds.minY, this.bounds.maxY),
      zoom:
        options.initialZoom !== undefined
          ? clamp(options.initialZoom, this.zoomBounds.minZoom, this.zoomBounds.maxZoom)
          : initial.zoom,
    };
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

    try {
      /* Painted ground and plants load while the GPU starts; the world waits for them a while, then draws what it has. */
      const artJob = loadTerrainArt(this.pack);
      const app = new Application();
      await app.init({
        width: this.viewport.width,
        height: this.viewport.height,
        backgroundColor: parseHexColor(this.pack.palette.backdrop),
        antialias: true,
        resolution: this.dpr,
        autoDensity: true,
        autoStart: false,
        preference: 'webgl',
      });
      if (this.destroyed) {
        app.destroy(APP_ENDS_ALONE, { children: true, texture: true });
        return;
      }
      await Promise.race([artJob, new Promise(resolve => setTimeout(resolve, 15000))]);
      if (this.destroyed) {
        app.destroy(APP_ENDS_ALONE, { children: true, texture: true });
        return;
      }
      this.useArt(terrainArtFor(this.pack));
      this.app = app;
      const roadArt = this.pack.terrainArt?.roads;
      const artBase = this.pack.art?.baseUrl;
      if (roadArt && artBase) {
        /* Streets turn painted once every tier's strip is in; until then (or without them) the city draws street tiles. */
        void this.roadPainter.load(artBase, roadArt).then(ok => {
          if (ok && !this.destroyed) this.markCityDirty();
        });
      }
      this.rendererKind = 'webgl';
      this.canvasElement = app.canvas;
      app.canvas.style.display = 'block';
      app.canvas.style.width = '100%';
      app.canvas.style.height = '100%';
      app.canvas.style.touchAction = 'none';
      this.host.appendChild(app.canvas);

      const worldContainer = new Container();
      const liquidLayer = new Container();
      const chunkLayer = new Container();
      const buildGridGraphic = new Graphics();
      const cityGraphic = new Graphics();
      const buildingArtLayer = new Container();
      const residentsGraphic = new Graphics();
      const residentArtLayer = new Container();
      const constructionGraphic = new Graphics();
      const loopArtLayer = new Container();
      const departmentFocusGraphic = new Graphics();
      const borderGraphic = new Graphics();
      const overlayGraphic = new Graphics();

      const paintedLiquid = this.art?.liquid ?? null;
      if (this.terrainMap && this.pack.liquidLayer && paintedLiquid) {
        this.mountPaintedLiquid(liquidLayer, paintedLiquid);
      } else if (this.terrainMap && this.pack.liquidLayer) {
        const liqCanvas = buildLiquidSurfaceCanvas(this.pack.liquidLayer, 256);
        const liqTex = Texture.from(liqCanvas);
        /* Explicit repeat wrapping prevents bilinear clamp seams at tile borders in WebGL. */
        liqTex.source.style.addressMode = 'repeat';
        const spriteA = new TilingSprite({
          texture: liqTex,
          width: this.bounds.width,
          height: this.bounds.height,
        });
        spriteA.x = this.bounds.minX;
        spriteA.y = this.bounds.minY;
        /* 2:1 foreshortening aligns animated liquid ripples with the isometric horizontal plane. */
        spriteA.tileScale.set(1.25, 0.625);

        const spriteB = new TilingSprite({
          texture: liqTex,
          width: this.bounds.width,
          height: this.bounds.height,
        });
        spriteB.x = this.bounds.minX;
        spriteB.y = this.bounds.minY;
        spriteB.alpha = 0.36;
        spriteB.tileScale.set(1.75, 0.875);

        const n = this.pack.mapSize;
        const mTop = tileTopVertexToWorld(0, 0, this.tileW, this.tileH);
        const mRight = tileTopVertexToWorld(n, 0, this.tileW, this.tileH);
        const mBottom = tileTopVertexToWorld(n, n, this.tileW, this.tileH);
        const mLeft = tileTopVertexToWorld(0, n, this.tileW, this.tileH);
        const mask = new Graphics();
        mask
          .moveTo(mTop.x, mTop.y)
          .lineTo(mRight.x, mRight.y)
          .lineTo(mBottom.x, mBottom.y)
          .lineTo(mLeft.x, mLeft.y)
          .closePath()
          .fill({ color: 0xffffff });

        liquidLayer.addChild(spriteA);
        liquidLayer.addChild(spriteB);
        liquidLayer.addChild(mask);
        liquidLayer.mask = mask;

        this.liquidCanvas = liqCanvas;
        this.liquidTexture = liqTex;
        this.liquidSpriteA = spriteA;
        this.liquidSpriteB = spriteB;
      }

      worldContainer.addChild(liquidLayer);
      /* Reflections of the plants by the water: under the ground, which is see-through only over open water. */
      const reflectionLayer = new Container();
      worldContainer.addChild(reflectionLayer);
      worldContainer.addChild(chunkLayer);
      worldContainer.addChild(buildGridGraphic);
      /* Painted streets lie on the ground, under the plants' shadows and everything standing. */
      worldContainer.addChild(this.roadPainter.container);
      /* Flat details and shadows of the plants lie on the ground under the city; plant bodies, buildings and people
         render through one depth layer sorted by the world y of their ground point, so a palm in front of a wall
         covers it and one behind is covered. */
      const plantLayer = new Container();
      worldContainer.addChild(plantLayer);
      const depthLayer = new RenderLayer({ sortableChildren: true });
      this.plantRenderer?.attachPixi(plantLayer, reflectionLayer, depthLayer);
      worldContainer.addChild(cityGraphic);
      worldContainer.addChild(buildingArtLayer);
      worldContainer.addChild(depthLayer);
      worldContainer.addChild(residentsGraphic);
      worldContainer.addChild(residentArtLayer);
      worldContainer.addChild(constructionGraphic);
      worldContainer.addChild(loopArtLayer);
      worldContainer.addChild(departmentFocusGraphic);
      worldContainer.addChild(borderGraphic);
      worldContainer.addChild(overlayGraphic);
      app.stage.addChild(worldContainer);

      this.worldContainer = worldContainer;
      this.chunkLayer = chunkLayer;
      this.buildGridGraphic = buildGridGraphic;
      this.cityGraphic = cityGraphic;
      this.buildingArtPool = new DisplayRunPool(buildingArtLayer, depthLayer);
      this.residentsGraphic = residentsGraphic;
      this.residentArtPool = new DisplayRunPool(residentArtLayer, depthLayer);
      this.constructionGraphic = constructionGraphic;
      this.loopArtPool = new DisplayRunPool(loopArtLayer, depthLayer);
      this.departmentFocusGraphic = departmentFocusGraphic;
      this.borderGraphic = borderGraphic;
      this.overlayGraphic = overlayGraphic;
      if (this.cityRenderState) {
        this.cityDirty = true;
      }
      this.drawMapBorderPixi();
      this.loadArt();
    } catch {
      this.mountFallbackCanvas();
    }

    this.attachEvents();
    this.lastFrameTs = performance.now();
    this.stepFrame(this.lastFrameTs);
    this.rafId = requestAnimationFrame(this.onAnimationFrame);
  }

  /* Reads the pack's art index once; every texture that finishes loading redraws the city. */
  private loadArt(): void {
    if (!this.pack.art) return;
    void WorldArtLibrary.load(this.pack).then(library => {
      if (this.destroyed) {
        library.destroy();
        return;
      }
      this.artLibrary.destroy();
      this.artLibrary = library;
      library.onChange(() => {
        this.cityDirty = true;
        this.dirtyScene = true;
      });
      this.cityDirty = true;
      this.dirtyScene = true;
    });
  }

  /* Also without pack art: placeholders then go through the pool too, to sort among the plants. */
  private cityArtContext(): CityArtContext | null {
    if (!this.buildingArtPool) return null;
    return {
      library: this.artLibrary,
      pool: this.buildingArtPool,
      upgradingHouseIds: this.residentSim?.scaffoldingHouseIds,
      variants: this.buildingVariants,
      paintedRoads: this.roadPainter.ready,
      swaying: this.swayingLayers,
    };
  }

  private residentArtContext(): ResidentArtContext | null {
    if (!this.residentArtPool) return null;
    return { library: this.artLibrary, pool: this.residentArtPool };
  }

  private loopArtContext(): LoopArtContext | null {
    if (!this.loopArtPool) return null;
    return { library: this.artLibrary, pool: this.loopArtPool, variants: this.buildingVariants };
  }

  /* How much of the city is drawn from artist files instead of placeholders. */
  getArtStats(): WorldArtStats {
    return { ...this.artLibrary.stats };
  }

  private mountFallbackCanvas(): void {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(this.viewport.width * this.dpr);
    canvas.height = Math.round(this.viewport.height * this.dpr);
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';
    this.host.appendChild(canvas);
    this.fallbackCanvas = canvas;
    this.fallbackCtx = canvas.getContext('2d');
    this.canvasElement = canvas;
    this.rendererKind = 'canvas2d';
    this.useArt(terrainArtFor(this.pack));
    if (this.terrainMap && this.pack.liquidLayer) {
      this.liquidCanvas = buildLiquidSurfaceCanvas(this.pack.liquidLayer, 256);
    }
  }

  /* Painted water in layers, as its art set describes: the base colour shaded by the bed's relief, and two drifting
     ripple layers (the second finer) that lighten the crests and darken the troughs. The textures are seen from above;
     a squashed, turned tiling maps them onto the 2:1 ground the same way the ground textures are. */
  private mountPaintedLiquid(layer: Container, liquid: Readonly<{ bed: ArtPixels; ripples: ArtPixels; baseColor: string }>): void {
    const base = parseHexColor(liquid.baseColor);
    const br = ((base >> 16) & 255) / 255;
    const bg = ((base >> 8) & 255) / 255;
    const bb = (base & 255) / 255;
    const bedCanvas = document.createElement('canvas');
    bedCanvas.width = liquid.bed.width;
    bedCanvas.height = liquid.bed.height;
    const bctx = bedCanvas.getContext('2d');
    const ripCanvas = document.createElement('canvas');
    ripCanvas.width = liquid.ripples.width;
    ripCanvas.height = liquid.ripples.height;
    const rctx = ripCanvas.getContext('2d');
    if (!bctx || !rctx) return;
    const bed = bctx.createImageData(bedCanvas.width, bedCanvas.height);
    const src = liquid.bed.data;
    /* The bed's sand bars are painted with crisp edges; at full strength one of them reads as a seam along the river. */
    const kBed = 0.5;
    for (let i = 0; i < src.length; i += 4) {
      bed.data[i] = Math.max(0, Math.min(255, (br + (src[i]! / 255 - 0.54) * 0.45 * kBed) * 255));
      bed.data[i + 1] = Math.max(0, Math.min(255, (bg + (src[i + 1]! / 255 - 0.54) * 0.55 * kBed) * 255));
      bed.data[i + 2] = Math.max(0, Math.min(255, (bb + (src[i + 2]! / 255 - 0.54) * 0.4 * kBed) * 255));
      bed.data[i + 3] = 255;
    }
    bctx.putImageData(bed, 0, 0);
    /* Only the crests of the ripple map turn into short white glints; the troughs darken a little. */
    const rip = rctx.createImageData(ripCanvas.width, ripCanvas.height);
    const rs = liquid.ripples.data;
    const step = (lo: number, hi: number, x: number): number => {
      const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
      return t * t * (3 - 2 * t);
    };
    for (let i = 0; i < rs.length; i += 4) {
      const delta = rs[i]! / 255 - 0.5;
      if (delta >= 0) {
        rip.data[i] = 255;
        rip.data[i + 1] = 255;
        rip.data[i + 2] = 255;
        rip.data[i + 3] = 255 * (0.25 * step(0, 0.1, delta) + 0.75 * step(0.08, 0.28, delta));
      } else {
        rip.data[i] = br * 0.35 * 255;
        rip.data[i + 1] = bg * 0.45 * 255;
        rip.data[i + 2] = bb * 0.55 * 255;
        rip.data[i + 3] = 255 * 0.45 * step(0.02, 0.16, -delta);
      }
    }
    rctx.putImageData(rip, 0, 0);

    /* The ripples are painted as waves running across the picture; laid flat on the 2:1 ground without turning them,
       they read as short horizontal strokes, as on the reference. One ripple picture spans three tiles' width. */
    const iso = new Container();
    iso.scale.set(1, 0.5);
    const tilePx = (this.tileW * 3) / Math.max(1, liquid.ripples.width);
    const make = (canvas: HTMLCanvasElement, scale: number, alpha: number): TilingSprite => {
      const tex = Texture.from(canvas);
      tex.source.style.addressMode = 'repeat';
      this.liquidArtTextures.push(tex);
      const sprite = new TilingSprite({ texture: tex, width: this.bounds.width, height: this.bounds.height * 2 });
      sprite.x = this.bounds.minX;
      sprite.y = this.bounds.minY * 2;
      sprite.tileScale.set(tilePx * scale, tilePx * scale);
      sprite.tilePosition.set(-this.bounds.minX, -this.bounds.minY * 2);
      sprite.alpha = alpha;
      iso.addChild(sprite);
      return sprite;
    };
    make(bedCanvas, 1, 1);
    this.liquidSpriteA = make(ripCanvas, 1, 0.65);
    this.liquidSpriteB = make(ripCanvas, 1 / 1.37, 0.45);
    this.liquidOrigin = { x: -this.bounds.minX, y: -this.bounds.minY * 2 };
    this.liquidWrap = Infinity;

    const n = this.pack.mapSize;
    const mTop = tileTopVertexToWorld(0, 0, this.tileW, this.tileH);
    const mRight = tileTopVertexToWorld(n, 0, this.tileW, this.tileH);
    const mBottom = tileTopVertexToWorld(n, n, this.tileW, this.tileH);
    const mLeft = tileTopVertexToWorld(0, n, this.tileW, this.tileH);
    const mask = new Graphics();
    mask.moveTo(mTop.x, mTop.y).lineTo(mRight.x, mRight.y).lineTo(mBottom.x, mBottom.y).lineTo(mLeft.x, mLeft.y).closePath().fill({ color: 0xffffff });
    layer.addChild(iso);
    layer.addChild(mask);
    layer.mask = mask;
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
      .stroke({ color: stroke.color, alpha: stroke.alpha, width: 2 / Math.max(this.camera.zoom, 0.25) });
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
    const nextDpr = Math.min(Math.max(1, window.devicePixelRatio || 1), 2);
    if (next.width === this.viewport.width && next.height === this.viewport.height && nextDpr === this.dpr) return;
    this.viewport = next;
    this.dpr = nextDpr;
    this.zoomBounds = computeEffectiveZoomBounds(this.pack, this.dpr);
    this.camera = {
      ...this.camera,
      zoom: clamp(this.camera.zoom, this.zoomBounds.minZoom, this.zoomBounds.maxZoom),
    };
    if (this.app) {
      this.app.renderer.resize(next.width, next.height);
    } else if (this.fallbackCanvas) {
      this.fallbackCanvas.width = Math.round(next.width * this.dpr);
      this.fallbackCanvas.height = Math.round(next.height * this.dpr);
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
      this.onHover?.(nextHover);
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
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    this.camera = zoomCameraAt(
      this.camera,
      factor,
      pt,
      this.viewport,
      this.zoomBounds.minZoom,
      this.zoomBounds.maxZoom,
      this.bounds,
    );
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

  setZoom(zoom: number): void {
    const clamped = clamp(zoom, this.zoomBounds.minZoom, this.zoomBounds.maxZoom);
    if (Math.abs(clamped - this.camera.zoom) < 1e-9) return;
    this.camera = { ...this.camera, zoom: clamped };
    this.dirtyScene = true;
    this.emitStats(true);
  }

  zoomBy(factor: number): void {
    const center = { x: this.viewport.width / 2, y: this.viewport.height / 2 };
    this.camera = zoomCameraAt(
      this.camera,
      factor,
      center,
      this.viewport,
      this.zoomBounds.minZoom,
      this.zoomBounds.maxZoom,
      this.bounds,
    );
    this.dirtyScene = true;
    this.emitStats(true);
  }

  zoomIn(): void {
    this.zoomBy(ZOOM_STEP_FACTOR);
  }

  zoomOut(): void {
    this.zoomBy(1 / ZOOM_STEP_FACTOR);
  }

  fitToCity(): void {
    const city = this.cityRenderState?.city;
    if (!city || city.buildings.length === 0) {
      this.centerOnTile(this.terrainMap?.startCenter ?? { col: Math.floor(this.pack.mapSize / 2), row: Math.floor(this.pack.mapSize / 2) }, 1.0);
      return;
    }
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const b of city.buildings) {
      const top = tileTopVertexToWorld(b.col, b.row, this.tileW, this.tileH);
      const bottom = tileTopVertexToWorld(b.col + b.spanCol, b.row + b.spanRow, this.tileW, this.tileH);
      const left = tileTopVertexToWorld(b.col, b.row + b.spanRow, this.tileW, this.tileH);
      const right = tileTopVertexToWorld(b.col + b.spanCol, b.row, this.tileW, this.tileH);
      minX = Math.min(minX, left.x);
      maxX = Math.max(maxX, right.x);
      minY = Math.min(minY, top.y - 60);
      maxY = Math.max(maxY, bottom.y + 30);
    }
    const spanW = Math.max(240, maxX - minX + 180);
    const spanH = Math.max(180, maxY - minY + 180);
    const fitZoom = Math.min(this.viewport.width / spanW, this.viewport.height / spanH);
    this.setCamera({
      x: (minX + maxX) * 0.5,
      y: (minY + maxY) * 0.5,
      zoom: clamp(fitZoom, this.zoomBounds.minZoom, this.zoomBounds.maxZoom),
    });
  }

  centerOnBuilding(buildingId: string, zoom?: number): boolean {
    const b = this.cityRenderState?.city.buildings.find(item => item.id === buildingId);
    if (!b) return false;
    this.centerOnTile(
      { col: b.col + (b.spanCol - 1) * 0.5, row: b.row + (b.spanRow - 1) * 0.5 },
      zoom ?? this.camera.zoom,
    );
    return true;
  }

  setDepartmentFocus(focus: DepartmentFocusSpec | null): void {
    this.departmentFocus = focus;
    if (!focus && this.departmentFocusGraphic) {
      this.departmentFocusGraphic.clear();
    }
    this.dirtyScene = true;
  }

  getDepartmentFocus(): DepartmentFocusSpec | null {
    return this.departmentFocus;
  }

  resetZoom(): void {
    this.setZoom(this.zoomBounds.defaultZoom);
  }

  setCamera(camera: CameraState): void {
    this.camera = {
      x: clamp(camera.x, this.bounds.minX, this.bounds.maxX),
      y: clamp(camera.y, this.bounds.minY, this.bounds.maxY),
      zoom: clamp(camera.zoom, this.zoomBounds.minZoom, this.zoomBounds.maxZoom),
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

  /* Updates the Stage 4 isometric city placeholder layer and its pickable building footprints. */
  setCityRenderState(state: CityRenderState | null): void {
    this.cityRenderState = state;
    this.buildingVariants = cityBuildingVariants(state, this.pack);
    this.refreshCityGround();
    this.cityDirty = true;
    this.cityCullWindow = null;
    this.objects = state ? cityToPickableObjects(state.city) : [];
    if (state?.relocationPreview !== undefined) {
      this.relocationPreview = state.relocationPreview;
    }
    this.dirtyScene = true;
  }

  setRelocationPreview(preview: RelocationTargetPreview | null): void {
    this.relocationPreview = preview;
    this.dirtyScene = true;
  }

  /* Attaches or clears the Stage 5 resident simulation rendered atop the city layer. */
  setResidentSimulation(sim: ResidentSimulation | null): void {
    this.residentSim = sim;
    if (!sim) {
      this.selectedResidentId = null;
      this.residentsGraphic?.clear();
      this.residentArtPool?.clear();
    }
    this.dirtyScene = true;
  }

  /* Attaches or clears the Stage 6 construction, animation loops and demolition/relocation simulation. */
  setConstructionSimulation(sim: ConstructionSimulation | null): void {
    this.constructionSim = sim;
    this.lastConstructionCityVersion = sim ? sim.dirtyCityVersion : -1;
    if (!sim) {
      this.constructionGraphic?.clear();
      this.loopArtPool?.clear();
    }
    this.cityDirty = true;
    this.dirtyScene = true;
  }

  markCityDirty(): void {
    this.refreshCityGround();
    this.cityDirty = true;
    this.dirtyScene = true;
  }

  /* The ground the city stands on: its lots are cleared in the baked ground and plants leave them, its streets and walls
     too. Recomputed only when that ground changes. */
  private refreshCityGround(): void {
    const key = cityGroundKey(this.cityRenderState);
    if (key === this.cityGroundKey) return;
    this.cityGroundKey = key;
    const ground = cityGround(this.cityRenderState, this.pack);
    this.lotClearing = ground.clearing;
    this.chunkLotKeys.reset(ground.clearing);
    this.dirtyScene = true;
    this.coverPlants(ground.cover);
  }

  /* Plants leave the tiles the city covers. */
  private coverPlants(cover: ((col: number, row: number) => boolean) | null): void {
    this.plantRenderer?.setCityCover(cover);
  }

  setSelectedResidentId(residentId: string | null): void {
    this.selectedResidentId = residentId;
    if (residentId !== null) {
      this.selectedPick = null;
    }
    this.dirtyScene = true;
  }

  setResidentPickingEnabled(enabled: boolean): void {
    this.residentPickingEnabled = enabled;
  }

  centerOnResident(residentId: string, zoom?: number): boolean {
    const r = this.residentSim?.residents.find(item => item.id === residentId || item.agentId === residentId);
    if (!r) return false;
    const pt = tileCenterToWorld(r.col, r.row, this.tileW, this.tileH);
    this.setCamera({
      x: pt.x,
      y: pt.y - 18,
      zoom: zoom ?? this.camera.zoom,
    });
    return true;
  }

  getResidentScreenPoint(residentId: string): { x: number; y: number } | null {
    const r = this.residentSim?.residents.find(item => item.id === residentId || item.agentId === residentId);
    if (!r) return null;
    const world = tileCenterToWorld(r.col, r.row, this.tileW, this.tileH);
    return worldToScreen(world.x, world.y - 24, this.camera, this.viewport);
  }

  centerOnTile(tile: TileCoord, zoom?: number): void {
    const pt = tileCenterToWorld(tile.col, tile.row, this.tileW, this.tileH);
    this.setCamera({
      x: pt.x,
      y: pt.y,
      zoom: zoom ?? this.camera.zoom,
    });
  }

  getRendererDebugInfo(): RendererDebugInfo {
    let glRenderer: string | null = null;
    let glVendor: string | null = null;
    if (this.canvasElement && this.rendererKind === 'webgl') {
      try {
        const gl = (this.canvasElement.getContext('webgl2') ??
          this.canvasElement.getContext('webgl')) as WebGLRenderingContext | null;
        if (gl) {
          const dbg = gl.getExtension('WEBGL_debug_renderer_info');
          glRenderer = dbg
            ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
            : String(gl.getParameter(gl.RENDERER));
          glVendor = dbg
            ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL))
            : String(gl.getParameter(gl.VENDOR));
        }
      } catch {
        /* Ignore context inspection errors in restricted environments. */
      }
    }
    return { rendererKind: this.rendererKind, glRenderer, glVendor };
  }

  /* Fixes the clock (seconds) of the wind and the water so shots and video repeat exactly; null goes back to real time. */
  setWindClock(seconds: number | null): void {
    this.windClockSec = seconds;
    this.dirtyScene = true;
  }

  private windTime(): number {
    return this.windClockSec ?? performance.now() / 1000;
  }

  setBuildGridVisible(visible: boolean): void {
    if (this.buildGridVisible === visible) return;
    this.buildGridVisible = visible;
    this.dirtyScene = true;
    this.emitStats(true);
  }

  pickScreenPoint(sx: number, sy: number): PickResult | null {
    if (this.residentSim && this.residentPickingEnabled) {
      const hit = pickResidentAtScreen(
        this.residentSim,
        sx,
        sy,
        this.camera,
        this.viewport,
        this.tileW,
        this.tileH,
      );
      if (hit) {
        this.selectedResidentId = hit.id;
        this.selectedPick = null;
        this.dirtyScene = true;
        this.onSelectResident?.(hit);
        this.onSelect?.(null);
        this.emitStats(true);
        return null;
      }
    }

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
    this.selectedResidentId = null;
    this.selectedPick = pick;
    this.dirtyScene = true;
    this.onSelectResident?.(null);
    this.onSelect?.(pick);
    this.emitStats(true);
    return pick;
  }

  /* Synchronously finishes baking all currently visible chunks (for deterministic screenshot capture). */
  flushVisibleBakes(): void {
    const lod = lodForCamera(this.pack, this.camera.zoom, this.dpr);
    const rect = visibleWorldRect(this.camera, this.viewport, this.tileW);
    const visible = cullVisibleChunks(this.chunkGrid, rect);
    for (const chunk of visible) {
      this.ensureChunkBaked(chunk, lod);
    }
    this.dirtyScene = true;
    this.syncScene(Infinity);
    if (this.app && this.residentsGraphic && this.residentSim) {
      renderResidentsToPixi(
        this.residentsGraphic,
        this.residentSim,
        this.cityRenderState?.city ?? null,
        this.pack,
        rect,
        this.tileW,
        this.tileH,
        animationDetailForZoom(this.camera.zoom),
        this.selectedResidentId,
        this.drawnResidentIds,
        this.residentArtContext(),
      );
    }
    this.redrawDepartmentFocusPixi();
    if (this.app && this.constructionGraphic && this.constructionSim) {
      renderConstructionLoopsToPixi(
        this.constructionGraphic,
        this.constructionSim,
        this.cityRenderState?.city ?? null,
        this.pack,
        rect,
        this.tileW,
        this.tileH,
        animationDetailForZoom(this.camera.zoom),
        this.loopArtContext(),
      );
    }
    this.app?.render();
    this.emitStats(true);
  }

  getStats(): WorldEngineStats {
    const lod = lodForCamera(this.pack, this.camera.zoom, this.dpr);
    return {
      fps: Math.round(this.lastFps),
      frameTimeMs: Math.round(this.lastFrameMs * 10) / 10,
      cpuStepMs: Math.round(this.lastCpuStepMs * 100) / 100,
      zoom: Math.round(this.camera.zoom * 1000) / 1000,
      zoomPercent: zoomPercent(this.camera.zoom),
      minZoom: this.zoomBounds.minZoom,
      maxZoom: this.zoomBounds.maxZoom,
      cappedBySource: this.zoomBounds.cappedBySource,
      cssTileW: Math.round(this.tileW * this.camera.zoom),
      cssTileH: Math.round(this.tileH * this.camera.zoom),
      lodId: lod.id,
      lodTileW: lod.tileW,
      lodTileH: lod.tileH,
      dpr: this.dpr,
      animationDetail: animationDetailForZoom(this.camera.zoom),
      visibleChunks: this.visibleChunkList.length,
      totalChunks: this.chunkGrid.chunks.length,
      cachedChunks: this.chunkCache.size,
      pendingBakes: this.pendingBakeCount,
      mapSize: this.pack.mapSize,
      chunkSize: this.pack.params.chunkSize,
      rendererKind: this.rendererKind,
      buildGridVisible: this.buildGridVisible,
      hasAnimatedLiquid: Boolean(this.terrainMap && this.pack.liquidLayer),
      plants: this.plantRenderer?.stats ?? null,
      hoveredTile: this.hoveredTile,
      selectedPick: this.selectedPick,
      camera: this.camera,
    };
  }

  private cacheKey(chunk: ChunkCoord, lodId: LodTierId): string {
    return `${chunk.key}@${lodId}${this.chunkLotKeys.keyOf(chunk)}`;
  }

  private disposeEntry = (entry: CachedChunkEntry): void => {
    this.lastVisibleChunkSig = '';
    if (entry.sprite) {
      entry.sprite.removeFromParent();
      entry.sprite.destroy();
    }
    if (entry.texture) {
      entry.texture.destroy(true);
    }
  };

  private ensureChunkBaked(chunk: ChunkCoord, lod: LodTierSpec): CachedChunkEntry {
    const key = this.cacheKey(chunk, lod.id);
    const existing = this.chunkCache.get(key);
    if (existing) return existing;

    this.bakeJobs.delete(key);
    const baked =
      this.terrainMap && this.hasSmoothGround()
        ? bakeSmoothChunkCanvas(chunk, this.terrainMap, this.pack, lod, this.art, this.lotClearing)
        : bakeChunkCanvas(chunk, this.pack, this.tileLookup, lod, this.resolveTileId);
    return this.cacheBakedChunk(key, baked);
  }

  /* The first mount that gets this far fixes the art; a fallback after a failed GPU start keeps the same art. */
  private useArt(art: LoadedTerrainArt | null): void {
    if (this.artPinned) return;
    this.artPinned = true;
    this.art = art;
    this.plantRenderer?.useArt(art);
  }

  private hasSmoothGround(): boolean {
    return Boolean(this.pack.materials && this.pack.materials.length > 0);
  }

  /* Bakes part of a chunk within the frame's deadline; the chunk's entry once its last row is baked, else null. Tile
     ground bakes whole, as it is cheap. */
  private advanceChunkBake(chunk: ChunkCoord, lod: LodTierSpec, deadline: number): CachedChunkEntry | null {
    const key = this.cacheKey(chunk, lod.id);
    const existing = this.chunkCache.get(key);
    if (existing) return existing;
    if (!this.terrainMap || !this.hasSmoothGround()) return this.ensureChunkBaked(chunk, lod);
    let job = this.bakeJobs.get(key);
    if (!job) {
      job = startSmoothChunkBake(chunk, this.terrainMap, this.pack, lod, this.art, this.lotClearing);
      this.bakeJobs.set(key, job);
    }
    if (!job.advance(deadline, () => performance.now())) return null;
    this.bakeJobs.delete(key);
    return this.cacheBakedChunk(key, smoothPixelsToCanvas(job.pixels, lod.id));
  }

  private cacheBakedChunk(key: string, baked: BakedChunk): CachedChunkEntry {
    let texture: Texture | null = null;
    let sprite: Sprite | null = null;
    if (this.app) {
      texture = Texture.from(baked.canvas);
      sprite = new Sprite(texture);
      sprite.x = baked.worldX;
      sprite.y = baked.worldY;
      sprite.scale.set(1 / baked.scale);
      sprite.visible = false;
      this.chunkLayer?.addChild(sprite);
    }
    const entry: CachedChunkEntry = { key, baked, texture, sprite };
    this.chunkCache.set(key, entry);
    this.chunkLotKeys.baked(key);
    return entry;
  }

  private readonly onAnimationFrame = (ts: number): void => {
    if (this.destroyed) return;
    this.stepFrame(ts);
    this.rafId = requestAnimationFrame(this.onAnimationFrame);
  };

  private stepFrame(ts: number): void {
    const stepStart = performance.now();
    const dtMs = Math.max(1, Math.min(100, ts - this.lastFrameTs || 16.67));
    this.lastFrameTs = ts;
    this.lastFrameMs = dtMs;
    this.fpsSamples.push(1000 / dtMs);
    if (this.fpsSamples.length > 30) this.fpsSamples.shift();
    this.lastFps = this.fpsSamples.reduce((acc, v) => acc + v, 0) / this.fpsSamples.length;

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

    /* Smoothly animate the dedicated liquid layer independently from baked ground chunks. */
    let liquidAnimated = false;
    if (this.terrainMap && this.pack.liquidLayer) {
      liquidAnimated = true;
      const dtSec = dtMs / 1000;
      const animDetail = animationDetailForZoom(this.camera.zoom);
      const speedScale = animDetail === 'reduced' ? 0.55 : 1.0;
      if (this.windClockSec !== null) {
        /* A fixed clock moves the water by the clock, not by how long the frames took. */
        this.liquidPhaseX = (this.pack.liquidLayer.speedX * this.windClockSec * speedScale) % this.liquidWrap;
        this.liquidPhaseY = (this.pack.liquidLayer.speedY * this.windClockSec * speedScale) % this.liquidWrap;
      } else {
        this.liquidPhaseX = (this.liquidPhaseX + this.pack.liquidLayer.speedX * dtSec * speedScale) % this.liquidWrap;
        this.liquidPhaseY = (this.liquidPhaseY + this.pack.liquidLayer.speedY * dtSec * speedScale) % this.liquidWrap;
      }
      const o = this.liquidOrigin;
      if (this.liquidSpriteA) {
        this.liquidSpriteA.tilePosition.set(o.x + this.liquidPhaseX, o.y + this.liquidPhaseY);
      }
      if (this.liquidSpriteB) {
        this.liquidSpriteB.visible = animDetail !== 'reduced';
        this.liquidSpriteB.tilePosition.set(o.x - this.liquidPhaseX * 0.65, o.y + this.liquidPhaseY * 0.85);
      }
      if (!this.app) {
        this.dirtyScene = true;
      }
    }

    /* Advance Stage 5 live resident simulation at smooth real-time cadence. */
    let residentsAnimated = false;
    if (this.residentSim) {
      /* Residents drawn from a walking sheet walk its stride per cycle; without art the speed stays their own. */
      this.residentSim.walkSpeedOf = r => residentWalkSpeed(this.pack, this.artLibrary.index, r);
      this.residentSim.standsStillOf = r => residentStandsStill(this.pack, this.artLibrary.index, r);
      /* The harbour shows, and its carriers walk from the yard, once its art is in (#2006). */
      const harbour = this.residentSim.harbour;
      if (harbour) harbour.shown = harbourArtReady(this.pack, this.artLibrary.index, harbour.plan, boatCargoMaxOf(this.pack));
      stepResidentSimulation(this.residentSim, dtMs / 1000);
      residentsAnimated = true;
      if (this.pack.art) {
        /* A house that starts or stops growing in place swaps to or from its annex picture. */
        const sig = [...this.residentSim.scaffoldingHouseIds].join('|');
        if (sig !== this.lastScaffoldSig) {
          this.lastScaffoldSig = sig;
          this.cityDirty = true;
          this.dirtyScene = true;
        }
      }
      if (!this.app) {
        this.dirtyScene = true;
      }
    }

    /* Advance Stage 6 building loops, construction stages & demolition/relocation timers. */
    let constructionAnimated = false;
    if (this.constructionSim) {
      const stageChanged = stepConstructionSimulation(this.constructionSim, dtMs / 1000);
      if (stageChanged || this.constructionSim.dirtyCityVersion !== this.lastConstructionCityVersion) {
        this.lastConstructionCityVersion = this.constructionSim.dirtyCityVersion;
        this.cityDirty = true;
        this.dirtyScene = true;
      }
      constructionAnimated = true;
      if (!this.app) {
        this.dirtyScene = true;
      }
    }

    /* Plants sway in the wind, so a map with plants redraws every frame. */
    let plantsAnimated = false;
    if (this.plantRenderer) {
      plantsAnimated = true;
      if (this.app) {
        this.plantRenderer.update(visibleWorldRect(this.camera, this.viewport, this.tileW), this.windTime());
      } else {
        this.dirtyScene = true;
      }
    }

    const needsSync = this.dirtyScene || this.pendingBakeCount > 0;
    if (needsSync) {
      this.syncScene(BAKE_BUDGET_MS);
    }
    /* Awnings and cloth of the buildings in view move with the wind, after the city pass that placed them. */
    const swayAnimated = Boolean(this.app) && this.swayingLayers.length > 0;
    if (swayAnimated) swayCloths(this.swayingLayers, this.windTime());
    if (
      this.app &&
      ((this.residentsGraphic && this.residentSim && (residentsAnimated || needsSync)) ||
        (this.constructionGraphic && this.constructionSim && (constructionAnimated || needsSync)))
    ) {
      const visRect = visibleWorldRect(this.camera, this.viewport, this.tileW);
      const detail = animationDetailForZoom(this.camera.zoom);
      if (this.residentsGraphic && this.residentSim && (residentsAnimated || needsSync)) {
        renderResidentsToPixi(
          this.residentsGraphic,
          this.residentSim,
          this.cityRenderState?.city ?? null,
          this.pack,
          visRect,
          this.tileW,
          this.tileH,
          detail,
          this.selectedResidentId,
          this.drawnResidentIds,
          this.residentArtContext(),
        );
        if (this.departmentFocus) {
          this.redrawDepartmentFocusPixi();
        }
      }
      if (this.constructionGraphic && this.constructionSim && (constructionAnimated || needsSync)) {
        renderConstructionLoopsToPixi(
          this.constructionGraphic,
          this.constructionSim,
          this.cityRenderState?.city ?? null,
          this.pack,
          visRect,
          this.tileW,
          this.tileH,
          detail,
          this.loopArtContext(),
        );
      }
    }
    if (this.app && (needsSync || liquidAnimated || residentsAnimated || constructionAnimated || plantsAnimated || swayAnimated)) {
      this.app.render();
    }
    this.lastCpuStepMs = performance.now() - stepStart;

    if (ts - this.lastStatsPushTs >= 180) {
      this.lastStatsPushTs = ts;
      this.emitStats(false);
    }
  }

  private findAnyCachedLod(chunk: ChunkCoord): { key: string; entry: CachedChunkEntry } | null {
    const lods = this.pack.projection.lods;
    for (let i = lods.length - 1; i >= 0; i--) {
      const k = this.cacheKey(chunk, lods[i]!.id);
      const hit = this.chunkCache.get(k);
      if (hit) return { key: k, entry: hit };
    }
    /* The picture baked before the lots changed, until the new one is done. */
    return this.chunkLotKeys.lastBakedHit(chunk.key, lods.map(l => l.id), k => this.chunkCache.get(k));
  }

  private syncScene(bakeBudgetMs: number): void {
    const lod = lodForCamera(this.pack, this.camera.zoom, this.dpr);
    const visibleRect = visibleWorldRect(this.camera, this.viewport, this.tileW);
    const visible = cullVisibleChunks(this.chunkGrid, visibleRect);
    this.visibleChunkList = visible;

    const protectedKeys = new Set<string>();
    const drawEntries: CachedChunkEntry[] = [];
    const bakeStart = performance.now();
    let pending = 0;

    for (const chunk of visible) {
      const key = this.cacheKey(chunk, lod.id);
      protectedKeys.add(key);
      let entry = this.chunkCache.get(key);
      if (!entry && performance.now() - bakeStart < bakeBudgetMs) {
        entry = this.advanceChunkBake(chunk, lod, bakeStart + bakeBudgetMs) ?? undefined;
      }
      if (!entry) {
        pending++;
        const fallback = this.findAnyCachedLod(chunk);
        if (fallback) {
          protectedKeys.add(fallback.key);
          entry = fallback.entry;
        }
      }
      if (entry) drawEntries.push(entry);
    }

    for (const key of this.bakeJobs.keys()) {
      if (!protectedKeys.has(key)) this.bakeJobs.delete(key);
    }
    this.pendingBakeCount = pending;
    this.dirtyScene = pending > 0;
    this.chunkCache.evictIfNeeded(protectedKeys, this.disposeEntry);

    if (this.app && this.worldContainer && this.chunkLayer) {
      this.worldContainer.position.set(
        this.viewport.width / 2 - this.camera.x * this.camera.zoom,
        this.viewport.height / 2 - this.camera.y * this.camera.zoom,
      );
      this.worldContainer.scale.set(this.camera.zoom);

      const chunkSig = drawEntries.map(e => e.key).join('|');
      if (chunkSig !== this.lastVisibleChunkSig) {
        this.lastVisibleChunkSig = chunkSig;
        const wanted = new Set<Sprite>();
        for (const entry of drawEntries) {
          if (entry.sprite) {
            wanted.add(entry.sprite);
            if (entry.sprite.parent !== this.chunkLayer) {
              this.chunkLayer.addChild(entry.sprite);
            }
            entry.sprite.visible = true;
          }
        }
        for (const child of this.chunkLayer.children) {
          if (!wanted.has(child as Sprite)) {
            child.visible = false;
          }
        }
      }

      if (this.cityGraphic) {
        if (!this.cityRenderState) {
          if (this.cityDirty) {
            this.cityDirty = false;
            this.cityCullWindow = null;
            this.cityGraphic.clear();
            this.buildingArtPool?.clear();
            this.roadPainter.draw(new Map(), null, this.tileW, this.tileH);
          }
        } else {
          const viewCorners = [
            worldToTileFloat(visibleRect.minX, visibleRect.minY, this.tileW, this.tileH),
            worldToTileFloat(visibleRect.maxX, visibleRect.minY, this.tileW, this.tileH),
            worldToTileFloat(visibleRect.maxX, visibleRect.maxY, this.tileW, this.tileH),
            worldToTileFloat(visibleRect.minX, visibleRect.maxY, this.tileW, this.tileH),
          ];
          const vMinC = Math.floor(Math.min(...viewCorners.map(p => p.col))) - 2;
          const vMaxC = Math.ceil(Math.max(...viewCorners.map(p => p.col))) + 2;
          const vMinR = Math.floor(Math.min(...viewCorners.map(p => p.row))) - 2;
          const vMaxR = Math.ceil(Math.max(...viewCorners.map(p => p.row))) + 2;
          const cw = this.cityCullWindow;
          const outsideCached =
            !cw || vMinC < cw.minCol || vMaxC > cw.maxCol || vMinR < cw.minRow || vMaxR > cw.maxRow;
          if (this.cityDirty || outsideCached) {
            this.cityDirty = false;
            const pad = 8;
            const nextWindow: TileWindow = {
              minCol: vMinC - pad,
              maxCol: vMaxC + pad,
              minRow: vMinR - pad,
              maxRow: vMaxR + pad,
            };
            this.cityCullWindow = nextWindow;
            const renderStateWithJobs: CityRenderState = this.constructionSim
              ? { ...this.cityRenderState, constructionJobs: this.constructionSim.jobs }
              : this.cityRenderState;
            renderCityToPixi(
              this.cityGraphic,
              renderStateWithJobs,
              this.pack,
              this.tileW,
              this.tileH,
              nextWindow,
              this.cityArtContext(),
            );
            this.roadPainter.draw(this.cityRenderState.city.roads, nextWindow, this.tileW, this.tileH, this.pack.terrainArt?.texelsPerTile);
          }
        }
      }

      this.redrawDepartmentFocusPixi();

      this.drawBuildGridPixi(visibleRect);
      if (this.lastBorderZoom !== this.camera.zoom) {
        this.lastBorderZoom = this.camera.zoom;
        this.drawMapBorderPixi();
      }
      this.drawOverlayPixi();
    } else {
      this.renderFallback2D(drawEntries);
    }
  }

  private redrawDepartmentFocusPixi(): void {
    if (!this.departmentFocusGraphic) return;
    this.departmentFocusGraphic.clear();
    if (this.departmentFocus && this.cityRenderState) {
      renderDepartmentFocusToPixi(
        this.departmentFocusGraphic,
        this.departmentFocus,
        this.cityRenderState.city,
        this.residentSim?.residents ?? [],
        this.pack.mapSize,
        this.tileW,
        this.tileH,
        this.camera.zoom,
        this.residentSim ? this.drawnResidentIds : undefined,
      );
    }
  }

  private drawBuildGridPixi(visibleRect: { minX: number; maxX: number; minY: number; maxY: number }): void {
    if (!this.buildGridGraphic) return;
    if (!this.terrainMap || !this.buildGridVisible) {
      if (this.lastGridKey !== 'off') {
        this.lastGridKey = 'off';
        this.buildGridGraphic.clear();
      }
      return;
    }

    const corners = [
      worldToTileFloat(visibleRect.minX, visibleRect.minY, this.tileW, this.tileH),
      worldToTileFloat(visibleRect.maxX, visibleRect.minY, this.tileW, this.tileH),
      worldToTileFloat(visibleRect.maxX, visibleRect.maxY, this.tileW, this.tileH),
      worldToTileFloat(visibleRect.minX, visibleRect.maxY, this.tileW, this.tileH),
    ];
    let minC = Infinity;
    let maxC = -Infinity;
    let minR = Infinity;
    let maxR = -Infinity;
    for (const pt of corners) {
      if (pt.col < minC) minC = pt.col;
      if (pt.col > maxC) maxC = pt.col;
      if (pt.row < minR) minR = pt.row;
      if (pt.row > maxR) maxR = pt.row;
    }
    const n = this.pack.mapSize;
    const c0 = Math.max(0, Math.floor(minC) - 1);
    const c1 = Math.min(n, Math.ceil(maxC) + 1);
    const r0 = Math.max(0, Math.floor(minR) - 1);
    const r1 = Math.min(n, Math.ceil(maxR) + 1);
    const gridKey = `${c0}:${c1}:${r0}:${r1}:${Math.round(this.camera.zoom * 1000)}`;
    if (gridKey === this.lastGridKey) return;
    this.lastGridKey = gridKey;

    const g = this.buildGridGraphic;
    g.clear();
    const stroke = parseColorAndAlpha(this.pack.palette.gridLine, 0xffffff, 0.28);
    const w = Math.max(0.8, 1 / this.camera.zoom);

    for (let c = c0; c <= c1; c++) {
      const a = tileTopVertexToWorld(c, r0, this.tileW, this.tileH);
      const b = tileTopVertexToWorld(c, r1, this.tileW, this.tileH);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    for (let r = r0; r <= r1; r++) {
      const a = tileTopVertexToWorld(c0, r, this.tileW, this.tileH);
      const b = tileTopVertexToWorld(c1, r, this.tileW, this.tileH);
      g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    g.stroke({ color: stroke.color, alpha: Math.max(0.24, stroke.alpha), width: w });
  }

  private drawOverlayPixi(): void {
    if (!this.overlayGraphic) return;
    const overlayKey = [
      Math.round(this.camera.zoom * 1000),
      this.markerTile ? `${this.markerTile.col},${this.markerTile.row}` : '-',
      this.hoveredTile ? `${this.hoveredTile.col},${this.hoveredTile.row}` : '-',
      this.selectedPick
        ? `${this.selectedPick.kind}:${this.selectedPick.col},${this.selectedPick.row}:${this.selectedPick.kind === 'object' ? this.selectedPick.object.id : ''}`
        : '-',
      this.relocationPreview
        ? `${this.relocationPreview.col},${this.relocationPreview.row},${this.relocationPreview.spanCol}x${this.relocationPreview.spanRow}:${this.relocationPreview.valid}`
        : '-',
    ].join('|');
    if (overlayKey === this.lastOverlayKey) return;
    this.lastOverlayKey = overlayKey;

    const g = this.overlayGraphic;
    g.clear();
    const strokeW = Math.max(1, 2 / this.camera.zoom);

    if (this.markerTile) {
      const pts = tileDiamondVertices(this.markerTile.col, this.markerTile.row, this.tileW, this.tileH);
      const center = tileCenterToWorld(this.markerTile.col, this.markerTile.row, this.tileW, this.tileH);
      g.moveTo(pts[0].x, pts[0].y)
        .lineTo(pts[1].x, pts[1].y)
        .lineTo(pts[2].x, pts[2].y)
        .lineTo(pts[3].x, pts[3].y)
        .closePath()
        .fill({ color: 0xffd166, alpha: 0.32 })
        .stroke({ color: 0x111720, alpha: 0.9, width: strokeW * 1.4 })
        .stroke({ color: 0xffd166, alpha: 1, width: strokeW * 0.85 });
      g.circle(center.x, center.y, Math.max(4, 7 / this.camera.zoom))
        .fill({ color: 0xffd166, alpha: 0.98 })
        .stroke({ color: 0x111720, alpha: 0.95, width: Math.max(1.5, 2 / this.camera.zoom) });
    }

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

    if (this.relocationPreview) {
      const rp = this.relocationPreview;
      const top = tileTopVertexToWorld(rp.col, rp.row, this.tileW, this.tileH);
      const right = tileTopVertexToWorld(rp.col + rp.spanCol, rp.row, this.tileW, this.tileH);
      const bottom = tileTopVertexToWorld(rp.col + rp.spanCol, rp.row + rp.spanRow, this.tileW, this.tileH);
      const left = tileTopVertexToWorld(rp.col, rp.row + rp.spanRow, this.tileW, this.tileH);
      const fillColor = rp.valid ? 0x4ad680 : 0xe85d5d;
      const strokeColor = rp.valid ? 0x8cf0b2 : 0xff9494;
      g.moveTo(top.x, top.y)
        .lineTo(right.x, right.y)
        .lineTo(bottom.x, bottom.y)
        .lineTo(left.x, left.y)
        .closePath()
        .fill({ color: fillColor, alpha: 0.36 })
        .stroke({ color: strokeColor, alpha: 0.96, width: strokeW * 1.4 });
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

    const n = this.pack.mapSize;
    const top = tileTopVertexToWorld(0, 0, this.tileW, this.tileH);
    const right = tileTopVertexToWorld(n, 0, this.tileW, this.tileH);
    const bottom = tileTopVertexToWorld(n, n, this.tileW, this.tileH);
    const left = tileTopVertexToWorld(0, n, this.tileW, this.tileH);

    /* Dedicated animated liquid layer underneath alpha-cutout smooth ground chunks. */
    if (this.terrainMap && this.liquidCanvas) {
      const pattern = ctx.createPattern(this.liquidCanvas, 'repeat');
      if (pattern) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(top.x, top.y);
        ctx.lineTo(right.x, right.y);
        ctx.lineTo(bottom.x, bottom.y);
        ctx.lineTo(left.x, left.y);
        ctx.closePath();
        ctx.clip();
        ctx.translate(this.liquidPhaseX, this.liquidPhaseY);
        ctx.fillStyle = pattern;
        ctx.fillRect(this.bounds.minX - 256, this.bounds.minY - 256, this.bounds.width + 512, this.bounds.height + 512);
        ctx.restore();
      }
    }

    for (const entry of entries) {
      const b = entry.baked;
      ctx.drawImage(b.canvas, b.worldX, b.worldY, b.pixelWidth / b.scale, b.pixelHeight / b.scale);
    }

    this.plantRenderer?.drawFallback2D(ctx, visibleWorldRect(this.camera, this.viewport, this.tileW), this.windTime());

    if (this.terrainMap && this.buildGridVisible) {
      const rect = visibleWorldRect(this.camera, this.viewport, this.tileW);
      const corners = [
        worldToTileFloat(rect.minX, rect.minY, this.tileW, this.tileH),
        worldToTileFloat(rect.maxX, rect.minY, this.tileW, this.tileH),
        worldToTileFloat(rect.maxX, rect.maxY, this.tileW, this.tileH),
        worldToTileFloat(rect.minX, rect.maxY, this.tileW, this.tileH),
      ];
      const c0 = Math.max(0, Math.floor(Math.min(...corners.map(p => p.col))) - 1);
      const c1 = Math.min(n, Math.ceil(Math.max(...corners.map(p => p.col))) + 1);
      const r0 = Math.max(0, Math.floor(Math.min(...corners.map(p => p.row))) - 1);
      const r1 = Math.min(n, Math.ceil(Math.max(...corners.map(p => p.row))) + 1);
      ctx.beginPath();
      for (let c = c0; c <= c1; c++) {
        const a = tileTopVertexToWorld(c, r0, this.tileW, this.tileH);
        const b = tileTopVertexToWorld(c, r1, this.tileW, this.tileH);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      for (let r = r0; r <= r1; r++) {
        const a = tileTopVertexToWorld(c0, r, this.tileW, this.tileH);
        const b = tileTopVertexToWorld(c1, r, this.tileW, this.tileH);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
      }
      ctx.strokeStyle = this.pack.palette.gridLine;
      ctx.lineWidth = Math.max(0.8, 1 / this.camera.zoom);
      ctx.stroke();
    }

    if (this.cityRenderState) {
      renderCityFallback2D(ctx, this.cityRenderState, this.pack, this.tileW, this.tileH);
    }
    if (this.residentSim) {
      const rect = visibleWorldRect(this.camera, this.viewport, this.tileW);
      renderResidentsFallback2D(
        ctx,
        this.residentSim,
        this.cityRenderState?.city ?? null,
        this.pack,
        rect,
        this.tileW,
        this.tileH,
        this.selectedResidentId,
      );
    }
    if (this.constructionSim) {
      const rect = visibleWorldRect(this.camera, this.viewport, this.tileW);
      renderConstructionLoopsFallback2D(
        ctx,
        this.constructionSim,
        this.cityRenderState?.city ?? null,
        this.pack,
        rect,
        this.tileW,
        this.tileH,
      );
    }
    if (this.departmentFocus && this.cityRenderState) {
      renderDepartmentFocusFallback2D(
        ctx,
        this.departmentFocus,
        this.cityRenderState.city,
        this.residentSim?.residents ?? [],
        this.pack.mapSize,
        this.tileW,
        this.tileH,
        this.camera.zoom,
      );
    }

    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(right.x, right.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.lineTo(left.x, left.y);
    ctx.closePath();
    ctx.strokeStyle = this.pack.palette.border;
    ctx.lineWidth = 2 / Math.max(this.camera.zoom, 0.25);
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

    if (this.markerTile) {
      drawHighlight(
        this.markerTile.col,
        this.markerTile.row,
        1,
        1,
        'rgba(255, 209, 102, 0.34)',
        '#FFD166',
      );
      const center = tileCenterToWorld(this.markerTile.col, this.markerTile.row, this.tileW, this.tileH);
      ctx.beginPath();
      ctx.arc(center.x, center.y, Math.max(4, 7 / this.camera.zoom), 0, Math.PI * 2);
      ctx.fillStyle = '#FFD166';
      ctx.fill();
      ctx.strokeStyle = '#111720';
      ctx.lineWidth = Math.max(1.5, 2 / this.camera.zoom);
      ctx.stroke();
    }

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

    this.chunkCache.clear(this.disposeEntry);
    this.bakeJobs.clear();
    this.buildingArtPool?.destroy();
    this.residentArtPool?.destroy();
    this.loopArtPool?.destroy();
    this.buildingArtPool = null;
    this.residentArtPool = null;
    this.loopArtPool = null;
    this.artLibrary.destroy();
    for (const t of this.liquidArtTextures) if (!t.destroyed) t.destroy(true);
    this.liquidArtTextures = [];
    if (this.liquidTexture) {
      this.liquidTexture.destroy(true);
      this.liquidTexture = null;
    }
    this.liquidSpriteA = null;
    this.liquidSpriteB = null;
    this.liquidCanvas = null;
    this.buildGridGraphic = null;
    this.cityGraphic = null;
    this.residentsGraphic = null;
    this.constructionGraphic = null;
    this.residentSim = null;
    this.constructionSim = null;

    if (this.app) {
      this.app.destroy(APP_ENDS_ALONE, { children: true, texture: true });
      this.app = null;
    }
    this.plantRenderer?.destroy();
    this.roadPainter.destroy();
    this.plantRenderer = null;
    if (this.fallbackCanvas) {
      this.fallbackCanvas.remove();
      this.fallbackCanvas = null;
      this.fallbackCtx = null;
    }
    this.canvasElement = null;
  }
}
