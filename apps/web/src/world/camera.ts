/* Camera model for drag panning, smooth cursor-anchored zooming within hard bounds,
   Retina/DPR-aware LOD capping (zero upscaling blur) and animation detail selection. */

import { mapWorldBounds, screenToWorld, type MapWorldBounds, type Point2D, type WorldRect } from './coords';
import {
  packMaxSourceTileW,
  selectLodTier,
  type AnimationDetailLevel,
  type LodTierSpec,
  type WorldPackManifest,
} from './manifest';

export type ViewportSize = Readonly<{ width: number; height: number }>;

export type CameraState = Readonly<{
  /* Logical world coordinate centered in the viewport (at 100% default 120x60 scale). */
  x: number;
  y: number;
  /* Scale factor relative to 100% default (0.5 = 50% / 60x30 CSS px, 1.0 = 100% / 120x60, 2.0 = 200% / 240x120). */
  zoom: number;
}>;

export type EffectiveZoomBounds = Readonly<{
  minZoom: number;
  defaultZoom: number;
  maxZoom: number;
  /* True when source asset resolution caps maxZoom below pack.camera.maxZoom at the current DPR. */
  cappedBySource: boolean;
}>;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/* Computes hard zoom bounds for the pack at the display's devicePixelRatio.
   Never permits zooming past native source resolution (no upscaling blur). */
export function computeEffectiveZoomBounds(
  pack: WorldPackManifest,
  devicePixelRatio = 1,
  assetMaxSourceTileW?: number,
): EffectiveZoomBounds {
  const dpr = Math.max(1, devicePixelRatio);
  const minZoom = pack.camera.minZoom;
  const configuredMax = pack.camera.maxZoom;
  const maxSourceW = assetMaxSourceTileW ?? packMaxSourceTileW(pack);
  const noStretchMax = (maxSourceW / dpr) / pack.projection.defaultTileW;
  const maxZoom = Math.max(minZoom, Math.min(configuredMax, noStretchMax));
  const defaultZoom = clamp(pack.camera.defaultZoom, minZoom, maxZoom);
  return {
    minZoom,
    defaultZoom,
    maxZoom,
    cappedBySource: noStretchMax + 1e-6 < configuredMax,
  };
}

/* Selects the crisp LOD tier from the pack for the current zoom and devicePixelRatio. */
export function lodForCamera(pack: WorldPackManifest, zoom: number, devicePixelRatio = 1): LodTierSpec {
  const cssTileW = pack.projection.defaultTileW * zoom;
  return selectLodTier(pack.projection.lods, cssTileW, devicePixelRatio);
}

/* Selects animation detail level by CSS zoom: reduced at far district zoom, full up close. */
export function animationDetailForZoom(zoom: number): AnimationDetailLevel {
  if (zoom < 0.75) return 'reduced';
  if (zoom < 1.5) return 'standard';
  return 'full';
}

export function zoomPercent(zoom: number): number {
  return Math.round(zoom * 100);
}

export function clampCameraPosition(cam: CameraState, bounds: MapWorldBounds): CameraState {
  return {
    x: clamp(cam.x, bounds.minX, bounds.maxX),
    y: clamp(cam.y, bounds.minY, bounds.maxY),
    zoom: cam.zoom,
  };
}

export function createInitialCamera(pack: WorldPackManifest, devicePixelRatio = 1): CameraState {
  const bounds = mapWorldBounds(pack.mapSize, pack.projection.defaultTileW, pack.projection.defaultTileH);
  const zoomBounds = computeEffectiveZoomBounds(pack, devicePixelRatio);
  return {
    x: bounds.centerX,
    y: bounds.centerY,
    zoom: zoomBounds.defaultZoom,
  };
}

/* Pans the camera by a pointer drag delta in screen pixels, clamped to map world bounds. */
export function panCamera(
  cam: CameraState,
  deltaScreenX: number,
  deltaScreenY: number,
  bounds: MapWorldBounds,
): CameraState {
  return clampCameraPosition(
    {
      x: cam.x - deltaScreenX / cam.zoom,
      y: cam.y - deltaScreenY / cam.zoom,
      zoom: cam.zoom,
    },
    bounds,
  );
}

/* Smoothly zooms around a screen anchor point (such as the mouse cursor) clamped strictly to [minZoom, maxZoom]. */
export function zoomCameraAt(
  cam: CameraState,
  factor: number,
  anchorScreen: Point2D,
  viewport: ViewportSize,
  minZoom: number,
  maxZoom: number,
  bounds: MapWorldBounds,
): CameraState {
  const nextZoom = clamp(cam.zoom * factor, minZoom, maxZoom);
  if (Math.abs(nextZoom - cam.zoom) < 1e-9) return cam;
  const worldBefore = screenToWorld(anchorScreen.x, anchorScreen.y, cam, viewport);
  const nextX = worldBefore.x - (anchorScreen.x - viewport.width / 2) / nextZoom;
  const nextY = worldBefore.y - (anchorScreen.y - viewport.height / 2) / nextZoom;
  return clampCameraPosition({ x: nextX, y: nextY, zoom: nextZoom }, bounds);
}

/* World-space axis-aligned bounding box visible through the camera, expanded by optional padding. */
export function visibleWorldRect(cam: CameraState, viewport: ViewportSize, padWorld = 0): WorldRect {
  const halfW = viewport.width / (2 * cam.zoom) + padWorld;
  const halfH = viewport.height / (2 * cam.zoom) + padWorld;
  return {
    minX: cam.x - halfW,
    maxX: cam.x + halfW,
    minY: cam.y - halfH,
    maxY: cam.y + halfH,
  };
}
