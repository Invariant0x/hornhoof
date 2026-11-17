import { useState, useSyncExternalStore } from 'react';

/* The guard against a page that redraws without end and keeps a person's tab at full CPU until the browser kills it. It
   counts how often a block draws, how often a ResizeObserver swings between two sizes and how late frames come; past a
   bar it stops the block behind its boundary or holds the observer back, and turns the page light: no animations,
   transitions, filters or shadows until the person turns them back on. Every count runs on a clock it is given, so a test
   moves time by hand. */

export type Clock = () => number;
type RateMeter = { hit(): boolean; reset(): void };

/* What happened within the last windowMs: hit counts one more and says whether that is past the limit. It keeps at most
   limit + 1 moments, so a storm costs no memory. */
export function rateMeter(limit: number, windowMs: number, now: Clock = Date.now): RateMeter {
  let times: number[] = [];
  return {
    hit() {
      const t = now();
      times.push(t);
      while (times[0]! <= t - windowMs) times.shift();
      if (times.length > limit + 1) times.shift();
      return times.length > limit;
    },
    reset() {
      times = [];
    },
  };
}

/* Why the page went light: a block drew without end, a box swung between two sizes, or frames kept coming late. */
type GuardReason = 'render' | 'resize' | 'frames';

let light: GuardReason | null = null;
const lightWatchers = new Set<() => void>();

function setLight(next: GuardReason | null): void {
  if (light === next) return;
  light = next;
  const root = document.documentElement;
  if (next) root.dataset.light = 'on';
  else delete root.dataset.light;
  for (const watch of [...lightWatchers]) watch();
}

export const isLight = () => light !== null;

/* The block that tripped goes to the console, so a person's report of a slow page names it. */
export function enterLight(reason: GuardReason, block: string): void {
  if (light) return;
  console.warn(`Hornhoof turned the page light: ${block} (${reason}).`);
  setLight(reason);
}

export function leaveLight(): void {
  setLight(null);
}

function watchLight(watch: () => void): () => void {
  lightWatchers.add(watch);
  return () => lightWatchers.delete(watch);
}

/* Why the page is light now, or null while every effect is on. */
export function useLight(): GuardReason | null {
  return useSyncExternalStore(watchLight, () => light, () => null);
}

/* A block draws a few times a second as a person types or drags; one stuck in a loop draws thousands of times. */
const RENDER_LIMIT = 300;
const RENDER_WINDOW_MS = 2000;

class RenderStormError extends Error {
  constructor(readonly block: string) {
    super(`${block} drew more than ${RENDER_LIMIT} times in ${RENDER_WINDOW_MS / 1000} s`);
    this.name = 'RenderStormError';
  }
}

/* React stops a loop of updates inside one commit itself, with this error (number 185 in a production build). */
const REACT_LOOP = /Maximum update depth exceeded|Minified React error #185\b/;

/* Whether an error a boundary caught is a block that drew without end. */
export const isRenderStorm = (error: unknown) => error instanceof RenderStormError || (error instanceof Error && REACT_LOOP.test(error.message));

/* Counts each drawing of the block; past the bar the drawing throws, and the block's GuardBoundary takes it off the page. */
export function useRenderGuard(block: string): void {
  const [meter] = useState(() => rateMeter(RENDER_LIMIT, RENDER_WINDOW_MS));
  if (meter.hit()) throw new RenderStormError(block);
}

/* A box that swings back to the size it had two calls ago does it a few times at most as its content settles. */
const SWINGS = 6;
const SWING_WINDOW_MS = 1000;
/* More calls than a 240 Hz screen draws frames is no resize a person makes. */
const RESIZE_LIMIT = 240;
/* How long a swinging observer is held back before its newest size goes on. */
const HOLD_MS = 250;

const sizeOf = (entries: ResizeObserverEntry[] | undefined) => (entries ?? []).map(e => `${e.contentRect?.width}x${e.contentRect?.height}`).join(' ');

/* Whether this call of an observer is a storm: its box came back to the size of two calls ago more than SWINGS times a
   second, or the calls come faster than frames. */
function swingWatch(now: Clock): (entries: ResizeObserverEntry[] | undefined) => boolean {
  const swings = rateMeter(SWINGS, SWING_WINDOW_MS, now);
  const calls = rateMeter(RESIZE_LIMIT, SWING_WINDOW_MS, now);
  const sizes: string[] = [];
  return entries => {
    const size = sizeOf(entries);
    const swung = sizes.length === 2 && sizes[0] === size && sizes[1] !== size;
    sizes.push(size);
    if (sizes.length > 2) sizes.shift();
    return (swung && swings.hit()) || calls.hit();
  };
}

/* Holds an observer's calls back and hands on only the newest of them, HOLD_MS after the first. */
function holdBack(callback: ResizeObserverCallback) {
  let held: [ResizeObserverEntry[], ResizeObserver] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const release = () => {
    timer = null;
    const newest = held;
    held = null;
    if (newest) callback(...newest);
  };
  return {
    holding: () => timer !== null,
    hold(entries: ResizeObserverEntry[], self: ResizeObserver) {
      held = [entries, self];
      timer ??= setTimeout(release, HOLD_MS);
    },
    drop() {
      if (timer) clearTimeout(timer);
      timer = null;
      held = null;
    },
  };
}

/* A ResizeObserver for block that hands every size on, until the box swings between two sizes or the calls come faster
   than frames: then the page goes light and the observer hands on only its newest size, once every HOLD_MS. */
export function guardedResizeObserver(callback: ResizeObserverCallback, block: string, now: Clock = Date.now): ResizeObserver {
  const stormy = swingWatch(now);
  const held = holdBack(callback);
  const observer = new ResizeObserver((entries, self) => {
    const storm = stormy(entries);
    if (!storm && !held.holding()) return callback(entries, self);
    if (storm) enterLight('resize', block);
    held.hold(entries, self);
  });
  const disconnect = observer.disconnect.bind(observer);
  observer.disconnect = () => {
    held.drop();
    disconnect();
  };
  return observer;
}

const hidden = () => document.visibilityState === 'hidden';

/* Calls fn every ms while the tab is seen: a hidden tab polls nothing, and one that comes back calls fn at once, then
   every ms again. The returned function stops it and takes its listener away. */
export function everyVisible(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const start = () => {
    timer ??= setInterval(fn, ms);
  };
  const pause = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const turn = () => {
    if (hidden()) pause();
    else if (!timer) {
      fn();
      start();
    }
  };
  document.addEventListener('visibilitychange', turn);
  if (!hidden()) start();
  return () => {
    pause();
    document.removeEventListener('visibilitychange', turn);
  };
}

type FrameWatch = { every: number; budget: number; strikes: number; now: Clock; frame: (cb: FrameRequestCallback) => void };

/* Every `every` ms while the tab is seen, how long two frames in a row take; past `budget` `strikes` times running, the
   page goes light. A hidden tab draws no frames, so the watch waits for it to come back. */
export function watchFrames({ every, budget, strikes, now, frame }: FrameWatch): () => void {
  let late = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const back = () => {
    if (hidden()) return;
    document.removeEventListener('visibilitychange', back);
    next();
  };
  const measured = (start: number) => {
    if (stopped) return;
    late = now() - start > budget ? late + 1 : 0;
    if (late >= strikes) {
      late = 0;
      enterLight('frames', 'frames');
    }
    next();
  };
  const sample = () => {
    timer = null;
    if (hidden()) return document.addEventListener('visibilitychange', back);
    frame(() => {
      const start = now();
      frame(() => measured(start));
    });
  };
  function next() {
    if (!stopped) timer = setTimeout(sample, every);
  }
  next();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    document.removeEventListener('visibilitychange', back);
  };
}
