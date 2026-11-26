import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page, type Route } from '@playwright/test';
import { BUILTIN_SKINS } from '../src/skins/registry';
import type { UpdatesView } from '../src/types';
import { serveApi } from './api';

/* Capture the connection window and strip, and two frames of each centered loader,
   in every built-in theme at phone and desktop widths. */
test.describe.configure({ timeout: 0 });

const SIDE = process.env.SHOT_SIDE === 'before' ? 'before' : 'after';
const SHOTS = process.env.SHOTS_DIR ?? fileURLToPath(new URL('results/service-road-shots', import.meta.url));
const SKINS = BUILTIN_SKINS.map(skin => skin.id);
const SIZES = [[1440, 900], [375, 700]] as const;
const STATES = ['lost', 'updating'] as const;
type State = (typeof STATES)[number];

const MAINTENANCE = { error: { code: 'unavailable', message: 'Hornhoof is installing an update and takes no changes until it ends.', reason: 'maintenance' } };
const RUNNING: UpdatesView = {
  current: { version: '0.44.0', commit: 'a'.repeat(40), migrations: 5 },
  available: true, checkedAt: '2026-11-25T02:00:00Z', latest: null, versions: [], error: null,
  updater: { present: true, status: { id: 'u1', version: '0.45.0', commit: 'b'.repeat(40), state: 'running', step: 'install', log: '', at: '2026-11-25T02:05:00Z' }, waiting: null, calledOff: null },
};

/* What the server answers to any look while each state holds it: no answer at all, or the refusal of an update. */
const ANSWERS: Record<State | 'up', (route: Route) => Promise<void>> = {
  up: route => route.fallback(),
  lost: route => route.abort('connectionrefused'),
  updating: route => route.fulfill({ status: 503, json: MAINTENANCE, headers: { 'retry-after': '10' } }),
};

type Server = { state: State | null };

const answerFor = (server: Server) => (route: Route) => ANSWERS[server.state ?? 'up'](route);
const updatesFor = (server: Server) => (route: Route) => (server.state === 'updating' ? route.fulfill({ json: RUNNING }) : route.fallback());

/* The server as the state holds it. An update that holds it still tells its panel how far it is, so that answer comes first. */
async function serveState(page: Page) {
  const server: Server = { state: null };
  await serveApi(page);
  await page.route('**/api/**', answerFor(server));
  await page.route('**/api/updates', updatesFor(server));
  return server;
}

async function shot(page: Page, name: string, motion = false): Promise<void> {
  const png = await page.screenshot({ animations: motion ? 'allow' : 'disabled' });
  mkdirSync(join(SHOTS, SIDE), { recursive: true });
  const file = `${SIDE}/${name}.png`;
  writeFileSync(join(SHOTS, file), png);
  console.log(`SHOT ${file} sha256=${createHash('sha256').update(png).digest('hex')}`);
}

/* Freeze the real CSS animations at two points so the two frames can be compared.
   Check that the states differ and the text and dots keep exactly the same box. */
async function loaderFrames(page: Page, name: string): Promise<void> {
  const line = page.locator('.boot-screen .boot-line');
  await expect(line).toBeVisible();
  const box = await line.boundingBox();
  const sample = (time: number) => line.locator('.boot-dots > i').evaluateAll((dots, at) => dots.map(dot => {
    for (const animation of dot.getAnimations()) {
      animation.pause();
      animation.currentTime = at;
    }
    return getComputedStyle(dot).opacity;
  }), time);
  const early = await sample(0);
  await shot(page, `${name}-dots-early`, true);
  const late = await sample(360);
  await shot(page, `${name}-dots-late`, true);
  expect(early).toHaveLength(3);
  expect(late).not.toEqual(early);
  expect(await line.boundingBox()).toEqual(box);
}

const wait = (page: Page, ms: number) => page.clock.runFor(ms);

for (const skin of SKINS) for (const [width, height] of SIZES) for (const state of STATES) {
  const name = `${skin}-${width}-${state}`;

  test(`shot an open page ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(s => localStorage.setItem('hh-theme', s), skin);
    await page.clock.install();
    const server = await serveState(page);
    await page.goto('/tasks');
    await page.getByRole('navigation').getByRole('button').first().waitFor();
    server.state = state;
    await wait(page, 12_000);
    if (SIDE === 'after' && state === 'updating') {
      await loaderFrames(page, `${name}-loaded`);
      return;
    }
    await shot(page, `${name}-first`);
    if (SIDE === 'before') return;
    await page.keyboard.press('Escape');
    await wait(page, 1_000);
    await shot(page, `${name}-then`);
  });

  test(`shot a page opened with nothing cached ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(s => localStorage.setItem('hh-theme', s), skin);
    await page.clock.install();
    const server = await serveState(page);
    server.state = state;
    await page.goto('/');
    await wait(page, 12_000);
    if (SIDE === 'before') {
      await shot(page, `${name}-cold-first`);
      return;
    }
    await loaderFrames(page, `${name}-cold`);
  });
}
