/* Camera model for panning, cursor-anchored zooming, bird-eye framing and resolution tier selection. */

import { mapWorldBounds, screenToWorld, type MapWorldBounds, type Point2D, type WorldRect } from './coords';
import type { ResolutionTierId } from './manifest';

export type ViewportSize = Readonly<{ width: number; height: number }>;

export type CameraState = Readonly<{
  /* Logical world coordinate centered in the viewport. */
  x: number;
  y: number;
  /* Scale factor relative to classic 1x logical tiles (1 = 60x30, 2 = 120x60, 4 = 240x120). */
  zoom: number;
}>;

export const MIN_SAFE_VIEWPORT = 1;
export const MAX_CAMERA_ZOOM = 4;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/* Zoom level at which the entire N x N diamond map fits inside the viewport with marginPx padding. */
export function computeBirdEyeZoom(
  mapSize: number,
  tileW: number,
  tileH: number,
  viewport: ViewportSize,
  marginPx = 24,
): number {
  const bounds = mapWorldBounds(mapSize, tileW, tileH);
  const availW = Math.max(MIN_SAFE_VIEWPORT, viewport.width - marginPx * 2);
  const availH = Math.max(MIN_SAFE_VIEWPORT, viewport.height - marginPx * 2);
  const fit = Math.min(availW / bounds.width, availH / bounds.height);
  return clamp(fit, 0.04, 1);
}

export function zoomForTier(
  tier: ResolutionTierId,
  mapSize: number,
  tileW: number,
  tileH: number,
  viewport: ViewportSize,
  marginPx = 24,
): number {
  switch (tier) {
    case 'overview':
      return computeBirdEyeZoom(mapSize, tileW, tileH, viewport, marginPx);
    case '1x':
      return 1;
    case '2x':
      return 2;
    case '4x':
      return 4;
  }
}

/* Maps any continuous zoom level onto the colleague's mipmap resolution ladder (overview / 1x / 2x / 4x). */
export function activeZoomTier(zoom: number): ResolutionTierId {
  if (zoom < 0.55) return 'overview';
  if (zoom < 1.5) return '1x';
  if (zoom < 3.0) return '2x';
  return '4x';
}

export function clampCameraPosition(cam: CameraState, bounds: MapWorldBounds): CameraState {
  return {
    x: clamp(cam.x, bounds.minX, bounds.maxX),
    y: clamp(cam.y, bounds.minY, bounds.maxY),
    zoom: cam.zoom,
  };
}

export function createInitialCamera(
  mapSize: number,
  tileW: number,
  tileH: number,
  viewport: ViewportSize,
  initialTier: ResolutionTierId = '1x',
  marginPx = 24,
): CameraState {
  const bounds = mapWorldBounds(mapSize, tileW, tileH);
  return {
    x: bounds.centerX,
    y: bounds.centerY,
    zoom: zoomForTier(initialTier, mapSize, tileW, tileH, viewport, marginPx),
  };
}

/* Pans the camera by a pointer drag delta in screen pixels, softly clamped to map world bounds. */
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

/* Zooms around a screen anchor point (such as the mouse cursor) so the world point beneath it stays fixed. */
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
