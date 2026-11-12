import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Org, PersonView } from '../src/types';
import { box, ME, serveApi } from './api';

/* Two departments and Oleg, who runs both from the strip under them, as on Ivan's map. */
const SALES = '00000000-0000-4000-8000-000000000001', DEV = '00000000-0000-4000-8000-000000000002';
const OLEG = '00000000-0000-4000-8000-000000000006';
const IVAN: PersonView = { id: ME.person.id, name: 'Ivan', email: 'ivan@acme.com', title: 'CEO', status: 'active', isOwner: true, access: { whole: true, departments: [], teams: [] } };
const ORG: Org = {
  company: ME.company,
  orchestrator: { id: 'a1', name: 'Orchestrator', model: '', effort: null, subscription: null, context: null, program: null, alarm: null, retry: null, failure: null },
  agents: { total: 0, working: 0 },
  people: [
    IVAN,
    { ...IVAN, id: OLEG, name: 'Oleg Tikhonov', email: 'oleg@acme.com', title: '', isOwner: false, deputy: true, departments: [SALES, DEV], access: { whole: false, departments: [{ id: SALES, name: 'Sales' }, { id: DEV, name: 'Development' }], teams: [] } },
  ],
  departments: [SALES, DEV].map((id, i) => ({ id, name: ['Sales', 'Development'][i]!, templateKey: null, roleCode: 'SAL', about: '', agents: { total: 0, working: 0 }, products: [], teams: [], people: [], employees: [], roles: [] })),
};

type At = { x: number; y: number };

/* The server keeps one arrangement for the page's person, as it does for each person. */
async function serveMap(page: Page) {
  const kept: { blocks: Record<string, At> } = { blocks: {} };
  const writes: { method: string; body: unknown }[] = [];
  await serveApi(page);
  await page.route('**/api/org', route => route.fulfill({ json: ORG }));
  await page.route('**/api/version', route => route.fulfill({ json: { version: '0.18.6', commit: 'map-drag' } }));
  await page.route('**/api/updates', route => route.fulfill({ json: { current: { version: '0.18.6', commit: 'map-drag' }, available: false, latest: null, updater: { status: null, waiting: null } } }));
  await page.route('**/api/map/layout', route => {
    const method = route.request().method();
    if (method === 'GET') return route.fulfill({ json: kept });
    const body = route.request().postDataJSON() as { blocks: Record<string, At | null> } | null;
    writes.push({ method, body });
    if (method === 'DELETE') {
      kept.blocks = {};
      return route.fulfill({ status: 204 });
    }
    for (const [key, at] of Object.entries(body!.blocks)) {
      if (at) kept.blocks[key] = at;
      else delete kept.blocks[key];
    }
    return route.fulfill({ json: kept });
  });
  return { kept, writes };
}

const worldOf = async (el: Locator) => el.evaluate((e: HTMLElement) => ({ x: parseFloat(e.style.left), y: parseFloat(e.style.top), w: parseFloat(e.style.width), h: parseFloat(e.style.height) }));
const scaleOf = async (page: Page) => Number(/scale\(([^)]+)\)/.exec(await page.locator('.world').evaluate((e: HTMLElement) => e.style.transform))![1]);
const lines = async (page: Page) =>
  page.locator('.wires path.tr').evaluateAll(paths => paths.map(p => ({ d: p.getAttribute('d')!, person: p.getAttribute('data-person') })));
/* A line's points, run after run: a stretch another line already draws is left out of it. */
const runsOf = (d: string) => d.split('M ').filter(Boolean).map(run => run.trim().split(' L ').map(p => p.split(' ').map(Number) as [number, number]));
const pointsOf = (d: string) => runsOf(d).flat();
const square = (pts: [number, number][]) => pts.slice(1).every((q, i) => q[0] === pts[i]![0] || q[1] === pts[i]![1]);
const onEdge = ([x, y]: [number, number], r: { x: number; y: number; w: number; h: number }) =>
  ((Math.abs(x - r.x) < 0.01 || Math.abs(x - r.x - r.w) < 0.01) && y >= r.y && y <= r.y + r.h) || ((Math.abs(y - r.y) < 0.01 || Math.abs(y - r.y - r.h) < 0.01) && x >= r.x && x <= r.x + r.w);

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');
  await expect(page.locator('.dept')).toHaveCount(2);
  return errors;
}

test.describe('arranging the company map', () => {
  test.use({ viewport: { width: 1440, height: 1000 }, hasTouch: true });

  test('a block taken by the grip at its top left corner goes where it is put, stays there, and its lines follow at right angles', async ({ page }) => {
    const { kept, writes } = await serveMap(page);
    const errors = await open(page);
    const oleg = page.locator('.dept-chips li', { hasText: 'Oleg Tikhonov' });
    const before = await worldOf(oleg);
    const world = await page.locator('.world').getAttribute('style');
    const k = await scaleOf(page);

    /* The grip stands over the card's corner, its middle on it, and is 44 px to touch on the screen. */
    const grip = page.getByRole('button', { name: 'Move Oleg Tikhonov' });
    const g = await box(grip), card = await box(oleg);
    expect(Math.round(g.width)).toBe(44);
    expect(Math.round(g.height)).toBe(44);
    expect(Math.abs(g.x + g.width / 2 - card.x)).toBeLessThan(1);
    expect(Math.abs(g.y + g.height / 2 - card.y)).toBeLessThan(1);

    await page.mouse.move(g.x + g.width - 8, g.y + g.height - 8);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width - 8 - 120, g.y + g.height - 8 - 200, { steps: 8 });
    await page.mouse.up();

    const after = await worldOf(oleg);
    /* A block stands on whole world pixels. */
    expect(Math.abs(after.x - before.x + 120 / k)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - before.y + 200 / k)).toBeLessThanOrEqual(1);
    /* The map itself did not move under the hand. */
    expect(await page.locator('.world').getAttribute('style')).toBe(world);
    await expect.poll(() => kept.blocks[`person:${OLEG}`]).toEqual({ x: after.x, y: after.y });
    expect(writes.map(w => w.method)).toEqual(['PATCH']);

    /* Every line runs across and down only, and Oleg's lines end on the edge of his card. */
    const drawn = await lines(page);
    for (const { d } of drawn) expect(runsOf(d).every(square), d).toBe(true);
    const own = drawn.filter(l => l.person === OLEG);
    expect(own.length).toBeGreaterThan(0);
    expect(own.some(l => runsOf(l.d).some(run => [run[0]!, run.at(-1)!].some(p => onEdge(p, after))))).toBe(true);

    /* It stays where it was put on the next visit. */
    await page.reload();
    await expect(page.locator('.dept')).toHaveCount(2);
    expect(await worldOf(oleg)).toEqual(after);

    expect(errors).toEqual([]);
    /* A press on a department still opens it. */
    await page.getByRole('button', { name: /^Sales/ }).click();
    await expect(page.locator('.dview')).toBeVisible();
  });

  test('a finger moves a department by its grip, and Put back as it was brings everything home', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'The finger is Chromium\'s own touch input.');
    const { kept, writes } = await serveMap(page);
    const errors = await open(page);
    const sales = page.locator('.dept', { hasText: 'Sales' });
    const before = await worldOf(sales);
    const trace = page.locator(`.wires [data-wire="${SALES}"]`);
    const home = await trace.getAttribute('d');
    const k = await scaleOf(page);

    const g = await box(page.getByRole('button', { name: 'Move Sales' }));
    const cdp = await page.context().newCDPSession(page);
    const at = (dx: number, dy: number) => [{ x: g.x + g.width - 8 + dx, y: g.y + g.height - 8 + dy }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0, 0) });
    for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(i * -10, i * 70) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    const after = await worldOf(sales);
    expect(Math.abs(after.x - before.x + 60 / k)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.y - before.y - 420 / k)).toBeLessThanOrEqual(1);
    await expect.poll(() => kept.blocks[`dept:${SALES}`]).toEqual({ x: after.x, y: after.y });
    const moved = pointsOf((await trace.getAttribute('d'))!);
    expect(runsOf((await trace.getAttribute('d'))!).every(square)).toBe(true);
    expect(onEdge(moved.at(-1)!, after)).toBe(true);

    await page.getByRole('button', { name: 'Put back as it was' }).click();
    await expect(page.getByRole('button', { name: 'Put back as it was' })).toHaveCount(0);
    expect(await worldOf(sales)).toEqual(before);
    expect(await trace.getAttribute('d')).toBe(home);
    await expect.poll(() => writes.map(w => w.method)).toEqual(['PATCH', 'DELETE']);
    expect(kept.blocks).toEqual({});
    expect(errors).toEqual([]);
  });
});

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      test(`map grips and the way back in ${lang} ${theme} ${width}`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(({ lang, theme }) => {
          localStorage.setItem('hh-lang', lang);
          localStorage.setItem('hh-theme', theme);
        }, { lang, theme });
        const { kept } = await serveMap(page);
        kept.blocks = { [`dept:${DEV}`]: { x: 820, y: 640 } };
        const errors = await open(page);
        const putBack = page.getByRole('button', { name: lang === 'en' ? 'Put back as it was' : 'Вернуть как было' });
        await expect(putBack).toBeVisible();
        /* The way back fits the screen above the zoom, at 44 px to touch. */
        const b = await box(putBack), zoom = await box(page.locator('.zoom'));
        expect(b.height).toBeGreaterThanOrEqual(44);
        expect(b.x + b.width).toBeLessThanOrEqual(width);
        expect(b.y + b.height).toBeLessThanOrEqual(zoom.y);
        /* Nor does the orchestrator's line cover it. */
        const line = await box(page.locator('.ticker'));
        expect(b.y + b.height <= line.y || line.x + line.width <= b.x || b.x + b.width <= line.x).toBe(true);
        const grips = page.getByRole('button', { name: lang === 'en' ? /^Move / : /^Передвинуть: / });
        await expect(grips).toHaveCount(5);
        for (const g of await grips.all()) {
          const r = await box(g);
          expect(Math.round(r.width)).toBe(44);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`map-arranged-${lang}-${theme}-${width}.png`), animations: 'disabled' });
        expect(errors).toEqual([]);
      });
    }
  }
}
