import { expect, test, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { serveApi } from './api';

/* A server that cannot be reached must never read as a missing page (#1938). Each way the server can be away answers the
   page differently, and each must end in the same honest layer, then bring the page back by itself, with no reload:
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
  const server = { mode: 'up' as Mode, org: 0 };
  await serveApi(page);
  await page.route('**/api/**', route => {
    if (new URL(route.request().url()).pathname === '/api/org') server.org++;
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
  const title = mode === 'updating' ? en.connection.updating.title : en.connection.lost.title;

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

test('the layer speaks Russian, wraps, and keeps the page where it stands', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => localStorage.setItem('hh-lang', 'ru'));
  await page.setViewportSize({ width: 375, height: 700 });
  const server = await serveServer(page);
  await page.goto('/');
  await expect(tab(page, ru.shell.tabs.tasks)).toBeVisible();
  const before = await page.getByRole('navigation').boundingBox();
  server.mode = 'refused';
  await page.clock.runFor(NOTICE_MS);
  const lost = layer(page, ru.connection.lost.title);
  await expect(lost).toBeVisible();
  await expect(lost.getByText(ru.connection.lost.hint)).toBeVisible();
  await expect(lost.getByRole('button', { name: ru.connection.tryNow, exact: true })).toBeVisible();
  const box = await lost.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  /* Over the page, not in its flow: nothing under it moved. */
  expect(await page.getByRole('navigation').boundingBox()).toEqual(before);
});
