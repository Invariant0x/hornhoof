import type { PlantPassport } from './manifest';

function point(raw: unknown): readonly [number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const [x, y] = raw as unknown[];
  return typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

/* Reads the passport file that comes with an artist's plant image: root_point, crown_center, optional crown_hub (the
   crown centre stands in for it) and the height and crown width, written height_px / crown_width_px or height /
   crown_width; null when anything required is missing or not a number. */
export function parsePlantPassport(raw: unknown): PlantPassport | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const j = raw as Record<string, unknown>;
  const rootPoint = point(j.root_point);
  const crownCenter = point(j.crown_center);
  const crownHub = j.crown_hub === undefined ? crownCenter : point(j.crown_hub);
  const heightPx = j.height_px ?? j.height;
  const crownWidthPx = j.crown_width_px ?? j.crown_width;
  if (!rootPoint || !crownCenter || !crownHub) return null;
  if (typeof heightPx !== 'number' || typeof crownWidthPx !== 'number') return null;
  if (!(heightPx > 0) || !(crownWidthPx > 0)) return null;
  return { rootPoint, crownCenter, crownHub, heightPx, crownWidthPx };
}
