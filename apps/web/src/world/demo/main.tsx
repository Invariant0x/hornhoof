import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { tileCenterToWorld, worldToScreen } from '../coords';
import type { ResolutionTierId } from '../manifest';
import { STUB_DIAMOND_PACK } from '../packs/stub-pack';
import { IsometricWorldEngine, type WorldEngineStats } from '../renderer';

/* Standalone Stage 1 engine demo page: renders an empty 150x150 2:1 diamond grid on the stub pack
   with pan, 4x/2x/1x/bird-eye zoom, baked chunk culling, click-to-select tile readout and FPS counter. */

type DemoHandle = {
  setZoomTier: (tier: ResolutionTierId) => void;
  panByScreen: (dx: number, dy: number) => void;
  flushVisibleBakes: () => void;
  getStats: () => WorldEngineStats;
  screenPointOfTile: (col: number, row: number) => { x: number; y: number };
};

declare global {
  interface Window {
    __WORLD_DEMO__?: DemoHandle;
  }
}

const TIERS: readonly { id: ResolutionTierId; label: string }[] = [
  { id: 'overview', label: "Bird's-eye" },
  { id: '1x', label: '1x (60x30)' },
  { id: '2x', label: '2x (120x60)' },
  { id: '4x', label: '4x (240x120)' },
];

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
      initialTier: '1x',
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
        setZoomTier: tier => engine.setZoomTier(tier),
        panByScreen: (dx, dy) => engine.panByScreen(dx, dy),
        flushVisibleBakes: () => engine.flushVisibleBakes(),
        getStats: () => engine.getStats(),
        screenPointOfTile: (col, row) => {
          const cur = engine.getStats();
          const rect = host.getBoundingClientRect();
          const w = tileCenterToWorld(
            col,
            row,
            STUB_DIAMOND_PACK.projection.tiers.classic1x.tileW,
            STUB_DIAMOND_PACK.projection.tiers.classic1x.tileH,
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
        STUB_DIAMOND_PACK.projection.tiers.classic1x.tileW,
        STUB_DIAMOND_PACK.projection.tiers.classic1x.tileH,
      )
    : null;

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
          maxWidth: 'min(360px, calc(100vw - 28px))',
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
                Zoom: <strong data-testid="metric-zoom">{stats.zoom.toFixed(2)}x</strong> | Tier: <strong data-testid="metric-tier">{stats.tier}</strong>
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
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {TIERS.map(t => {
            const active = stats?.tier === t.id;
            return (
              <button
                key={t.id}
                type="button"
                data-testid={`zoom-tier-${t.id}`}
                onClick={() => engineRef.current?.setZoomTier(t.id)}
                style={{
                  padding: '6px 10px',
                  border: active ? '1px solid #FFD166' : '1px solid rgba(130, 184, 224, 0.45)',
                  background: active ? 'rgba(255, 209, 102, 0.22)' : 'rgba(30, 42, 58, 0.9)',
                  color: active ? '#FFE599' : '#D9E7F5',
                  fontFamily: 'inherit',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Stage1Demo />);
