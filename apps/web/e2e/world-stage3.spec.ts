import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CityTileBreakdown } from '../src/world/city-layout';
import { captureWith } from './capture';

/* Stage 3 live browser verification:
   1. 5-year accelerated Egypt city growth timelapse video (hornhoof) + Year 1, Year 2 and Year 5 snapshots.
   2. 3-seed x 3-Order/Chaos comparison grid at Year 5.
   3. Full 5-year Dungeon subterranean city (carving halls out of solid bedrock) at Year 5. */

const capture = captureWith('stage3', process.env.HH_SCREENSHOT_DIR);

async function captureFull(page: Page, info: TestInfo, name: string): Promise<void> {
  const file = `stage3-${name}.png`;
  const dir = process.env.HH_SCREENSHOT_DIR;
  const path = dir ? join(dir, file) : info.outputPath(file);
  await page.screenshot({ path, fullPage: true });
  await info.attach(file, { path, contentType: 'image/png' });
}

type CitySimHandle = {
  setPack: (packId: string) => void;
  setMode: (mode: 'timelapse' | 'matrix') => void;
  setSeed: (seed: string) => void;
  setKnob: (knob: number) => void;
  setMonth: (month: number) => void;
  setLang: (lang: 'ru' | 'en') => void;
  getCurrentSummary: () => {
    packId: string;
    seed: string;
    orderChaos: number;
    month: number;
    agents: number;
    tasks: number;
    goals: number;
    wallGeneration: number;
    buildings: number;
    excavatedTiles: number;
    breakdown: CityTileBreakdown;
  };
};

test('Stage 3 records 5-year Egypt timelapse, 3x3 Order/Chaos grid and Dungeon carved-halls simulation', async ({ browser }, info: TestInfo) => {
  const shotDir = process.env.HH_SCREENSHOT_DIR;
  const videoDir = info.outputPath('stage3-video');
  if (shotDir) mkdirSync(shotDir, { recursive: true });
  mkdirSync(videoDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 880 },
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size: { width: 1280, height: 880 } },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  try {
    await page.goto('/world-city.html?lang=ru&pack=egypt');
    await page.waitForFunction(() => Boolean((window as unknown as { __WORLD_CITY_SIM__?: CitySimHandle }).__WORLD_CITY_SIM__));

    /* Step smoothly through Months 1..60 so the accelerated growth timelapse records clearly. */
    for (let m = 1; m <= 60; m += 2) {
      await page.evaluate(month => {
        (window as unknown as { __WORLD_CITY_SIM__: CitySimHandle }).__WORLD_CITY_SIM__.setMonth(month);
      }, m);
      await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
      if (m === 11) {
        await page.evaluate(() => (window as unknown as { __WORLD_CITY_SIM__: CitySimHandle }).__WORLD_CITY_SIM__.setMonth(12));
        await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
        await capture(page, info, 'year1-hornhoof');
      } else if (m === 23) {
        await page.evaluate(() => (window as unknown as { __WORLD_CITY_SIM__: CitySimHandle }).__WORLD_CITY_SIM__.setMonth(24));
        await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
        await capture(page, info, 'year2-hornhoof');
      }
      await page.waitForTimeout(140);
    }

    await page.evaluate(() => (window as unknown as { __WORLD_CITY_SIM__: CitySimHandle }).__WORLD_CITY_SIM__.setMonth(60));
    await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const y5 = await page.evaluate(() => (window as unknown as { __WORLD_CITY_SIM__: CitySimHandle }).__WORLD_CITY_SIM__.getCurrentSummary());
    expect(y5.agents).toBe(150);
    expect(y5.tasks).toBe(160000);
    expect(y5.goals).toBe(30);
    expect(y5.wallGeneration).toBeGreaterThanOrEqual(2);
    await capture(page, info, 'year5-hornhoof');
    await page.waitForTimeout(600);

    expect(errors).toEqual([]);
  } finally {
    const video = page.video();
    await context.close();
    if (video && shotDir) {
      const recordedPath = await video.path();
      copyFileSync(recordedPath, join(shotDir, 'stage3-timelapse-5yr.webm'));
    }
  }

  /* Capture full 3-seed x 3-Order/Chaos Egypt comparison matrix AND 5-year Dungeon subterranean city. */
  const matrixCtx = await browser.newContext({ viewport: { width: 1440, height: 1440 }, deviceScaleFactor: 1 });
  const matrixPage = await matrixCtx.newPage();
  const matrixErrors: string[] = [];
  matrixPage.on('pageerror', error => matrixErrors.push(error.message));
  try {
    await matrixPage.goto('/world-city.html?lang=ru&pack=egypt&mode=matrix');
    await expect(matrixPage.locator('[data-testid^="matrix-card-"]')).toHaveCount(9);
    await matrixPage.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    await captureFull(matrixPage, info, 'order-vs-chaos');

    /* Switch to Dungeon pack in timelapse mode at Month 60 to verify carved underground halls & corridors. */
    await matrixPage.setViewportSize({ width: 1280, height: 880 });
    await matrixPage.getByTestId('pack-dungeon').click();
    await matrixPage.getByTestId('mode-timelapse').click();
    await matrixPage.evaluate(() => (window as unknown as { __WORLD_CITY_SIM__: CitySimHandle }).__WORLD_CITY_SIM__.setMonth(60));
    await matrixPage.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const dungeonY5 = await matrixPage.evaluate(() =>
      (window as unknown as { __WORLD_CITY_SIM__: CitySimHandle }).__WORLD_CITY_SIM__.getCurrentSummary(),
    );
    expect(dungeonY5.packId).toBe('dungeon');
    expect(dungeonY5.agents).toBe(150);
    expect(dungeonY5.excavatedTiles).toBeGreaterThan(1500);
    await capture(matrixPage, info, 'dungeon-year5-hornhoof');

    /* Verify Russian / English toggle works cleanly. */
    await matrixPage.getByTestId('lang-en').click();
    await expect(matrixPage.getByTestId('stage3-title')).toContainText('Stage 3: 5-Year City Growth');
    expect(matrixErrors).toEqual([]);
  } finally {
    await matrixCtx.close();
  }
});
