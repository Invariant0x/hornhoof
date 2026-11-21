import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WorldEngineStats } from '../src/world/renderer';
import { GALLERY_SEEDS } from '../src/world/terrain-engine';
import { captureWith } from './capture';

/* Stage 2 live browser verification:
   1. Pack-owned procedural recipes: 12-seed gallery for BOTH Ancient Egypt and Subterranean Dungeon.
   2. Smooth blended textures + curved shoreline without staircase + separate animated liquid layer +
      build-grid hidden by default (visible only on toggle) at 100% and 200% zoom on hornhoof. */

const capture = captureWith('stage2', process.env.HH_SCREENSHOT_DIR);

async function captureFull(page: Page, info: TestInfo, name: string): Promise<void> {
  const file = `stage2-${name}.png`;
  const dir = process.env.HH_SCREENSHOT_DIR;
  const path = dir ? join(dir, file) : info.outputPath(file);
  await page.screenshot({ path, fullPage: true });
  await info.attach(file, { path, contentType: 'image/png' });
}

type GallerySummary = Readonly<{
  packId: string;
  seed: string;
  buildableRatio: number;
  continuityOk: boolean;
  continuityEdges: readonly string[];
  startCenter: { col: number; row: number };
  centerDistanceToLiquid: number;
}>;

type GalleryHandle = {
  setPack: (packId: string) => void;
  openSeed: (seed: string) => void;
  backToGallery: () => void;
  setLang: (lang: 'ru' | 'en') => void;
  setZoom: (zoom: number) => void;
  setBuildGridVisible: (visible: boolean) => void;
  focusTile: (col: number, row: number) => void;
  focusNearestShore: () => { col: number; row: number };
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
    (window as unknown as { __WORLD_GALLERY__: GalleryHandle }).__WORLD_GALLERY__.flushVisibleBakes();
  });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test('Stage 2 gallery supports Egypt and Dungeon packs and renders smooth non-staircased shorelines at 100% and 200%', async ({ browser }, info: TestInfo) => {
  const shotDir = process.env.HH_SCREENSHOT_DIR;
  if (shotDir) mkdirSync(shotDir, { recursive: true });

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
    /* 1. Ancient Egypt 12-seed gallery. */
    await page.goto('/world-gallery.html?lang=ru&pack=egypt');
    await page.waitForFunction(() => Boolean((window as unknown as { __WORLD_GALLERY__?: GalleryHandle }).__WORLD_GALLERY__));
    await expect(page.locator('[data-testid^="gallery-card-"]')).toHaveCount(12);

    const egyptSummaries = await page.evaluate(() =>
      (window as unknown as { __WORLD_GALLERY__: GalleryHandle }).__WORLD_GALLERY__.getGallerySummaries(),
    );
    expect(egyptSummaries).toHaveLength(12);
    for (const s of egyptSummaries) {
      expect(GALLERY_SEEDS).toContain(s.seed);
      expect(s.packId).toBe('egypt');
      expect(s.continuityOk).toBe(true);
      expect(s.buildableRatio).toBeGreaterThanOrEqual(0.55);
    }
    await captureFull(page, info, 'gallery-egypt-12');

    /* 2. Switch to Subterranean Dungeon pack -> exact same gallery shows 12 Dungeon maps. */
    await page.getByTestId('pack-dungeon').click();
    await expect(page.locator('[data-testid^="gallery-card-"]')).toHaveCount(12);
    const dungeonSummaries = await page.evaluate(() =>
      (window as unknown as { __WORLD_GALLERY__: GalleryHandle }).__WORLD_GALLERY__.getGallerySummaries(),
    );
    expect(dungeonSummaries).toHaveLength(12);
    for (const s of dungeonSummaries) {
      expect(s.packId).toBe('dungeon');
      expect(s.continuityOk).toBe(true);
      expect(s.buildableRatio).toBeGreaterThanOrEqual(0.65);
    }
    await captureFull(page, info, 'gallery-dungeon-12');

    /* Verify EN/RU language switch. */
    await page.getByTestId('lang-en').click();
    await expect(page.getByTestId('stage2-gallery-title')).toContainText('Stage 2: Pack-Owned Map Gallery');
    await page.getByTestId('lang-ru').click();

    /* 3. Open Dungeon "hornhoof" in the smooth isometric engine at 100% zoom (1440x900). */
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('gallery-card-hornhoof').click();
    await waitForIsoReady(page);
    const dungeonStats = await page.evaluate(() =>
      (window as unknown as { __WORLD_GALLERY__: GalleryHandle }).__WORLD_GALLERY__.getStats()!,
    );
    expect(dungeonStats.buildGridVisible).toBe(false);
    expect(dungeonStats.hasAnimatedLiquid).toBe(true);
    await capture(page, info, 'dungeon-hornhoof-100pct');

    /* 4. Open Ancient Egypt "hornhoof" and inspect smooth curved shoreline at 100% and 200% zoom. */
    await page.getByTestId('stage2-back-gallery').click();
    await page.getByTestId('pack-egypt').click();
    await page.getByTestId('gallery-card-hornhoof').click();
    await waitForIsoReady(page);

    const egypt100 = await page.evaluate(() =>
      (window as unknown as { __WORLD_GALLERY__: GalleryHandle }).__WORLD_GALLERY__.getStats()!,
    );
    expect(egypt100.zoomPercent).toBe(100);
    expect(egypt100.buildGridVisible).toBe(false);
    expect(egypt100.hasAnimatedLiquid).toBe(true);

    /* Focus cleanly on the smooth curved hornhoof riverbank at 100% (grid OFF). */
    await page.evaluate(() => (window as unknown as { __WORLD_GALLERY__: GalleryHandle }).__WORLD_GALLERY__.focusNearestShore());
    await waitForIsoReady(page);
    await capture(page, info, 'shore-hornhoof-100pct');

    /* Toggle Build Grid ON at 100% to verify grid appears cleanly only during build mode. */
    await page.getByTestId('stage2-toggle-grid').click();
    await waitForIsoReady(page);
    const gridOnStats = await page.evaluate(() =>
      (window as unknown as { __WORLD_GALLERY__: GalleryHandle }).__WORLD_GALLERY__.getStats()!,
    );
    expect(gridOnStats.buildGridVisible).toBe(true);
    await capture(page, info, 'shore-hornhoof-buildgrid-100pct');

    /* Turn Build Grid back OFF and zoom to 200% max zoom right on the smooth curved shoreline. */
    await page.getByTestId('stage2-toggle-grid').click();
    await page.evaluate(() => (window as unknown as { __WORLD_GALLERY__: GalleryHandle }).__WORLD_GALLERY__.setZoom(2.0));
    await waitForIsoReady(page);
    const egypt200 = await page.evaluate(() =>
      (window as unknown as { __WORLD_GALLERY__: GalleryHandle }).__WORLD_GALLERY__.getStats()!,
    );
    expect(egypt200.zoomPercent).toBe(200);
    expect(egypt200.buildGridVisible).toBe(false);
    await capture(page, info, 'shore-hornhoof-200pct');

    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }

  /* Verify mobile portrait viewport renders the multi-pack gallery with zero overflow. */
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
