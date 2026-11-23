import { expect, test } from '@playwright/test';
import type { IsometricWorldEngine } from '../src/world/renderer';
import type { resolveWorldPack } from '../src/world-packs/registry';

/* Two world maps share one page whenever one ends while another draws: React's development mode mounts every map twice,
   and the first of the two can end before it ever draws. Ending one map must leave the other drawing, with no error in
   the page (run 594: "Cannot read properties of null (reading 'clear')" on a switch to and from Egypt). */
test('a world map that ends before it draws leaves the live city on the page drawing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/world-live.html?pack=egypt&lang=en&mode=hornhoof');
  await page.waitForFunction(() => ((window as unknown as { __WORLD_LIVE__?: { getBuildings: () => unknown[] } }).__WORLD_LIVE__?.getBuildings().length ?? 0) > 0);
  const frames = await page.evaluate(async () => {
    /* The page's own modules, as the dev server serves them to it. */
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { IsometricWorldEngine: Engine } = (await load('/src/world/renderer.ts')) as { IsometricWorldEngine: typeof IsometricWorldEngine };
    const { resolveWorldPack: packOf } = (await load('/src/world-packs/registry.ts')) as { resolveWorldPack: typeof resolveWorldPack };
    const next = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
    for (let i = 0; i < 30; i++) await next();
    const host = document.createElement('div');
    host.style.cssText = 'position: fixed; left: 0; top: 0; width: 320px; height: 200px;';
    document.body.append(host);
    const other = await Engine.create({ host, pack: packOf('egypt')! });
    other.destroy();
    host.remove();
    /* The live city goes on: its residents walk, so it draws anew in each of the next frames. */
    let drawn = 0;
    for (let i = 0; i < 60; i++) {
      await next();
      drawn++;
    }
    return drawn;
  });
  expect(frames).toBe(60);
  expect(errors).toEqual([]);
});
