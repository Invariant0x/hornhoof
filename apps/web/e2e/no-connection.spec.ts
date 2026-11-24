import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { serveApi } from './api';

/* A server that cannot be reached must never read as a missing page (#1938). Each way the server can be away answers the
   page differently, and each must end in the same honest layer, the sign of Hornhoof and one line in English, "No connection"
   or "Updating" (#2049), then bring the page back by itself, with no reload:
   - refused: the process is stopped or restarting, so the browser's own request fails;
   - relay: a hop that is not Hornhoof answers 404 with a page of its own, as the public link's relay does when no keeper
     holds the name;
   - front: the front or the keeper has no live server behind it and answers 502 in Hornhoof's own words;
   - updating: the keeper answers 503 "maintenance" while an update installs. */
const MODES = ['refused', 'relay', 'front', 'updating'] as const;
type Mode = (typeof MODES)[number] | 'up';

const RELAY_PAGE = '<!DOCTYPE html><html><head><title>Not Found</title></head><body><h1>The page you requested was not found.</h1></body></html>';
const STARTING = { error: { code: 'unavailable', message: 'Hornhoof is starting.', reason: 'starting' } };
const MAINTENANCE = { error: { code: 'unavailable', message: 'Hornhoof is installing an update and takes no changes until it ends.', reason: 'maintenance' } };

/* The server the page talks to, as the test sets it: every /api call, the stream and the build included, is answered the
   way the mode says until the test brings it up again. */
async function serveServer(page: Page) {
  const server = { mode: 'up' as Mode, org: 0, gate: null as Promise<void> | null };
  await serveApi(page);
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/org') server.org++;
    /* A look at the server that the test holds on its way, to see the page while it looks. */
    if (path === '/api/build' && server.gate && server.mode !== 'up') await server.gate;
    switch (server.mode) {
      case 'up': return route.fallback();
      case 'refused': return route.abort('connectionrefused');
      case 'relay': return route.fulfill({ status: 404, contentType: 'text/html', body: RELAY_PAGE });
      case 'front': return route.fulfill({ status: 502, json: STARTING, headers: { 'retry-after': '5' } });
      case 'updating': return route.fulfill({ status: 503, json: MAINTENANCE, headers: { 'retry-after': '10' } });
    }
  });
  return server;
}

/* How many times the document loaded, counted across reloads: it must stay one, since the page comes back by itself. */
function loads(page: Page) {
  const count = { n: 0 };
  page.on('load', () => count.n++);
  return count;
}

const LINE = { lost: 'No connection', updating: 'Updating' };
const SCREENSHOT_DIR = process.env.HH_SCREENSHOT_DIR;

async function shot(page: Page, name: string): Promise<void> {
  if (!SCREENSHOT_DIR) return;
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: resolve(SCREENSHOT_DIR, `${name}.png`) });
}

const layer = (page: Page, title: string) => page.getByRole('alertdialog', { name: title, exact: true });
const tab = (page: Page, name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true });

/* The page's clock moves on while the test waits for the layer to go: each look is one second of the clock, so a probe
   that backs off comes due. */
async function until(page: Page, check: () => Promise<boolean>) {
  await expect.poll(async () => {
    await page.clock.runFor(1_000);
    return check();
  }).toBe(true);
}

/* What the page asks every few seconds on its own (the move of the server, the updates), as the clock moves. */
const NOTICE_MS = 6_000;

for (const mode of MODES) {
  const title = mode === 'updating' ? LINE.updating : LINE.lost;

  test(`${mode}: an open page says so and comes back by itself`, async ({ page }) => {
    await page.clock.install();
    const server = await serveServer(page);
    const loaded = loads(page);
    await page.goto('/tasks');
    await expect(tab(page, en.shell.tabs.tasks)).toBeVisible();
    await expect(layer(page, title)).toHaveCount(0);

    server.mode = mode;
    await page.clock.runFor(NOTICE_MS);
    await expect(layer(page, title)).toBeVisible();
    await expect(page.getByRole('heading', { name: en.routes.accessDenied })).toHaveCount(0);
    await expect(page.getByText(en.routes.explanation)).toHaveCount(0);

    server.mode = 'up';
    const before = server.org;
    await until(page, async () => (await layer(page, title).count()) === 0);
    await expect(tab(page, en.shell.tabs.tasks)).toBeVisible();
    /* What the screens hold is asked for again, and the page did not reload. */
    await expect.poll(() => server.org).toBeGreaterThan(before);
    expect(loaded.n).toBe(1);
  });

  test(`${mode}: a page opened or reloaded while it lasts says so and comes back by itself`, async ({ page }) => {
    await page.clock.install();
    const server = await serveServer(page);
    server.mode = mode;
    const loaded = loads(page);
    await page.goto('/');
    await expect(layer(page, title)).toBeVisible();
    await expect(page.getByRole('heading', { name: en.app.notResponding })).toHaveCount(0);
    await expect(page.getByText(en.errors.codes.internal)).toHaveCount(0);

    server.mode = 'up';
    await until(page, async () => (await layer(page, title).count()) === 0);
    await expect(page.getByRole('navigation')).toBeVisible();
    expect(loaded.n).toBe(1);
  });
}

test('a hop that answers 404 for one screen reads as no connection there, never as a missing page', async ({ page }) => {
  await page.clock.install();
  await serveServer(page);
  const hop = { on: false };
  await page.route('**/api/machines', route => (hop.on ? route.fulfill({ status: 404, contentType: 'text/html', body: RELAY_PAGE }) : route.fallback()));
  await page.goto('/');
  await expect(tab(page, en.shell.tabs.machines)).toBeVisible();
  hop.on = true;
  await tab(page, en.shell.tabs.machines).click();
  await expect(page.getByText(en.load.failed.offline).or(page.getByText(en.errors.codes.network)).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: en.routes.accessDenied })).toHaveCount(0);
  await expect(page.getByText(en.routes.explanation)).toHaveCount(0);
});

test('a stream that breaks while the server answers draws no layer', async ({ page }) => {
  await page.clock.install();
  await serveApi(page);
  await page.route('**/api/stream', route => route.fulfill({ status: 404, contentType: 'text/html', body: RELAY_PAGE }));
  await page.goto('/tasks');
  await expect(tab(page, en.shell.tabs.tasks)).toBeVisible();
  await page.clock.runFor(NOTICE_MS * 3);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('what the server itself says is missing still reads as missing', async ({ page }) => {
  await page.clock.install();
  const server = await serveServer(page);
  await page.route('**/api/machines', route => (server.mode === 'up' ? route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not found.' } } }) : route.fallback()));
  await page.goto('/machines');
  await expect(page.getByRole('heading', { name: en.routes.accessDenied })).toBeVisible();
  await page.clock.runFor(NOTICE_MS * 2);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

/* The layer is the sign and the one line, on the plain background of the theme, over the whole window: nothing else in it, the
   line in English whatever the person's language, and nothing under it moved. */
test('the layer is the sign and one English line, centred over the whole window, and keeps the page where it stands', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => localStorage.setItem('hh-lang', 'ru'));
  await page.setViewportSize({ width: 375, height: 700 });
  const server = await serveServer(page);
  await page.goto('/');
  const before = await page.getByRole('navigation').boundingBox();
  server.mode = 'refused';
  await page.clock.runFor(NOTICE_MS);
  const lost = layer(page, LINE.lost);
  await expect(lost).toBeVisible();
  await expect(lost).toHaveText(LINE.lost);
  await expect(lost.locator('svg')).toHaveCount(1);
  await expect(lost.locator('button, a, input, .spinner, [role="status"]')).toHaveCount(0);
  const box = await lost.boundingBox();
  expect(box).toEqual({ x: 0, y: 0, width: 375, height: 700 });
  const mark = await lost.locator('svg').boundingBox();
  const line = await lost.locator('p').boundingBox();
  expect(mark).toMatchObject({ width: 48, height: 48 });
  expect(Math.abs(mark!.x + mark!.width / 2 - 375 / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(line!.x + line!.width / 2 - 375 / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs((mark!.y + line!.y + line!.height) / 2 - 700 / 2)).toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  /* Over the page, not in its flow: nothing under it moved. */
  expect(await page.getByRole('navigation').boundingBox()).toEqual(before);
});

/* The layer is a plain page of the theme over the page: the background is the theme's own, it takes every click, the page
   under it is inert, it is the dialog the screen reader names by its line, and Escape leaves it where it is. The focus goes
   to it and comes back to where it was when the server answers. */
test('the layer takes the focus, holds the page, ignores Escape, and gives the focus back when the server answers', async ({ page }) => {
  await page.clock.install();
  const server = await serveServer(page);
  await page.goto('/');
  const tasks = tab(page, en.shell.tabs.tasks);
  await expect(tasks).toBeVisible();
  await tasks.focus();
  await expect(tasks).toBeFocused();

  server.mode = 'refused';
  await page.clock.runFor(NOTICE_MS);
  const lost = layer(page, LINE.lost);
  await expect(lost).toBeVisible();
  await expect(lost).toHaveAttribute('aria-labelledby', 'conn-line');
  await expect(lost).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(lost).toBeVisible();

  /* The plain background of the theme, which takes the click meant for the page under it, and the page under it is inert. */
  expect(await lost.evaluate(el => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--bg)';
    document.body.append(probe);
    const bg = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return getComputedStyle(el).backgroundColor === bg;
  })).toBe(true);
  expect(await page.evaluate(() => document.elementFromPoint(window.innerWidth / 2, 20)?.closest('.conn-layer') !== null)).toBe(true);
  await expect(page.locator('.app-screen')).toHaveAttribute('inert', '');

  server.mode = 'up';
  await until(page, async () => (await layer(page, LINE.lost).count()) === 0);
  await expect(page.locator('.app-screen')).not.toHaveAttribute('inert', '');
  await expect(tasks).toBeFocused();
});

/* However long the wait gets, the layer says no more: no second line, no counter, no ring, no button. */
test('the layer says nothing more as the wait grows long, an update included', async ({ page }) => {
  await page.clock.install();
  const server = await serveServer(page);
  await page.goto('/');
  await expect(tab(page, en.shell.tabs.tasks)).toBeVisible();
  server.mode = 'refused';
  await page.clock.runFor(NOTICE_MS);
  const lost = layer(page, LINE.lost);
  await expect(lost).toBeVisible();
  await page.clock.runFor(10 * 60_000);
  await expect(lost).toHaveText(LINE.lost);
  await expect(lost.locator('button, .spinner, [role="status"]')).toHaveCount(0);
  server.mode = 'updating';
  await page.clock.runFor(20_000);
  const updating = layer(page, LINE.updating);
  await expect(updating).toBeVisible();
  await page.clock.runFor(10 * 60_000);
  await expect(updating).toHaveText(LINE.updating);
  await expect(updating.locator('button, .spinner, [role="status"]')).toHaveCount(0);
});

/* The look the Design checks: both states, light and dark, wide and narrow. */
for (const scheme of ['light', 'dark'] as const) {
  for (const [width, height] of [[1440, 900], [375, 700]] as const) {
    test(`the layer looks the same in ${scheme} at ${width}: one sign, one line, the theme's background`, async ({ browser }) => {
      const context = await browser.newContext({ colorScheme: scheme, viewport: { width, height } });
      const page = await context.newPage();
      try {
        await page.clock.install();
        const server = await serveServer(page);
        await page.goto('/');
        await expect(tab(page, en.shell.tabs.tasks)).toBeVisible();
        for (const mode of ['refused', 'updating'] as const) {
          server.mode = mode;
          await page.clock.runFor(mode === 'refused' ? NOTICE_MS : 20_000);
          const name = mode === 'updating' ? LINE.updating : LINE.lost;
          const shown = layer(page, name);
          await expect(shown).toBeVisible();
          await expect(shown).toHaveText(name);
          await shot(page, `overlay-${mode === 'updating' ? 'updating' : 'lost'}-${width === 1440 ? 'wide' : 'narrow'}-${scheme}`);
        }
      } finally {
        await context.close();
      }
    });
  }
}
