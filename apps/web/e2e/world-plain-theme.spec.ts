/* #1973: a theme is either the interface alone or a full world. A plain theme loads no world: no engine or pack code,
   no PixiJS, no world data from /api/world, no WebGL context, whichever screen the person opens. The dev server serves
   every module the page imports as its own request, so a module the page never asked for was never loaded. */
import { expect, test, type Page } from '@playwright/test';
import { ME, serveApi } from './api';
import { createHornhoofLiveFixture } from '../src/world/live-sync';

const isWorldCode = (path: string) => /\/src\/world(-packs)?\//.test(path) || /pixi/i.test(path);

/* Every path the page asks for, and the WebGL contexts it opens, from the first byte on. */
async function watch(page: Page, theme: string): Promise<string[]> {
  const asked: string[] = [];
  page.on('request', request => asked.push(new URL(request.url()).pathname));
  await page.addInitScript(look => {
    localStorage.setItem('hh-lang', 'en');
    localStorage.setItem('hh-theme', look);
    const w = window as unknown as { __webglContexts: number };
    w.__webglContexts = 0;
    const real = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
      if (/webgl/.test(kind)) w.__webglContexts += 1;
      return (real as (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) => RenderingContext | null).call(this, kind, ...rest);
    } as typeof real;
  }, theme);
  await serveApi(page);
  await page.route('**/api/me', route => route.fulfill({ json: { ...ME, company: { ...ME.company, theme } } }));
  await page.route('**/api/world/state', route => route.fulfill({ json: createHornhoofLiveFixture() }));
  return asked;
}

const webglContexts = (page: Page) => page.evaluate(() => (window as unknown as { __webglContexts: number }).__webglContexts);

test('a plain theme loads no world engine, world code or world data on the map, tasks and people', async ({ page }) => {
  const asked = await watch(page, 'cyberpunk');
  await page.goto('/');
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('button', { name: 'Map', exact: true })).toBeVisible();
  await nav.getByRole('button', { name: 'Tasks', exact: true }).click();
  await nav.getByRole('button', { name: 'People', exact: true }).click();
  await nav.getByRole('button', { name: 'Map', exact: true }).click();
  await page.waitForLoadState('networkidle');
  expect(asked.filter(p => p.startsWith('/api/world')), 'world data').toEqual([]);
  expect(asked.filter(isWorldCode), 'world code').toEqual([]);
  expect(await webglContexts(page), 'WebGL contexts').toBe(0);
});

/* The check sees the world when there is one: the same watch on a world theme catches its code, data and context. */
test('a world theme loads its engine, code and data, which the plain-theme check would catch', async ({ page }) => {
  const asked = await watch(page, 'egypt');
  await page.goto('/');
  await expect(page.locator('[data-world-canvas="egypt"] canvas').first()).toBeVisible();
  expect(asked.filter(p => p.startsWith('/api/world/state')).length).toBeGreaterThan(0);
  expect(asked.filter(isWorldCode).length).toBeGreaterThan(0);
  expect(await webglContexts(page)).toBeGreaterThan(0);
});
