/* #1978: the guard's plates over the world map leave no hole in the canvas.

   Chromium culled the WebGL canvas under the one opaque panel on top of it, and took the culled rectangle upside down:
   the canvas showed a solid black block at the panel's mirror image across the page's middle line, wherever the world
   itself drew. A dark look made the guard's "Effects are off" note such a panel, so the black block stood under the
   logo. These checks put the panel there and read the page's own picture where its mirror image falls. */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { builtinSkin } from '../src/skins/registry';
import { declarations, extraDeclarations } from '../src/skins/roles';
import { createHornhoofLiveFixture } from '../src/world/live-sync';
import { ME, serveApi } from './api';

const OUT_DIR = process.env.HH_OUT || join(process.cwd(), 'e2e', 'results', 'world-canvas-overlay');
type Box = { x: number; y: number; width: number; height: number };

async function openEgyptMap(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => {
    localStorage.setItem('hh-lang', 'en');
    localStorage.setItem('hh-theme', 'egypt');
  });
  await serveApi(page);
  await page.route('**/api/me', route => route.fulfill({ json: { ...ME, company: { ...ME.company, theme: 'egypt' } } }));
  await page.route('**/api/world/state', route => route.fulfill({ json: createHornhoofLiveFixture() }));
  await page.goto('/');
  await expect(page.locator('[data-world-canvas="egypt"] canvas').first()).toBeVisible();
  await page.waitForFunction(() => {
    const world = (window as unknown as { __WORLD_PRODUCT__?: { getBuildings: () => unknown[] } }).__WORLD_PRODUCT__;
    return Boolean(world && world.getBuildings().length > 0);
  });
  await page.evaluate(() => {
    (window as unknown as { __WORLD_PRODUCT__: { flushVisibleBakes: () => void } }).__WORLD_PRODUCT__.flushVisibleBakes();
  });
}

/* The dark pixel look's tokens put on the page the way the skin store puts on any look, while the world stays: the
   values the upload test of #1960 gives an uploaded theme, before a theme of its own can carry a world on this turn. */
async function putOnPixelLook(page: Page): Promise<void> {
  const look = builtinSkin('pixel')!;
  const extra = extraDeclarations(look);
  await page.evaluate(({ set, clear, scheme, shape }) => {
    const root = document.documentElement;
    for (const [property, value] of set) root.style.setProperty(property, value);
    for (const property of clear) root.style.removeProperty(property);
    root.dataset.scheme = scheme;
    root.dataset.cut = shape;
    delete root.dataset.surface;
  }, { set: [...declarations(look), ...extra.set], clear: extra.clear, scheme: look.scheme, shape: look.shape });
}

/* The guard's own switch, from the module the page runs, so the note shows on a fast machine as on a slow one. */
async function turnEffectsOff(page: Page): Promise<Box> {
  await page.evaluate(async () => {
    const guardUrl = '/src/guard.ts';
    const guard = (await import(/* @vite-ignore */ guardUrl)) as { enterLight: (reason: 'frames', block: string) => void };
    guard.enterLight('frames', 'world canvas overlay check');
  });
  const note = page.locator('.light-note');
  await expect(note).toBeVisible();
  return (await note.boundingBox())!;
}

/* The share of the most common colour inside a box of the page's own picture, read back by the page itself: about 1
   where the canvas was left undrawn (a flat hole, black or the page's own background showing through), well below it
   over the drawn map, whose ground and water never come out one flat colour. */
async function flatShareIn(page: Page, box: Box): Promise<number> {
  const png = (await page.screenshot({ animations: 'allow' })).toString('base64');
  return page.evaluate(async ({ png, box }) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const x0 = Math.max(0, Math.floor(box.x));
    const y0 = Math.max(0, Math.floor(box.y));
    const x1 = Math.min(bitmap.width, Math.ceil(box.x + box.width));
    const y1 = Math.min(bitmap.height, Math.ceil(box.y + box.height));
    if (x1 <= x0 || y1 <= y0) return 0;
    const data = context.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    const counts = new Map<number, number>();
    for (let i = 0; i < data.length; i += 4) {
      const colour = (data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!;
      counts.set(colour, (counts.get(colour) ?? 0) + 1);
    }
    return Math.max(...counts.values()) / (data.length / 4);
  }, { png, box });
}

const mirrorOf = (box: Box, pageHeight: number): Box => ({ ...box, y: pageHeight - box.y - box.height });

/* A few frames apart, since the map keeps drawing between them. */
async function expectNoHoleAt(page: Page, panel: Box, pageHeight: number, what: string): Promise<void> {
  const mirror = mirrorOf(panel, pageHeight);
  for (let frame = 0; frame < 3; frame += 1) {
    expect(await flatShareIn(page, mirror), `${what}: one flat colour at the panel's mirror image, frame ${frame + 1}`).toBeLessThan(0.9);
    await page.waitForTimeout(400);
  }
}

async function keepShot(page: Page, info: TestInfo, name: string): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path, animations: 'allow' });
  await info.attach(name, { path, contentType: 'image/png' });
}

test.describe('World canvas under an opaque panel (#1978)', () => {
  for (const [width, height] of [[1440, 900], [375, 812]] as const) {
    test(`the pixel look's "Effects are off" note leaves no black block in the map at ${width}`, async ({ page }, info) => {
      await openEgyptMap(page, width, height);
      await putOnPixelLook(page);
      const note = await turnEffectsOff(page);
      await page.waitForTimeout(800);
      await keepShot(page, info, `world-canvas-overlay-pixel-note-${width}`);
      await expectNoHoleAt(page, note, height, `pixel look at ${width}`);
    });
  }

  /* The general case stays open: any single fully opaque box over the map still cuts the hole, and only a mask on the
     canvas host (fix A, its cost to be measured in #1947's fps table) would cure that. The guard's plates avoid it by
     being 99% opaque (theme.css). Kept here, skipped, so the case is not forgotten. */
  test('one plain opaque box over the shipped Egypt map leaves no hole at its mirror image', async ({ page }, info) => {
    test.skip(true, 'Known Chromium issue: with WebGL drawn in software (SwiftShader) the canvas under a single fully opaque box is left undrawn, mirrored across the page middle. Needs fix A (#1947); the guard plates avoid it at 99% (#1978).');
    await openEgyptMap(page, 1440, 900);
    const panel: Box = { x: 600, y: 300, width: 300, height: 100 };
    await page.evaluate(box => {
      const plate = document.createElement('div');
      plate.style.cssText = `position: fixed; z-index: 28; left: ${box.x}px; top: ${box.y}px; width: ${box.width}px; height: ${box.height}px; background: #202033;`;
      document.body.append(plate);
    }, panel);
    await page.waitForTimeout(800);
    await keepShot(page, info, 'world-canvas-overlay-egypt-panel-1440');
    await expectNoHoleAt(page, panel, 900, 'Egypt skin');
  });
});
