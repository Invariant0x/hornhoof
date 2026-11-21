import { chromium, expect, test, type Page, type TestInfo } from '@playwright/test';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CityBuilding } from '../src/world/city-layout';
import type { TileCoord } from '../src/world/coords';
import type { LiveCitySummary } from '../src/world/live-sync';
import type { RendererDebugInfo, WorldEngineStats } from '../src/world/renderer';
import type { ResidentEntity } from '../src/world/residents';
import { captureWith } from './capture';

/* Stage 5 residents & behavior E2E verification:
   - records video of live Hornhoof team city with moving residents (stage5-live-residents.webm),
   - captures 100%, 200%, Agent Card (click + wake cooldown + agent window link), 7-states showcase,
     Dungeon pack modularity residents, and 150-resident scene,
   - benchmarks 150 simultaneous residents without video-recording throttling (stage5-150-perf.json). */

test.describe.configure({ mode: 'serial' });

const capture = captureWith('stage5', process.env.HH_SCREENSHOT_DIR);

type LiveStage5Handle = {
  getStats: () => WorldEngineStats | null;
  getDebugInfo: () => RendererDebugInfo | null;
  getSummary: () => LiveCitySummary | null;
  getBuildings: () => readonly CityBuilding[];
  getResidents: () => readonly ResidentEntity[];
  getAltarTile: () => TileCoord | null;
  getSimFlags: () => {
    smokingDepartments: string[];
    stuckDepartments: string[];
    nightDistricts: string[];
    scaffoldingHouses: string[];
  } | null;
  setZoom: (zoom: number) => void;
  panByScreen: (dx: number, dy: number) => void;
  flushVisibleBakes: () => void;
  centerOnBuilding: (buildingId: string, zoom?: number) => boolean;
  centerOnResident: (residentId: string, zoom?: number) => boolean;
  getResidentScreenPoint: (residentId: string) => { x: number; y: number } | null;
  selectResident: (residentId: string | null) => boolean;
  wakeResident: (agentId: string) => { allowed: boolean; remainingMs: number };
  setScenario: (
    scenario: 'hornhoof' | 'stress150' | 'empty' | 'no_subscription' | 'live',
    pack?: 'egypt' | 'dungeon',
  ) => void;
};

async function waitForStage5Ready(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const h = (window as unknown as { __WORLD_LIVE__?: LiveStage5Handle }).__WORLD_LIVE__;
    return Boolean(h && h.getSummary() && h.getStats() && h.getResidents().length > 0);
  });
  await page.evaluate(() => {
    (window as unknown as { __WORLD_LIVE__: LiveStage5Handle }).__WORLD_LIVE__.flushVisibleBakes();
  });
  await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

async function measureStress150Fps(
  page: Page,
  frames = 90,
): Promise<{
  frames: number;
  residentsCount: number;
  avgFrameMs: number;
  p95FrameMs: number;
  avgCpuStepMs: number;
  fps: number;
  minFps: number;
}> {
  return page.evaluate(
    count =>
      new Promise(resolve => {
        const deltas: number[] = [];
        const cpuSteps: number[] = [];
        let last = performance.now();
        let i = 0;

        const tick = (now: number) => {
          const dt = now - last;
          last = now;
          if (i > 0) deltas.push(dt);

          const h = (window as unknown as { __WORLD_LIVE__: LiveStage5Handle }).__WORLD_LIVE__;
          const dx = Math.cos(i * 0.14) * 9;
          const dy = Math.sin(i * 0.14) * 5;
          h.panByScreen(dx, dy);
          const s = h.getStats();
          if (s) cpuSteps.push(s.cpuStepMs);

          i++;
          if (i <= count) {
            requestAnimationFrame(tick);
          } else {
            const sorted = [...deltas].sort((a, b) => a - b);
            const avg = deltas.reduce((a, b) => a + b, 0) / Math.max(1, deltas.length);
            const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? avg;
            const maxDt = sorted[sorted.length - 1] ?? avg;
            const avgCpu = cpuSteps.reduce((a, b) => a + b, 0) / Math.max(1, cpuSteps.length);
            resolve({
              frames: deltas.length,
              residentsCount: h.getResidents().length,
              avgFrameMs: Math.round(avg * 100) / 100,
              p95FrameMs: Math.round(p95 * 100) / 100,
              avgCpuStepMs: Math.round(avgCpu * 100) / 100,
              fps: Math.round((1000 / Math.max(1, avg)) * 10) / 10,
              minFps: Math.round((1000 / Math.max(1, maxDt)) * 10) / 10,
            });
          }
        };

        requestAnimationFrame(tick);
      }),
    frames,
  );
}

test('Stage 5 records live residents video of Hornhoof team city', async ({ browser }, info: TestInfo) => {
  const shotDir = process.env.HH_SCREENSHOT_DIR;
  if (shotDir) mkdirSync(shotDir, { recursive: true });
  const videoDir = shotDir ? join(shotDir, '.video-stage5-tmp') : info.outputPath('stage5-video');
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
    await page.goto('/world-live.html?mode=hornhoof&pack=egypt&zoom=100&lang=ru');
    await waitForStage5Ready(page);

    /* Let live residents walk across streets at 100% zoom. */
    await page.waitForTimeout(1400);

    /* Gently pan to view central street, God's Altar, builders & heads. */
    for (let i = 0; i < 16; i++) {
      await page.evaluate(() => {
        (window as unknown as { __WORLD_LIVE__: LiveStage5Handle }).__WORLD_LIVE__.panByScreen(-14, -6);
      });
      await page.waitForTimeout(90);
    }

    /* Zoom to 200% on a working builder/turnkey resident to show cloak, outfit tier and carried stone clearly. */
    await page.evaluate(() => {
      const h = (window as unknown as { __WORLD_LIVE__: LiveStage5Handle }).__WORLD_LIVE__;
      const active =
        h.getResidents().find(r => r.carrying === 'stone' && r.liveState === 'working') ?? h.getResidents()[0];
      if (active) h.centerOnResident(active.id, 2.0);
    });
    await page.waitForTimeout(1300);

    /* Inspect waiting agent at God's Altar & smoking department, then open an Agent Card. */
    await page.evaluate(() => {
      const h = (window as unknown as { __WORLD_LIVE__: LiveStage5Handle }).__WORLD_LIVE__;
      const waiter = h.getResidents().find(r => r.liveState === 'waiting_human');
      if (waiter) h.centerOnResident(waiter.id, 1.35);
    });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const h = (window as unknown as { __WORLD_LIVE__: LiveStage5Handle }).__WORLD_LIVE__;
      const failed = h.getResidents().find(r => r.liveState === 'turn_failed');
      if (failed) h.centerOnResident(failed.id, 1.25);
    });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const h = (window as unknown as { __WORLD_LIVE__: LiveStage5Handle }).__WORLD_LIVE__;
      const turnkey = h.getResidents().find(r => r.roleClass === 'turnkey') ?? h.getResidents()[0];
      if (turnkey) {
        h.centerOnResident(turnkey.id, 1.5);
        h.selectResident(turnkey.id);
      }
    });
    await page.waitForTimeout(1000);

    expect(errors).toEqual([]);
  } finally {
    const video = page.video();
    await context.close();
    if (video && shotDir) {
      const recordedPath = await video.path();
      copyFileSync(recordedPath, join(shotDir, 'stage5-live-residents.webm'));
    }
  }
});

test('Stage 5 captures residents (100%/200%), interactive Agent Card + wake cooldown, 7 states, Dungeon pack and 150-resident city', async ({
  browser,
}, info: TestInfo) => {
  const shotDir = process.env.HH_SCREENSHOT_DIR;
  if (shotDir) mkdirSync(shotDir, { recursive: true });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));

  try {
    await page.goto('/world-live.html?mode=hornhoof&pack=egypt&zoom=100&lang=ru');
    await waitForStage5Ready(page);
    await page.waitForTimeout(350);

    /* Verify live resident population, flags and all 7 live states exist. */
    const snapshotInfo = await page.evaluate(() => {
      const h = (window as unknown as { __WORLD_LIVE__: LiveStage5Handle }).__WORLD_LIVE__;
      const rs = h.getResidents();
      return {
        count: rs.length,
        states: [...new Set(rs.map(r => r.liveState))],
        classes: [...new Set(rs.map(r => r.roleClass))],
        flags: h.getSimFlags(),
        altar: h.getAltarTile(),
      };
    });
    expect(snapshotInfo.count).toBeGreaterThanOrEqual(58);
    expect(snapshotInfo.states).toEqual(
      expect.arrayContaining([
        'working',
        'idle',
        'upgrading_home',
        'waiting_human',
        'exhausted',
        'turn_failed',
        'machine_offline',
      ]),
    );
    expect(snapshotInfo.classes).toEqual(
      expect.arrayContaining(['executor', 'checker', 'head', 'turnkey', 'day_laborer', 'ruler']),
    );
    expect(snapshotInfo.flags?.smokingDepartments.length).toBeGreaterThanOrEqual(1);
    expect(snapshotInfo.flags?.nightDistricts.length).toBeGreaterThanOrEqual(1);
    expect(snapshotInfo.flags?.scaffoldingHouses.length).toBeGreaterThanOrEqual(1);
    expect(snapshotInfo.altar).not.toBeNull();

    /* 1. 100% live city with bustling residents. */
    await capture(page, info, 'residents-100pct');

    /* 2. 200% closeup on active resident with stone/cloak/outfit details. */
    await page.evaluate(() => {
      const h = (window as unknown as { __WORLD_LIVE__: LiveStage5Handle }).__WORLD_LIVE__;
      const target =
        h.getResidents().find(r => r.carrying === 'stone' && r.liveState === 'working') ??
        h.getResidents().find(r => r.roleClass === 'head') ??
        h.getResidents()[0];
      if (target) h.centerOnResident(target.id, 2.0);
    });
    await page.waitForTimeout(200);
    await capture(page, info, 'residents-200pct');

    /* 3. Click a real resident via mouse click -> verify Agent Card fields, wake cooldown & open-agent link. */
    const clickPt = await page.evaluate(() => {
      const h = (window as unknown as { __WORLD_LIVE__: LiveStage5Handle }).__WORLD_LIVE__;
      const target = h.getResidents().find(r => r.liveState === 'waiting_human') ?? h.getResidents()[0]!;
      h.centerOnResident(target.id, 1.5);
      h.flushVisibleBakes();
      return { id: target.id, agentId: target.agentId, pt: h.getResidentScreenPoint(target.id) };
    });
    expect(clickPt.pt).not.toBeNull();
    await page.mouse.click(clickPt.pt!.x, clickPt.pt!.y);

    const card = page.getByTestId('world-stage5-agent-card');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('world-stage5-agent-level')).toBeVisible();
    await expect(page.getByTestId('world-stage5-agent-accepted')).toBeVisible();
    await expect(page.getByTestId('world-stage5-agent-next-level')).toBeVisible();
    await expect(page.getByTestId('world-stage5-agent-task')).toBeVisible();
    await expect(page.getByTestId('world-stage5-agent-department')).toBeVisible();
    await expect(page.getByTestId('world-stage5-agent-model')).toBeVisible();
    await expect(page.getByTestId('world-stage5-agent-machine')).toBeVisible();
    const openLink = page.getByTestId('world-stage5-open-agent');
    await expect(openLink).toHaveAttribute('href', /\/agents\/.+/);

    /* First wake succeeds; immediate second wake hits cooldown cleanly. */
    const wakeBtn = page.getByTestId('world-stage5-wake-btn');
    await wakeBtn.click();
    await expect(page.getByTestId('world-stage5-wake-status')).toContainText('отправлен');
    await wakeBtn.click();
    await expect(page.getByTestId('world-stage5-wake-status')).toContainText('Слишком часто');
    await capture(page, info, 'agent-card');

    /* Close card and frame God's Altar + smoking department / states showcase. */
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const h = (window as unknown as { __WORLD_LIVE__: LiveStage5Handle }).__WORLD_LIVE__;
      const failed = h.getResidents().find(r => r.liveState === 'turn_failed');
      if (failed) h.centerOnResident(failed.id, 1.0);
    });
    await page.waitForTimeout(250);
    await capture(page, info, 'states-showcase');

    /* 4. Dungeon pack on exact same live residents (zero outer wall, subterranean looks & shrine). */
    await page.goto('/world-live.html?mode=hornhoof&pack=dungeon&zoom=100&lang=ru');
    await waitForStage5Ready(page);
    await page.waitForTimeout(250);
    const dungeonSummary = await page.evaluate(() =>
      (window as unknown as { __WORLD_LIVE__: LiveStage5Handle }).__WORLD_LIVE__.getSummary()!,
    );
    expect(dungeonSummary.wallTilesCount).toBe(0);
    await capture(page, info, 'dungeon-residents');

    /* 5. 150-resident live stress scene visual snapshot. */
    await page.goto('/world-live.html?mode=stress150&pack=egypt&zoom=100&lang=ru');
    await waitForStage5Ready(page);
    const stressCount = await page.evaluate(() =>
      (window as unknown as { __WORLD_LIVE__: LiveStage5Handle }).__WORLD_LIVE__.getResidents().length,
    );
    expect(stressCount).toBeGreaterThanOrEqual(150);
    await page.waitForTimeout(250);
    await capture(page, info, '150-residents');

    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Stage 5 benchmarks 150 simultaneous residents without frame drops (no video throttling)', async ({
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

    await page.goto(`${baseURL}/world-live.html?mode=stress150&pack=egypt&zoom=100&lang=ru`);
    await waitForStage5Ready(page);
    const debug = await page.evaluate(() =>
      (window as unknown as { __WORLD_LIVE__: LiveStage5Handle }).__WORLD_LIVE__.getDebugInfo(),
    );
    const perf150 = await measureStress150Fps(page, 90);
    const isSoftwareGl = /swiftshader|llvmpipe|software/i.test(debug?.glRenderer ?? '');

    const report = {
      platform: process.platform,
      arch: process.arch,
      isSoftwareGl,
      debug,
      perf150,
    };
    console.log('STAGE5_150_RESIDENTS_PERF', JSON.stringify(report));

    if (process.env.HH_SCREENSHOT_DIR) {
      mkdirSync(process.env.HH_SCREENSHOT_DIR, { recursive: true });
      writeFileSync(join(process.env.HH_SCREENSHOT_DIR, 'stage5-150-perf.json'), JSON.stringify(report, null, 2));
    }

    expect(debug?.rendererKind).toBe('webgl');
    expect(perf150.residentsCount).toBeGreaterThanOrEqual(150);
    if (!isSoftwareGl) {
      expect(perf150.fps, `Stage 5 150-resident real GPU FPS (${debug?.glRenderer})`).toBeGreaterThanOrEqual(55);
    } else {
      expect(perf150.avgCpuStepMs, 'Stage 5 150-resident engine CPU step ms').toBeLessThanOrEqual(8);
      expect(perf150.fps, 'Stage 5 150-resident SwiftShader FPS').toBeGreaterThan(0);
    }

    await context.close();
  } finally {
    await gpuBrowser.close();
  }
});
