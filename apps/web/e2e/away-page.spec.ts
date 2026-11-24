/// <reference types="node" />
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { startServer } from './real-server';

/* A browser that opens or reloads Hornhoof while no server is behind the front gets a page that says so, never a missing page
   and never an unstyled line (#1938): the sign of Hornhoof and one line in English, "No connection" or "Updating", centred on
   a plain background, and nothing else (#2049). The front is the real one, run as the company's web port runs it, and the
   keeper behind it is a stand-in the test starts and stops: down, or answering as it does while an update installs. */
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

const LINE = { lost: 'No connection', updating: 'Updating' };

/* A visitor whose browser asks for a language (its Accept-Language) and a colour scheme, on a screen of one size. */
async function visitor(browser: Browser, locale: string, colorScheme: 'light' | 'dark' = 'light', viewport = { width: 1440, height: 900 }): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ locale, colorScheme, viewport });
  return { page: await context.newPage(), context };
}

/* What the page looks like, as the browser drew it: what a person reads, how many things there are to touch, the sign and the
   line by their boxes, and the background. */
const look = (page: Page) => page.evaluate(() => {
  const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number; right: number; bottom: number };
  const line = getComputedStyle(document.querySelector('p')!);
  return {
    text: document.body.innerText.trim(),
    touchable: document.querySelectorAll('button, a, input, select, textarea, [tabindex], [onclick]').length,
    sign: box('.sign'),
    line: box('p'),
    size: { size: line.fontSize, weight: line.fontWeight },
    background: getComputedStyle(document.body).backgroundColor,
    lang: document.documentElement.lang,
    across: document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight,
  };
});

test('no server behind the front: the page is the sign and "No connection", makes no outside request, and opens by itself', async ({ page }) => {
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
    await expect(page.getByText(LINE.lost, { exact: true })).toBeVisible();
    const seen = await look(page);
    expect(seen.text).toBe(LINE.lost);
    expect(seen.touchable).toBe(0);
    await expect(page.getByRole('button')).toHaveCount(0);
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

test('an update installing: the page is the sign and "Updating", and its sizes are the other page\'s', async ({ page }) => {
  const down = await startFront('down');
  const updating = await startFront('updating');
  try {
    await page.goto(down.url + '/');
    const lost = await look(page);
    const response = await page.goto(updating.url + '/');
    expect(response!.status()).toBe(503);
    await expect(page.getByText(LINE.updating, { exact: true })).toBeVisible();
    await expect(page.getByText(LINE.lost)).toHaveCount(0);
    const seen = await look(page);
    expect(seen.text).toBe(LINE.updating);
    expect(seen.touchable).toBe(0);
    expect(seen.sign).toEqual(lost.sign);
    expect(seen.size).toEqual(lost.size);
  } finally {
    await down.stop();
    await updating.stop();
  }
});

test('the line is English for a browser of any language: Russian, German or none', async ({ browser }) => {
  const front = await startFront('down');
  const updating = await startFront('updating');
  try {
    for (const locale of ['ru-RU', 'de-DE', 'en-US']) {
      const { page, context } = await visitor(browser, locale);
      try {
        await page.goto(front.url + '/');
        await expect(page.getByText(LINE.lost, { exact: true })).toBeVisible();
        expect((await look(page)).text, locale).toBe(LINE.lost);
        expect((await look(page)).lang, locale).toBe('en');
        await page.goto(updating.url + '/');
        await expect(page.getByText(LINE.updating, { exact: true })).toBeVisible();
        expect((await look(page)).text, locale).toBe(LINE.updating);
      } finally {
        await context.close();
      }
    }
  } finally {
    await front.stop();
    await updating.stop();
  }
});

/* Each look the Design checks: light and dark, wide and narrow, both states. The sign and the line stand in the middle of the
   window on a plain background of the scheme, nothing runs past a phone, and nothing else is on the page. */
test('the page is centred and plain in every scheme and width, and fits a phone, light and dark', async ({ browser }) => {
  const fronts = { lost: await startFront('down'), updating: await startFront('updating') };
  try {
    const backgrounds: Record<string, string> = {};
    for (const scheme of ['light', 'dark'] as const) {
      for (const [width, height] of [[1440, 900], [375, 700], [320, 640]] as const) {
        const { page, context } = await visitor(browser, 'en-US', scheme, { width, height });
        try {
          for (const state of ['lost', 'updating'] as const) {
            await page.goto(fronts[state].url + '/');
            await expect(page.getByText(LINE[state], { exact: true })).toBeVisible();
            const seen = await look(page);
            expect(seen.text).toBe(LINE[state]);
            expect(seen.touchable).toBe(0);
            expect(seen.sign).toMatchObject({ width: 48, height: 48 });
            /* Centred: the sign and the line share the middle of the window, and the two together the middle of its height. */
            expect(Math.abs(seen.sign.x + seen.sign.width / 2 - width / 2)).toBeLessThanOrEqual(1);
            expect(Math.abs(seen.line.x + seen.line.width / 2 - width / 2)).toBeLessThanOrEqual(1);
            expect(seen.line.y).toBeGreaterThan(seen.sign.bottom);
            expect(Math.abs((seen.sign.y + seen.line.bottom) / 2 - height / 2)).toBeLessThanOrEqual(2);
            expect(seen.across).toBe(true);
            backgrounds[`${scheme}`] = seen.background;
            if (width !== 320) await shot(page, `fallback-${state}-${width === 1440 ? 'wide' : 'narrow'}-${scheme}`);
          }
        } finally {
          await context.close();
        }
      }
    }
    /* The scheme of the browser decides the background, and each is one plain colour. */
    expect(backgrounds.light).not.toBe(backgrounds.dark);
  } finally {
    await fronts.lost.stop();
    await fronts.updating.stop();
  }
});
