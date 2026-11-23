import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { tileCenterToWorld, worldToScreen } from '../coords';
import { STUB_DIAMOND_PACK } from '../packs/stub-pack';
import { IsometricWorldEngine, type RendererDebugInfo, type WorldEngineStats } from '../renderer';

/* Standalone Stage 1 engine demo page: renders an empty 150x150 2:1 diamond grid on the stub pack
   with drag pan, hard-bounded zoom (50% min 60x30 .. 100% default 120x60 .. 200% max 240x120),
   Retina-aware LOD selection, baked chunk culling, click-to-select tile readout and FPS counter. */

type DemoHandle = {
  setZoom: (zoom: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  panByScreen: (dx: number, dy: number) => void;
  flushVisibleBakes: () => void;
  getStats: () => WorldEngineStats;
  getDebugInfo: () => RendererDebugInfo;
  screenPointOfTile: (col: number, row: number) => { x: number; y: number };
};

declare global {
  interface Window {
    __WORLD_DEMO__?: DemoHandle;
  }
}

function Stage1Demo() {
  const hostRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<IsometricWorldEngine | null>(null);
  const [stats, setStats] = useState<WorldEngineStats | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let alive = true;

    void IsometricWorldEngine.create({
      host,
      pack: STUB_DIAMOND_PACK,
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
      window.__WORLD_DEMO__ = {
        setZoom: z => engine.setZoom(z),
        zoomIn: () => engine.zoomIn(),
        zoomOut: () => engine.zoomOut(),
        resetZoom: () => engine.resetZoom(),
        panByScreen: (dx, dy) => engine.panByScreen(dx, dy),
        flushVisibleBakes: () => engine.flushVisibleBakes(),
        getStats: () => engine.getStats(),
        getDebugInfo: () => engine.getRendererDebugInfo(),
        screenPointOfTile: (col, row) => {
          const cur = engine.getStats();
          const rect = host.getBoundingClientRect();
          const w = tileCenterToWorld(
            col,
            row,
            STUB_DIAMOND_PACK.projection.defaultTileW,
            STUB_DIAMOND_PACK.projection.defaultTileH,
          );
          return worldToScreen(w.x, w.y, cur.camera, { width: rect.width, height: rect.height });
        },
      };
    });

    return () => {
      alive = false;
      delete window.__WORLD_DEMO__;
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, []);

  const selected = stats?.selectedPick ?? null;
  const selectedChunk = selected
    ? {
        cx: Math.floor(selected.col / STUB_DIAMOND_PACK.params.chunkSize),
        cy: Math.floor(selected.row / STUB_DIAMOND_PACK.params.chunkSize),
      }
    : null;
  const selectedWorld = selected
    ? tileCenterToWorld(
        selected.col,
        selected.row,
        STUB_DIAMOND_PACK.projection.defaultTileW,
        STUB_DIAMOND_PACK.projection.defaultTileH,
      )
    : null;

  const atMin = stats ? stats.zoom <= stats.minZoom + 1e-4 : false;
  const atMax = stats ? stats.zoom >= stats.maxZoom - 1e-4 : false;

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen?.().catch(() => undefined);
    } else {
      void document.exitFullscreen?.().catch(() => undefined);
    }
  };

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden', background: STUB_DIAMOND_PACK.palette.backdrop }}>
      <div ref={hostRef} data-testid="world-stage1-canvas" style={{ position: 'absolute', inset: 0 }} />

      <div
        data-testid="world-stage1-hud"
        style={{
          position: 'fixed',
          top: 14,
          left: 14,
          display: 'grid',
          gap: 8,
          padding: '12px 14px',
          background: 'rgba(18, 25, 34, 0.9)',
          border: '1px solid rgba(126, 214, 255, 0.32)',
          color: '#E7F0F9',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 12.5,
          lineHeight: 1.45,
          maxWidth: 'min(380px, calc(100vw - 28px))',
          pointerEvents: 'auto',
          userSelect: 'none',
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 13.5, color: '#8ED8FF' }}>
          Stage 1 Engine Core ({STUB_DIAMOND_PACK.mapSize} x {STUB_DIAMOND_PACK.mapSize})
        </div>
        <div data-testid="world-stage1-metrics">
          {stats ? (
            <>
              <div>
                FPS: <strong data-testid="metric-fps">{stats.fps}</strong> ({stats.frameTimeMs} ms) | Renderer: {stats.rendererKind}
              </div>
              <div>
                Zoom: <strong data-testid="metric-zoom">{stats.zoomPercent}%</strong> ({stats.cssTileW}x{stats.cssTileH} px) | Bounds: {Math.round(stats.minZoom * 100)}%..{Math.round(stats.maxZoom * 100)}%
              </div>
              <div>
                LOD: <strong data-testid="metric-lod">{stats.lodId}</strong> ({stats.lodTileW}x{stats.lodTileH}, DPR {stats.dpr}) | Anim: {stats.animationDetail}
              </div>
              <div>
                Chunks: <strong data-testid="metric-visible-chunks">{stats.visibleChunks}</strong> / <span data-testid="metric-total-chunks">{stats.totalChunks}</span> (cached {stats.cachedChunks})
              </div>
              <div>
                Hover: {stats.hoveredTile ? `(${stats.hoveredTile.col}, ${stats.hoveredTile.row})` : 'none'}
              </div>
            </>
          ) : (
            <div>Initializing...</div>
          )}
        </div>
        <div
          data-testid="world-stage1-selected"
          style={{
            padding: '6px 8px',
            background: 'rgba(255, 209, 102, 0.12)',
            border: '1px solid rgba(255, 209, 102, 0.35)',
            color: '#FFE08A',
          }}
        >
          {selected && selectedChunk && selectedWorld
            ? `Clicked tile: (${selected.col}, ${selected.row}) | Chunk (${selectedChunk.cx}, ${selectedChunk.cy}) | World (${selectedWorld.x}, ${selectedWorld.y})`
            : 'Click any diamond tile to inspect coordinates'}
        </div>
      </div>

      {/* Product-aligned zoom bar in bottom-left corner: minus, percent (100% = default), plus, fullscreen. */}
      <div
        data-testid="world-stage1-zoombar"
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

createRoot(document.getElementById('root')!).render(<Stage1Demo />);
