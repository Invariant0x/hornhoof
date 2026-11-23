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

/* The layer is the book's dialog on its dimmed layer: it takes every click, the page under it is inert, it is the dialog the
   screen reader names by its heading and describes by its hint, and Escape leaves it where it is. The focus goes to its button
   and comes back to where it was when the server answers. */
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
  const lost = layer(page, en.connection.lost.title);
  await expect(lost).toBeVisible();
  await expect(lost).toHaveAttribute('aria-labelledby', 'conn-title');
  await expect(lost.getByRole('heading', { name: en.connection.lost.title })).toHaveAttribute('id', 'conn-title');
  await expect(lost).toHaveAccessibleDescription(en.connection.lost.hint);
  await expect(lost.getByRole('status')).toBeVisible();
  await expect(lost.getByRole('button', { name: en.connection.tryNow, exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(lost).toBeVisible();

  /* The standard dimmed layer, which takes the click meant for the page under it, and the page under it is inert. */
  expect(await page.locator('.conn-layer').evaluate(el => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--scrim)';
    document.body.append(probe);
    const scrim = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return getComputedStyle(el).backgroundColor === scrim;
  })).toBe(true);
  expect(await page.evaluate(() => document.elementFromPoint(window.innerWidth / 2, 20)?.closest('.conn-layer') !== null)).toBe(true);
  await expect(page.locator('.app-screen')).toHaveAttribute('inert', '');

  server.mode = 'up';
  await until(page, async () => (await layer(page, en.connection.lost.title).count()) === 0);
  await expect(page.locator('.app-screen')).not.toHaveAttribute('inert', '');
  await expect(tasks).toBeFocused();
});

/* The ring turns only while a look is on its way. Between looks the layer says when the next one comes, counting down, and
   once the wait is long it says so under the text: after 2 minutes of no connection, after 5 of an update. */
test('the ring turns only during a look, the layer counts down to the next, and says when the wait is long', async ({ page }) => {
  await page.clock.install();
  const server = await serveServer(page);
  await page.goto('/');
  await expect(tab(page, en.shell.tabs.tasks)).toBeVisible();
  server.mode = 'refused';
  await page.clock.runFor(NOTICE_MS);
  const lost = layer(page, en.connection.lost.title);
  await expect(lost).toBeVisible();

  /* Between looks: no ring, the seconds to the next. */
  await expect(lost.getByText(/^Next try in \d+\s?s$/)).toBeVisible();
  await expect(lost.locator('.spinner')).toHaveCount(0);

  /* During a look: the ring and its words, and the countdown gone. */
  let release!: () => void;
  server.gate = new Promise<void>(resolve => (release = resolve));
  await page.clock.runFor(10_000);
  await expect(lost.locator('.spinner')).toBeVisible();
  await expect(lost.getByText(en.connection.trying)).toBeVisible();
  await expect(lost.getByText(/^Next try in/)).toHaveCount(0);
  release();
  await expect(lost.getByText(/^Next try in \d+\s?s$/)).toBeVisible();
  await expect(lost.locator('.spinner')).toHaveCount(0);

  /* Not long yet, then long: the line comes under the text after 2 minutes. */
  server.gate = null;
  await expect(lost.getByText(en.connection.lost.long)).toHaveCount(0);
  await page.clock.runFor(125_000);
  await expect(lost.getByText(en.connection.lost.long)).toBeVisible();
  await expect(lost.getByText(en.connection.updating.long)).toHaveCount(0);
});

test('an update that takes longer than five minutes says so, and not sooner', async ({ page }) => {
  await page.clock.install();
  const server = await serveServer(page);
  await page.goto('/');
  await expect(tab(page, en.shell.tabs.tasks)).toBeVisible();
  server.mode = 'updating';
  await page.clock.runFor(NOTICE_MS);
  const updating = layer(page, en.connection.updating.title);
  await expect(updating).toBeVisible();
  await page.clock.runFor(200_000);
  await expect(updating.getByText(en.connection.updating.long)).toHaveCount(0);
  await page.clock.runFor(110_000);
  await expect(updating.getByText(en.connection.updating.long)).toBeVisible();
  await expect(updating.getByText(en.connection.lost.long)).toHaveCount(0);
});

test('the ring stands still as a quarter arc where motion is reduced', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  const server = await serveServer(page);
  await page.goto('/');
  await expect(tab(page, en.shell.tabs.tasks)).toBeVisible();
  server.mode = 'refused';
  await page.clock.runFor(NOTICE_MS);
  const lost = layer(page, en.connection.lost.title);
  await expect(lost).toBeVisible();
  let release!: () => void;
  server.gate = new Promise<void>(resolve => (release = resolve));
  await page.clock.runFor(10_000);
  const ring = lost.locator('.spinner');
  await expect(ring).toBeVisible();
  expect(await ring.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  /* A quarter arc: one side of its border in the accent, the rest in the idle colour. */
  expect(await ring.evaluate(el => {
    const style = getComputedStyle(el);
    return style.borderTopColor !== style.borderRightColor && style.borderRightColor === style.borderBottomColor && style.borderBottomColor === style.borderLeftColor;
  })).toBe(true);
  release();
});
