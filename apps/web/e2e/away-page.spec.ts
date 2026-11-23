/// <reference types="node" />
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { startServer } from './real-server';

/* A browser that opens or reloads Hornhoof while no server is behind the front gets a page that says so, never a missing page
   and never an unstyled line (#1938). The front is the real one, run as the company's web port runs it, and the keeper behind
   it is a stand-in the test starts and stops: down, or answering as it does while an update installs. */
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_CWD = process.env.HH_E2E_SERVER_CWD ?? resolve(HERE, '../../server');
const SCREENSHOT_DIR = process.env.HH_SCREENSHOT_DIR;

const SCRIPT = `
import http from 'node:http';
import { startFront } from './src/net/front.ts';
import { maintenanceAnswer } from './src/modules/keeper/doors.ts';
import { passThrough, serve } from './src/net/proxy.ts';

const keeperPort = Number(process.env.HH_KEEPER_PORT);
/* The keeper as an update leaves it: it is there and answers for an app that is not. */
if (process.env.HH_AWAY === 'updating') {
  const keeper = serve(passThrough({ target: { host: '127.0.0.1', port: 1 }, headers: () => ({}), unreachable: maintenanceAnswer }));
  await new Promise(resolve => keeper.listen(keeperPort, '127.0.0.1', resolve));
}
const front = await startFront({ port: 0, host: '127.0.0.1', keeper: { host: '127.0.0.1', port: keeperPort }, holdMs: 0 });
console.log(JSON.stringify({ url: 'http://127.0.0.1:' + front.address().port }));
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
`;

type Front = { url: string; keeperPort: number; stop(): Promise<void> };

/* A port nobody listens on: the keeper's, while it is down. */
async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startFront(away: 'down' | 'updating'): Promise<Front> {
  const keeperPort = await freePort();
  const server = await startServer<{ url: string }>(SCRIPT, {
    cwd: SERVER_CWD, publicUrl: 'http://127.0.0.1', invalidBoot: 'Invalid front boot line', env: { HH_KEEPER_PORT: String(keeperPort), HH_AWAY: away },
  });
  return { url: server.url, keeperPort, stop: server.stop };
}

/* The keeper coming back, with a page of its own to show. */
async function keeperBack(port: number): Promise<() => Promise<void>> {
  const keeper = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><title>Hornhoof</title><h1 id="back">Hornhoof is back</h1>');
  });
  await new Promise<void>(resolve => keeper.listen(port, '127.0.0.1', resolve));
  return () => new Promise<void>(resolve => {
    keeper.closeAllConnections();
    keeper.close(() => resolve());
  });
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SCREENSHOT_DIR) return;
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: resolve(SCREENSHOT_DIR, `${name}.png`) });
}

const EN = { lost: 'No connection to the server', updating: 'Server is updating', checking: /^Checking every \d+\s?s$/, reload: 'Reload page' };
const RU = { lost: 'Нет связи с сервером', updating: 'Сервер обновляется', checking: /^Проверяем каждые \d+\s?с$/, reload: 'Обновить страницу' };

/* A visitor whose browser asks for a language (its Accept-Language) and a colour scheme, on a screen of one size. */
async function visitor(browser: Browser, locale: string, colorScheme: 'light' | 'dark' = 'light', viewport = { width: 1440, height: 900 }): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ locale, colorScheme, viewport });
  return { page: await context.newPage(), context };
}

/* What a part of the page looks like, as the browser drew it. */
const look = (page: Page) => page.evaluate(() => {
  const size = (selector: string) => {
    const style = getComputedStyle(document.querySelector(selector)!);
    return { size: style.fontSize, weight: style.fontWeight, line: style.lineHeight, color: style.color };
  };
  const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number; right: number };
  return { title: size('h1'), hint: size('main > p:not(.checking)'), checking: size('p.checking'), sign: box('.sign'), button: box('button'), card: box('main'), lang: document.documentElement.lang };
});

test('no server behind the front: the page says no connection in English, makes no outside request, and opens by itself', async ({ page }) => {
  const front = await startFront('down');
  const outside: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).origin !== front.url) outside.push(request.url());
  });
  let stopKeeper: (() => Promise<void>) | null = null;
  try {
    const response = await page.goto(front.url + '/tasks');
    /* The status says the server is missing: not 404. */
    expect(response!.status()).toBe(502);
    await expect(page.getByRole('heading', { name: EN.lost })).toBeVisible();
    await expect(page.getByText('This page opens by itself when the server answers.')).toBeVisible();
    await expect(page.getByText(EN.checking)).toBeVisible();
    await expect(page.getByRole('button', { name: EN.reload })).toBeVisible();
    /* One language, not two in a row. */
    await expect(page.getByText(RU.lost)).toHaveCount(0);
    await expect(page.getByText('404')).toHaveCount(0);
    await expect(page.getByText(/not found/i)).toHaveCount(0);

    stopKeeper = await keeperBack(front.keeperPort);
    /* Its own refresh takes the page to the server once it answers: no click, no reload by the test. */
    await expect(page.locator('#back')).toBeVisible();
    expect(outside).toEqual([]);
  } finally {
    await stopKeeper?.();
    await front.stop();
  }
});

test('the button asks the server at once, before the page asks by itself', async ({ page }) => {
  const front = await startFront('down');
  try {
    await page.goto(front.url + '/tasks');
    const button = page.getByRole('button', { name: EN.reload });
    await expect(button).toBeVisible();
    /* The page's own refresh is 5 s away: a request within 2 s of the click is the button's. */
    const asked = page.waitForRequest(request => request.isNavigationRequest() && request.url().endsWith('/tasks'), { timeout: 2000 });
    await button.click();
    await asked;
  } finally {
    await front.stop();
  }
});

test('a browser that asks for Russian gets the page in Russian only', async ({ browser }) => {
  const front = await startFront('down');
  const { page, context } = await visitor(browser, 'ru-RU');
  try {
    const response = await page.goto(front.url + '/');
    expect(response!.status()).toBe(502);
    await expect(page.getByRole('heading', { name: RU.lost })).toBeVisible();
    await expect(page.getByText('Страница откроется сама, когда сервер ответит.')).toBeVisible();
    await expect(page.getByText(RU.checking)).toBeVisible();
    await expect(page.getByRole('button', { name: RU.reload })).toBeVisible();
    await expect(page.getByText(EN.lost)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('ru');
  } finally {
    await context.close();
    await front.stop();
  }
});

test('a browser that asks for a language Hornhoof does not ship gets English', async ({ browser }) => {
  const front = await startFront('down');
  const { page, context } = await visitor(browser, 'de-DE');
  try {
    await page.goto(front.url + '/');
    await expect(page.getByRole('heading', { name: EN.lost })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('en');
  } finally {
    await context.close();
    await front.stop();
  }
});

test('an update installing: the page says the server is updating, and its sizes are the other page\'s', async ({ browser }) => {
  const down = await startFront('down');
  const updating = await startFront('updating');
  const english = await visitor(browser, 'en-US');
  const russian = await visitor(browser, 'ru-RU');
  const page = english.page;
  try {
    await page.goto(down.url + '/');
    const lost = await look(page);
    const response = await page.goto(updating.url + '/');
    expect(response!.status()).toBe(503);
    await expect(page.getByRole('heading', { name: EN.updating })).toBeVisible();
    await expect(page.getByText('This takes a few minutes. The page opens by itself.')).toBeVisible();
    await expect(page.getByRole('heading', { name: EN.lost })).toHaveCount(0);
    expect(await look(page)).toEqual(lost);
    await russian.page.goto(updating.url + '/');
    await expect(russian.page.getByRole('heading', { name: RU.updating })).toBeVisible();
    await expect(russian.page.getByText('Это займет несколько минут. Страница откроется сама.')).toBeVisible();
  } finally {
    await english.context.close();
    await russian.context.close();
    await down.stop();
    await updating.stop();
  }
});

/* Each look the Design checks: both languages, light and dark, wide and narrow, both states. The title is 600 at 22 px, the text
   14 px, the line that says it asks again 13 px, the sign 48 px, the button from 44 px at the end edge, and nothing runs past the
   phone. */
test('the page is the same in every language, scheme and width, wraps, and fits a phone, light and dark', async ({ browser }) => {
  const fronts = { lost: await startFront('down'), updating: await startFront('updating') };
  try {
    for (const [language, locale, words] of [['en', 'en-US', EN], ['ru', 'ru-RU', RU]] as const) {
      for (const scheme of ['light', 'dark'] as const) {
        for (const [width, height] of [[1440, 900], [375, 700], [320, 640]] as const) {
          const { page, context } = await visitor(browser, locale, scheme, { width, height });
          try {
            for (const state of ['lost', 'updating'] as const) {
              await page.goto(fronts[state].url + '/');
              await expect(page.getByRole('heading', { name: words[state] })).toBeVisible();
              const seen = await look(page);
              expect(seen.lang).toBe(language);
              expect(seen.title).toMatchObject({ size: '22px', weight: '600' });
              expect(seen.hint).toMatchObject({ size: '14px', weight: '400' });
              expect(seen.checking.size).toBe('13px');
              expect(seen.sign).toMatchObject({ width: 48, height: 48 });
              expect(seen.button.height).toBeGreaterThanOrEqual(44);
              expect(seen.card.x).toBeGreaterThanOrEqual(0);
              expect(seen.card.right).toBeLessThanOrEqual(width);
              expect(seen.card.width).toBeLessThanOrEqual(440);
              /* The button stands at the end edge of the card's content. */
              expect(Math.abs(seen.card.right - 1 - 20 - seen.button.right)).toBeLessThanOrEqual(1);
              expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
              if (width !== 320) await shot(page, `fallback-${language}-${state}-${width === 1440 ? 'wide' : 'narrow'}-${scheme}`);
            }
          } finally {
            await context.close();
          }
        }
      }
    }
  } finally {
    await fronts.lost.stop();
    await fronts.updating.stop();
  }
});
