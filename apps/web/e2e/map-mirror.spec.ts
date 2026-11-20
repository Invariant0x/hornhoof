import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { Org } from '../src/types';
import { ME, serveApi } from './api';
import { captureWith } from './capture';

/* The map's zoom, and Put back over it, stand at the start of the map's bottom: at the left on a page left to right, where
   they always stood, and at the right on a page right to left, mirrored as the rest of the layout is (#1622). Each look is
   shot before any check, so the code before the change draws its own. Shots go to HH_SCREENSHOT_DIR when it is set. A
   made-up company. */

const capture = captureWith('map-mirror', process.env.HH_SCREENSHOT_DIR);
const SIZES = { 375: { width: 375, height: 812 }, 1440: { width: 1440, height: 900 } } as const;
type Width = keyof typeof SIZES;
type Dir = 'ltr' | 'rtl';
/* Where they stood left to right before #1622: the zoom 16 px from the left and from the bottom, Put back 16 px from the left
   and 76 px from the bottom, 124 px on a phone. */
const EDGE = 16;
const PUT_BACK_BOTTOM: Record<Width, number> = { 375: 124, 1440: 76 };

const SALES = '00000000-0000-4000-8000-000000000001', DEV = '00000000-0000-4000-8000-000000000002';
const org = (): Org => ({
  company: ME.company,
  orchestrator: { id: 'a1', name: 'Orchestrator', model: '', effort: null, subscription: null, context: null, program: null, alarm: null, retry: null, failure: null },
  agents: { total: 4, working: 0 },
  people: [],
  departments: [SALES, DEV].map((id, i) => ({
    id, name: ['Sales', 'Development'][i]!, templateKey: null, roleCode: ['SAL', 'DEV'][i]!, about: '', agents: { total: 2, working: 0 },
    products: [], teams: [], people: [], employees: [], roles: [],
  })),
});

type Box = { x: number; y: number; width: number; height: number };

async function box(page: Page, selector: string): Promise<Box> {
  const b = await page.locator(selector).boundingBox();
  if (!b) throw new Error(`${selector} is not on the screen`);
  return b;
}

/* The map of a person who moved a department, so Put back shows over the zoom, at a width and in a direction. */
async function openMap(context: BrowserContext, width: Width, dir: Dir): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize(SIZES[width]);
  await page.addInitScript(dir => {
    localStorage.setItem('hh-lang', 'en');
    if (dir === 'rtl') document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = 'rtl'; });
  }, dir);
  await serveApi(page);
  await page.route('**/api/org', route => route.fulfill({ json: org() }));
  await page.route('**/api/map/layout', route => route.fulfill({ json: { blocks: { [`dept:${DEV}`]: { x: 900, y: 900 } } } }));
  await page.goto('/');
  await expect(page.locator('.map .dept')).toHaveCount(2);
  await expect(page.locator('.map > .map-arrange button')).toBeVisible();
  await expect(page.locator('.map > .zoom')).toBeVisible();
  if (dir === 'rtl') await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.evaluate(async () => { await document.fonts.ready; });
  return page;
}

for (const width of [1440, 375] as const) {
  test(`the zoom and Put back stand at the start of the map's bottom, mirrored right to left: ${width}px`, async ({ context }, info) => {
    const ltr = await openMap(context, width, 'ltr'), rtl = await openMap(context, width, 'rtl');
    if (info.project.name.includes('chromium')) {
      await capture(ltr, info, `ltr-${width}`);
      await capture(rtl, info, `rtl-${width}`);
    }
    const { width: across, height } = SIZES[width];
    const zoom = { ltr: await box(ltr, '.map > .zoom'), rtl: await box(rtl, '.map > .zoom') };
    const back = { ltr: await box(ltr, '.map > .map-arrange'), rtl: await box(rtl, '.map > .map-arrange') };

    /* Left to right they stand where they stood, to the pixel. */
    expect(zoom.ltr.x, 'the zoom from the left, left to right').toBeCloseTo(EDGE, 1);
    expect(height - (zoom.ltr.y + zoom.ltr.height), 'the zoom from the bottom, left to right').toBeCloseTo(EDGE, 1);
    expect(back.ltr.x, 'Put back from the left, left to right').toBeCloseTo(EDGE, 1);
    expect(height - (back.ltr.y + back.ltr.height), 'Put back from the bottom, left to right').toBeCloseTo(PUT_BACK_BOTTOM[width], 1);

    /* Right to left they are the mirror of that: as far from the right, at the same height, the zoom as wide. */
    expect(across - (zoom.rtl.x + zoom.rtl.width), 'the zoom from the right, right to left').toBeCloseTo(EDGE, 1);
    expect(zoom.rtl.y, 'the zoom at the same height').toBeCloseTo(zoom.ltr.y, 1);
    expect(zoom.rtl.width, 'the zoom as wide').toBeCloseTo(zoom.ltr.width, 1);
    expect(across - (back.rtl.x + back.rtl.width), 'Put back from the right, right to left').toBeCloseTo(EDGE, 1);
    expect(back.rtl.y, 'Put back at the same height').toBeCloseTo(back.ltr.y, 1);
  });
}
