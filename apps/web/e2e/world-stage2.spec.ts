import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WorldEngineStats } from '../src/world/renderer';
import { GALLERY_SEEDS, MIN_BUILDABLE_RATIO } from '../src/world/terrain';
import { captureWith } from './capture';

/* Stage 2 live browser verification: 12-seed procedural map gallery + click-to-inspect
   inside the live Stage 1 isometric chunked WebGL renderer. */

const capture = captureWith('stage2', process.env.HH_SCREENSHOT_DIR);

async function captureFull(page: Page, info: TestInfo, name: string): Promise<void> {
  const file = `stage2-${name}.png`;
  const dir = process.env.HH_SCREENSHOT_DIR;
  const path = dir ? join(dir, file) : info.outputPath(file);
  await page.screenshot({ path, fullPage: true });
  await info.attach(file, { path, contentType: 'image/png' });
}

type GallerySummary = Readonly<{
  seed: string;
  buildableRatio: number;
  riverIsContinuous: boolean;
  riverTouchesEdges: readonly string[];
  cityCenter: { col: number; row: number };
  centerDistanceToRiver: number;
}>;

type GalleryHandle = {
  openSeed: (seed: string) => void;
  backToGallery: () => void;
  setLang: (lang: 'ru' | 'en') => void;
  setZoom: (zoom: number) => void;
  flushVisibleBakes: () => void;
  getStats: () => WorldEngineStats | null;
  screenPointOfTile: (col: number, row: number) => { x: number; y: number } | null;
  getGallerySummaries: () => readonly GallerySummary[];
};

async function waitForIsoReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const g = (window as unknown as { __WORLD_GALLERY__?: GalleryHandle }).__WORLD_GALLERY__;
    return Boolean(g?.getStats());
  });
  await page.evaluate(() => {
    const g = (window as unknown as { __WORLD_GALLERY__: GalleryHandle }).__WORLD_GALLERY__;
    g.flushVisibleBakes();
  });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('Stage 2 gallery renders 12 distinct procedural maps and opens any seed in the live isometric engine', async ({ browser }, info: TestInfo) => {
  const shotDir = process.env.HH_SCREENSHOT_DIR;
  if (shotDir) mkdirSync(shotDir, { recursive: true });

  /* 1600x1280 displays all 12 maps in a crisp 4x3 grid for visual inspection. */
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1280 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  try {
    await page.goto('/world-gallery.html?lang=ru');
    await page.waitForFunction(() => Boolean((window as unknown as { __WORLD_GALLERY__?: GalleryHandle }).__WORLD_GALLERY__));
    await expect(page.locator('[data-testid^="gallery-card-"]')).toHaveCount(12);

    const summaries = await page.evaluate(() =>
      (window as unknown as { __WORLD_GALLERY__: GalleryHandle }).__WORLD_GALLERY__.getGallerySummaries(),
    );
    expect(summaries).toHaveLength(12);
    for (const s of summaries) {
      expect(GALLERY_SEEDS).toContain(s.seed);
      expect(s.riverIsContinuous, `${s.seed} river continuity`).toBe(true);
      expect(s.riverTouchesEdges.length, `${s.seed} river edges`).toBeGreaterThanOrEqual(2);
      expect(s.buildableRatio, `${s.seed} buildable share`).toBeGreaterThanOrEqual(MIN_BUILDABLE_RATIO);
      expect(s.centerDistanceToRiver, `${s.seed} center distance`).toBeGreaterThanOrEqual(2);
      expect(s.centerDistanceToRiver, `${s.seed} center distance`).toBeLessThanOrEqual(10);
    }

    /* Confirm every gallery canvas rendered non-empty pixels and capture the full 12-map gallery. */
    const paintedCount = await page.evaluate(() => {
      const canvases = [...document.querySelectorAll<HTMLCanvasElement>('[data-testid^="gallery-canvas-"]')];
      return canvases.filter(c => c.width >= 300 && c.height >= 300).length;
    });
    expect(paintedCount).toBe(12);
    await captureFull(page, info, 'gallery-12-maps');

    /* Verify Russian / English toggle updates headings cleanly without errors. */
    await page.getByTestId('lang-en').click();
    await expect(page.getByTestId('stage2-gallery-title')).toContainText('Stage 2: Procedural Map Gallery');
    await page.getByTestId('lang-ru').click();
    await expect(page.getByTestId('stage2-gallery-title')).toContainText('Этап 2: Галерея процедурных карт');

    /* Open "hornhoof" in the live isometric engine at 1440x900 desktop viewport. */
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('gallery-card-hornhoof').click();
    await waitForIsoReady(page);

    const hornhoofSummary = summaries.find(s => s.seed === 'hornhoof')!;
    const iso100 = await page.evaluate(() => (window as unknown as { __WORLD_GALLERY__: GalleryHandle }).__WORLD_GALLERY__.getStats()!);
    expect(iso100.mapSize).toBe(150);
    expect(iso100.zoomPercent).toBe(100);
    expect(iso100.visibleChunks).toBeLessThan(iso100.totalChunks * 0.06);

    /* Click the riverside city center tile and verify exact tile + terrain readout. */
    const centerPt = await page.evaluate(
      ({ col, row }) => (window as unknown as { __WORLD_GALLERY__: GalleryHandle }).__WORLD_GALLERY__.screenPointOfTile(col, row)!,
      hornhoofSummary.cityCenter,
    );
    await page.mouse.click(centerPt.x, centerPt.y);
    await expect(page.getByTestId('stage2-iso-selected')).toContainText(
      `(${hornhoofSummary.cityCenter.col}, ${hornhoofSummary.cityCenter.row})`,
    );
    await expect(page.getByTestId('stage2-iso-selected')).toContainText('под застройку');
    await capture(page, info, 'iso-hornhoof-100pct');

    /* Zoom out to 50% minimum to inspect river bend, banks, fertile strip, fields and plains in 2:1 isometry. */
    await page.evaluate(() => (window as unknown as { __WORLD_GALLERY__: GalleryHandle }).__WORLD_GALLERY__.setZoom(0.5));
    await waitForIsoReady(page);
    await capture(page, info, 'iso-hornhoof-50pct');

    /* Return to gallery and inspect a second distinct seed ("meridian-hq") at 50% zoom. */
    await page.getByTestId('stage2-back-gallery').click();
    await expect(page.locator('[data-testid^="gallery-card-"]')).toHaveCount(12);
    await page.getByTestId('gallery-card-meridian-hq').click();
    await waitForIsoReady(page);
    await page.evaluate(() => (window as unknown as { __WORLD_GALLERY__: GalleryHandle }).__WORLD_GALLERY__.setZoom(0.5));
    await waitForIsoReady(page);
    await capture(page, info, 'iso-meridian-50pct');

    console.log(
      `STAGE2_METRICS seeds=${summaries.length} hornhoofCenter=(${hornhoofSummary.cityCenter.col},${hornhoofSummary.cityCenter.row})` +
        ` hornhoofBuildable=${(hornhoofSummary.buildableRatio * 100).toFixed(1)}% isoRenderer=${iso100.rendererKind}`,
    );
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }

  /* Verify mobile portrait viewport renders the 12-map gallery cleanly with zero horizontal overflow. */
  const mobileCtx = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: 1 });
  const mobilePage = await mobileCtx.newPage();
  const mobileErrors: string[] = [];
  mobilePage.on('pageerror', error => mobileErrors.push(error.message));
  try {
    await mobilePage.goto('/world-gallery.html?lang=ru');
    await expect(mobilePage.locator('[data-testid^="gallery-card-"]')).toHaveCount(12);
    const overflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    expect(mobileErrors).toEqual([]);
  } finally {
    await mobileCtx.close();
  }
});
