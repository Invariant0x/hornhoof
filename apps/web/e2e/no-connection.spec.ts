/// <reference types="node" />
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { serveApi } from './api';

/* A server that cannot be reached or installs an update shows only the Hornhoof logo and one English line, centred on a plain
   background over the page, and returns by itself with no reload once the server answers (#1938, #2049). */
const MODES = ['refused', 'relay', 'front', 'updating'] as const;
type Mode = (typeof MODES)[number] | 'up';

const SCREENSHOT_DIR = process.env.HH_SCREENSHOT_DIR;
const RELAY_PAGE = '<!DOCTYPE html><html><head><title>Not Found</title></head><body><h1>The page you requested was not found.</h1></body></html>';
const STARTING = { error: { code: 'unavailable', message: 'Hornhoof is starting.', reason: 'starting' } };
const MAINTENANCE = { error: { code: 'unavailable', message: 'Hornhoof is installing an update and takes no changes until it ends.', reason: 'maintenance' } };
const LINE = { lost: 'No connection', updating: 'Updating' } as const;

async function shot(page: Page, name: string): Promise<void> {
  if (!SCREENSHOT_DIR) return;
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: resolve(SCREENSHOT_DIR, `${name}.png`) });
}

async function serveServer(page: Page) {
  const server = { mode: 'up' as Mode, org: 0, gate: null as Promise<void> | null };
  await serveApi(page);
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/org') server.org++;
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

function loads(page: Page) {
  const count = { n: 0 };
  page.on('load', () => count.n++);
  return count;
}

const layer = (page: Page, title: string) => page.getByRole('alertdialog', { name: title, exact: true });
const tab = (page: Page, name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true });

async function until(page: Page, check: () => Promise<boolean>) {
  await expect.poll(async () => {
    await page.clock.runFor(1_000);
    return check();
  }).toBe(true);
}

const NOTICE_MS = 6_000;

for (const mode of MODES) {
  const title = mode === 'updating' ? LINE.updating : LINE.lost;

  test(`${mode}: an open page shows only ${title} and comes back by itself`, async ({ page }) => {
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
    await expect.poll(() => server.org).toBeGreaterThan(before);
    expect(loaded.n).toBe(1);
  });

  test(`${mode}: a page opened or reloaded while it lasts shows only ${title} and comes back by itself`, async ({ page }) => {
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

test('keeps the one English line even on a Russian page, hides the retry, holds focus, and keeps the page where it stands', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => localStorage.setItem('hh-lang', 'ru'));
  const server = await serveServer(page);
  await page.goto('/');
  const tasks = tab(page, ru.shell.tabs.tasks);
  await expect(tasks).toBeVisible();
  const before = await page.getByRole('navigation').boundingBox();
  await tasks.focus();
  await expect(tasks).toBeFocused();

  server.mode = 'refused';
  await page.clock.runFor(NOTICE_MS);
  const lost = layer(page, LINE.lost);
  await expect(lost).toBeVisible();
  await expect(lost).toBeFocused();
  expect(await lost.textContent()).toBe(LINE.lost);
  await expect(lost.locator('button, .spinner, h1, h2')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(lost).toBeVisible();

  /* During a probe and after 6 minutes: still only the logo and one English line. */
  let release!: () => void;
  server.gate = new Promise<void>(r => (release = r));
  await page.clock.runFor(10_000);
  expect(await lost.textContent()).toBe(LINE.lost);
  await expect(lost.locator('button, .spinner')).toHaveCount(0);
  release();
  server.gate = null;
  await page.clock.runFor(360_000);
  expect(await lost.textContent()).toBe(LINE.lost);

  /* Plain --bg over the whole window, page underneath inert and unshifted. */
  expect(await page.locator('.conn-layer').evaluate(el => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--bg)';
    document.body.append(probe);
    const bg = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return getComputedStyle(el).backgroundColor === bg;
  })).toBe(true);
  expect(await page.evaluate(() => document.elementFromPoint(window.innerWidth / 2, 20)?.closest('.conn-layer') !== null)).toBe(true);
  expect(await page.evaluate(() => document.elementFromPoint(20, window.innerHeight - 10)?.closest('.conn-layer') !== null)).toBe(true);
  await expect(page.locator('.app-screen')).toHaveAttribute('inert', '');
  expect(await page.getByRole('navigation').boundingBox()).toEqual(before);

  server.mode = 'up';
  await until(page, async () => (await layer(page, LINE.lost).count()) === 0);
  await expect(page.locator('.app-screen')).not.toHaveAttribute('inert', '');
  await expect(tasks).toBeFocused();
});

test('centres the overlay logo and one line on a plain token background across schemes and widths', async ({ browser }) => {
  const skins = [
    ['light', 'light', 'rgb(230, 235, 240)'],
    ['dark', 'cyberpunk', 'rgb(20, 26, 34)'],
  ] as const;
  for (const [scheme, skin, expectedBg] of skins) {
    for (const [width, height] of [[1440, 900], [375, 700]] as const) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
      const page = await context.newPage();
      try {
        await page.clock.install();
        await page.addInitScript(s => localStorage.setItem('hh-theme', s), skin);
        const server = await serveServer(page);
        await page.goto('/');
        await expect(tab(page, en.shell.tabs.tasks)).toBeVisible();

        for (const [state, mode] of [['lost', 'refused'], ['updating', 'updating']] as const) {
          server.mode = mode;
          const dialog = layer(page, LINE[state]);
          await until(page, async () => (await dialog.count()) > 0);
          await expect(dialog).toBeVisible();
          const seen = await page.evaluate(() => {
            const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number; bottom: number };
            const inner = getComputedStyle(document.querySelector('.conn')!);
            const line = getComputedStyle(document.querySelector('#conn-title')!);
            return {
              layerBox: box('.conn-layer'),
              layerBg: getComputedStyle(document.querySelector('.conn-layer')!).backgroundColor,
              innerBg: inner.backgroundColor,
              innerBorder: inner.borderTopWidth,
              mark: box('.conn-mark'),
              logoParts: {
                dome: document.querySelectorAll('.conn-mark .mk-dome').length,
                base: document.querySelectorAll('.conn-mark .mk-base').length,
                dot: document.querySelectorAll('.conn-mark .mk-dot').length,
              },
              lineBox: box('#conn-title'),
              lineFont: { size: line.fontSize, weight: line.fontWeight },
              text: document.querySelector('.conn-layer')!.textContent ?? '',
              extras: document.querySelectorAll('.conn-layer :is(button, .spinner, h1, h2, h3)').length,
              fitsWidth: document.documentElement.scrollWidth <= window.innerWidth,
            };
          });
          expect(seen.layerBox).toMatchObject({ x: 0, y: 0, width, height });
          expect(seen.layerBg).toBe(expectedBg);
          expect(seen.innerBg).toBe('rgba(0, 0, 0, 0)');
          expect(seen.innerBorder).toBe('0px');
          expect(seen.text).toBe(LINE[state]);
          expect(seen.extras).toBe(0);
          expect(seen.logoParts).toEqual({ dome: 1, base: 1, dot: 1 });
          expect(seen.mark).toMatchObject({ width: 48, height: 48 });
          expect(seen.lineFont).toEqual({ size: '14px', weight: '400' });
          expect(seen.lineBox.y).toBeGreaterThanOrEqual(seen.mark.bottom);
          expect(Math.abs(seen.mark.x + seen.mark.width / 2 - width / 2)).toBeLessThanOrEqual(1);
          expect(Math.abs(seen.lineBox.x + seen.lineBox.width / 2 - width / 2)).toBeLessThanOrEqual(1);
          expect(Math.abs((seen.mark.y + seen.lineBox.bottom) / 2 - height / 2)).toBeLessThanOrEqual(2);
          expect(seen.fitsWidth).toBe(true);
          await shot(page, `overlay-${state}-${width}-${scheme}`);

          server.mode = 'up';
          await until(page, async () => (await layer(page, LINE[state]).count()) === 0);
        }
      } finally {
        await context.close();
      }
    }
  }
});
