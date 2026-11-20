import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { Org, PersonView } from '../src/types';
import { box, ME, serveApi } from './api';

/* Two departments around the hub and Ivan on top, as a small company's map stands. */
const SALES = '00000000-0000-4000-8000-000000000001', DEV = '00000000-0000-4000-8000-000000000002';
const IVAN: PersonView = { id: ME.person.id, name: 'Ivan', email: 'ivan@acme.com', title: 'CEO', status: 'active', isOwner: true, access: { whole: true, departments: [], teams: [] } };
const ORG: Org = {
  company: ME.company,
  orchestrator: { id: 'a1', name: 'Orchestrator', model: '', effort: null, subscription: null, context: null, program: null, alarm: null, retry: null, failure: null },
  agents: { total: 0, working: 0 },
  people: [IVAN],
  departments: [SALES, DEV].map((id, i) => ({ id, name: ['Sales', 'Development'][i]!, templateKey: null, roleCode: 'SAL', about: '', agents: { total: 0, working: 0 }, products: [], teams: [], people: [], employees: [], roles: [] })),
};
const LINE = `dept:${SALES}`;
/* The trace from the hub to Sales as the map lays it out: out of the hub, up beside it and into the middle of Sales' side. */
const HOME = 'M 600 420 L 516 420 L 516 200 L 390 200';

type Point = [number, number];
type Layout = { blocks: Record<string, unknown>; anchors: Record<string, Point[]> };

/* The server keeps one arrangement for the page's person, with the bends they put on its lines. */
async function serveMap(page: Page) {
  const kept: Layout = { blocks: {}, anchors: {} };
  const writes: unknown[] = [];
  await serveApi(page);
  await page.route('**/api/org', route => route.fulfill({ json: ORG }));
  await page.route('**/api/version', route => route.fulfill({ json: { version: '0.23.1', commit: 'map-bends' } }));
  await page.route('**/api/updates', route => route.fulfill({ json: { current: { version: '0.23.1', commit: 'map-bends' }, available: false, latest: null, updater: { status: null, waiting: null } } }));
  await page.route('**/api/map/layout', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: kept });
    const body = route.request().postDataJSON() as { anchors?: Record<string, Point[] | null> };
    writes.push(body);
    for (const [line, at] of Object.entries(body.anchors ?? {})) {
      if (at) kept.anchors[line] = at;
      else delete kept.anchors[line];
    }
    return route.fulfill({ json: kept });
  });
  return { kept, writes };
}

const shot = (page: Page, info: TestInfo, name: string) => page.screenshot({ path: info.outputPath(`${name}.png`), animations: 'disabled' });
const trace = (page: Page) => page.locator(`.wires [data-wire="${SALES}"]`).getAttribute('d');

/* Where a point of the map's world is on the screen. */
async function onScreen(page: Page, [x, y]: Point) {
  const world = await box(page.locator('.world'));
  const k = world.width / 1200;
  return { x: world.x + x * k, y: world.y + y * k, k };
}

/* What the page draws at a point of the screen: a line that takes a click there, a bend's handle, or something else. */
const hitAt = (page: Page, x: number, y: number) =>
  page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x!, y!);
    return el?.getAttribute('data-line') ?? (el?.classList.contains('bend') ? 'bend' : el?.tagName.toLowerCase() ?? null);
  }, [x, y]);

test.describe('bends on the lines of the company map', () => {
  test.use({ viewport: { width: 1440, height: 1000 } });

  test('a click on a line puts a bend, the hand and the arrow keys move it, and a press takes it away', async ({ page }, info) => {
    const { kept, writes } = await serveMap(page);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto('/');
    await expect(page.locator('.dept')).toHaveCount(2);
    await expect.poll(() => page.locator('.world').evaluate((e: HTMLElement) => e.style.transform)).not.toBe('translate(0px, 0px) scale(1)');
    expect(await trace(page)).toBe(HOME);
    await shot(page, info, 'bends-1-map');

    /* The line takes the hand 6 px either side of it on the screen, and the pointer says it can be clicked. */
    const at = await onScreen(page, [516, 260]);
    expect(await hitAt(page, at.x, at.y)).toBe(LINE);
    expect(await hitAt(page, at.x + 5, at.y)).toBe(LINE);
    expect(await hitAt(page, at.x - 5, at.y)).toBe(LINE);
    expect(await hitAt(page, at.x + 9, at.y)).not.toBe(LINE);
    await page.mouse.move(at.x + 4, at.y);
    expect(await page.locator(`.wires .hit[data-line="${LINE}"]`).evaluate(e => getComputedStyle(e).cursor)).toBe('pointer');

    /* A click 4 px beside the line puts the bend on it, on the whole world pixel the screen's pixel stands for, and the line
       runs on as it did. */
    await page.mouse.click(at.x + 4, at.y);
    const bend = page.getByRole('button', { name: 'Bend in the line: Orchestrator and Sales. Drag it or use the arrow keys to move it, click it to remove it' });
    await expect(bend).toBeVisible();
    await expect.poll(() => writes.length).toBe(1);
    const [[x0, y0]] = kept.anchors[LINE]!;
    expect(x0).toBe(516);
    expect(Math.abs(y0! - 260)).toBeLessThanOrEqual(1);
    expect(writes).toEqual([{ anchors: { [LINE]: [[516, y0]] } }]);
    expect(await trace(page)).toBe(HOME);
    /* Its dot is the one the map draws where a trace turns, and the handle over it is 28 px on the screen, its middle on it. */
    const dot = page.locator(`.wires circle.via[cx="516"][cy="${y0}"]`), turn = page.locator('.wires circle.via[cx="516"][cy="200"]');
    const look = (c: typeof dot) => c.evaluate(e => { const s = getComputedStyle(e); return [e.getAttribute('r'), s.fill, s.stroke, s.strokeWidth]; });
    expect(await look(dot)).toEqual(await look(turn));
    const b = await box(bend), d = await box(dot);
    expect([Math.round(b.width), Math.round(b.height)]).toEqual([28, 28]);
    expect(Math.abs(b.x + b.width / 2 - (d.x + d.width / 2))).toBeLessThan(1);
    expect(Math.abs(b.y + b.height / 2 - (d.y + d.height / 2))).toBeLessThan(1);
    expect(await bend.evaluate(e => [e.childElementCount, getComputedStyle(e).cursor, getComputedStyle(e).backgroundColor])).toEqual([0, 'move', 'rgba(0, 0, 0, 0)']);
    /* The handle takes the hand 12 px from the dot's middle. */
    expect(await hitAt(page, at.x + 12, at.y)).toBe('bend');
    await shot(page, info, 'bends-2-put');
    await page.screenshot({ path: info.outputPath('bends-2-put-close.png'), animations: 'disabled', clip: { x: at.x - 160, y: at.y - 120, width: 240, height: 240 } });

    /* The hand takes the bend 36 left and 40 down; the line follows it at right angles before it lets go, and the map stays. */
    const view = await page.locator('.world').getAttribute('style');
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    await page.mouse.move(at.x - 36 * at.k, at.y + 40 * at.k, { steps: 8 });
    const [x1, y1] = await bend.evaluate((e: HTMLElement) => [parseFloat(e.style.left), parseFloat(e.style.top)]);
    expect(Math.abs(x1! - 480)).toBeLessThanOrEqual(1);
    expect(Math.abs(y1! - 300)).toBeLessThanOrEqual(1);
    expect(await trace(page)).toBe(`M 600 420 L ${x1} 420 L ${x1} 200 L 390 200`);
    expect(await bend.evaluate(e => getComputedStyle(e).cursor)).toBe('grabbing');
    await shot(page, info, 'bends-3-moving');
    expect(writes).toHaveLength(1);
    await page.mouse.up();
    expect(await page.locator('.world').getAttribute('style')).toBe(view);
    await expect.poll(() => kept.anchors[LINE]).toEqual([[x1, y1]]);

    /* The arrow keys move a bend that has the keyboard's focus, 10 at a step, and it shows that focus with a ring of its own
       inside its handle, not the page's ring around it. The keyboard brings the focus, on with Tab and back with Shift+Tab, as
       a person's would: every engine rings what the keyboard reached, while Firefox does not ring a button a script focused
       after the hand held it (#1657). */
    await bend.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(bend).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    expect(await trace(page)).toBe(`M 600 420 L ${x1! - 20} 420 L ${x1! - 20} 200 L 390 200`);
    await expect.poll(() => kept.anchors[LINE]).toEqual([[x1! - 20, y1]]);
    expect(await bend.evaluate(e => { const s = getComputedStyle(e); return [e.matches(':focus-visible'), s.outlineStyle, s.outlineWidth, s.outlineOffset]; }))
      .toEqual([true, 'solid', '2px', '-6px']);
    const moved = await onScreen(page, [x1! - 20, y1!]);
    await page.screenshot({ path: info.outputPath('bends-4-keys-close.png'), animations: 'disabled', clip: { x: moved.x - 160, y: moved.y - 140, width: 260, height: 260 } });
    await shot(page, info, 'bends-4-keys');

    /* A press that does not move it takes it away, and the line runs its own way again. */
    await page.mouse.click(moved.x, moved.y);
    await expect(bend).toHaveCount(0);
    expect(await trace(page)).toBe(HOME);
    await expect.poll(() => writes.at(-1)).toEqual({ anchors: { [LINE]: null } });
    expect(kept.anchors).toEqual({});
    await expect(page.getByRole('button', { name: 'Put back as it was' })).toHaveCount(0);
    await shot(page, info, 'bends-5-taken-away');

    /* Zoomed far out, the line still takes the hand 6 px either side of it on the screen. */
    for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Zoom out' }).click();
    const far = await onScreen(page, [516, 260]);
    expect(far.k).toBeLessThan(0.6);
    expect(await hitAt(page, far.x + 5, far.y)).toBe(LINE);
    expect(await hitAt(page, far.x - 5, far.y)).toBe(LINE);
    expect(await hitAt(page, far.x + 9, far.y)).not.toBe(LINE);

    /* A press on a department still opens it. */
    expect(errors).toEqual([]);
    await page.getByRole('button', { name: /^Sales/ }).click();
    await expect(page.locator('.dview')).toBeVisible();
  });
});

test.describe('bends under a finger', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('a finger puts a bend from 10 px beside a line, takes it by a handle as big as a block\'s grip, and a tap takes it away', async ({ page, browserName }, info) => {
    const { writes } = await serveMap(page);
    await page.goto('/');
    await expect(page.locator('.dept')).toHaveCount(2);
    await expect.poll(() => page.locator('.world').evaluate((e: HTMLElement) => e.style.transform)).not.toBe('translate(0px, 0px) scale(1)');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

    /* Under a finger the line takes a touch 12 px either side of it. */
    const at = await onScreen(page, [516, 260]);
    expect(await hitAt(page, at.x + 11, at.y)).toBe(LINE);
    expect(await hitAt(page, at.x - 11, at.y)).toBe(LINE);
    expect(await hitAt(page, at.x + 15, at.y)).not.toBe(LINE);
    /* Neither the line nor the bend is drawn for the touch, so the phone flashes nothing over the map where it lands. That flash
       is -webkit-tap-highlight-color, Chromium's and WebKit's own: Firefox has no such property and flashes nothing on a tap,
       so only an engine that has it is asked, and Firefox stays the only one without it (#1657). */
    const flashes = await page.evaluate(() => CSS.supports('-webkit-tap-highlight-color', 'transparent'));
    expect(flashes, 'an engine with a tap flash').toBe(browserName !== 'firefox');
    const flash = (of: Locator) => of.evaluate(e => getComputedStyle(e).getPropertyValue('-webkit-tap-highlight-color'));
    if (flashes) expect(await flash(page.locator(`.wires .hit[data-line="${LINE}"]`))).toBe('rgba(0, 0, 0, 0)');
    await page.touchscreen.tap(at.x + 10, at.y);
    const bend = page.locator('.bend');
    if (flashes) expect(await flash(bend)).toBe('rgba(0, 0, 0, 0)');
    await expect(bend).toHaveCount(1);
    await expect.poll(() => writes.length).toBe(1);

    /* Its handle is as big as a block's grip, its middle on the dot. */
    const b = await box(bend), grip = await box(page.locator('.grip').first());
    expect([Math.round(b.width), Math.round(b.height)]).toEqual([44, 44]);
    expect(Math.round(b.width)).toBe(Math.round(grip.width));
    const [x0, y0] = (writes[0] as { anchors: Record<string, Point[]> }).anchors[LINE]![0]!;
    const d = await box(page.locator(`.wires circle.via[cx="${x0}"][cy="${y0}"]`));
    expect(Math.abs(b.x + b.width / 2 - (d.x + d.width / 2))).toBeLessThan(1);
    expect(Math.abs(b.y + b.height / 2 - (d.y + d.height / 2))).toBeLessThan(1);
    expect(await hitAt(page, at.x + 20, at.y)).toBe('bend');
    await shot(page, info, 'bends-6-finger');

    /* A tap on it takes it away, and the line under it does not take that tap to put it back. */
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await expect(bend).toHaveCount(0);
    await expect.poll(() => writes.at(-1)).toEqual({ anchors: { [LINE]: null } });
    expect(writes).toHaveLength(2);
  });
});
