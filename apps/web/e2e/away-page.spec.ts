/// <reference types="node" />
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { startServer } from './real-server';

/* A browser that opens or reloads Hornhoof while no server is behind the front or the keeper gets only the Hornhoof logo and
   one English line, centred on a plain background, and the page reloads itself when the server answers (#1938, #2049). */
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_CWD = process.env.HH_E2E_SERVER_CWD ?? resolve(HERE, '../../server');
const SCREENSHOT_DIR = process.env.HH_SCREENSHOT_DIR;

const SCRIPT = `
import { startFront } from './src/net/front.ts';
import { maintenanceAnswer } from './src/modules/keeper/doors.ts';
import { passThrough, serve } from './src/net/proxy.ts';

const keeperPort = Number(process.env.HH_KEEPER_PORT);
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

const LINE = { lost: 'No connection', updating: 'Updating' } as const;
const BG = { light: 'rgb(230, 235, 240)', dark: 'rgb(20, 26, 34)' } as const;

async function visitor(
  browser: Browser,
  locale: string,
  colorScheme: 'light' | 'dark' = 'light',
  viewport = { width: 1440, height: 900 },
  extraHTTPHeaders?: Record<string, string>,
): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ locale, colorScheme, viewport, extraHTTPHeaders });
  return { page: await context.newPage(), context };
}

const look = (page: Page) => page.evaluate(() => {
  const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number; right: number; bottom: number };
  const main = getComputedStyle(document.querySelector('main')!);
  const line = getComputedStyle(document.querySelector('main > p')!);
  return {
    lang: document.documentElement.lang,
    bg: getComputedStyle(document.body).backgroundColor,
    mainBg: main.backgroundColor,
    mainBorder: main.borderTopWidth,
    sign: box('.sign'),
    logoParts: {
      dome: document.querySelectorAll('.sign .mk-dome').length,
      base: document.querySelectorAll('.sign .mk-base').length,
      dot: document.querySelectorAll('.sign .mk-dot').length,
    },
    lineBox: box('main > p'),
    lineFont: { size: line.fontSize, weight: line.fontWeight },
    text: document.body.textContent?.trim() ?? '',
    extras: document.querySelectorAll('button, h1, h2, h3, a, input').length,
    fitsWidth: document.documentElement.scrollWidth <= window.innerWidth,
  };
});

test('no server behind the front: the page shows only the logo and No connection, makes no outside request, and opens by itself', async ({ page }) => {
  const front = await startFront('down');
  const outside: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).origin !== front.url) outside.push(request.url());
  });
  let stopKeeper: (() => Promise<void>) | null = null;
  try {
    const response = await page.goto(front.url + '/tasks');
    expect(response!.status()).toBe(502);
    await expect(page.locator('main > p')).toHaveText(LINE.lost);
    const seen = await look(page);
    expect(seen.text).toBe(LINE.lost);
    expect(seen.extras).toBe(0);
    expect(seen.logoParts).toEqual({ dome: 1, base: 1, dot: 1 });
    await expect(page.getByText('404')).toHaveCount(0);
    await expect(page.getByText(/not found/i)).toHaveCount(0);

    stopKeeper = await keeperBack(front.keeperPort);
    await expect(page.locator('#back')).toBeVisible();
    expect(outside).toEqual([]);
  } finally {
    await stopKeeper?.();
    await front.stop();
  }
});

test('browsers asking for other languages still get the one English line on both states', async ({ browser }) => {
  const down = await startFront('down');
  const updating = await startFront('updating');
  try {
    for (const locale of ['ru-RU', 'de-DE']) {
      const { page, context } = await visitor(browser, locale);
      try {
        const lostRes = await page.goto(down.url + '/');
        expect(lostRes!.status()).toBe(502);
        await expect(page.locator('main > p')).toHaveText(LINE.lost);
        expect(await page.evaluate(() => ({ lang: document.documentElement.lang, text: document.body.textContent?.trim() }))).toEqual({ lang: 'en', text: LINE.lost });

        const updRes = await page.goto(updating.url + '/');
        expect(updRes!.status()).toBe(503);
        await expect(page.locator('main > p')).toHaveText(LINE.updating);
        expect(await page.evaluate(() => ({ lang: document.documentElement.lang, text: document.body.textContent?.trim() }))).toEqual({ lang: 'en', text: LINE.updating });
      } finally {
        await context.close();
      }
    }
  } finally {
    await down.stop();
    await updating.stop();
  }
});

test('centres the logo and one line on a plain background across schemes, widths and plain front or keeper requests', async ({ browser }) => {
  const fronts = { lost: await startFront('down'), updating: await startFront('updating') };
  const plainTargets = {
    lost: fronts.lost.url + '/',
    updating: `http://127.0.0.1:${fronts.updating.keeperPort}/`,
  };
  try {
    for (const scheme of ['light', 'dark'] as const) {
      for (const [width, height] of [[1440, 900], [375, 700], [320, 640]] as const) {
        for (const [kind, headers, urls] of [
          ['away', undefined, { lost: fronts.lost.url + '/', updating: fronts.updating.url + '/' }],
          ['plain', { accept: '*/*' }, plainTargets],
        ] as const) {
          const { page, context } = await visitor(browser, 'en-US', scheme, { width, height }, headers);
          try {
            for (const state of ['lost', 'updating'] as const) {
              const res = await page.goto(urls[state]);
              expect(res!.status()).toBe(state === 'lost' ? 502 : 503);
              await expect(page.locator('main > p')).toHaveText(LINE[state]);
              const seen = await look(page);
              expect(seen.lang).toBe('en');
              expect(seen.bg).toBe(BG[scheme]);
              expect(seen.mainBg).toBe('rgba(0, 0, 0, 0)');
              expect(seen.mainBorder).toBe('0px');
              expect(seen.text).toBe(LINE[state]);
              expect(seen.extras).toBe(0);
              expect(seen.logoParts).toEqual({ dome: 1, base: 1, dot: 1 });
              expect(seen.sign).toMatchObject({ width: 48, height: 48 });
              expect(seen.lineFont).toEqual({ size: '14px', weight: '400' });
              expect(seen.lineBox.y).toBeGreaterThanOrEqual(seen.sign.bottom);
              expect(Math.abs(seen.sign.x + seen.sign.width / 2 - width / 2)).toBeLessThanOrEqual(1);
              expect(Math.abs(seen.lineBox.x + seen.lineBox.width / 2 - width / 2)).toBeLessThanOrEqual(1);
              expect(Math.abs((seen.sign.y + seen.lineBox.bottom) / 2 - height / 2)).toBeLessThanOrEqual(2);
              expect(seen.fitsWidth).toBe(true);
              if (width !== 320) await shot(page, `${kind}-${state}-${width}-${scheme}`);
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
