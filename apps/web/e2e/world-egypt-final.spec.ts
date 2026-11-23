import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorldEngineStats } from '../src/world/renderer';
import { captureWith } from './capture';

/* The finished Egypt map in a real browser: plants stand where the seed says, sway out of step in the wind, the water
   moves, the picture repeats exactly on a fixed clock, a pack without plants still draws, and scrolling and zooming
   stay smooth. Shots at 100% and 200% of one spot go to the task. */

const capture = captureWith('egypt-final', process.env.HH_SCREENSHOT_DIR);

type Handle = {
  setPack: (packId: string) => void;
  setCamera: (camera: { x: number; y: number; zoom: number }) => void;
  setWindClock: (seconds: number | null) => void;
  flushVisibleBakes: () => void;
  getStats: () => WorldEngineStats | null;
  getGallerySummaries: () => readonly { seed: string; startCenter: { col: number; row: number } }[];
};

const VIEW = { width: 1280, height: 800 };

async function openMap(page: Page, pack: string, seed: string): Promise<{ x: number; y: number }> {
  await page.goto(`/world-gallery.html?lang=en&pack=${pack}&seed=${seed}&marker=0`);
  await page.waitForFunction(() => Boolean((window as unknown as { __WORLD_GALLERY__?: Handle }).__WORLD_GALLERY__?.getStats()));
  return page.evaluate(seedName => {
    const g = (window as unknown as { __WORLD_GALLERY__: Handle }).__WORLD_GALLERY__;
    const c = g.getGallerySummaries().find(m => m.seed === seedName)!.startCenter;
    document.querySelectorAll('body *').forEach(el => {
      if (getComputedStyle(el).position === 'fixed') (el as HTMLElement).style.display = 'none';
    });
    return { x: (c.col - c.row) * 60, y: (c.col + c.row + 1) * 30 };
  }, seed);
}

async function show(page: Page, at: { x: number; y: number }, zoom: number, clock: number): Promise<WorldEngineStats> {
  await page.evaluate(
    ({ at, zoom, clock }) => {
      const g = (window as unknown as { __WORLD_GALLERY__: Handle }).__WORLD_GALLERY__;
      g.setWindClock(clock);
      g.setCamera({ x: at.x, y: at.y, zoom });
      g.flushVisibleBakes();
    },
    { at, zoom, clock },
  );
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  return page.evaluate(() => (window as unknown as { __WORLD_GALLERY__: Handle }).__WORLD_GALLERY__.getStats()!);
}

test('The Egypt map grows the same plants for the same seed, and plants sway out of step', async ({ browser }, info: TestInfo) => {
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    const at = await openMap(page, 'egypt', 'hornhoof');
    const first = await show(page, at, 0.8, 4);
    expect(first.plants).not.toBeNull();
    expect(first.plants!.total).toBeGreaterThan(300);
    expect(first.plants!.inView).toBeGreaterThan(20);
    expect(first.plants!.drawn).toBeGreaterThan(20);
    expect(Object.values(first.plants!.byKind).filter(n => n > 0).length).toBeGreaterThanOrEqual(4);
    /* The plants of the view do not move in unison. */
    expect(first.plants!.leanSpan).toBeGreaterThan(0.03);

    /* Same seed, new page: the same plants. */
    const again = await openMap(page, 'egypt', 'hornhoof');
    const second = await show(page, again, 0.8, 4);
    expect(second.plants!.byKind).toEqual(first.plants!.byKind);

    /* Another seed grows another map. */
    const other = await openMap(page, 'egypt', 'north-star');
    const otherStats = await show(page, other, 0.8, 4);
    expect(otherStats.plants!.byKind).not.toEqual(first.plants!.byKind);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
  void info;
});

test('Wind and water move on the clock and a fixed clock repeats the picture exactly', async ({ browser }, info: TestInfo) => {
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    const at = await openMap(page, 'egypt', 'hornhoof');
    await show(page, at, 1, 2);
    const a = await page.screenshot();
    await show(page, at, 1, 5.3);
    const b = await page.screenshot();
    await show(page, at, 1, 2);
    const c = await page.screenshot();
    expect(Buffer.compare(a, b)).not.toBe(0);
    expect(Buffer.compare(a, c)).toBe(0);
    const leanA = (await show(page, at, 1, 2)).plants!.leanSpan;
    const leanB = (await show(page, at, 1, 5.3)).plants!.leanSpan;
    expect(leanA).toBeGreaterThan(0.03);
    expect(leanB).toBeGreaterThan(0.03);
    expect(leanA).not.toBeCloseTo(leanB, 6);
  } finally {
    await context.close();
  }
  void info;
});

test('A pack without plants still draws its ground and animated water', async ({ browser }) => {
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    const at = await openMap(page, 'dungeon', 'hornhoof');
    const stats = await show(page, at, 1, 3);
    expect(stats.plants).toBeNull();
    expect(stats.hasAnimatedLiquid).toBe(true);
    expect(stats.visibleChunks).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test('Shore with plants at 100% and 200%, and scrolling and zooming frame rate', async ({ browser }, info: TestInfo) => {
  const shotDir = process.env.HH_SCREENSHOT_DIR;
  if (shotDir) mkdirSync(shotDir, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    const at = await openMap(page, 'egypt', 'hornhoof');
    await show(page, at, 1, 6);
    await capture(page, info, 'hornhoof-100pct');
    await show(page, at, 2, 6);
    await capture(page, info, 'hornhoof-200pct');

    /* Frame rate while the camera scrolls and zooms for 4 seconds over the map. */
    const fps = await page.evaluate(
      ({ at }) =>
        new Promise<{ fps: number; frames: number; seconds: number; worstFrameMs: number; cpuStepMedianMs: number; cpuStepP90Ms: number; renderer: string; glRenderer: string }>(resolve => {
          const g = (window as unknown as { __WORLD_GALLERY__: Handle }).__WORLD_GALLERY__;
          g.setWindClock(null);
          const start = performance.now();
          let last = start;
          let worst = 0;
          let frames = 0;
          const cpu: number[] = [];
          const tick = (now: number) => {
            const t = (now - start) / 4000;
            worst = Math.max(worst, now - last);
            last = now;
            frames++;
            cpu.push(g.getStats()!.cpuStepMs);
            const zoom = 1 + 0.6 * Math.sin(t * Math.PI * 2);
            g.setCamera({ x: at.x + 1500 * t, y: at.y + 420 * t, zoom });
            if (t < 1) requestAnimationFrame(tick);
            else {
              cpu.sort((a, b) => a - b);
              const gl = document.createElement('canvas').getContext('webgl');
              const ext = gl?.getExtension('WEBGL_debug_renderer_info');
              resolve({
                fps: Math.round((frames / ((now - start) / 1000)) * 10) / 10,
                frames,
                seconds: Math.round(((now - start) / 1000) * 100) / 100,
                worstFrameMs: Math.round(worst),
                cpuStepMedianMs: cpu[cpu.length >> 1] ?? 0,
                cpuStepP90Ms: cpu[Math.floor(cpu.length * 0.9)] ?? 0,
                renderer: g.getStats()!.rendererKind,
                glRenderer: gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown',
              });
            }
          };
          requestAnimationFrame(tick);
        }),
      { at },
    );
    const file = 'egypt-final-fps.json';
    const path = shotDir ? join(shotDir, file) : info.outputPath(file);
    writeFileSync(path, JSON.stringify({ ...fps, viewport: '1600x900', browser: 'chromium' }, null, 2));
    await info.attach(file, { path, contentType: 'application/json' });
    /* Only a sanity floor: headless Chromium without a GPU draws every frame in software. The number goes to the task. */
    expect(fps.frames).toBeGreaterThan(10);
    expect(fps.fps).toBeGreaterThan(3);
    expect(fps.cpuStepP90Ms).toBeLessThan(60);
  } finally {
    await context.close();
  }
});
