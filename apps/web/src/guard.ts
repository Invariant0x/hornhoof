/* The guard against a page that redraws without end. Not yet built: these stand in with what the page does today. */
export type Clock = () => number;
export type RateMeter = { hit(): boolean; reset(): void };
export function rateMeter(_limit: number, _windowMs: number, _now: Clock = Date.now): RateMeter {
  return { hit: () => false, reset: () => {} };
}
export const isLight = () => false;
export function leaveLight(): void {}
export function useRenderGuard(_block: string): void {}
export function guardedResizeObserver(callback: ResizeObserverCallback, _block: string): ResizeObserver {
  return new ResizeObserver(callback);
}
export function everyVisible(fn: () => void, ms: number): () => void {
  const timer = setInterval(fn, ms);
  return () => clearInterval(timer);
}
export type FrameWatch = { every: number; budget: number; strikes: number; now?: Clock; frame?: (cb: FrameRequestCallback) => void };
export function watchFrames(_watch: FrameWatch): () => void {
  return () => {};
}
