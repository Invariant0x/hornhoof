/// <reference types="node" />
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { awayPage } from '../../server/src/net/away-page';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { serveApi } from './api';

/* On a loaded page a connection loss opens a window, then becomes a strip. Cold starts
   and updates use the startup loader, and the app recovers without a reload. */
const MODES = ['refused', 'relay', 'front'] as const;
type Mode = (typeof MODES)[number] | 'updating' | 'up';

const SCREENSHOT_DIR = process.env.HH_SCREENSHOT_DIR;
const RELAY_PAGE = '<!DOCTYPE html><html><head><title>Not Found</title></head><body><h1>The page you requested was not found.</h1></body></html>';
const STARTING = { error: { code: 'unavailable', message: 'Hornhoof is starting.', reason: 'starting' } };
const MAINTENANCE = { error: { code: 'unavailable', message: 'Hornhoof is installing an update and takes no changes until it ends.', reason: 'maintenance' } };
const LINE = { lost: 'No connection', updating: 'Updating…' } as const;

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
  const title = LINE.lost;

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

  test(`${mode}: a page opened or reloaded while it lasts shows only the centered loader, and comes back by itself`, async ({ page }) => {
    await page.clock.install();
    const server = await serveServer(page);
    server.mode = mode;
    const loaded = loads(page);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: en.app.notResponding })).toHaveCount(0);
    await expect(page.getByText(en.errors.codes.internal)).toHaveCount(0);

    const loader = page.locator('.boot-screen');
    await expect(loader).toHaveText(title);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await loader.boundingBox()).toMatchObject({ x: 0, y: 0, ...page.viewportSize() });
    await expect(loader).toHaveAttribute('aria-busy', 'true');
    await expect(strip(page)).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveCount(1);

    server.mode = 'up';
    await until(page, async () => (await loader.count()) === 0);
    await expect(page.getByRole('navigation')).toBeVisible();
    expect(loaded.n).toBe(1);
  });
}

for (const cold of [false, true]) {
  test(`an update uses only the loading screen on a ${cold ? 'cold' : 'loaded'} page`, async ({ page }) => {
    const server = await serveServer(page);
    const loaded = loads(page);
    await page.clock.install();
    if (cold) server.mode = 'updating';
    await page.goto('/tasks');
    if (!cold) {
      await expect(tab(page, en.shell.tabs.tasks)).toBeVisible();
      server.mode = 'updating';
      await page.clock.runFor(NOTICE_MS);
    }
    const loader = page.locator('.boot-screen');
    await expect(loader).toHaveText(LINE.updating);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('progressbar')).toHaveCount(0);
    await expect(page.getByRole('navigation')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(loader).toBeVisible();
    await expect(strip(page)).toHaveCount(0);

    server.mode = 'up';
    await until(page, async () => (await loader.count()) === 0);
    await expect(tab(page, en.shell.tabs.tasks)).toBeVisible();
    expect(loaded.n).toBe(1);
  });
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`startup and standalone updating use the same loader with motion set to ${reducedMotion}`, async ({ browser }) => {
    for (const colorScheme of ['light', 'dark'] as const) {
      for (const [width, height] of [[1440, 900], [375, 700]] as const) {
        const context = await browser.newContext({ viewport: { width, height }, colorScheme, reducedMotion });
        let finishSetup: (() => void) | undefined;
        try {
          const startup = await context.newPage();
          await serveApi(startup);
          // Keep setup pending until the screenshot is taken. Release it before closing the context.
          const setup = new Promise<void>(resolve => { finishSetup = resolve; });
          await startup.route('**/api/setup', async route => {
            await setup;
            await route.fallback();
          });
          await startup.goto('/');
          const update = await context.newPage();
          await update.route('**/updating-test', route => route.fulfill({ status: 503, contentType: 'text/html', body: awayPage('updating') }));
          await update.goto('/updating-test');

          const loading = startup.locator('.boot-screen');
          const updating = update.locator('.boot-screen');
          await expect(loading).toHaveText(en.common.loading);
          await expect(updating).toHaveText('Updating…');
          expect(await loading.boundingBox()).toEqual({ x: 0, y: 0, width, height });
          expect(await updating.boundingBox()).toEqual(await loading.boundingBox());
          expect(await updating.locator('.boot-mark').boundingBox()).toEqual(await loading.locator('.boot-mark').boundingBox());
          const animation = async (loader: typeof loading) => loader.locator('.boot-dots > i').evaluateAll(dots => dots.map(dot => {
            const css = getComputedStyle(dot);
            return [css.animationName, css.animationDuration, css.animationDelay];
          }));
          const animations = await animation(loading);
          expect(animations).toHaveLength(3);
          if (reducedMotion === 'reduce') {
            expect(animations.every(([name]) => name === 'none')).toBe(true);
            expect((await animation(updating)).every(([name]) => name === 'none')).toBe(true);
            await shot(startup, `startup-loading-${colorScheme}-${width}-reduced`);
            await shot(update, `startup-503-${colorScheme}-${width}-reduced`);
          } else {
            expect(await animation(updating)).toEqual(animations);
            expect(animations.every(([name]) => name !== 'none')).toBe(true);
            expect(new Set(animations.map(([, , delay]) => delay)).size).toBe(3);
            for (const [label, page] of [['loading', startup], ['503', update]] as const) {
              const line = page.locator('.boot-line');
              const box = await line.boundingBox();
              const frames = [];
              for (const [phase, time] of [['early', 0], ['late', 360]] as const) {
                frames.push(await line.locator('.boot-dots > i').evaluateAll((dots, at) => dots.map(dot => {
                  for (const animation of dot.getAnimations()) {
                    animation.pause();
                    animation.currentTime = at;
                  }
                  return getComputedStyle(dot).opacity;
                }), time));
                await shot(page, `startup-${label}-${colorScheme}-${width}-${phase}`);
              }
              expect(frames[0]).not.toEqual(frames[1]);
              expect(await line.boundingBox()).toEqual(box);
            }
          }
        } finally {
          finishSetup?.();
          await context.close();
        }
      }
    }
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

test('places the connection strip under the desktop menu and clear of the phone heading', async ({ browser }) => {
  const skins = [['light', 'light'], ['dark', 'cyberpunk']] as const;
  for (const [scheme, skin] of skins) {
    for (const [width, height] of [[1440, 900], [375, 700]] as const) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: 'reduce' });
      const page = await context.newPage();
      try {
        await page.clock.install();
        await page.addInitScript(s => localStorage.setItem('hh-theme', s), skin);
        const server = await serveServer(page);
        await page.goto('/tasks');
        await expect(tab(page, en.shell.tabs.tasks)).toBeVisible();
        await expect(page.getByRole('heading', { name: en.tracker.where.mine, exact: true })).toBeVisible();
        const still = await placeOf(page);

        server.mode = 'refused';
        const dialog = windowOf(page, LINE.lost);
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
        await shot(page, `window-lost-${width}-${scheme}`);

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
        if (width === 375) {
          const heading = await page.getByRole('heading', { name: en.tracker.where.mine, exact: true }).boundingBox();
          expect(heading).not.toBeNull();
          expect(bar.top).toBeGreaterThan(heading!.y + heading!.height);
          expect(height - bar.top - bar.height).toBeCloseTo(8, 0);
        } else {
          expect(Math.abs(bar.top - (bar.menuBottom + 8))).toBeLessThanOrEqual(1);
        }
        expect(bar.height).toBeGreaterThanOrEqual(36);
        expect(bar.mark).toBe(24);
        expect(await placeOf(page)).toEqual(still);
        await shot(page, `strip-lost-${width}-${scheme}`);

        server.mode = 'up';
        await until(page, async () => (await strip(page).count()) === 0);
      } finally {
        await context.close();
      }
    }
  }
});

test('the phone strip leaves the loaded map the same size', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await page.addInitScript(() => localStorage.setItem('hh-theme', 'light'));
  await page.clock.install();
  const server = await serveServer(page);
  await page.goto('/');
  await expect(tab(page, en.shell.tabs.tasks)).toBeVisible();
  const map = page.locator('.map:not(.map-wait)');
  await expect(map).toBeVisible();
  const before = await map.boundingBox();
  expect(before).not.toBeNull();

  server.mode = 'refused';
  await page.clock.runFor(NOTICE_MS);
  await expect(windowOf(page, LINE.lost)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(strip(page)).toBeVisible();
  expect(await map.boundingBox()).toEqual(before);
  const blocked = await strip(page).evaluate(node => {
    const stripBox = node.getBoundingClientRect();
    return [...document.querySelectorAll('.map :is(.zoom, .ticker, .map-version)')].some(control => {
      const box = control.getBoundingClientRect();
      return box.width > 0 && box.height > 0 &&
        stripBox.left < box.right && stripBox.right > box.left &&
        stripBox.top < box.bottom && stripBox.bottom > box.top;
    });
  });
  expect(blocked).toBe(false);
});
