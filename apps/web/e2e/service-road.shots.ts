import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type Page, type Route } from '@playwright/test';
import { BUILTIN_SKINS } from '../src/skins/registry';
import type { UpdatesView } from '../src/types';
import { serveApi } from './api';

/* The pictures of the one road of service messages (#2098, #2099, Design #2100), before and after, in every built-in theme:
   no connection to the server, and an update that holds the server with its progress, each as the window (or what stood on
   the page before it), as the strip once the window is closed, and as the loader line of a page opened with nothing cached.
   It touches the page only through the theme key, the answers of the server, the clock and Escape, so the same file takes
   the pictures of the code before (SHOT_SIDE=before) and after (SHOT_SIDE=after). They go to SHOTS_DIR, else beside this
   test's results; each line SHOT names one and its sha256. */
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

/* The server as the state holds it. An update that holds it still tells its panel how far it is, so that answer comes first. */
async function serveState(page: Page) {
  const server = { state: null as State | null };
  await serveApi(page);
  await page.route('**/api/**', route => ANSWERS[server.state ?? 'up'](route));
  await page.route('**/api/updates', route => (server.state === 'updating' ? route.fulfill({ json: RUNNING }) : route.fallback()));
  return server;
}

async function shot(page: Page, name: string): Promise<void> {
  const png = await page.screenshot({ animations: 'disabled' });
  mkdirSync(join(SHOTS, SIDE), { recursive: true });
  const file = `${SIDE}/${name}.png`;
  writeFileSync(join(SHOTS, file), png);
  console.log(`SHOT ${file} sha256=${createHash('sha256').update(png).digest('hex')}`);
}

/* The page comes to its state by its own clock: a few seconds, as a person would wait. */
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
    await shot(page, `${name}-cold-first`);
    if (SIDE === 'before') return;
    await page.keyboard.press('Escape');
    await wait(page, 1_000);
    await shot(page, `${name}-cold-then`);
  });
}
