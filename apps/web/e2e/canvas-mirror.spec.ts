import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { captureWith } from './capture';
import { DEV, serveTasksBoard, TASKS } from './tasks-board/api';
import { serveTree } from './tree-api';

/* The zoom of the department's schema and tree stands at the start of its canvas's bottom, mirrored on a page right to left
   as the rest of the layout is. The department's line of what happened and its actions follow the zoom along the bottom, and
   its Speed and About drawer opens at the start, under its name. Left to right nothing moves. Agent windows stand at the right
   in either direction, so with one open the actions keep away from it: after the zoom left to right, at the end right to
   left, and the mirrored zoom stays clear of it (#1658). The tracker's graph is drawn mirrored right to left, its root at the
   right, and its zoom follows to the start too (#1670). Each look is shot before any check; shots go to HH_SCREENSHOT_DIR
   when it is set. Made-up companies. */

const capture = captureWith('canvas-mirror', process.env.HH_SCREENSHOT_DIR);
type Dir = 'ltr' | 'rtl';
type Size = { width: number; height: number };
type Box = { x: number; y: number; width: number; height: number };
const PHONE: Size = { width: 375, height: 812 }, WIDE: Size = { width: 1440, height: 900 };
/* One skin of each kind the pictures for Design need: the plain light one and Cyberpunk. */
const SKINS = ['light', 'cyberpunk'] as const;
/* Where they stood left to right before #1658: 16 px from the edges; the line of what happened 212 px from the left, right
   after the zoom; the tracker's zoom 16 px inside its canvas's 1 px frame. */
const EDGE = 16, AFTER_ZOOM = 212, FRAME = 1;

async function open(context: BrowserContext, size: Size, dir: Dir, skin: string, serve: (page: Page) => Promise<unknown>, path: string): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize(size);
  await page.addInitScript(({ dir, skin }) => {
    localStorage.setItem('hh-lang', 'en');
    localStorage.setItem('hh-theme', skin);
    if (dir === 'rtl') document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = 'rtl'; });
  }, { dir, skin });
  await serve(page);
  await page.goto(path);
  if (dir === 'rtl') await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.evaluate(async () => { await document.fonts.ready; });
  return page;
}

const department = (context: BrowserContext, size: Size, dir: Dir, skin: string) =>
  open(context, size, dir, skin, page => serveTree(page, { during: true }), '/departments/d2');

/* Two frames in a row with the same boxes: the page has stopped moving. */
async function still(page: Page, selector: string) {
  const boxes = () => page.evaluate(async s => {
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    return JSON.stringify([...document.querySelectorAll(s)].map(e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
  }, selector);
  let before = await boxes();
  for (let now = await boxes(); now !== before; now = await boxes()) before = now;
}

async function box(page: Page, selector: string): Promise<Box> {
  const b = await page.locator(selector).boundingBox();
  if (!b) throw new Error(`${selector} is not on the screen`);
  return b;
}
const meets = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
/* Soft, so a test shows every place that is off, not only the first. */
const near = (actual: number, expected: number, what: string) => expect.soft(Math.abs(actual - expected), `${what}: ${actual} for ${expected}`).toBeLessThanOrEqual(1);

/* Right to left a box is its left to right box mirrored across the page: as far from the right, at the same height, as wide. */
function mirrored(what: string, ltr: Box, rtl: Box, across: number) {
  near(across - (rtl.x + rtl.width), ltr.x, `${what} from the right, right to left`);
  near(rtl.y, ltr.y, `${what} at the same height`);
  near(rtl.width, ltr.width, `${what} as wide`);
}

/* None of the boxes meets another. */
function apart(where: string, boxes: Record<string, Box>) {
  const met = Object.entries(boxes).flatMap(([a, x], i) => Object.entries(boxes).slice(i + 1).filter(([, y]) => meets(x, y)).map(([b]) => `${a} and ${b}`));
  expect(met, `${where}: what meets`).toEqual([]);
}

const ZOOM = '.dview .zoom', TICKER = '.dview .ticker', ACTS = '.dview .dv-acts', NAME = '.dview .crumbs', DRAWER = '.dview .dv-drawer';
const SETTLED = `${ZOOM}, ${ACTS}, ${NAME}, .dview .world`;

for (const skin of SKINS) for (const size of [WIDE, PHONE]) {
  test(`the department's zoom, line and actions, its drawer and its tree's zoom stand mirrored right to left: ${skin} ${size.width}`, async ({ context }, info) => {
    const page = { ltr: await department(context, size, 'ltr', skin), rtl: await department(context, size, 'rtl', skin) };
    const shoot = info.project.name.includes('chromium');
    for (const dir of ['ltr', 'rtl'] as const) {
      await expect(page[dir].locator(ZOOM)).toBeVisible();
      await still(page[dir], SETTLED);
      if (shoot) await capture(page[dir], info, `department-${skin}-${dir}-${size.width}`);
    }
    const across = size.width, wide = size === WIDE;
    const at = async (selector: string) => ({ ltr: await box(page.ltr, selector), rtl: await box(page.rtl, selector) });

    /* The schema's zoom, and on a wide screen the line of what happened and the actions beside it, where they stood left to
       right and mirrored right to left; the department's name was mirrored already. */
    const zoom = await at(ZOOM), acts = await at(ACTS), name = await at(NAME);
    if (wide) {
      near(zoom.ltr.x, EDGE, 'the zoom from the left, left to right');
      near(size.height - (zoom.ltr.y + zoom.ltr.height), EDGE, 'the zoom from the bottom, left to right');
      near(across - (acts.ltr.x + acts.ltr.width), EDGE, 'the actions from the right, left to right');
      const line = await at(TICKER);
      near(line.ltr.x, AFTER_ZOOM, 'the line of what happened from the left, left to right');
      mirrored('the line of what happened', line.ltr, line.rtl, across);
      for (const dir of ['ltr', 'rtl'] as const) apart(`${dir} ${size.width}`, { zoom: zoom[dir], line: line[dir], actions: acts[dir], name: name[dir] });
    } else {
      near(across - (zoom.ltr.x + zoom.ltr.width), EDGE, 'the zoom from the right, left to right');
    }
    mirrored('the zoom', zoom.ltr, zoom.rtl, across);
    mirrored('the actions', acts.ltr, acts.rtl, across);
    /* The name was mirrored already; its words shape a few pixels wider or narrower right to left, so only its start counts. */
    near(across - (name.rtl.x + name.rtl.width), name.ltr.x, 'the name from the right, right to left');

    /* The Speed drawer opens at the start under the name, mirrored, and on a wide screen it meets nothing along the bottom. */
    for (const dir of ['ltr', 'rtl'] as const) {
      await page[dir].locator(ACTS).getByRole('button', { name: en.dept.speed, exact: true }).click();
      await expect(page[dir].locator(DRAWER)).toBeVisible();
      await still(page[dir], `${DRAWER}, ${SETTLED}`);
    }
    const drawer = await at(DRAWER);
    if (wide) near(drawer.ltr.x, EDGE, 'the drawer from the left, left to right');
    mirrored('the drawer', drawer.ltr, drawer.rtl, across);
    if (wide) for (const dir of ['ltr', 'rtl'] as const) apart(`${dir} ${size.width} with the drawer`, { drawer: drawer[dir], zoom: zoom[dir], actions: acts[dir], name: name[dir] });

    /* The tree puts its zoom in the same place. The drawer closes by its own button: on a phone it covers the dock. */
    for (const dir of ['ltr', 'rtl'] as const) {
      await page[dir].locator(DRAWER).getByRole('button', { name: en.dept.close, exact: true }).click();
      await expect(page[dir].locator(DRAWER)).toHaveCount(0);
      await page[dir].locator(ACTS).getByRole('button', { name: en.dept.treeButton, exact: true }).click();
      await expect(page[dir].locator('.dview .tview')).toBeVisible();
      await expect(page[dir].locator(ZOOM)).toBeVisible();
      await still(page[dir], `.dview .tview, ${SETTLED}`);
    }
    const tree = await at(ZOOM);
    mirrored("the tree's zoom", tree.ltr, tree.rtl, across);
    near(tree.ltr.x, zoom.ltr.x, "the tree's zoom where the schema's stands, left to right");
  });
}

/* Agent windows stand at the right in either direction and end above the bottom: right to left the mirrored zoom stands under
   one's bottom edge but meets it in no window, short or tall, and the actions keep the end, away from it. */
for (const skin of SKINS) for (const height of [900, 640]) {
  test(`with an agent window open the zoom and the actions keep clear of it, mirrored right to left: ${skin} 1440x${height}`, async ({ context }, info) => {
    const size = { width: 1440, height };
    const page = { ltr: await department(context, size, 'ltr', skin), rtl: await department(context, size, 'rtl', skin) };
    for (const dir of ['ltr', 'rtl'] as const) {
      await expect(page[dir].locator('.dview .schip').first()).toBeVisible();
      await page[dir].locator('.dview .schip').first().click();
      await expect(page[dir].locator('aside.orch')).toBeVisible();
      await expect(page[dir].locator('main.body')).toHaveClass(/\bwith-window\b/);
      await still(page[dir], `aside.orch, ${SETTLED}`);
      if (info.project.name.includes('chromium')) await capture(page[dir], info, `window-${skin}-${dir}-${height}`);
    }
    const at = async (selector: string) => ({ ltr: await box(page.ltr, selector), rtl: await box(page.rtl, selector) });
    const zoom = await at(ZOOM), acts = await at(ACTS), window = await at('aside.orch');
    mirrored('the zoom', zoom.ltr, zoom.rtl, size.width);
    near(acts.ltr.x, AFTER_ZOOM, 'the actions right after the zoom, left to right');
    near(acts.rtl.x, EDGE, 'the actions at the end, right to left');
    near(window.rtl.x, window.ltr.x, 'the window where it stands left to right');
    for (const dir of ['ltr', 'rtl'] as const) apart(`${dir} 1440x${height} with a window`, { zoom: zoom[dir], actions: acts[dir], window: window[dir] });
  });
}

/* Right to left the tracker's graph is the mirror of its drawing left to right: its root at the right, each level further to
   the left, the lane of a wait left of the tree and its word between the waiting node and the lane, the words of each reading
   in their own direction. Its zoom stands at the start of the canvas's bottom as on the other canvases, over the side by the
   root, where it covers no node when the graph opens. Left to right nothing moves (#1670, Design's verdict in #1668). The
   check of the card payments waits for their build, so a wait is drawn. */
/* A node by its words as the page shows them: a goal after its mark, a task after its number. */
const ROOT = '◎ Card payments', CHILD = '#1 Take card payments';
const WAITING = TASKS.find(x => x.title === 'Check: take card payments')!, AWAITED = TASKS.find(x => x.title === 'Build: take card payments')!;
async function serveWithWait(page: Page) {
  await serveTasksBoard(page);
  await page.route(url => url.pathname === '/api/tasks', route => route.fulfill({ json: { tasks: TASKS.map(x => (x.id === WAITING.id ? { ...x, waitsFor: [AWAITED.number] } : x)) } }));
}
const graph = (context: BrowserContext, size: Size, dir: Dir, skin: string) =>
  open(context, size, dir, skin, serveWithWait, `/tasks?department=${DEV.id}&view=graph`);

for (const skin of SKINS) for (const size of [WIDE, PHONE]) {
  test(`the tracker graph grows from a root at the start, its wait and its zoom mirrored with it, over no node: ${skin} ${size.width}`, async ({ context }, info) => {
    const page = { ltr: await graph(context, size, 'ltr', skin), rtl: await graph(context, size, 'rtl', skin) };
    for (const dir of ['ltr', 'rtl'] as const) {
      await expect(page[dir].getByRole('region', { name: en.tracker.graph.canvas }).locator('.tr-node').first()).toBeVisible();
      await expect(page[dir].locator('.tr-wires .wait')).toHaveCount(1);
      /* On a phone the canvas runs below the fold: its zoom is brought into sight, as a person scrolls to it. */
      await page[dir].locator('.tr-canvas .zoom').scrollIntoViewIfNeeded();
      await still(page[dir], '.tr-canvas, .tr-canvas .zoom, .tr-canvas .world, .tr-canvas .tr-node');
      if (info.project.name.includes('chromium')) await capture(page[dir], info, `tracker-${skin}-${dir}-${size.width}`);
    }
    const at = async (selector: string) => ({ ltr: await box(page.ltr, selector), rtl: await box(page.rtl, selector) });
    const node = (title: string) => at(`.tr-canvas .tr-node:has(.tr-node-title:text-is("${title}"))`);
    const canvas = await at('.tr-canvas'), zoom = await at('.tr-canvas .zoom');
    mirrored('the canvas', canvas.ltr, canvas.rtl, size.width);
    /* Left to right the zoom stands where it stood; right to left it is mirrored with the page. */
    near(zoom.ltr.x - canvas.ltr.x, EDGE + FRAME, 'the zoom from the canvas\'s left, left to right');
    mirrored('the zoom', zoom.ltr, zoom.rtl, size.width);
    const root = await node(ROOT), child = await node(CHILD);
    const waiting = await node(`#${WAITING.number} ${WAITING.title}`), awaited = await node(`#${AWAITED.number} ${AWAITED.title}`);
    const lane = await at('.tr-wires .wait path'), word = await at('.tr-wires .wait text');
    expect.soft(root.ltr.x + root.ltr.width, 'left to right: the root left of its task').toBeLessThan(child.ltr.x);
    expect.soft(root.rtl.x, 'right to left: the root right of its task').toBeGreaterThan(child.rtl.x + child.rtl.width);
    /* As far from the canvas's start as left to right, at the same height: the drawing is mirrored, not only moved. */
    near(canvas.rtl.x + canvas.rtl.width - (root.rtl.x + root.rtl.width), root.ltr.x - canvas.ltr.x, 'the root from the canvas\'s start, right to left');
    near(root.rtl.y, root.ltr.y, 'the root at the same height, right to left');
    expect.soft(lane.ltr.x + lane.ltr.width, 'left to right: the lane right of its nodes').toBeGreaterThan(Math.max(waiting.ltr.x + waiting.ltr.width, awaited.ltr.x + awaited.ltr.width));
    expect.soft(lane.rtl.x, 'right to left: the lane left of its nodes').toBeLessThan(Math.min(waiting.rtl.x, awaited.rtl.x));
    expect.soft(word.ltr.x, 'left to right: the word after the waiting node').toBeGreaterThanOrEqual(waiting.ltr.x + waiting.ltr.width);
    expect.soft(word.rtl.x + word.rtl.width, 'right to left: the word before the waiting node').toBeLessThanOrEqual(waiting.rtl.x);
    for (const dir of ['ltr', 'rtl'] as const) {
      /* What the canvas shows of each node, its words inside it, meets no floating control. */
      const nodes = await page[dir].locator('.tr-canvas .tr-node').evaluateAll(els => els.map(e => {
        const r = e.getBoundingClientRect();
        return { name: (e.textContent ?? '').trim().slice(0, 40), box: { x: r.x, y: r.y, width: r.width, height: r.height } };
      }));
      expect(nodes.length, `${dir}: the graph's nodes`).toBeGreaterThan(0);
      const frame = canvas[dir];
      const seen = (b: Box): Box => {
        const x = Math.max(b.x, frame.x), y = Math.max(b.y, frame.y);
        return { x, y, width: Math.max(0, Math.min(b.x + b.width, frame.x + frame.width) - x), height: Math.max(0, Math.min(b.y + b.height, frame.y + frame.height) - y) };
      };
      expect.soft(nodes.filter(n => meets(seen(n.box), zoom[dir])).map(n => n.name), `${dir} ${size.width}: nodes under the zoom`).toEqual([]);
      near(canvas[dir].y + canvas[dir].height - (zoom[dir].y + zoom[dir].height), EDGE + FRAME, `the zoom from the canvas's bottom, ${dir}`);
    }
  });
}
