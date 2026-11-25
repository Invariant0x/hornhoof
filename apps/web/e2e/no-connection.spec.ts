/// <reference types="node" />
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { serveApi } from './api';

/* A server that cannot be reached or installs an update goes the one road of service messages (#2098, #2099, Design #2100):
   the window first, once it is closed the thin strip under the menu, which never moves the page, and gone by itself once the
   server answers, with no reload. Where a page area has nothing cached, the loader line stands in its place. The words are
   English in every language. */
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
  const server = { mode: 'up' as Mode, org: 0 };
  await serveApi(page);
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/org') server.org++;
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

const windowOf = (page: Page, title: string) => page.getByRole('dialog', { name: title, exact: true });
const strip = (page: Page) => page.locator('.svc-strip');
const tab = (page: Page, name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true });

async function until(page: Page, check: () => Promise<boolean>) {
  await expect.poll(async () => {
    await page.clock.runFor(1_000);
    return check();
  }).toBe(true);
}

const NOTICE_MS = 6_000;

/* What stands under the strip and the window: the menu, the app and the map or the page. */
async function placeOf(page: Page) {
  const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
  return { nav: await box('.topbar'), app: await box('.app-screen'), body: await box('.shell') };
}

for (const mode of MODES) {
  const title = mode === 'updating' ? LINE.updating : LINE.lost;

  test(`${mode}: an open page shows the window ${title}, then the strip once it is closed, and both go by themselves`, async ({ page }) => {
    await page.clock.install();
    const server = await serveServer(page);
    const loaded = loads(page);
    await page.goto('/tasks');
    await expect(tab(page, en.shell.tabs.tasks)).toBeVisible();
    await expect(windowOf(page, title)).toHaveCount(0);
    await expect(strip(page)).toHaveCount(0);
    const still = await placeOf(page);

    server.mode = mode;
    await page.clock.runFor(NOTICE_MS);
    await expect(windowOf(page, title)).toBeVisible();
    /* The window and the strip never stand together; a missing page never shows. */
    await expect(strip(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: en.routes.accessDenied })).toHaveCount(0);
    await expect(page.getByText(en.routes.explanation)).toHaveCount(0);
    await shot(page, `window-${mode}`);

    await page.keyboard.press('Escape');
    await expect(windowOf(page, title)).toHaveCount(0);
    await expect(strip(page)).toBeVisible();
    await expect(strip(page)).toHaveText(title);
    await expect(strip(page).locator('button, a, input')).toHaveCount(0);
    /* Out of the flow: not one pixel of the menu or the page moved or shrank. */
    expect(await placeOf(page)).toEqual(still);
    await shot(page, `strip-${mode}`);

    server.mode = 'up';
    const before = server.org;
    await until(page, async () => (await strip(page).count()) === 0);
    await expect(tab(page, en.shell.tabs.tasks)).toBeVisible();
    await expect.poll(() => server.org).toBeGreaterThan(before);
    expect(loaded.n).toBe(1);
  });

  test(`${mode}: a page opened or reloaded while it lasts shows the window and the loader in its place, and comes back by itself`, async ({ page }) => {
    await page.clock.install();
    const server = await serveServer(page);
    server.mode = mode;
    const loaded = loads(page);
    await page.goto('/');
    await expect(windowOf(page, title)).toBeVisible();
    await expect(page.getByRole('heading', { name: en.app.notResponding })).toHaveCount(0);
    await expect(page.getByText(en.errors.codes.internal)).toHaveCount(0);

    /* Once the window is closed, the page area with nothing cached says the same line in its place, and the strip is not
       drawn: one status on the screen. */
    await page.keyboard.press('Escape');
    await expect(windowOf(page, title)).toHaveCount(0);
    const loader = page.locator('.svc-loader');
    await expect(loader).toBeVisible();
    await expect(loader).toHaveText(title);
    await expect(loader).toHaveAttribute('aria-busy', 'true');
    await expect(strip(page)).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveCount(1);

    server.mode = 'up';
    await until(page, async () => (await loader.count()) === 0);
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
  await expect(windowOf(page, LINE.lost).or(strip(page).filter({ hasText: LINE.lost }))).toBeVisible();
  await expect(page.getByRole('heading', { name: en.routes.accessDenied })).toHaveCount(0);
  await expect(page.getByText(en.routes.explanation)).toHaveCount(0);
});

test('a stream that breaks while the server answers draws no window and no strip', async ({ page }) => {
  await page.clock.install();
  await serveApi(page);
  await page.route('**/api/stream', route => route.fulfill({ status: 404, contentType: 'text/html', body: RELAY_PAGE }));
  await page.goto('/tasks');
  await expect(tab(page, en.shell.tabs.tasks)).toBeVisible();
  await page.clock.runFor(NOTICE_MS * 3);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(strip(page)).toHaveCount(0);
});

test('what the server itself says is missing still reads as missing', async ({ page }) => {
  await page.clock.install();
  const server = await serveServer(page);
  await page.route('**/api/machines', route => (server.mode === 'up' ? route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not found.' } } }) : route.fallback()));
  await page.goto('/machines');
  await expect(page.getByRole('heading', { name: en.routes.accessDenied })).toBeVisible();
  await page.clock.runFor(NOTICE_MS * 2);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(strip(page)).toHaveCount(0);
});

test('keeps the one English line and the English Close on a Russian page, takes the focus, holds it on Close, and keeps the page where it stands', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => localStorage.setItem('hh-lang', 'ru'));
  const server = await serveServer(page);
  await page.goto('/');
  const tasks = tab(page, ru.shell.tabs.tasks);
  await expect(tasks).toBeVisible();
  const still = await placeOf(page);
  await tasks.focus();
  await expect(tasks).toBeFocused();

  server.mode = 'refused';
  await page.clock.runFor(NOTICE_MS);
  const lost = windowOf(page, LINE.lost);
  await expect(lost).toBeVisible();
  const close = lost.getByRole('button', { name: 'Close', exact: true });
  await expect(close).toBeFocused();
  expect(await lost.locator('.svc-line').textContent()).toBe(LINE.lost);
  await expect(lost.locator('button, .spinner, h1, h2, .svc-progress')).toHaveCount(1);
  /* Tab stays on the one button; the page under the window is inert and has not moved. */
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await expect(page.locator('.app-screen')).toHaveAttribute('inert', '');
  expect(await placeOf(page)).toEqual(still);
  /* Over the whole window, on the shared scrim. */
  expect(await page.evaluate(() => document.elementFromPoint(window.innerWidth / 2, 20)?.closest('.dialog-back') !== null)).toBe(true);

  await page.keyboard.press('Escape');
  await expect(lost).toHaveCount(0);
  await expect(page.locator('.app-screen')).not.toHaveAttribute('inert', '');
  await expect(tasks).toBeFocused();
  await expect(strip(page)).toHaveText(LINE.lost);

  server.mode = 'up';
  await until(page, async () => (await strip(page).count()) === 0);
  await expect(tasks).toBeVisible();
});

test('a click outside the window closes it, and a click inside does not', async ({ page }) => {
  await page.clock.install();
  const server = await serveServer(page);
  await page.goto('/');
  await expect(tab(page, en.shell.tabs.tasks)).toBeVisible();
  server.mode = 'refused';
  await page.clock.runFor(NOTICE_MS);
  const lost = windowOf(page, LINE.lost);
  await expect(lost).toBeVisible();
  await lost.locator('.svc-line').click();
  await expect(lost).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(lost).toHaveCount(0);
  await expect(strip(page)).toBeVisible();
});

test('draws the window, the strip and the loader as Design drew them, across themes and widths, with the strip 8 px under the menu', async ({ browser }) => {
  const skins = [['light', 'light'], ['dark', 'cyberpunk']] as const;
  for (const [scheme, skin] of skins) {
    for (const [width, height] of [[1440, 900], [375, 700]] as const) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
      const page = await context.newPage();
      try {
        await page.clock.install();
        await page.addInitScript(s => localStorage.setItem('hh-theme', s), skin);
        const server = await serveServer(page);
        await page.goto('/');
        await expect(tab(page, en.shell.tabs.tasks)).toBeVisible();
        const still = await placeOf(page);

        for (const [state, mode] of [['lost', 'refused'], ['updating', 'updating']] as const) {
          server.mode = mode;
          const dialog = windowOf(page, LINE[state]);
          await until(page, async () => (await dialog.count()) > 0);
          await expect(dialog).toBeVisible();
          const seen = await page.evaluate(() => {
            const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number; bottom: number; right: number };
            const line = getComputedStyle(document.querySelector('.svc-window .svc-line')!);
            return {
              back: box('.dialog-back'),
              window: box('.svc-window'),
              mark: box('.svc-window .svc-mark'),
              lineBox: box('.svc-window .svc-line'),
              closeBox: box('.svc-window .window-close'),
              lineFont: { size: line.fontSize, weight: line.fontWeight },
              fitsWidth: document.documentElement.scrollWidth <= window.innerWidth,
            };
          });
          expect(seen.back).toMatchObject({ x: 0, y: 0, width, height });
          expect(seen.window.width).toBeCloseTo(Math.min(360, width - 32), 0);
          expect(seen.mark).toMatchObject({ width: 72, height: 72 });
          expect(seen.lineFont).toEqual({ size: '18px', weight: '600' });
          expect(seen.closeBox).toMatchObject({ width: 44, height: 44 });
          expect(Math.abs(seen.window.x + seen.window.width / 2 - width / 2)).toBeLessThanOrEqual(1);
          expect(Math.abs(seen.window.y + seen.window.height / 2 - height / 2)).toBeLessThanOrEqual(2);
          expect(seen.lineBox.y).toBeGreaterThanOrEqual(seen.mark.bottom);
          expect(seen.fitsWidth).toBe(true);
          await shot(page, `window-${state}-${width}-${scheme}`);

          await page.keyboard.press('Escape');
          await expect(strip(page)).toBeVisible();
          const bar = await page.evaluate(() => {
            const el = document.querySelector('.svc-strip')!;
            const box = el.getBoundingClientRect();
            const menu = document.querySelector('.topbar')!.getBoundingClientRect();
            const style = getComputedStyle(el);
            return { top: box.top, height: box.height, menuBottom: menu.bottom, position: style.position, mark: document.querySelector('.svc-strip .svc-mark')!.getBoundingClientRect().width };
          });
          expect(bar.position).toBe('fixed');
          expect(Math.abs(bar.top - (bar.menuBottom + 8))).toBeLessThanOrEqual(1);
          expect(bar.height).toBeGreaterThanOrEqual(36);
          expect(bar.mark).toBe(24);
          expect(await placeOf(page)).toEqual(still);
          await shot(page, `strip-${state}-${width}-${scheme}`);

          server.mode = 'up';
          await until(page, async () => (await strip(page).count()) === 0);
        }
      } finally {
        await context.close();
      }
    }
  }
});
