import { expect, test, type Browser, type BrowserContextOptions, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildWorldViewer, packFolder } from '../scripts/build-world-viewer';
import type { CameraState } from '../src/world/camera';
import type { WorldEngineStats } from '../src/world/renderer';
import { overviewLayout, overviewToWorld, worldToOverview } from '../src/world-packs/viewer-core';
import { captureWith } from './capture';

/* The static map viewer as Ivan gets it: the one archive unpacked onto a plain static host under a sub-path, opened in
   Chromium. It asks only for its own files, the camera follows drag, keys, wheel and pinch without picking tiles, the
   overview from above takes the camera where it is tapped, and the seed switch opens another map. With the licensed art
   folder in this checkout the build ships it; without it (test machines) the world draws its procedural ground.
   WORLD_VIEWER_ARCHIVE names an archive to check instead of building one. Shots and numbers go to HH_SCREENSHOT_DIR. */

const SUB = '/shared/egypt-map/';
const ART = fileURLToPath(new URL('../public/world-art/egypt', import.meta.url));
const SHOTS = process.env.HH_SCREENSHOT_DIR;
const capture = captureWith('world-viewer', SHOTS);
const VIEW = { width: 1600, height: 900 };
const TILE_H = 60;
const MAP_SIZE = 150;

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
};

type Handle = {
  ready: boolean;
  seed: string;
  getStats: () => WorldEngineStats | null;
  setCamera: (camera: CameraState) => void;
  setWindClock: (seconds: number | null) => void;
  flushVisibleBakes: () => void;
};

let scratch = '';
let server: Server | null = null;
let origin = '';
let packed: string[] = [];
let served = '';

function serve(folder: string): Promise<{ server: Server; origin: string }> {
  const root = resolve(folder);
  const s = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://host').pathname);
    const file = path.startsWith(SUB) ? normalize(join(root, path.slice(SUB.length) || 'index.html')) : '';
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise(done => s.listen(0, '127.0.0.1', () => done({ server: s, origin: `http://127.0.0.1:${(s.address() as AddressInfo).port}` })));
}

test.beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'world-viewer-e2e-'));
  let archive = process.env.WORLD_VIEWER_ARCHIVE ?? '';
  if (!archive) {
    const out = join(scratch, 'egypt-map');
    await buildWorldViewer({ outDir: out, artDir: existsSync(ART) ? ART : null });
    archive = join(scratch, 'egypt-map.tar.gz');
    packFolder(out, archive);
  }
  const unpacked = join(scratch, 'unpacked');
  mkdirSync(unpacked);
  execFileSync('tar', ['-xzf', resolve(archive), '-C', unpacked]);
  packed = readdirSync(unpacked);
  served = join(unpacked, packed[0] ?? '');
  ({ server, origin } = await serve(served));
});

test.afterAll(() => {
  server?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function openViewer(browser: Browser, query = '', options: BrowserContextOptions = {}): Promise<Page> {
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1, ...options });
  const page = await context.newPage();
  await page.goto(`${origin}${SUB}${query}`);
  await waitReady(page);
  return page;
}

async function waitReady(page: Page, seed?: string): Promise<void> {
  await page.waitForFunction(
    want => {
      const v = (window as unknown as { __WORLD_VIEWER__?: Handle }).__WORLD_VIEWER__;
      return Boolean(v?.ready && v.getStats() && (!want || v.seed === want));
    },
    seed ?? null,
  );
}

function stats(page: Page): Promise<WorldEngineStats> {
  return page.evaluate(() => (window as unknown as { __WORLD_VIEWER__: Handle }).__WORLD_VIEWER__.getStats()!);
}

async function show(page: Page, camera: CameraState, clock: number): Promise<WorldEngineStats> {
  await page.evaluate(
    ({ camera, clock }) => {
      const v = (window as unknown as { __WORLD_VIEWER__: Handle }).__WORLD_VIEWER__;
      v.setWindClock(clock);
      v.setCamera(camera);
      v.flushVisibleBakes();
    },
    { camera, clock },
  );
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  return stats(page);
}

function keep(info: TestInfo, file: string, data: unknown): Promise<void> {
  const path = SHOTS ? join(SHOTS, file) : info.outputPath(file);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  return info.attach(file, { path, contentType: 'application/json' });
}

test('opens from a plain static host under a sub-path and asks only for its own files', async ({ browser }, info) => {
  expect(packed).toEqual(['egypt-map']);
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const asked: string[] = [];
  const answers: { path: string; type: string; status: number }[] = [];
  const failed: string[] = [];
  const errors: string[] = [];
  page.on('request', r => asked.push(r.url()));
  page.on('response', r => answers.push({ path: r.url().replace(origin, ''), type: r.request().resourceType(), status: r.status() }));
  page.on('requestfailed', r => failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text());
  });
  try {
    await page.goto(`${origin}${SUB}`);
    await waitReady(page);
    await page.waitForLoadState('networkidle');
    const s = await stats(page);
    expect(s.visibleChunks).toBeGreaterThan(0);
    expect(s.plants!.total).toBeGreaterThan(300);
    expect(s.selectedPick).toBeNull();

    expect(asked.filter(url => !url.startsWith(`${origin}${SUB}`))).toEqual([]);
    expect(answers.filter(a => a.status >= 400)).toEqual([]);
    expect(failed).toEqual([]);
    expect(errors).toEqual([]);
    /* A build without the art folder ships no art and asks for none, its index included. */
    const art = existsSync(join(served, 'world-art/egypt/ground/plain.png'));
    if (art) {
      expect(answers.map(a => a.path)).toContain(`${SUB}world-art/egypt/art-index.json`);
      expect(answers).toContainEqual({ path: `${SUB}world-art/egypt/ground/plain.png`, type: 'fetch', status: 200 });
    } else {
      expect(asked.filter(url => url.includes('/world-art/'))).toEqual([]);
    }
    await keep(info, 'world-viewer-requests.json', { origin: 'same origin, under the sub-path', subPath: SUB, art, requests: answers });
  } finally {
    await context.close();
  }
});

test('the start of the map at 100% and 200%, and the frame rate while scrolling and zooming', async ({ browser }, info) => {
  const page = await openViewer(browser);
  try {
    const start = (await stats(page)).camera;
    expect(start.zoom).toBe(1);
    await show(page, start, 6);
    await capture(page, info, 'start-100pct');
    await show(page, { ...start, zoom: 2 }, 6);
    await capture(page, info, 'start-200pct');

    const fps = await page.evaluate(
      start =>
        new Promise<{ fps: number; frames: number; seconds: number; worstFrameMs: number; cpuStepMedianMs: number; cpuStepP90Ms: number; glRenderer: string }>(done => {
          const v = (window as unknown as { __WORLD_VIEWER__: Handle }).__WORLD_VIEWER__;
          v.setWindClock(null);
          const t0 = performance.now();
          let last = t0;
          let worst = 0;
          let frames = 0;
          const cpu: number[] = [];
          const tick = (now: number) => {
            const t = (now - t0) / 4000;
            worst = Math.max(worst, now - last);
            last = now;
            frames++;
            cpu.push(v.getStats()!.cpuStepMs);
            v.setCamera({ x: start.x + 1500 * t, y: start.y + 420 * t, zoom: 1 + 0.6 * Math.sin(t * Math.PI * 2) });
            if (t < 1) {
              requestAnimationFrame(tick);
              return;
            }
            cpu.sort((a, b) => a - b);
            const gl = document.createElement('canvas').getContext('webgl');
            const ext = gl?.getExtension('WEBGL_debug_renderer_info');
            done({
              fps: Math.round((frames / ((now - t0) / 1000)) * 10) / 10,
              frames,
              seconds: Math.round(((now - t0) / 1000) * 100) / 100,
              worstFrameMs: Math.round(worst),
              cpuStepMedianMs: cpu[cpu.length >> 1] ?? 0,
              cpuStepP90Ms: cpu[Math.floor(cpu.length * 0.9)] ?? 0,
              glRenderer: gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown',
            });
          };
          requestAnimationFrame(tick);
        }),
      start,
    );
    await keep(info, 'world-viewer-fps.json', { ...fps, viewport: `${VIEW.width}x${VIEW.height}`, browser: 'chromium' });
    /* Only a floor: without a GPU every frame is drawn on the CPU. The number goes to the task. */
    expect(fps.frames).toBeGreaterThan(10);
    expect(fps.cpuStepP90Ms).toBeLessThan(60);
  } finally {
    await page.context().close();
  }
});

test('drag, keys, wheel, pinch and the zoom buttons move the camera and pick no tile', async ({ browser }) => {
  const page = await openViewer(browser, '', { hasTouch: true });
  try {
    const start = (await stats(page)).camera;
    await page.mouse.move(800, 450);
    await page.mouse.down();
    await page.mouse.move(900, 500, { steps: 5 });
    await page.mouse.move(1000, 550, { steps: 5 });
    await page.mouse.up();
    const dragged = (await stats(page)).camera;
    expect(dragged.x).toBeCloseTo(start.x - 200, 3);
    expect(dragged.y).toBeCloseTo(start.y - 100, 3);

    await page.keyboard.down('ArrowRight');
    await page.waitForFunction(x => (window as unknown as { __WORLD_VIEWER__: Handle }).__WORLD_VIEWER__.getStats()!.camera.x > x + 50, dragged.x);
    await page.keyboard.up('ArrowRight');

    const before = (await stats(page)).camera;
    await page.mouse.wheel(0, -100);
    await page.waitForFunction(z => (window as unknown as { __WORLD_VIEWER__: Handle }).__WORLD_VIEWER__.getStats()!.zoom > z, before.zoom);
    expect((await stats(page)).zoom).toBeCloseTo(1.15, 3);

    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', apart: number) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints:
          type === 'touchEnd'
            ? []
            : [
                { x: 800 - apart, y: 450, id: 1 },
                { x: 800 + apart, y: 450, id: 2 },
              ],
      });
    const pinchFrom = (await stats(page)).zoom;
    await touch('touchStart', 60);
    for (const apart of [70, 80, 90]) await touch('touchMove', apart);
    await touch('touchEnd', 0);
    expect((await stats(page)).zoom).toBeCloseTo(Math.min(2, pinchFrom * 1.5), 2);

    await page.getByTestId('viewer-zoom-reset').click();
    await expect(page.getByTestId('viewer-zoom-reset')).toHaveText('100%');
    await page.getByTestId('viewer-zoom-in').click();
    await expect(page.getByTestId('viewer-zoom-reset')).toHaveText('125%');
    await page.getByTestId('viewer-zoom-out').click();
    await expect(page.getByTestId('viewer-zoom-reset')).toHaveText('100%');

    const end = await stats(page);
    expect(end.selectedPick).toBeNull();
    expect(end.hoveredTile).toBeNull();
  } finally {
    await page.context().close();
  }
});

test('the overview from above shows the whole map and takes the camera to the place tapped', async ({ browser }, info) => {
  const page = await openViewer(browser);
  try {
    await page.getByTestId('viewer-overview').click();
    const panel = page.getByTestId('viewer-overview-panel');
    await expect(panel).toBeVisible();
    const map = page.getByTestId('viewer-overview-map');
    const box = (await map.boundingBox())!;
    const layout = overviewLayout(MAP_SIZE, box);
    const pixel = (p: { x: number; y: number }) =>
      map.evaluate((c, p) => Array.from((c as HTMLCanvasElement).getContext('2d')!.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data), p);
    expect((await pixel({ x: box.width / 2, y: box.height / 2 }))[3]).toBe(255);
    /* Only the frame of the view marks the map: no pin at the start, where the camera opened. */
    const start = worldToOverview(layout, TILE_H, (await stats(page)).camera);
    expect((await pixel(start)).slice(0, 3)).not.toEqual([255, 209, 102]);
    await capture(page, info, 'overview');

    const at = { x: Math.round(box.width * 0.3), y: Math.round(box.height * 0.5) };
    const want = overviewToWorld(layout, TILE_H, at)!;
    await map.click({ position: at });
    await expect(panel).toBeHidden();
    const camera = (await stats(page)).camera;
    /* Within one pixel of the overview. */
    const onePixel = TILE_H / layout.unit;
    expect(Math.abs(camera.x - want.x)).toBeLessThanOrEqual(onePixel);
    expect(Math.abs(camera.y - want.y)).toBeLessThanOrEqual(onePixel);
    expect(camera.x).toBeLessThan(-2000);

    await page.keyboard.press('o');
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  } finally {
    await page.context().close();
  }
});

test('the seed switch opens another map and keeps it in the address', async ({ browser }) => {
  const page = await openViewer(browser);
  try {
    const first = (await stats(page)).plants!.byKind;
    await page.getByTestId('viewer-seed').selectOption('north-star');
    await waitReady(page, 'north-star');
    expect(new URL(page.url()).searchParams.get('seed')).toBe('north-star');
    expect((await stats(page)).plants!.byKind).not.toEqual(first);
    await page.reload();
    await waitReady(page, 'north-star');
    await expect(page.getByTestId('viewer-seed')).toHaveValue('north-star');
  } finally {
    await page.context().close();
  }
});

test('fits a phone screen: the buttons stay inside it and the hint gives way to the map', async ({ browser }, info) => {
  const page = await openViewer(browser, '', { viewport: { width: 375, height: 740 }, hasTouch: true, isMobile: true });
  try {
    const bar = (await page.getByTestId('viewer-bar').boundingBox())!;
    expect(bar.x).toBeGreaterThanOrEqual(0);
    expect(bar.x + bar.width).toBeLessThanOrEqual(375);
    expect(bar.y + bar.height).toBeLessThanOrEqual(740);
    await expect(page.locator('.bar .hint')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await show(page, (await stats(page)).camera, 6);
    await capture(page, info, 'phone-375');
  } finally {
    await page.context().close();
  }
});

test('opened from a file, the page says it needs a web server instead of building forever', async ({ browser }) => {
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    await page.goto(pathToFileURL(join(served, 'index.html')).href);
    const note = page.getByTestId('viewer-file-note');
    await expect(note).toBeVisible();
    await expect(note).toContainText('http.server');
    await expect(page.locator('.loading')).toHaveCount(0);
  } finally {
    await context.close();
  }
});
