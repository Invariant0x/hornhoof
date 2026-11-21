import { chromium, expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CityBuilding } from '../src/world/city-layout';
import type { LiveCitySummary } from '../src/world/live-sync';
import type { RendererDebugInfo, WorldEngineStats } from '../src/world/renderer';
import { captureWith } from './capture';

/* Stage 4 live data, God's Word relocation confirmation workflow, Dungeon no-outer-wall proof,
   and real hardware GPU 60 FPS benchmark (without video-recording throttling). */

const capture = captureWith('stage4', process.env.HH_SCREENSHOT_DIR);

type LiveHandle = {
  getStats: () => WorldEngineStats | null;
  getDebugInfo: () => RendererDebugInfo | null;
  getSummary: () => LiveCitySummary | null;
  getBuildings: () => readonly CityBuilding[];
  setZoom: (zoom: number) => void;
  panByScreen: (dx: number, dy: number) => void;
  flushVisibleBakes: () => void;
  centerOnBuilding: (buildingId: string, zoom?: number) => boolean;
  setScenario: (scenario: 'hornhoof' | 'empty' | 'no_subscription' | 'live', pack?: 'egypt' | 'dungeon') => void;
  triggerRelocationModal: (
    buildingId?: string,
  ) => { buildingId: string; fromCol: number; fromRow: number; toCol: number; toRow: number } | null;
};

type DemoHandle = {
  setZoom: (zoom: number) => void;
  panByScreen: (dx: number, dy: number) => void;
  flushVisibleBakes: () => void;
  getStats: () => WorldEngineStats;
  getDebugInfo: () => RendererDebugInfo;
};

async function waitForLiveReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const h = (window as unknown as { __WORLD_LIVE__?: LiveHandle }).__WORLD_LIVE__;
    return Boolean(h && h.getSummary() && h.getStats());
  });
  await page.evaluate(() => {
    const h = (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__;
    h.flushVisibleBakes();
  });
  await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

async function measurePanZoomFps(
  page: Page,
  panFn: string,
  frames = 90,
): Promise<{
  frames: number;
  avgFrameMs: number;
  p95FrameMs: number;
  fps: number;
  minFps: number;
}> {
  return page.evaluate(
    ({ count, kind }) =>
      new Promise(resolve => {
        const deltas: number[] = [];
        let last = performance.now();
        let i = 0;

        const tick = (now: number) => {
          const dt = now - last;
          last = now;
          if (i > 0) deltas.push(dt);

          const dx = Math.cos(i * 0.14) * 9;
          const dy = Math.sin(i * 0.14) * 5;
          if (kind === 'demo') {
            const h = (window as unknown as { __WORLD_DEMO__: DemoHandle }).__WORLD_DEMO__;
            h.panByScreen(dx, dy);
          } else {
            const h = (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__;
            h.panByScreen(dx, dy);
          }

          i++;
          if (i <= count) {
            requestAnimationFrame(tick);
          } else {
            const sorted = [...deltas].sort((a, b) => a - b);
            const avg = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
            const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? avg;
            const maxDt = sorted[sorted.length - 1] ?? avg;
            resolve({
              frames: deltas.length,
              avgFrameMs: Math.round(avg * 100) / 100,
              p95FrameMs: Math.round(p95 * 100) / 100,
              fps: Math.round((1000 / Math.max(1, avg)) * 10) / 10,
              minFps: Math.round((1000 / Math.max(1, maxDt)) * 10) / 10,
            });
          }
        };

        requestAnimationFrame(tick);
      }),
    { count: frames, kind: panFn },
  );
}

test('Stage 4 renders live Hornhoof city (100%/200%), empty lot, no-subscription resting state, Dungeon without outer wall, and God\'s Word relocation confirmation', async ({
  browser,
}, info: TestInfo) => {
  const shotDir = process.env.HH_SCREENSHOT_DIR;
  if (shotDir) mkdirSync(shotDir, { recursive: true });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  try {
    /* 1. Live Hornhoof team scale on Egypt pack (100% default + 200% close-up). */
    await page.goto('/world-live.html?mode=hornhoof&pack=egypt&zoom=100&lang=ru');
    await waitForLiveReady(page);

    const summary = await page.evaluate(() => (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.getSummary()!);
    expect(summary.worldMode).toBe('active');
    expect(summary.agentsCount).toBe(56);
    expect(summary.machinesCount).toBe(5);
    expect(summary.subscriptionsCount).toBe(11);
    expect(summary.acceptedTasksTotal).toBe(944);
    expect(summary.topAgentLevel).toBeGreaterThanOrEqual(6);
    expect(summary.goalsCount).toBe(3);
    expect(summary.reachedGoalsCount).toBe(1);
    expect(summary.statuesCount).toBeGreaterThanOrEqual(4);
    expect(summary.wallTilesCount).toBeGreaterThan(0);

    await capture(page, info, 'hornhoof-live-100pct');

    /* Zoom to 200% on the central palace/monument square. */
    await page.evaluate(() => {
      const h = (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__;
      h.centerOnBuilding('residence-main', 2.0);
    });
    await waitForLiveReady(page);
    await capture(page, info, 'hornhoof-live-200pct');

    /* 2. God's Word relocation confirmation modal ("Вы действительно хотите перестроить ...? Да / Нет"). */
    await page.evaluate(() => {
      const h = (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__;
      h.setZoom(1.0);
      h.flushVisibleBakes();
    });
    const relTarget = await page.evaluate(() =>
      (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.triggerRelocationModal(),
    );
    expect(relTarget).not.toBeNull();
    await expect(page.getByTestId('world-stage4-confirm-modal')).toBeVisible();
    await expect(page.getByTestId('world-stage4-confirm-modal')).toContainText('Вы действительно хотите перестроить');
    await capture(page, info, 'relocate-confirm');

    /* Click "Нет": modal closes, coordinates remain completely unchanged. */
    await page.getByTestId('world-stage4-confirm-no').click();
    await expect(page.getByTestId('world-stage4-confirm-modal')).toBeHidden();
    const afterNo = await page.evaluate(
      id => (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.getBuildings().find(b => b.id === id)!,
      relTarget!.buildingId,
    );
    expect(afterNo.col).toBe(relTarget!.fromCol);
    expect(afterNo.row).toBe(relTarget!.fromRow);

    /* Re-open and click "Да": creates pending task, building stays at old tile until task is accepted! */
    await page.evaluate(
      id => (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.triggerRelocationModal(id),
      relTarget!.buildingId,
    );
    await page.getByTestId('world-stage4-confirm-yes').click();
    await expect(page.getByTestId('world-stage4-pending-relocation')).toBeVisible();
    const whilePending = await page.evaluate(
      id => (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.getBuildings().find(b => b.id === id)!,
      relTarget!.buildingId,
    );
    expect(whilePending.col).toBe(relTarget!.fromCol);
    expect(whilePending.row).toBe(relTarget!.fromRow);

    /* Cancel the task: building remains at old tile! */
    await page.getByTestId('world-stage4-cancel-relocation').click();
    await expect(page.getByTestId('world-stage4-pending-relocation')).toBeHidden();
    const afterCancel = await page.evaluate(
      id => (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.getBuildings().find(b => b.id === id)!,
      relTarget!.buildingId,
    );
    expect(afterCancel.col).toBe(relTarget!.fromCol);
    expect(afterCancel.row).toBe(relTarget!.fromRow);

    /* Confirm again and ACCEPT the task (done): building moves cleanly to destination tile! */
    await page.evaluate(
      id => (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.triggerRelocationModal(id),
      relTarget!.buildingId,
    );
    await page.getByTestId('world-stage4-confirm-yes').click();
    await page.getByTestId('world-stage4-accept-relocation').click();
    const afterDone = await page.evaluate(
      id => (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.getBuildings().find(b => b.id === id)!,
      relTarget!.buildingId,
    );
    expect(afterDone.col).toBe(relTarget!.toCol);
    expect(afterDone.row).toBe(relTarget!.toRow);

    /* 3. Brand-new empty company without template -> empty_lot (stakes, boards, starter tent). */
    await page.goto('/world-live.html?mode=empty&pack=egypt&zoom=100&lang=ru');
    await waitForLiveReady(page);
    const emptySummary = await page.evaluate(() => (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.getSummary()!);
    expect(emptySummary.worldMode).toBe('empty_lot');
    expect(emptySummary.departmentsCount).toBe(0);
    expect(emptySummary.agentsCount).toBe(0);
    expect(emptySummary.wallTilesCount).toBe(0);
    await capture(page, info, 'empty-company');

    /* 4. Template company without active subscription -> Stage 1 starter city, everyone resting. */
    await page.goto('/world-live.html?mode=no_subscription&pack=egypt&zoom=100&lang=ru');
    await waitForLiveReady(page);
    const noSubSummary = await page.evaluate(() => (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.getSummary()!);
    expect(noSubSummary.worldMode).toBe('no_subscription');
    expect(noSubSummary.activeSubscriptionsCount).toBe(0);
    await capture(page, info, 'no-subscription');

    /* 5. Dungeon pack on the exact same live Hornhoof data -> ZERO outer wall (bedrock boundary). */
    await page.goto('/world-live.html?mode=hornhoof&pack=dungeon&zoom=100&lang=ru');
    await waitForLiveReady(page);
    const dungeonSummary = await page.evaluate(() => (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.getSummary()!);
    expect(dungeonSummary.worldMode).toBe('active');
    expect(dungeonSummary.agentsCount).toBe(56);
    expect(dungeonSummary.wallTilesCount).toBe(0);
    await capture(page, info, 'dungeon-no-wall');

    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Stage 4 real hardware GPU FPS benchmark (Stage 1 empty 150x150 + Stage 4 live Hornhoof city, no video throttling)', async ({
  baseURL,
}) => {
  const gpuArgs =
    process.platform === 'darwin'
      ? ['--use-gl=angle', '--use-angle=metal', '--enable-webgl', '--ignore-gpu-blocklist']
      : ['--enable-webgl', '--ignore-gpu-blocklist'];

  const gpuBrowser = await chromium.launch({
    headless: true,
    channel: process.env.PLAYWRIGHT_CHANNEL,
    args: gpuArgs,
  });

  try {
    const context = await gpuBrowser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();

    /* Benchmark A: Stage 1 empty 150x150 diamond map (pre-warmed chunks, smooth drag-panning). */
    await page.goto(`${baseURL}/world-demo.html`);
    await page.waitForFunction(() => Boolean((window as unknown as { __WORLD_DEMO__?: DemoHandle }).__WORLD_DEMO__));
    await page.evaluate(() => {
      const h = (window as unknown as { __WORLD_DEMO__: DemoHandle }).__WORLD_DEMO__;
      h.flushVisibleBakes();
    });
    await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const stage1Debug = await page.evaluate(() => (window as unknown as { __WORLD_DEMO__: DemoHandle }).__WORLD_DEMO__.getDebugInfo());
    const stage1Perf = await measurePanZoomFps(page, 'demo', 90);

    /* Benchmark B: Stage 4 live Hornhoof city (smooth blended terrain + animated liquid + 56 homes + 5 hubs + 11 supplies + pyramids + walls). */
    await page.goto(`${baseURL}/world-live.html?mode=hornhoof&pack=egypt&zoom=100&lang=ru`);
    await waitForLiveReady(page);
    const stage4Debug = await page.evaluate(() => (window as unknown as { __WORLD_LIVE__: LiveHandle }).__WORLD_LIVE__.getDebugInfo());
    const stage4Perf = await measurePanZoomFps(page, 'live', 90);

    const isSoftwareGl = /swiftshader|llvmpipe|software/i.test(stage4Debug?.glRenderer ?? '');
    const report = {
      platform: process.platform,
      arch: process.arch,
      gpuArgs,
      isSoftwareGl,
      stage1: { debug: stage1Debug, perf: stage1Perf },
      stage4: { debug: stage4Debug, perf: stage4Perf },
    };
    console.log('STAGE4_GPU_FPS_BENCHMARK', JSON.stringify(report));

    if (process.env.HH_SCREENSHOT_DIR) {
      mkdirSync(process.env.HH_SCREENSHOT_DIR, { recursive: true });
      writeFileSync(join(process.env.HH_SCREENSHOT_DIR, 'stage4-gpu-fps.json'), JSON.stringify(report, null, 2));
    }

    expect(stage1Debug.rendererKind).toBe('webgl');
    expect(stage4Debug?.rendererKind).toBe('webgl');
    if (!isSoftwareGl) {
      expect(stage1Perf.fps, `Stage 1 real GPU FPS (${stage1Debug.glRenderer})`).toBeGreaterThanOrEqual(55);
      expect(stage4Perf.fps, `Stage 4 real GPU FPS (${stage4Debug?.glRenderer})`).toBeGreaterThanOrEqual(55);
    } else {
      expect(stage1Perf.fps).toBeGreaterThanOrEqual(20);
      expect(stage4Perf.fps).toBeGreaterThanOrEqual(20);
    }

    await context.close();
  } finally {
    await gpuBrowser.close();
  }
});
