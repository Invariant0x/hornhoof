import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { tileCenterToWorld, worldToScreen } from '../coords';
import { TERRAIN_PREVIEW_PACK } from '../packs/terrain-preview-pack';
import { IsometricWorldEngine, type WorldEngineStats } from '../renderer';
import {
  GALLERY_SEEDS,
  generateProceduralMap,
  TERRAIN_RULES,
  type ProceduralMap,
  type TerrainKind,
} from '../terrain';
import { renderProceduralMapPreview } from '../terrain-preview';

/* Stage 2 procedural map viewer: 12-seed gallery with full legend + click-to-inspect
   inside the live Stage 1 isometric chunked WebGL engine. */

type Lang = 'ru' | 'en';

const COPY: Record<
  Lang,
  {
    title: string;
    subtitle: string;
    backToGallery: string;
    clickToInspect: string;
    buildable: string;
    river: string;
    center: string;
    tilesToWater: string;
    hovered: string;
    clickedPrompt: string;
    buildableYes: string;
    buildableNo: string;
    legend: Record<TerrainKind | 'cityCenter', string>;
  }
> = {
  ru: {
    title: 'Этап 2: Галерея процедурных карт (12 зерен, 150 x 150)',
    subtitle: 'Каждое зерно строит свою карту целиком. Нажмите на любую карту, чтобы открыть ее в изометрическом движке.',
    backToGallery: '<- К галерее 12 карт',
    clickToInspect: 'Открыть в изометрии',
    buildable: 'Застройка',
    river: 'Река',
    center: 'Центр',
    tilesToWater: 'кл. до воды',
    hovered: 'Под курсором',
    clickedPrompt: 'Нажмите на любую клетку, чтобы увидеть ее тип и координаты',
    buildableYes: 'под застройку',
    buildableNo: 'не под застройку',
    legend: {
      river: 'Река',
      bank: 'Берег',
      fertile: 'Зеленая полоса',
      field: 'Поля',
      plain: 'Ровная земля',
      dune: 'Барханы',
      ridge: 'Скалы и гряды',
      quarry: 'Каменоломни',
      spring: 'Родник',
      grove: 'Роща',
      cityCenter: 'Центр города',
    },
  },
  en: {
    title: 'Stage 2: Procedural Map Gallery (12 seeds, 150 x 150)',
    subtitle: 'Each company seed generates its entire map deterministically. Click any map to open it in the isometric engine.',
    backToGallery: '<- Back to 12-map gallery',
    clickToInspect: 'Open isometric view',
    buildable: 'Buildable',
    river: 'River',
    center: 'Center',
    tilesToWater: 'tiles to water',
    hovered: 'Hover',
    clickedPrompt: 'Click any diamond tile to inspect its terrain and coordinates',
    buildableYes: 'buildable',
    buildableNo: 'non-buildable',
    legend: {
      river: 'River',
      bank: 'Bank',
      fertile: 'Fertile strip',
      field: 'Fields',
      plain: 'Flat plain',
      dune: 'Dunes',
      ridge: 'Ridges & cliffs',
      quarry: 'Quarries',
      spring: 'Spring',
      grove: 'Grove',
      cityCenter: 'City center',
    },
  },
};

const LEGEND_ORDER: readonly (TerrainKind | 'cityCenter')[] = [
  'river',
  'bank',
  'fertile',
  'field',
  'plain',
  'dune',
  'ridge',
  'quarry',
  'spring',
  'grove',
  'cityCenter',
];

type GallerySummary = Readonly<{
  seed: string;
  buildableRatio: number;
  riverIsContinuous: boolean;
  riverTouchesEdges: readonly string[];
  cityCenter: { col: number; row: number };
  centerDistanceToRiver: number;
}>;

type GalleryHandle = {
  openSeed: (seed: string) => void;
  backToGallery: () => void;
  setLang: (lang: Lang) => void;
  setZoom: (zoom: number) => void;
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

function readInitialQuery(): { lang: Lang; seed: string | null } {
  const params = new URLSearchParams(window.location.search);
  const rawLang = params.get('lang');
  const lang: Lang = rawLang === 'en' ? 'en' : 'ru';
  const rawSeed = params.get('seed');
  return { lang, seed: rawSeed && rawSeed.trim() ? rawSeed.trim() : null };
}

function MapCard({
  map,
  lang,
  onOpen,
}: {
  map: ProceduralMap;
  lang: Lang;
  onOpen: (seed: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const t = COPY[lang];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderProceduralMapPreview(canvas, map, TERRAIN_PREVIEW_PACK, 2);
  }, [map]);

  const pct = (map.stats.buildableRatio * 100).toFixed(1);
  const edges = map.stats.riverTouchesEdges.join('');

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
          imageRendering: 'pixelated',
        }}
      />
      <div style={{ fontSize: 11, color: '#B7C8DC', lineHeight: 1.35 }}>
        {t.river}: {edges} | {t.center}: ({map.cityCenter.col}, {map.cityCenter.row}) ({map.stats.centerDistanceToRiver} {t.tilesToWater})
      </div>
    </button>
  );
}

function IsometricInspector({
  map,
  lang,
  onBack,
  engineRef,
}: {
  map: ProceduralMap;
  lang: Lang;
  onBack: () => void;
  engineRef: { current: IsometricWorldEngine | null };
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState<WorldEngineStats | null>(null);
  const t = COPY[lang];

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let alive = true;

    void IsometricWorldEngine.create({
      host,
      pack: TERRAIN_PREVIEW_PACK,
      initialCenterTile: map.cityCenter,
      markerTile: map.cityCenter,
      resolveTileId: (col, row) => map.tileAt(col, row) ?? 'plain',
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
  }, [map, engineRef]);

  const atMin = stats ? stats.zoom <= stats.minZoom + 1e-4 : false;
  const atMax = stats ? stats.zoom >= stats.maxZoom - 1e-4 : false;
  const selected = stats?.selectedPick ?? null;
  const selectedKind = selected ? map.tileAt(selected.col, selected.row) : null;
  const hoveredKind = stats?.hoveredTile ? map.tileAt(stats.hoveredTile.col, stats.hoveredTile.row) : null;

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen?.().catch(() => undefined);
    } else {
      void document.exitFullscreen?.().catch(() => undefined);
    }
  };

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden', background: TERRAIN_PREVIEW_PACK.palette.backdrop }}>
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
          background: 'rgba(18, 25, 34, 0.92)',
          border: '1px solid rgba(126, 214, 255, 0.34)',
          color: '#E7F0F9',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12.5,
          lineHeight: 1.45,
          maxWidth: 'min(420px, calc(100vw - 28px))',
          userSelect: 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <strong style={{ fontSize: 13.5, color: '#9BD9FF' }}>
            {map.seed} ({map.width} x {map.height})
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

        {stats && (
          <div>
            <div>
              {t.buildable}: <strong>{(map.stats.buildableRatio * 100).toFixed(1)}%</strong> | {t.river}: {map.stats.riverTouchesEdges.join('')} | {t.center}: ({map.cityCenter.col}, {map.cityCenter.row})
            </div>
            <div>
              Zoom: <strong>{stats.zoomPercent}%</strong> ({stats.cssTileW}x{stats.cssTileH} px) | LOD: {stats.lodId} | Chunks: {stats.visibleChunks} / {stats.totalChunks}
            </div>
            <div>
              {t.hovered}: {stats.hoveredTile && hoveredKind ? `(${stats.hoveredTile.col}, ${stats.hoveredTile.row}) [${t.legend[hoveredKind]}]` : 'none'}
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
          {selected && selectedKind
            ? `(${selected.col}, ${selected.row}) | ${t.legend[selectedKind]} (${TERRAIN_RULES[selectedKind].buildable ? t.buildableYes : t.buildableNo})`
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
  const [activeSeed, setActiveSeed] = useState<string | null>(initial.seed);
  const engineRef = useRef<IsometricWorldEngine | null>(null);

  const maps = useMemo(
    () => GALLERY_SEEDS.map(seed => generateProceduralMap({ seed, mapSize: TERRAIN_PREVIEW_PACK.mapSize })),
    [],
  );

  const activeMap = useMemo(() => {
    if (!activeSeed) return null;
    const found = maps.find(m => m.seed === activeSeed);
    return found ?? generateProceduralMap({ seed: activeSeed, mapSize: TERRAIN_PREVIEW_PACK.mapSize });
  }, [activeSeed, maps]);

  useEffect(() => {
    window.__WORLD_GALLERY__ = {
      openSeed: seed => setActiveSeed(seed),
      backToGallery: () => setActiveSeed(null),
      setLang: next => setLang(next),
      setZoom: z => engineRef.current?.setZoom(z),
      flushVisibleBakes: () => engineRef.current?.flushVisibleBakes(),
      getStats: () => engineRef.current?.getStats() ?? null,
      screenPointOfTile: (col, row) => {
        const engine = engineRef.current;
        if (!engine) return null;
        const host = document.querySelector('[data-testid="stage2-iso-canvas"]');
        if (!host) return null;
        const rect = host.getBoundingClientRect();
        const cur = engine.getStats();
        const w = tileCenterToWorld(
          col,
          row,
          TERRAIN_PREVIEW_PACK.projection.defaultTileW,
          TERRAIN_PREVIEW_PACK.projection.defaultTileH,
        );
        return worldToScreen(w.x, w.y, cur.camera, { width: rect.width, height: rect.height });
      },
      getGallerySummaries: () =>
        maps.map(m => ({
          seed: m.seed,
          buildableRatio: m.stats.buildableRatio,
          riverIsContinuous: m.stats.riverIsContinuous,
          riverTouchesEdges: m.stats.riverTouchesEdges,
          cityCenter: m.cityCenter,
          centerDistanceToRiver: m.stats.centerDistanceToRiver,
        })),
    };
    return () => {
      delete window.__WORLD_GALLERY__;
    };
  }, [maps]);

  if (activeMap) {
    return (
      <IsometricInspector
        map={activeMap}
        lang={lang}
        onBack={() => setActiveSeed(null)}
        engineRef={engineRef}
      />
    );
  }

  const t = COPY[lang];
  const colorMap = new Map(TERRAIN_PREVIEW_PACK.tiles.map(slot => [slot.id, slot.fill]));

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
            {t.title}
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#A9BDD3' }}>{t.subtitle}</p>
        </div>

        <div style={{ display: 'inline-flex', gap: 4 }}>
          {(['ru', 'en'] as const).map(code => (
            <button
              key={code}
              type="button"
              data-testid={`lang-${code}`}
              onClick={() => setLang(code)}
              style={{
                padding: '6px 11px',
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
        {LEGEND_ORDER.map(key => (
          <span key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                display: 'inline-block',
                width: 12,
                height: 12,
                borderRadius: key === 'cityCenter' ? '50%' : 2,
                background: key === 'cityCenter' ? '#FFD166' : (colorMap.get(key) ?? '#888888'),
                border: '1px solid rgba(255, 255, 255, 0.35)',
              }}
            />
            <span>{t.legend[key]}</span>
          </span>
        ))}
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
          <MapCard key={map.seed} map={map} lang={lang} onOpen={setActiveSeed} />
        ))}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Stage2GalleryApp />);
