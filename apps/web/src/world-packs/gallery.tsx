import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { tileCenterToWorld, worldToScreen, type TileCoord } from '../world/coords';
import type { WorldPackManifest } from '../world/manifest';
import { IsometricWorldEngine, type WorldEngineStats } from '../world/renderer';
import {
  GALLERY_SEEDS,
  generateWorldTerrain,
  type GeneratedWorldMap,
} from '../world/terrain-engine';
import { renderProceduralMapPreview } from '../world/terrain-preview';
import { DUNGEON_WORLD_PACK } from './dungeon/pack';
import { EGYPT_WORLD_PACK } from './egypt/pack';

/* Multi-pack Stage 2 gallery viewer and smooth-blended isometric inspector.
   Lives outside engine core (src/world-packs/) and mounts any WorldPackManifest with a terrainRecipe. */

type Lang = 'ru' | 'en';

const AVAILABLE_PACKS: readonly WorldPackManifest[] = [
  EGYPT_WORLD_PACK,
  DUNGEON_WORLD_PACK,
];

const COPY: Record<
  Lang,
  {
    titlePrefix: string;
    subtitle: string;
    packLabel: string;
    backToGallery: string;
    clickToInspect: string;
    buildable: string;
    continuity: string;
    center: string;
    hovered: string;
    clickedPrompt: string;
    buildableYes: string;
    buildableNo: string;
    buildGrid: string;
    on: string;
    off: string;
    focusShore: string;
    focusCenter: string;
    startCenterLegend: string;
  }
> = {
  ru: {
    titlePrefix: 'Этап 2: Галерея карт из пакета мира (12 зерен, 150 x 150)',
    subtitle: 'Рецепт местности, виды клеток и текстуры принадлежат пакету мира. Нажмите на карту для плавного изометрического вида.',
    packLabel: 'Пакет мира',
    backToGallery: '<- К галерее 12 карт',
    clickToInspect: 'Открыть в плавной изометрии',
    buildable: 'Доступно',
    continuity: 'Поток',
    center: 'Центр',
    hovered: 'Под курсором',
    clickedPrompt: 'Нажмите на любую точку, чтобы увидеть клетку и тип земли',
    buildableYes: 'можно строить',
    buildableNo: 'нельзя строить',
    buildGrid: 'Сетка постройки',
    on: 'Вкл',
    off: 'Выкл',
    focusShore: 'К берегу',
    focusCenter: 'К центру',
    startCenterLegend: 'Стартовый центр',
  },
  en: {
    titlePrefix: 'Stage 2: Pack-Owned Map Gallery (12 seeds, 150 x 150)',
    subtitle: 'Terrain recipe, tile rules and ground textures live inside each world pack. Click any map for smooth isometric rendering.',
    packLabel: 'World pack',
    backToGallery: '<- Back to 12-map gallery',
    clickToInspect: 'Open smooth isometric view',
    buildable: 'Usable',
    continuity: 'Flow',
    center: 'Center',
    hovered: 'Hover',
    clickedPrompt: 'Click anywhere on the terrain to inspect tile coordinates and kind',
    buildableYes: 'buildable',
    buildableNo: 'non-buildable',
    buildGrid: 'Build grid',
    on: 'On',
    off: 'Off',
    focusShore: 'Focus shore',
    focusCenter: 'Focus center',
    startCenterLegend: 'Start center',
  },
};

type GallerySummary = Readonly<{
  packId: string;
  seed: string;
  buildableRatio: number;
  continuityOk: boolean;
  continuityEdges: readonly string[];
  startCenter: TileCoord;
  centerDistanceToLiquid: number;
}>;

type GalleryHandle = {
  setPack: (packId: string) => void;
  openSeed: (seed: string) => void;
  backToGallery: () => void;
  setLang: (lang: Lang) => void;
  setZoom: (zoom: number) => void;
  setBuildGridVisible: (visible: boolean) => void;
  focusTile: (col: number, row: number) => void;
  focusNearestShore: () => TileCoord;
  flushVisibleBakes: () => void;
  getStats: () => WorldEngineStats | null;
  screenPointOfTile: (col: number, row: number) => { x: number; y: number } | null;
  getGallerySummaries: () => readonly GallerySummary[];
};

declare global {
  interface Window {
    __WORLD_GALLERY__?: GalleryHandle;
  }
}

function readInitialQuery(): { lang: Lang; packId: string; seed: string | null } {
  const params = new URLSearchParams(window.location.search);
  const lang: Lang = params.get('lang') === 'en' ? 'en' : 'ru';
  const rawPack = params.get('pack');
  const packId = AVAILABLE_PACKS.some(p => p.id === rawPack) ? rawPack! : EGYPT_WORLD_PACK.id;
  const rawSeed = params.get('seed');
  return { lang, packId, seed: rawSeed && rawSeed.trim() ? rawSeed.trim() : null };
}

/* Finds the closest shoreline point right on the smooth water/liquid boundary near startCenter. */
function findNearestShoreTile(map: GeneratedWorldMap): TileCoord {
  const { col: cx, row: cy } = map.startCenter;
  let best: TileCoord = map.startCenter;
  let bestScore = Infinity;
  for (let dy = -42; dy <= 42; dy++) {
    for (let dx = -42; dx <= 42; dx++) {
      const c = cx + dx;
      const r = cy + dy;
      const spec = map.kindSpecAt(c, r);
      if (!spec || spec.liquid) continue;
      /* Check if 4-adjacent to a liquid tile. */
      const adjLiquid =
        map.kindSpecAt(c + 1, r)?.liquid ||
        map.kindSpecAt(c - 1, r)?.liquid ||
        map.kindSpecAt(c, r + 1)?.liquid ||
        map.kindSpecAt(c, r - 1)?.liquid;
      if (!adjLiquid) continue;
      const d = Math.hypot(dx, dy);
      if (d < bestScore) {
        bestScore = d;
        best = { col: c, row: r };
      }
    }
  }
  return best;
}

function MapCard({
  map,
  pack,
  lang,
  onOpen,
}: {
  map: GeneratedWorldMap;
  pack: WorldPackManifest;
  lang: Lang;
  onOpen: (seed: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const t = COPY[lang];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderProceduralMapPreview(canvas, map, pack, 2);
  }, [map, pack]);

  const pct = (map.stats.buildableRatio * 100).toFixed(1);
  const edges = map.stats.continuityEdges.join('') || 'ok';

  return (
    <button
      type="button"
      data-testid={`gallery-card-${map.seed}`}
      title={t.clickToInspect}
      onClick={() => onOpen(map.seed)}
      style={{
        display: 'grid',
        gap: 6,
        padding: 10,
        background: '#19222E',
        border: '1px solid rgba(130, 184, 224, 0.28)',
        color: '#E7F0F9',
        textAlign: 'left',
        cursor: 'pointer',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <strong style={{ fontSize: 13.5, color: '#9BD9FF' }}>{map.seed}</strong>
        <span style={{ fontSize: 11, color: '#A9BDD3' }}>
          {t.buildable}: {pct}%
        </span>
      </div>
      <canvas
        ref={canvasRef}
        data-testid={`gallery-canvas-${map.seed}`}
        style={{
          display: 'block',
          width: '100%',
          aspectRatio: '1 / 1',
          border: '1px solid rgba(130, 184, 224, 0.25)',
        }}
      />
      <div style={{ fontSize: 11, color: '#B7C8DC', lineHeight: 1.35 }}>
        {t.continuity}: {edges} | {t.center}: ({map.startCenter.col}, {map.startCenter.row})
      </div>
    </button>
  );
}

function IsometricInspector({
  map,
  pack,
  lang,
  onBack,
  engineRef,
}: {
  map: GeneratedWorldMap;
  pack: WorldPackManifest;
  lang: Lang;
  onBack: () => void;
  engineRef: { current: IsometricWorldEngine | null };
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState<WorldEngineStats | null>(null);
  const t = COPY[lang];
  const shoreTile = useMemo(() => findNearestShoreTile(map), [map]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let alive = true;

    /* Frame between startCenter and nearest shore when nearby; otherwise center on startCenter. */
    const shoreDist = Math.hypot(shoreTile.col - map.startCenter.col, shoreTile.row - map.startCenter.row);
    const initialMid: TileCoord =
      shoreDist <= 14
        ? {
            col: Math.round((map.startCenter.col + shoreTile.col) / 2),
            row: Math.round((map.startCenter.row + shoreTile.row) / 2),
          }
        : map.startCenter;

    void IsometricWorldEngine.create({
      host,
      pack,
      terrainMap: map,
      showBuildGrid: false,
      initialCenterTile: initialMid,
      markerTile: map.startCenter,
      resolveTileId: (col, row) => map.tileAt(col, row) ?? pack.defaultTileId,
      onStats: next => {
        if (alive) setStats(next);
      },
    }).then(engine => {
      if (!alive) {
        engine.destroy();
        return;
      }
      engineRef.current = engine;
      setStats(engine.getStats());
    });

    return () => {
      alive = false;
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, [map, pack, shoreTile, engineRef]);

  const atMin = stats ? stats.zoom <= stats.minZoom + 1e-4 : false;
  const atMax = stats ? stats.zoom >= stats.maxZoom - 1e-4 : false;
  const selected = stats?.selectedPick ?? null;
  const selectedSpec = selected ? map.kindSpecAt(selected.col, selected.row) : null;
  const hoveredSpec = stats?.hoveredTile ? map.kindSpecAt(stats.hoveredTile.col, stats.hoveredTile.row) : null;

  const focusOnTile = (tile: TileCoord) => {
    const engine = engineRef.current;
    if (!engine) return;
    const w = tileCenterToWorld(tile.col, tile.row, pack.projection.defaultTileW, pack.projection.defaultTileH);
    const cur = engine.getStats();
    engine.setCamera({ x: w.x, y: w.y, zoom: cur.camera.zoom });
  };

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen?.().catch(() => undefined);
    } else {
      void document.exitFullscreen?.().catch(() => undefined);
    }
  };

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden', background: pack.palette.backdrop }}>
      <div ref={hostRef} data-testid="stage2-iso-canvas" style={{ position: 'absolute', inset: 0 }} />

      <div
        data-testid="stage2-iso-hud"
        style={{
          position: 'fixed',
          top: 14,
          left: 14,
          display: 'grid',
          gap: 8,
          padding: '12px 14px',
          background: 'rgba(18, 25, 34, 0.9)',
          border: '1px solid rgba(126, 214, 255, 0.34)',
          color: '#E7F0F9',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12.5,
          lineHeight: 1.45,
          maxWidth: 'min(440px, calc(100vw - 28px))',
          userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <strong style={{ fontSize: 13.5, color: '#9BD9FF' }}>
            {pack.name[lang]} / {map.seed}
          </strong>
          <button
            type="button"
            data-testid="stage2-back-gallery"
            onClick={onBack}
            style={{
              padding: '4px 9px',
              background: 'rgba(30, 42, 58, 0.95)',
              border: '1px solid rgba(130, 184, 224, 0.45)',
              color: '#E7F0F9',
              fontFamily: 'inherit',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {t.backToGallery}
          </button>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <button
            type="button"
            data-testid="stage2-toggle-grid"
            onClick={() => engineRef.current?.setBuildGridVisible(!stats?.buildGridVisible)}
            style={{
              padding: '4px 9px',
              background: stats?.buildGridVisible ? '#284562' : 'rgba(30, 42, 58, 0.85)',
              border: '1px solid rgba(130, 184, 224, 0.42)',
              color: stats?.buildGridVisible ? '#FFE08A' : '#E7F0F9',
              fontFamily: 'inherit',
              fontSize: 11.5,
              cursor: 'pointer',
            }}
          >
            {t.buildGrid}: {stats?.buildGridVisible ? t.on : t.off}
          </button>
          <button
            type="button"
            data-testid="stage2-focus-shore"
            onClick={() => focusOnTile(shoreTile)}
            style={{
              padding: '4px 9px',
              background: 'rgba(30, 42, 58, 0.85)',
              border: '1px solid rgba(130, 184, 224, 0.42)',
              color: '#E7F0F9',
              fontFamily: 'inherit',
              fontSize: 11.5,
              cursor: 'pointer',
            }}
          >
            {t.focusShore}
          </button>
          <button
            type="button"
            data-testid="stage2-focus-center"
            onClick={() => focusOnTile(map.startCenter)}
            style={{
              padding: '4px 9px',
              background: 'rgba(30, 42, 58, 0.85)',
              border: '1px solid rgba(130, 184, 224, 0.42)',
              color: '#E7F0F9',
              fontFamily: 'inherit',
              fontSize: 11.5,
              cursor: 'pointer',
            }}
          >
            {t.focusCenter}
          </button>
        </div>

        {stats && (
          <div>
            <div>
              Zoom: <strong>{stats.zoomPercent}%</strong> ({stats.cssTileW}x{stats.cssTileH} px) | LOD: {stats.lodId} | Chunks: {stats.visibleChunks} / {stats.totalChunks}
            </div>
            <div>
              {t.hovered}: {stats.hoveredTile && hoveredSpec ? `(${stats.hoveredTile.col}, ${stats.hoveredTile.row}) [${hoveredSpec.label[lang]}]` : 'none'}
            </div>
          </div>
        )}

        <div
          data-testid="stage2-iso-selected"
          style={{
            padding: '6px 8px',
            background: 'rgba(255, 209, 102, 0.12)',
            border: '1px solid rgba(255, 209, 102, 0.35)',
            color: '#FFE08A',
          }}
        >
          {selected && selectedSpec
            ? `(${selected.col}, ${selected.row}) | ${selectedSpec.label[lang]} (${selectedSpec.buildable ? t.buildableYes : t.buildableNo})`
            : t.clickedPrompt}
        </div>
      </div>

      <div
        data-testid="stage2-iso-zoombar"
        style={{
          position: 'fixed',
          bottom: 16,
          left: 16,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: 4,
          background: 'rgba(18, 25, 34, 0.92)',
          border: '1px solid rgba(126, 214, 255, 0.35)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          userSelect: 'none',
        }}
      >
        <button
          type="button"
          data-testid="zoom-out"
          aria-label="Zoom out"
          disabled={atMin}
          onClick={() => engineRef.current?.zoomOut()}
          style={{
            minWidth: 36,
            height: 36,
            border: '1px solid rgba(130, 184, 224, 0.35)',
            background: atMin ? 'rgba(30, 42, 58, 0.35)' : 'rgba(30, 42, 58, 0.9)',
            color: atMin ? '#6C7D93' : '#E7F0F9',
            fontSize: 16,
            cursor: atMin ? 'not-allowed' : 'pointer',
          }}
        >
          -
        </button>
        <button
          type="button"
          data-testid="zoom-reset"
          aria-label="Reset zoom to 100%"
          onClick={() => engineRef.current?.resetZoom()}
          style={{
            minWidth: 62,
            height: 36,
            padding: '0 8px',
            border: '1px solid rgba(130, 184, 224, 0.35)',
            background: 'rgba(30, 42, 58, 0.9)',
            color: '#FFE08A',
            fontFamily: 'inherit',
            fontSize: 13,
            fontWeight: 700,
            cursor: 'pointer',
          }}
        >
          {stats ? `${stats.zoomPercent}%` : '100%'}
        </button>
        <button
          type="button"
          data-testid="zoom-in"
          aria-label="Zoom in"
          disabled={atMax}
          onClick={() => engineRef.current?.zoomIn()}
          style={{
            minWidth: 36,
            height: 36,
            border: '1px solid rgba(130, 184, 224, 0.35)',
            background: atMax ? 'rgba(30, 42, 58, 0.35)' : 'rgba(30, 42, 58, 0.9)',
            color: atMax ? '#6C7D93' : '#E7F0F9',
            fontSize: 16,
            cursor: atMax ? 'not-allowed' : 'pointer',
          }}
        >
          +
        </button>
        <button
          type="button"
          data-testid="zoom-fullscreen"
          aria-label="Fullscreen"
          onClick={toggleFullscreen}
          style={{
            minWidth: 36,
            height: 36,
            border: '1px solid rgba(130, 184, 224, 0.35)',
            background: 'rgba(30, 42, 58, 0.9)',
            color: '#E7F0F9',
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          [ ]
        </button>
      </div>
    </div>
  );
}

function Stage2GalleryApp() {
  const initial = useMemo(() => readInitialQuery(), []);
  const [lang, setLang] = useState<Lang>(initial.lang);
  const [packId, setPackId] = useState<string>(initial.packId);
  const [activeSeed, setActiveSeed] = useState<string | null>(initial.seed);
  const engineRef = useRef<IsometricWorldEngine | null>(null);

  const activePack = useMemo(
    () => AVAILABLE_PACKS.find(p => p.id === packId) ?? EGYPT_WORLD_PACK,
    [packId],
  );

  const maps = useMemo(
    () => GALLERY_SEEDS.map(seed => generateWorldTerrain(activePack, { seed, mapSize: activePack.mapSize })),
    [activePack],
  );

  const activeMap = useMemo(() => {
    if (!activeSeed) return null;
    const found = maps.find(m => m.seed === activeSeed);
    return found ?? generateWorldTerrain(activePack, { seed: activeSeed, mapSize: activePack.mapSize });
  }, [activeSeed, maps, activePack]);

  useEffect(() => {
    window.__WORLD_GALLERY__ = {
      setPack: id => {
        setActiveSeed(null);
        setPackId(id);
      },
      openSeed: seed => setActiveSeed(seed),
      backToGallery: () => setActiveSeed(null),
      setLang: next => setLang(next),
      setZoom: z => engineRef.current?.setZoom(z),
      setBuildGridVisible: v => engineRef.current?.setBuildGridVisible(v),
      focusTile: (col, row) => {
        const engine = engineRef.current;
        if (!engine) return;
        const w = tileCenterToWorld(col, row, activePack.projection.defaultTileW, activePack.projection.defaultTileH);
        engine.setCamera({ x: w.x, y: w.y, zoom: engine.getStats().camera.zoom });
      },
      focusNearestShore: () => {
        const target = activeMap ? findNearestShoreTile(activeMap) : { col: 75, row: 75 };
        const engine = engineRef.current;
        if (engine) {
          const w = tileCenterToWorld(
            target.col,
            target.row,
            activePack.projection.defaultTileW,
            activePack.projection.defaultTileH,
          );
          engine.setCamera({ x: w.x, y: w.y, zoom: engine.getStats().camera.zoom });
        }
        return target;
      },
      flushVisibleBakes: () => engineRef.current?.flushVisibleBakes(),
      getStats: () => engineRef.current?.getStats() ?? null,
      screenPointOfTile: (col, row) => {
        const engine = engineRef.current;
        if (!engine) return null;
        const host = document.querySelector('[data-testid="stage2-iso-canvas"]');
        if (!host) return null;
        const rect = host.getBoundingClientRect();
        const cur = engine.getStats();
        const w = tileCenterToWorld(col, row, activePack.projection.defaultTileW, activePack.projection.defaultTileH);
        return worldToScreen(w.x, w.y, cur.camera, { width: rect.width, height: rect.height });
      },
      getGallerySummaries: () =>
        maps.map(m => ({
          packId: m.packId,
          seed: m.seed,
          buildableRatio: m.stats.buildableRatio,
          continuityOk: m.stats.continuityOk,
          continuityEdges: m.stats.continuityEdges,
          startCenter: m.startCenter,
          centerDistanceToLiquid: m.stats.centerDistanceToLiquid,
        })),
    };
    return () => {
      delete window.__WORLD_GALLERY__;
    };
  }, [maps, activeMap, activePack]);

  if (activeMap) {
    return (
      <IsometricInspector
        map={activeMap}
        pack={activePack}
        lang={lang}
        onBack={() => setActiveSeed(null)}
        engineRef={engineRef}
      />
    );
  }

  const t = COPY[lang];
  const recipe = activePack.terrainRecipe!;

  return (
    <div
      data-testid="stage2-gallery-root"
      style={{
        minHeight: '100vh',
        background: '#111821',
        color: '#E7F0F9',
        padding: '16px 20px 24px',
        boxSizing: 'border-box',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <header
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div>
          <h1 data-testid="stage2-gallery-title" style={{ margin: 0, fontSize: 19, fontWeight: 700, color: '#9BD9FF' }}>
            {t.titlePrefix}: {recipe.name[lang]}
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#A9BDD3' }}>{t.subtitle}</p>
        </div>

        <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#A9BDD3' }}>{t.packLabel}:</span>
          {AVAILABLE_PACKS.map(p => (
            <button
              key={p.id}
              type="button"
              data-testid={`pack-${p.id}`}
              onClick={() => setPackId(p.id)}
              style={{
                padding: '6px 11px',
                border: '1px solid rgba(130, 184, 224, 0.4)',
                background: p.id === activePack.id ? '#284562' : '#19222E',
                color: p.id === activePack.id ? '#FFE08A' : '#C8D8E8',
                fontWeight: 700,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {p.name[lang]}
            </button>
          ))}
          {(['ru', 'en'] as const).map(code => (
            <button
              key={code}
              type="button"
              data-testid={`lang-${code}`}
              onClick={() => setLang(code)}
              style={{
                padding: '6px 10px',
                border: '1px solid rgba(130, 184, 224, 0.4)',
                background: lang === code ? '#284562' : '#19222E',
                color: lang === code ? '#FFE08A' : '#C8D8E8',
                fontWeight: 700,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {code.toUpperCase()}
            </button>
          ))}
        </div>
      </header>

      <div
        data-testid="stage2-legend"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px 14px',
          padding: '9px 12px',
          marginBottom: 14,
          background: '#18212D',
          border: '1px solid rgba(130, 184, 224, 0.25)',
          fontSize: 12,
        }}
      >
        {recipe.tileKinds.map(kind => (
          <span key={kind.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                display: 'inline-block',
                width: 12,
                height: 12,
                borderRadius: 2,
                background: kind.color,
                border: '1px solid rgba(255, 255, 255, 0.35)',
              }}
            />
            <span>{kind.label[lang]}</span>
          </span>
        ))}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              display: 'inline-block',
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: '#FFD166',
              border: '1px solid rgba(255, 255, 255, 0.35)',
            }}
          />
          <span>{t.startCenterLegend}</span>
        </span>
      </div>

      <main
        data-testid="stage2-gallery-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(340px, 100%), 1fr))',
          gap: 14,
        }}
      >
        {maps.map(map => (
          <MapCard key={`${activePack.id}-${map.seed}`} map={map} pack={activePack} lang={lang} onOpen={setActiveSeed} />
        ))}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Stage2GalleryApp />);
