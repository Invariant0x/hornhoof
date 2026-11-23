/// <reference types="node" />
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
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

const EN = { lost: 'No connection to the server', updating: 'Server is updating' };
const RU = { lost: 'Нет связи с сервером', updating: 'Сервер обновляется' };

test('no server behind the front: the page says no connection in both languages, makes no outside request, and opens by itself', async ({ page }) => {
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
    await expect(page.getByRole('heading', { name: RU.lost })).toBeVisible();
    await expect(page.getByText('404')).toHaveCount(0);
    await expect(page.getByText(/not found/i)).toHaveCount(0);
    await shot(page, 'fallback-lost-desktop');

    stopKeeper = await keeperBack(front.keeperPort);
    /* Its own refresh takes the page to the server once it answers: no click, no reload by the test. */
    await expect(page.locator('#back')).toBeVisible();
    expect(outside).toEqual([]);
  } finally {
    await stopKeeper?.();
    await front.stop();
  }
});

test('an update installing: the page says the server is updating, in both languages', async ({ page }) => {
  const front = await startFront('updating');
  try {
    const response = await page.goto(front.url + '/');
    expect(response!.status()).toBe(503);
    await expect(page.getByRole('heading', { name: EN.updating })).toBeVisible();
    await expect(page.getByRole('heading', { name: RU.updating })).toBeVisible();
    await expect(page.getByRole('heading', { name: EN.lost })).toHaveCount(0);
    await shot(page, 'fallback-updating-desktop');
  } finally {
    await front.stop();
  }
});

test('the page wraps and fits a phone, light and dark', async ({ page }) => {
  const front = await startFront('down');
  try {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const width of [375, 320]) {
        await page.setViewportSize({ width, height: 700 });
        await page.goto(front.url + '/');
        const box = await page.locator('main').boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        if (width === 375) await shot(page, `fallback-lost-narrow-${scheme}`);
      }
    }
  } finally {
    await front.stop();
  }
});
