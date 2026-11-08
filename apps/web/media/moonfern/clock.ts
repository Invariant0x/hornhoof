/* Shared UTC reference clock for all Moonfern and Oak Lane scenes, so limits, resets, last-seen labels and tree grids
   render the exact same numbers whenever the tool runs. */
export const BASE_DAY = '2026-11-05';
export const BASE_ISO = `${BASE_DAY}T14:20:00.000Z`;
export const BASE_MS = Date.parse(BASE_ISO);

export const isoAt = (offsetSeconds: number): string => new Date(BASE_MS + offsetSeconds * 1000).toISOString();
export const isoMinutes = (offsetMinutes: number): string => isoAt(offsetMinutes * 60);
export const clockIso = (hhmm: string, seconds = 0): string =>
  `${BASE_DAY}T${hhmm}:${String(seconds).padStart(2, '0')}.000Z`;
export const clockMs = (hhmm: string, seconds = 0): number => Date.parse(clockIso(hhmm, seconds));
