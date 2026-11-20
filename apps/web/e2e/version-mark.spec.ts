import { expect, test, type Locator, type Page } from '@playwright/test';
import { BUILTIN_SKINS, type BuiltinSkinId } from '../src/skins/registry';
import type { Org } from '../src/types';
import { ME, serveApi } from './api';
import { captureWith } from './capture';

/* The version over the map (#1590, Ivan's word): the map has no row of its own under it and no line above one; it runs to the
   bottom of the screen, and the version is small muted text in its bottom end corner, over the map, clear of every control
   and of the bars along a phone's bottom, catching no taps. Every other screen keeps the footer row b0e6cb58 gave it, so it
   covers nothing there. A made-up company. Shots go to HH_SCREENSHOT_DIR when it is set. */

const capture = captureWith('version-mark', process.env.HH_SCREENSHOT_DIR);
const VERSION = { version: '0.39.1', commit: 'a276aa6c0ffee' };
const TEXT = '0.39.1 (a276aa6)';
const SIZES = { 375: { width: 375, height: 812 }, 1440: { width: 1440, height: 900 } } as const;
type Width = keyof typeof SIZES;
type Dir = 'ltr' | 'rtl';
type Look = { width: Width; dir: Dir; skin: BuiltinSkinId };
/* How near the version keeps to the end of the screen and to what it stands on. */
const NEAR = 16;
/* The bars that float along the bottom of the map. */
const BARS = '.map > .zoom, .map > .ticker, .map > .map-arrange';
/* Everything a person can press or read as a control. */
const CONTROLS = 'button, a[href], input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"]), .zoom, .ticker, .map-arrange, .topbar';

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

/* The version as it shows on the screen: a closed menu names it too, in other words. */
const mark = (page: Page): Locator => page.getByText(TEXT, { exact: true }).filter({ visible: true });

async function box(locator: Locator): Promise<Box> {
  const b = await locator.boundingBox();
  if (!b) throw new Error('not on screen');
  return b;
}

/* Two frames in a row with the same boxes: the map and its bars have stopped moving. */
async function still(page: Page) {
  const boxes = () => page.evaluate(async selector => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return JSON.stringify([...document.querySelectorAll(selector)].map(e => {
      const r = e.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    }));
  }, `.map .world, ${BARS}, .version-mark`);
  let before = await boxes();
  for (let now = await boxes(); now !== before; now = await boxes()) before = now;
}

async function openMap(page: Page, look: Look, arranged = false) {
  await page.setViewportSize(SIZES[look.width]);
  await page.addInitScript(({ skin, dir }) => {
    localStorage.setItem('hh-lang', 'en');
    localStorage.setItem('hh-theme', skin);
    if (dir === 'rtl') document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = 'rtl'; });
  }, { skin: look.skin, dir: look.dir });
  await serveApi(page);
  await page.route('**/api/org', route => route.fulfill({ json: org() }));
  await page.route('**/api/version', route => route.fulfill({ json: VERSION }));
  /* A person who moved a department sees Put back in a bar of its own over the orchestrator's line. */
  if (arranged) await page.route('**/api/map/layout', route => route.fulfill({ json: { blocks: { [`dept:${DEV}`]: { x: 900, y: 900 } } } }));
  await page.goto('/');
  await expect(page.locator('.map .dept')).toHaveCount(2);
  await expect(page.locator('html')).toHaveAttribute('data-theme', look.skin);
  if (arranged) await expect(page.locator('.map-arrange button')).toBeVisible();
  await expect(mark(page)).toHaveCount(1);
  await page.evaluate(async () => { await document.fonts.ready; });
  await still(page);
}

/* What the version stands on. On a phone, the top of the highest bar along the bottom of the map, wherever it stands across,
   as Put back at the start over the dock: the room #1554 measures ends over them all, and the version stands in the end
   corner of that room. On a wide screen the room is the whole map and no bar stands in the end corner, the zoom and Put back
   at the start and the orchestrator's line in the middle (#1622), so it is the bottom of the window. */
const floorUnder = (page: Page, phone: boolean) => page.evaluate(({ selector, phone }) => {
  const tops = [...document.querySelectorAll(selector)].map(e => e.getBoundingClientRect())
    .filter(r => phone && r.width && r.height && r.top > innerHeight / 2).map(r => r.top);
  return tops.length ? Math.min(...tops) : innerHeight;
}, { selector: BARS, phone });

async function standsOn(page: Page, at: Box, width: Width) {
  const bottom = at.y + at.height, floor = await floorUnder(page, width === 375);
  expect(bottom, 'over the bars along the bottom').toBeLessThanOrEqual(floor);
  expect(floor - bottom, 'near what it stands on').toBeLessThanOrEqual(NEAR);
}

/* What of the page a person can press or read as a control lies under the version. */
const under = (page: Page, at: Box) => page.evaluate(({ selector, at }) => [...document.querySelectorAll(selector)].flatMap(e => {
  if (e.closest('.version-mark') || !e.getClientRects().length || getComputedStyle(e).visibility === 'hidden') return [];
  const r = e.getBoundingClientRect();
  const over = r.width > 0 && r.height > 0 && r.left < at.x + at.width && at.x < r.right && r.top < at.y + at.height && at.y < r.bottom;
  return over ? [`${e.tagName.toLowerCase()}.${[...e.classList].join('.')} "${(e.textContent ?? '').trim().slice(0, 40)}"`] : [];
}), { selector: CONTROLS, at });

/* The element a tap at the middle of the version reaches, and whether it is the version or inside it. */
const hitAt = (version: Locator) => version.evaluate(el => {
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { mine: !!hit && (hit === el || el.contains(hit)), what: hit ? `${hit.tagName.toLowerCase()}.${[...hit.classList].join('.')}` : 'nothing' };
});

/* The colour of a token as this page draws it. */
const tokenColor = (page: Page, token: string) => page.evaluate(name => {
  const probe = document.body.appendChild(document.createElement('span'));
  probe.style.color = `var(${name})`;
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}, token);

/* The contrast of the version's text with the ground of the map under it, by WCAG 2. */
const contrastOnMap = (version: Locator) => version.evaluate(el => {
  const parse = (value: string): number[] => {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(value);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : [0, 0, 0, 0];
  };
  const over = (top: number[], below: number[]) => [0, 1, 2].map(i => top[i]! * top[3]! + below[i]! * (1 - top[3]!)).concat(1);
  const luminance = (c: number[]) => [0, 1, 2].map(i => c[i]! / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  const layers: number[][] = [];
  for (let at: Element | null = el; at; at = at.parentElement) layers.push(parse(getComputedStyle(at).backgroundColor));
  const ground = layers.reverse().reduce((below, top) => over(top, below), [255, 255, 255, 1]);
  const [a, b] = [luminance(over(parse(getComputedStyle(el).color), ground)), luminance(ground)].sort((x, y) => y - x);
  return Math.round(((a! + 0.05) / (b! + 0.05)) * 100) / 100;
});

const LOOKS: Look[] = (['cyberpunk', 'light'] as const).flatMap(skin =>
  ([1440, 375] as const).flatMap(width => (['ltr', 'rtl'] as const).map(dir => ({ width, dir, skin }))));

for (const look of LOOKS) {
  test(`the map runs to the bottom with the version over its end corner: ${look.skin}, ${look.dir}, ${look.width}px`, async ({ page }, info) => {
    await openMap(page, look);
    const { width, height } = SIZES[look.width];

    /* No row of its own and no line: the screen and the map reach the bottom of the window. */
    expect(await page.getByRole('contentinfo').isVisible(), 'a footer row shows').toBe(false);
    expect((await box(page.locator('.app-screen'))).y + (await box(page.locator('.app-screen'))).height).toBe(height);
    const map = await box(page.locator('.map'));
    expect(map.y + map.height).toBe(height);

    /* Small muted text and nothing more: no frame, no line, no ground of its own. */
    const version = mark(page);
    const style = await version.evaluate(el => {
      const s = getComputedStyle(el);
      return {
        size: s.fontSize, color: s.color, ground: s.backgroundColor, lines: [s.borderTopWidth, s.borderBottomWidth, s.borderLeftWidth, s.borderRightWidth],
        taps: s.pointerEvents, reads: `${s.direction} ${s.unicodeBidi}`,
      };
    });
    /* The build is a name: it reads left to right on a page right to left too, its brackets where they belong. */
    expect(style).toEqual({
      size: '12px', color: await tokenColor(page, '--muted'), ground: 'rgba(0, 0, 0, 0)', lines: ['0px', '0px', '0px', '0px'], taps: 'none', reads: 'ltr isolate',
    });

    /* In the bottom end corner: right on a page left to right, left on one right to left. */
    const at = await box(version);
    if (look.dir === 'ltr') expect(width - (at.x + at.width), 'gap to the right edge').toBeGreaterThanOrEqual(0);
    if (look.dir === 'ltr') expect(width - (at.x + at.width), 'gap to the right edge').toBeLessThanOrEqual(NEAR);
    if (look.dir === 'rtl') expect(at.x, 'gap to the left edge').toBeGreaterThanOrEqual(0);
    if (look.dir === 'rtl') expect(at.x, 'gap to the left edge').toBeLessThanOrEqual(NEAR);
    expect(look.dir === 'ltr' ? at.x > width / 2 : at.x + at.width < width / 2, 'on the end half of the screen').toBe(true);

    /* At the bottom: right on the bars along the bottom on a phone, in the corner of the window on a wide screen. */
    await standsOn(page, at, look.width);

    /* It covers no control and no bar, and a tap at its middle goes to the map under it. */
    expect(await under(page, at)).toEqual([]);
    const hit = await hitAt(version);
    expect(hit.mine, `a tap there reaches ${hit.what}`).toBe(false);

    if (info.project.name.includes('chromium') || info.project.name === 'matrix') await capture(page, info, `map-${look.skin}-${look.dir}-${look.width}`);
  });
}

for (const width of [1440, 375] as const) for (const dir of ['ltr', 'rtl'] as const) {
  test(`with Put back over the zoom the version still stands clear of the bars: ${dir}, ${width}px`, async ({ page }, info) => {
    await openMap(page, { width, dir, skin: 'cyberpunk' }, true);
    const at = await box(mark(page));
    const end = dir === 'ltr' ? SIZES[width].width - (at.x + at.width) : at.x;
    expect(end, 'gap to the end of the screen').toBeGreaterThanOrEqual(0);
    expect(end, 'gap to the end of the screen').toBeLessThanOrEqual(NEAR);
    await standsOn(page, at, width);
    expect(await under(page, at)).toEqual([]);
    if (info.project.name.includes('chromium') || info.project.name === 'matrix') await capture(page, info, `map-arranged-${dir}-${width}`);
  });
}

for (const skin of BUILTIN_SKINS.map(s => s.id)) {
  test(`the version reads on the map in the ${skin} skin`, async ({ page }) => {
    await openMap(page, { width: 1440, dir: 'ltr', skin });
    const version = mark(page);
    expect(await version.evaluate(el => getComputedStyle(el).color)).toBe(await tokenColor(page, '--muted'));
    expect(await contrastOnMap(version)).toBeGreaterThanOrEqual(4.5);
  });
}

test('every other screen keeps the version in its footer row below the screen', async ({ page }, info) => {
  await page.setViewportSize(SIZES[1440]);
  await serveApi(page);
  await page.route('**/api/version', route => route.fulfill({ json: VERSION }));
  await page.goto('/machines');
  const footer = page.getByRole('contentinfo');
  await expect(footer).toHaveText(TEXT);
  const screen = await box(page.locator('.app-screen')), row = await box(footer);
  expect(screen.y + screen.height).toBe(row.y);
  expect(row.y + row.height).toBe(SIZES[1440].height);
  expect(await footer.evaluate(el => getComputedStyle(el).borderTopWidth)).toBe('1px');
  if (info.project.name.includes('chromium')) await capture(page, info, 'machines-footer-1440');
});
