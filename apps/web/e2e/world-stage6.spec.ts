import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WorldEngineStats } from '../src/world/renderer';
import { captureWith } from './capture';

/* Stage 6 construction stages, building animation loops, resident work slots, 20-stage statue alleys,
   tiered pyramid with golden capstone celebration, reverse-order demolition and stage-by-stage
   God's Word relocation E2E verification. */

test.describe.configure({ mode: 'serial' });

const capture = captureWith('stage6', process.env.HH_SCREENSHOT_DIR);

type Stage6Readout = {
  mode: 'build' | 'demolish';
  pack: 'egypt' | 'dungeon';
  progress: number;
  buildingStage: number;
  buildingStageId: string;
  statueStage: number;
  statuesCompleted: number;
  monumentTier: number;
  monumentReached: boolean;
  demolishStage: number;
  relocateOldStage: number;
  relocateNewStage: number;
};

type Stage6Handle = {
  getStats: () => WorldEngineStats | null;
  getState: () => Stage6Readout;
  setProgress: (p: number) => void;
  setPlaying: (playing: boolean) => void;
  setMode: (mode: 'build' | 'demolish') => void;
  setPack: (pack: 'egypt' | 'dungeon') => void;
  setZoom: (zoom: number) => void;
  centerOn: (target: 'plaza' | 'building' | 'statues' | 'pyramid' | 'demolish' | 'relocate', zoom?: number) => void;
  panByScreen: (dx: number, dy: number) => void;
  flushVisibleBakes: () => void;
};

async function waitForStage6Ready(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const h = (window as unknown as { __WORLD_STAGE6__?: Stage6Handle }).__WORLD_STAGE6__;
    return Boolean(h && h.getStats() && h.getState());
  });
  await page.evaluate(() => {
    (window as unknown as { __WORLD_STAGE6__: Stage6Handle }).__WORLD_STAGE6__.flushVisibleBakes();
  });
  await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

test('Stage 6 records accelerated construction timelapse video (building 1..10, statue alley 1..20, pyramid + golden capstone)', async ({
  browser,
}, info: TestInfo) => {
  const shotDir = process.env.HH_SCREENSHOT_DIR;
  if (shotDir) mkdirSync(shotDir, { recursive: true });
  const videoDir = shotDir ? join(shotDir, '.video-stage6-build-tmp') : info.outputPath('stage6-build-video');
  mkdirSync(videoDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));

  try {
    await page.goto('/world-construction.html?mode=build&pack=egypt&zoom=78&lang=ru&autoplay=0');
    await waitForStage6Ready(page);

    const seenBuildingStages = new Set<number>();
    const steps = 28;
    for (let i = 0; i <= steps; i++) {
      const p = i / steps;
      const st = await page.evaluate(val => {
        const h = (window as unknown as { __WORLD_STAGE6__: Stage6Handle }).__WORLD_STAGE6__;
        h.setProgress(val);
        h.flushVisibleBakes();
        return h.getState();
      }, p);
      seenBuildingStages.add(st.buildingStage);
      await page.waitForTimeout(160);
    }

    /* Hold briefly at 100% so the golden capstone & celebration loop sparkle visibly in the video. */
    await page.waitForTimeout(900);
    const finalState = await page.evaluate(() =>
      (window as unknown as { __WORLD_STAGE6__: Stage6Handle }).__WORLD_STAGE6__.getState(),
    );
    expect(seenBuildingStages.size).toBeGreaterThanOrEqual(9);
    expect(finalState.buildingStage).toBe(10);
    expect(finalState.statuesCompleted).toBeGreaterThanOrEqual(1);
    expect(finalState.monumentReached).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    const video = page.video();
    await context.close();
    if (video && shotDir) {
      const recordedPath = await video.path();
      copyFileSync(recordedPath, join(shotDir, 'stage6-build-timelapse.webm'));
    }
  }
});

test('Stage 6 records accelerated reverse demolition (10 -> 0) and stage-by-stage God\'s Word relocation video', async ({
  browser,
}, info: TestInfo) => {
  const shotDir = process.env.HH_SCREENSHOT_DIR;
  if (shotDir) mkdirSync(shotDir, { recursive: true });
  const videoDir = shotDir ? join(shotDir, '.video-stage6-demolish-tmp') : info.outputPath('stage6-demolish-video');
  mkdirSync(videoDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));

  try {
    await page.goto('/world-construction.html?mode=demolish&pack=egypt&zoom=82&lang=ru&autoplay=0');
    await waitForStage6Ready(page);

    const demolishTrace: number[] = [];
    const steps = 28;
    for (let i = 0; i <= steps; i++) {
      const p = i / steps;
      const st = await page.evaluate(val => {
        const h = (window as unknown as { __WORLD_STAGE6__: Stage6Handle }).__WORLD_STAGE6__;
        h.setProgress(val);
        h.flushVisibleBakes();
        return h.getState();
      }, p);
      if (demolishTrace[demolishTrace.length - 1] !== st.demolishStage) {
        demolishTrace.push(st.demolishStage);
      }
      await page.waitForTimeout(160);
    }

    await page.waitForTimeout(700);
    const finalState = await page.evaluate(() =>
      (window as unknown as { __WORLD_STAGE6__: Stage6Handle }).__WORLD_STAGE6__.getState(),
    );
    expect(demolishTrace[0]).toBe(10);
    expect(demolishTrace[demolishTrace.length - 1]).toBe(0);
    for (let i = 1; i < demolishTrace.length; i++) {
      expect(demolishTrace[i]!).toBeLessThan(demolishTrace[i - 1]!);
    }
    expect(finalState.relocateOldStage).toBe(0);
    expect(finalState.relocateNewStage).toBe(10);
    expect(errors).toEqual([]);
  } finally {
    const video = page.video();
    await context.close();
    if (video && shotDir) {
      const recordedPath = await video.path();
      copyFileSync(recordedPath, join(shotDir, 'stage6-demolish-relocate.webm'));
    }
  }
});

test('Stage 6 captures building stages, 20-stage statue alley, pyramid celebration, reverse demolition, live city loops and Dungeon modularity', async ({
  browser,
}, info: TestInfo) => {
  const shotDir = process.env.HH_SCREENSHOT_DIR;
  if (shotDir) mkdirSync(shotDir, { recursive: true });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));

  try {
    /* 1. Close-up on building Stage 4: open interior rooms with masons + scaffolding + ramp + jib crane + sled! */
    await page.goto('/world-construction.html?mode=build&pack=egypt&zoom=100&lang=ru&autoplay=0');
    await waitForStage6Ready(page);
    await page.evaluate(() => {
      const h = (window as unknown as { __WORLD_STAGE6__: Stage6Handle }).__WORLD_STAGE6__;
      h.setProgress(0.35);
      h.centerOn('building', 1.4);
    });
    await page.waitForTimeout(250);
    const sBuild = await page.evaluate(() =>
      (window as unknown as { __WORLD_STAGE6__: Stage6Handle }).__WORLD_STAGE6__.getState(),
    );
    expect(sBuild.buildingStageId).toBe('waist_walls_scaffold');
    await capture(page, info, 'building-stages');

    /* 2. Close-up on 20-stage Statue Alley (Statue #1 finished 20/20 stays + Statue #2 larger 2x2 carving!). */
    await page.evaluate(() => {
      const h = (window as unknown as { __WORLD_STAGE6__: Stage6Handle }).__WORLD_STAGE6__;
      h.setProgress(0.75);
      h.centerOn('statues', 1.35);
    });
    await page.waitForTimeout(250);
    const sStatues = await page.evaluate(() =>
      (window as unknown as { __WORLD_STAGE6__: Stage6Handle }).__WORLD_STAGE6__.getState(),
    );
    expect(sStatues.statuesCompleted).toBeGreaterThanOrEqual(1);
    await capture(page, info, 'statue-alley-20');

    /* 3. Completed Pyramid with golden capstone & celebration sparkles + upgraded building & supply water loop. */
    await page.evaluate(() => {
      const h = (window as unknown as { __WORLD_STAGE6__: Stage6Handle }).__WORLD_STAGE6__;
      h.setProgress(0.96);
      h.centerOn('plaza', 0.85);
    });
    await page.waitForTimeout(300);
    const sPyr = await page.evaluate(() =>
      (window as unknown as { __WORLD_STAGE6__: Stage6Handle }).__WORLD_STAGE6__.getState(),
    );
    expect(sPyr.monumentReached).toBe(true);
    await capture(page, info, 'pyramid-celebration');

    /* 4. Mid-transition Demolition (reverse stages) & God's Word Relocation (old site dismantling + new site rising!). */
    await page.goto('/world-construction.html?mode=demolish&pack=egypt&zoom=90&lang=ru&autoplay=0');
    await waitForStage6Ready(page);
    await page.evaluate(() => {
      const h = (window as unknown as { __WORLD_STAGE6__: Stage6Handle }).__WORLD_STAGE6__;
      h.setProgress(0.45);
      h.centerOn('plaza', 0.9);
    });
    await page.waitForTimeout(250);
    const sDem = await page.evaluate(() =>
      (window as unknown as { __WORLD_STAGE6__: Stage6Handle }).__WORLD_STAGE6__.getState(),
    );
    expect(sDem.demolishStage).toBeGreaterThan(0);
    expect(sDem.demolishStage).toBeLessThan(10);
    expect(sDem.relocateOldStage).toBeGreaterThan(0);
    expect(sDem.relocateNewStage).toBeGreaterThan(1);
    await capture(page, info, 'demolish-reverse');

    /* 5. Live Hornhoof team city with Stage 6 loops active alongside Stage 5 residents. */
    await page.goto('/world-live.html?mode=hornhoof&pack=egypt&zoom=100&lang=ru');
    await page.waitForFunction(() => {
      const h = (window as unknown as { __WORLD_LIVE__?: { getStats: () => WorldEngineStats | null } }).__WORLD_LIVE__;
      return Boolean(h && h.getStats());
    });
    await page.evaluate(() => {
      const h = (window as unknown as { __WORLD_LIVE__: { flushVisibleBakes: () => void } }).__WORLD_LIVE__;
      h.flushVisibleBakes();
    });
    await page.waitForTimeout(350);
    await capture(page, info, 'live-city-loops');

    /* 6. Dungeon pack running the exact same Stage 6 construction, statue alley & pyramid showcase (100% modular). */
    await page.goto('/world-construction.html?mode=build&pack=dungeon&zoom=85&lang=ru&autoplay=0');
    await waitForStage6Ready(page);
    await page.evaluate(() => {
      const h = (window as unknown as { __WORLD_STAGE6__: Stage6Handle }).__WORLD_STAGE6__;
      h.setProgress(0.42);
      h.centerOn('plaza', 0.85);
    });
    await page.waitForTimeout(250);
    await capture(page, info, 'dungeon-construction');

    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
