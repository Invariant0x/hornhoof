import { expect, test, type Locator, type Page } from '@playwright/test';
import { LANGUAGES, type Language, type Messages } from '../../src/i18n';
import { en } from '../../src/i18n/en';
import { ru } from '../../src/i18n/ru';
import { BUILTIN_SKINS } from '../../src/skins/registry';
import { NODE } from '../../src/tracker';
import { captureWith } from '../capture';
import { DEV, GOALS, QUESTION, serveShortNames, serveTasksBoard, SHORT, TASKS } from './api';

/* The tracker as a person meets it: the left panel of lists, where the person is, three views of the same work with their
   filters, the graph on a canvas like the map's, and the card at the end side. 138 tasks, every shipped language, a light and
   a dark skin, at a desk and on a phone, also mirrored right to left. Shots go to HH_SCREENSHOT_DIR when it is set. */

const MESSAGES: Record<Language, Messages> = { en, ru };
const capture = captureWith('tasks-board', process.env.HH_SCREENSHOT_DIR);
/* One built-in skin of each scheme. */
const SKINS = (['light', 'dark'] as const).map(scheme => BUILTIN_SKINS.find(skin => skin.scheme === scheme)!.id);
const LOOKS = LANGUAGES.flatMap(({ id }) => SKINS.map(skin => ({ lang: id, skin })));

async function open(page: Page, lang: Language, width: number, path: string, skin: string = SKINS[1]!) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ language, skin }) => {
    localStorage.setItem('hh-lang', language);
    localStorage.setItem('hh-theme', skin);
  }, { language: lang, skin });
  await page.goto(path);
  await expect(page.locator('.tr-where h1')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

const numbered = (title: string) => TASKS.find(x => x.title === title)!;
const named = (title: string) => `#${numbered(title).number} ${title}`;
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/* Every row, card, column and control of the main area stays inside it, from its start edge to its end edge, and no text
   is cut short with an ellipsis anywhere in the tracker. A closed select shows its choice on one line, as every select of
   the app does; its list shows each choice whole. */
async function inside(page: Page, what: string) {
  const frame = (await page.locator('.tr-main').boundingBox())!;
  const boxes = await page.locator('.tr-main :is(.tr-row, .tr-card, .tr-col, .tr-chip, .tr-views, .tr-canvas, button:not(.tr-node))').evaluateAll(els =>
    els.filter(e => e.getClientRects().length).map(e => e.getBoundingClientRect()).map(r => ({ x: r.x, right: r.right })));
  expect(boxes.length, what).toBeGreaterThan(0);
  for (const box of boxes) {
    expect(box.x, what).toBeGreaterThanOrEqual(frame.x - 1);
    expect(box.right, what).toBeLessThanOrEqual(frame.x + frame.width + 1);
  }
  expect(await page.locator('.tracker :not(select)').evaluateAll(els => els.filter(e => getComputedStyle(e).textOverflow === 'ellipsis').map(e => `${e.tagName.toLowerCase()}.${e.getAttribute('class')}`)), what).toEqual([]);
  expect(await sideways(page), what).toBeLessThanOrEqual(0);
}

/* What a finger presses is at least 44 px high, and a link that stands alone at least 44 px wide too, even with two letters. */
const LINKS = '.tr-title, .tr-card-title .linkish, .tr-goals .linkish, .tr-crumbs .linkish, .tp-path .linkish, .tr-people .linkish';
async function touchable(page: Page, what: string) {
  for (const height of await page.locator(`.tr-item, .tr-views label, .tr-chip, .tr-menu:visible, .tr-canvas .zbtn, ${LINKS}`).evaluateAll(els =>
    els.filter(e => e.getClientRects().length).map(e => e.getBoundingClientRect().height))) {
    expect(height, what).toBeGreaterThanOrEqual(43.5);
  }
  for (const [text, width] of await page.locator(LINKS).evaluateAll(els =>
    els.filter(e => e.getClientRects().length).map(e => [e.textContent, e.getBoundingClientRect().width] as const))) {
    expect(width, `${what}: ${text}`).toBeGreaterThanOrEqual(43.5);
  }
}

async function view(page: Page, t: Messages, name: string) {
  await page.getByRole('group', { name: t.tracker.views.label }).getByText(name, { exact: true }).click();
  await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
}

for (const { lang, skin } of LOOKS) for (const width of [1440, 375]) {
  test(`shows a department as a list, a board and a graph inside the screen: ${lang} ${skin} ${width}`, async ({ page }, info) => {
    const t = MESSAGES[lang];
    await serveTasksBoard(page);
    await open(page, lang, width, `/tasks?department=${DEV.id}`, skin);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(DEV.name);

    /* The list: groups by state in words, the task that waits for the person first; each row names who does it, who answers
       for it, its goal and its due day. */
    const list = page.getByRole('region', { name: t.tracker.views.list, exact: true });
    await expect(list.getByRole('heading', { level: 2 }).first()).toHaveText(`${t.tracker.groups.waitingYou}: 1`);
    const payments = list.getByRole('listitem', { name: named('Take card payments'), exact: true });
    await expect(payments).toContainText('Hana');
    await expect(payments).toContainText(GOALS[1]!.title);
    await expect(payments).toContainText(t.tracker.list.subtasks(1, 3));
    await inside(page, `list ${lang} ${skin} ${width}`);
    await touchable(page, `list ${lang} ${skin} ${width}`);
    await capture(page, info, `list-${lang}-${skin}-${width}`);

    /* The board: the pipeline's stages when one is chosen, columns by status otherwise, as many side by side as fit. */
    await view(page, t, t.tracker.views.board);
    const board = page.getByRole('region', { name: t.tracker.views.board, exact: true });
    await expect(board.locator('.tr-col').first()).toBeVisible();
    await inside(page, `board ${lang} ${skin} ${width}`);
    await capture(page, info, `board-${lang}-${skin}-${width}`);

    /* The graph: the department's goals with their work as a tree; no node cuts its words short. */
    await view(page, t, t.tracker.views.graph);
    const canvas = page.getByRole('region', { name: t.tracker.graph.canvas });
    await expect(canvas.getByRole('button', { name: new RegExp(GOALS[1]!.title) })).toBeVisible();
    expect(await canvas.locator('.tr-node').evaluateAll(els => els.filter(e => e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1).length)).toBe(0);
    await inside(page, `graph ${lang} ${skin} ${width}`);
    await touchable(page, `graph ${lang} ${skin} ${width}`);
    await capture(page, info, `graph-${lang}-${skin}-${width}`);
  });
}

test('pans and zooms the graph with a drag and the zoom bar, and opens a card from a node', async ({ page }) => {
  const t = MESSAGES.en;
  await serveTasksBoard(page);
  await open(page, 'en', 1440, `/tasks?department=${DEV.id}&view=graph`);
  const canvas = page.getByRole('region', { name: t.tracker.graph.canvas });
  const world = canvas.locator('.world');
  const percent = page.locator('.tr-canvas .zv');
  const transform = () => world.evaluate(el => new DOMMatrix(getComputedStyle(el).transform));
  await expect(canvas.locator('.tr-node').first()).toBeVisible();
  const fitted = await transform();
  const shown = await percent.textContent();
  /* A tree too big for the canvas opens at a size its words read at, on its first goal, not shrunk to dots. */
  expect(fitted.a).toBeGreaterThanOrEqual(0.6);
  const frame = (await canvas.boundingBox())!;
  const goal = (await canvas.getByRole('button', { name: new RegExp(GOALS[1]!.title) }).boundingBox())!;
  expect(goal.y).toBeGreaterThanOrEqual(frame.y);
  expect(goal.y + goal.height).toBeLessThanOrEqual(frame.y + frame.height);

  await page.getByRole('button', { name: t.map.zoomIn, exact: true }).click();
  await expect(percent).not.toHaveText(shown!);
  expect((await transform()).a).toBeGreaterThan(fitted.a);
  await page.getByRole('button', { name: t.map.zoomOut, exact: true }).click();
  await expect(percent).toHaveText(shown!);

  /* A drag on the dots between the first two levels moves the tree, and no card opens for it. */
  const before = await transform();
  const [x, y] = [frame.x + before.e + (NODE.w + (NODE.dx - NODE.w) / 2) * before.a, frame.y + frame.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 80, y - 40, { steps: 8 });
  await page.mouse.up();
  const moved = await transform();
  expect(Math.round(moved.e - before.e)).toBe(80);
  expect(Math.round(moved.f - before.f)).toBe(-40);
  await expect(page).toHaveURL(/\/tasks\?department=d2&view=graph$/);

  /* Show everything draws the whole tree as small as the canvas allows. */
  await page.getByRole('button', { name: t.map.showAll, exact: true }).click();
  await expect.poll(async () => (await transform()).a).toBeLessThan(fitted.a);

  /* A click on a node opens its card at the end side, and from it the graph grows again from that task. */
  const payments = numbered('Take card payments');
  await canvas.getByRole('button', { name: new RegExp(`^#${payments.number} Take card payments`) }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${payments.id}$`));
  const card = page.getByRole('complementary', { name: named('Take card payments'), exact: true });
  await card.getByRole('button', { name: t.tracker.card.graphFromHere, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks\\?root=${payments.id}&view=graph$`));
  const crumbs = page.getByRole('navigation', { name: t.tracker.graph.path });
  await expect(crumbs.locator('[aria-current]')).toHaveText(named('Take card payments'));
  await crumbs.getByRole('button', { name: GOALS[1]!.title, exact: true }).click();
  await expect(page).toHaveURL(/\/tasks\?goal=g2&view=graph$/);
});

for (const dir of ['ltr', 'rtl'] as const) {
  test(`puts the card at the end side, beside the work and not over it: ${dir}`, async ({ page }, info) => {
    const t = MESSAGES.en;
    await serveTasksBoard(page);
    await open(page, 'en', 1440, `/tasks?department=${DEV.id}`);
    await page.evaluate(d => { document.documentElement.dir = d; }, dir);
    const row = page.getByRole('region', { name: t.tracker.views.list, exact: true }).getByRole('listitem', { name: named('Take card payments'), exact: true });
    await row.locator('.tr-title').click();
    const card = page.getByRole('complementary', { name: named('Take card payments'), exact: true });
    await expect(card.getByRole('navigation', { name: t.tracker.card.path })).toContainText(GOALS[0]!.title);
    await expect(card.getByRole('navigation', { name: t.tracker.card.path })).toContainText(GOALS[1]!.title);
    const [panel, main] = [(await card.boundingBox())!, (await page.locator('.tr-main').boundingBox())!];
    if (dir === 'ltr') {
      expect(Math.round(1440 - (panel.x + panel.width))).toBe(16);
      expect(main.x + main.width).toBeLessThanOrEqual(panel.x);
    } else {
      expect(Math.round(panel.x)).toBe(16);
      expect(main.x).toBeGreaterThanOrEqual(panel.x + panel.width);
    }
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await capture(page, info, `card-${dir}-1440`);
  });
}

/* The colour a role of the skin gives words, as the engine computes it. */
const roleColor = (page: Page, role: string) => page.evaluate(r => {
  const probe = document.body.appendChild(document.createElement('i'));
  probe.style.color = `var(${r})`;
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}, role);

/* Design's rules for the tracker (#1150), in the light skin: a chip in focus has the app's ring, its choice is as wide and as
   high in every engine with the arrow at the end side, the left panel keeps no room for a bar, a chosen chip and the chosen
   view read clearly, and a card's facts keep their words in order right to left. */
for (const dir of ['ltr', 'rtl'] as const) {
  test(`keeps the chips, the left panel and the card's facts alike in every engine: ${dir}`, async ({ page }, info) => {
    const t = MESSAGES.en;
    const shot = (name: string) => capture(page, info, `design-${name}-${dir}-${info.project.name.replace('tasks-', '')}`);
    await serveTasksBoard(page);
    await open(page, 'en', 1440, `/tasks?department=${DEV.id}`, SKINS[0]);
    await page.evaluate(d => { document.documentElement.dir = d; }, dir);
    const chips = page.getByRole('group', { name: t.tracker.filters.label });
    const status = chips.getByLabel(t.tracker.filters.status);
    await status.focus();
    const ring = await status.evaluate(el => { const s = getComputedStyle(el); return [s.outlineStyle, s.outlineWidth, s.outlineOffset, s.outlineColor]; });
    expect(ring).toEqual(['solid', '2px', '2px', await roleColor(page, '--cyan-ink')]);
    await shot('chip-focus');
    const box = (await status.boundingBox())!;
    expect(Math.abs(box.width - 160)).toBeLessThanOrEqual(1);
    expect(Math.abs(box.height - 40)).toBeLessThanOrEqual(1);
    const arrow = await status.evaluate(el => { const s = getComputedStyle(el); return [s.paddingInlineEnd, s.backgroundPositionX]; });
    expect(arrow[0]).toBe('28px');
    if (dir === 'rtl') expect(arrow[1]).toBe('10px, 15px');
    else expect(arrow[1]).not.toBe('10px, 15px');
    const side = await page.locator('.tr-side').evaluate((el: HTMLElement) => { const s = getComputedStyle(el); return [el.clientWidth, el.offsetWidth - parseFloat(s.borderInlineStartWidth) - parseFloat(s.borderInlineEndWidth)]; });
    expect(side[0]).toBe(side[1]);
    await status.selectOption({ label: t.tracker.statuses.working });
    await status.evaluate(el => (el as HTMLSelectElement).blur());
    await expect(page.locator('.tr-chip.on')).toHaveCount(1);
    expect(await page.locator('.tr-chip.on').evaluate(el => getComputedStyle(el).borderTopColor)).toBe(await roleColor(page, '--cyan-ink'));
    expect(await page.locator('.tr-views label.on').evaluate(el => getComputedStyle(el).color)).toBe(await roleColor(page, '--ink'));
    await shot('light-chips');
    await view(page, t, t.tracker.views.board);
    const card = page.getByRole('region', { name: t.tracker.views.board, exact: true }).getByRole('article', { name: named('Take card payments'), exact: true });
    for (const fact of await card.locator('.tr-card-facts li').all()) await expect(fact).toHaveAttribute('dir', 'auto');
    expect(await card.locator('.tr-card-facts li').first().evaluate(el => getComputedStyle(el).direction)).toBe('ltr');
    await card.locator('.tr-card-title .linkish').click();
    const panel = page.getByRole('complementary', { name: named('Take card payments'), exact: true });
    await expect(panel.getByRole('navigation', { name: t.tracker.card.path })).toContainText(GOALS[1]!.title);
    await shot('card');
  });
}

/* The lowest contrast of a box's border against what lies on either side of it: its own ground inside, the ground under it
   outside, and the glow of its ring over that ground when it has one. */
const borderContrast = (locator: Locator) => locator.evaluate(el => {
  const parse = (value: string): number[] => {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(value);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : [0, 0, 0, 0];
  };
  const over = (top: number[], under: number[]) => [0, 1, 2].map(i => top[i]! * top[3]! + under[i]! * (1 - top[3]!)).concat(1);
  const luminance = (c: number[]) => [0, 1, 2].map(i => c[i]! / 255).map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  const ratio = (a: number[], b: number[]) => { const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (high! + 0.05) / (low! + 0.05); };
  const layers: number[][] = [];
  for (let at = el.parentElement; at; at = at.parentElement) layers.push(parse(getComputedStyle(at).backgroundColor));
  const outside = layers.reverse().reduce((under, top) => over(top, under), [255, 255, 255, 1]);
  const style = getComputedStyle(el);
  const ring = /rgba?\([^)]*\)/.exec(style.boxShadow);
  const grounds = [over(parse(style.backgroundColor), outside), outside, ...(ring ? [over(parse(ring[0]), outside)] : [])];
  const border = parse(style.borderTopColor);
  return Math.min(...grounds.map(ground => ratio(over(border, ground), ground)));
});

/* For each element, whether the day of the date in its words stands left of its month on the screen, as "20 Nov" reads in
   both directions; null where the date is not in its words. */
const dayFirst = (locator: Locator, date: string) => locator.evaluateAll((els, date) => els.map(el => {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.textContent!.indexOf(date);
    if (at < 0) continue;
    const x = (i: number) => { const range = document.createRange(); range.setStart(node!, i); range.setEnd(node!, i + 1); return range.getBoundingClientRect().x; };
    return x(at) < x(at + date.indexOf(' ') + 1);
  }
  return null;
}), date);
async function inOrder(locator: Locator, date: string, what: string) {
  const found = await dayFirst(locator, date);
  expect(found, what).toContain(true);
  expect(found, what).not.toContain(false);
}

/* The width a card gives its words, its path and its facts, is the card less its padding and the same 18 px of room for a
   scrollbar in every engine, whatever the engine's own bar takes of it: 344 px in a card of 400 px. */
async function cardWords(page: Page, what: string) {
  const card = page.locator('.acard');
  const inner = await card.evaluate(el => el.clientWidth);
  if (page.viewportSize()!.width === 1440) expect(inner, what).toBe(398);
  const boxes = await card.locator('.tp-path, .tp-facts').evaluateAll(els => els.map(e => e.getBoundingClientRect().width));
  expect(boxes, what).toHaveLength(2);
  for (const width of boxes) expect(Math.abs(width - (inner - 18 - 18 - 18)), `${what}: ${width} of ${inner}`).toBeLessThanOrEqual(1);
}

/* Design's last four rules for the tracker (#1296), in the light skin, at a desk and on a phone, left to right and mirrored:
   a chosen card, a chosen node and a node under the pointer draw their border at 3:1 at least on both sides; a due day reads
   day then month right to left too, in the list, on the board and in the cards of a task and a goal; a card gives its words
   as much width in every engine; and a link of two letters is still 44 px wide. */
for (const dir of ['ltr', 'rtl'] as const) for (const width of [1440, 375]) {
  test(`draws the chosen work clearly, keeps dates in order, cards as wide and links wide enough: ${dir} ${width}`, async ({ page }, info) => {
    const t = MESSAGES.en;
    const look = `${dir}-${width}-${info.project.name.replace('tasks-', '')}`;
    const shot = (name: string) => capture(page, info, `last-${name}-${look}`);
    /* A close look at one box and 24 px around it, where a line of 1 px is hard to see on the whole screen. */
    const closeUp = async (target: Locator, name: string) => {
      const box = (await target.boundingBox())!;
      const [x, y] = [Math.max(0, box.x - 24), Math.max(0, box.y - 24)];
      const file = `tasks-board-last-${name}-close-${look}.png`;
      const path = process.env.HH_SCREENSHOT_DIR ? `${process.env.HH_SCREENSHOT_DIR}/${file}` : info.outputPath(file);
      await page.screenshot({ path, clip: { x, y, width: Math.min(box.x + box.width + 24, width) - x, height: Math.min(box.y + box.height + 24, 900) - y } });
      await info.attach(file, { path, contentType: 'image/png' });
    };
    const visit = async (path: string) => {
      await open(page, 'en', width, path, SKINS[0]);
      await page.evaluate(d => { document.documentElement.dir = d; }, dir);
    };
    const cyanInk = async () => roleColor(page, '--cyan-ink');
    await page.clock.setFixedTime(new Date('2026-11-16T12:00:00Z'));
    await serveTasksBoard(page);
    await serveShortNames(page);

    /* The list: the due day of a row, and the task called QA. */
    await visit(`/tasks?department=${DEV.id}`);
    const list = page.getByRole('region', { name: t.tracker.views.list, exact: true });
    const dated = list.getByRole('listitem', { name: named('Take card payments'), exact: true });
    await inOrder(dated.locator('.tr-v'), '20 Nov', `list ${look}`);
    await expect(list.locator('.tr-title').filter({ hasText: new RegExp(`^${SHORT}$`) })).toBeVisible();
    await touchable(page, `list ${look}`);
    await dated.scrollIntoViewIfNeeded();
    await shot('list');

    /* The board: its due fact, the card called QA, and a chosen card with its task's card beside it. */
    await view(page, t, t.tracker.views.board);
    const board = page.getByRole('region', { name: t.tracker.views.board, exact: true });
    const payments = board.getByRole('article', { name: named('Take card payments'), exact: true });
    await inOrder(payments.locator('.tr-card-facts li'), '20 Nov', `board ${look}`);
    await touchable(page, `board ${look}`);
    await payments.locator('.tr-card-title .linkish').click();
    const card = page.getByRole('complementary', { name: named('Take card payments'), exact: true });
    await expect(card.getByRole('navigation', { name: t.tracker.card.path })).toContainText(GOALS[1]!.title);
    await expect(page.locator('.tr-card.on')).toHaveCount(1);
    expect(await borderContrast(page.locator('.tr-card.on')), `chosen card ${look}`).toBeGreaterThanOrEqual(3);
    expect(await page.locator('.tr-card.on').evaluate(el => getComputedStyle(el).borderTopColor)).toBe(await cyanInk());
    if (width === 1440) await closeUp(page.locator('.tr-card.on'), 'card-chosen');
    await inOrder(card.locator('.tp-facts dd'), '20 Nov', `task card ${look}`);
    await cardWords(page, `task card ${look}`);
    await shot('board-card');

    /* The graph: a task's node under the pointer, then chosen. */
    await visit(`/tasks?department=${DEV.id}&view=graph`);
    const canvas = page.getByRole('region', { name: t.tracker.graph.canvas });
    await expect(canvas.locator('.tr-node').first()).toBeVisible();
    const inSight = () => canvas.evaluate(frame => {
      const f = frame.getBoundingClientRect();
      return [...frame.querySelectorAll('button.tr-node:not(.goal)')].find(n => { const r = n.getBoundingClientRect(); return r.x >= f.x && r.y >= f.y && r.right <= f.right && r.bottom <= f.bottom; })?.getAttribute('data-node') ?? null;
    });
    if (!(await inSight())) await page.getByRole('button', { name: t.map.showAll, exact: true }).click();
    await expect.poll(inSight).not.toBeNull();
    const node = canvas.locator(`[data-node="${await inSight()}"]`);
    await node.hover();
    expect(await borderContrast(node), `node under the pointer ${look}`).toBeGreaterThanOrEqual(3);
    expect(await node.evaluate(el => getComputedStyle(el).borderTopColor)).toBe(await cyanInk());
    await closeUp(node, 'node-hover');
    await shot('graph-hover');
    await node.click();
    await page.mouse.move(0, 0);
    await expect(canvas.locator('.tr-node.on')).toHaveCount(1);
    expect(await borderContrast(canvas.locator('.tr-node.on')), `chosen node ${look}`).toBeGreaterThanOrEqual(3);
    expect(await canvas.locator('.tr-node.on').evaluate(el => getComputedStyle(el).borderTopColor)).toBe(await cyanInk());
    if (width === 1440) await closeUp(canvas.locator('.tr-node.on'), 'node-chosen');
    await shot('graph-chosen');

    /* A goal's card: its due day, past now, and its width. */
    await visit('/tasks?goal=g2&view=graph');
    await page.locator('[data-node="g2"]').click();
    const goal = page.getByRole('complementary', { name: GOALS[1]!.title, exact: true });
    await expect(goal.getByRole('navigation', { name: t.tracker.card.path })).toContainText(GOALS[0]!.title);
    await inOrder(goal.locator('.tp-facts dd'), '10 Nov', `goal card ${look}`);
    await cardWords(page, `goal card ${look}`);
    await shot('goal-card');

    /* The way up to a task of the goal QA, and the path in its card. */
    const refunds = numbered('Refunds on request');
    await visit(`/tasks?root=${refunds.id}&view=graph`);
    await expect(page.getByRole('navigation', { name: t.tracker.graph.path }).getByRole('button', { name: SHORT, exact: true })).toBeVisible();
    await touchable(page, `crumbs ${look}`);
    await shot('crumbs');
    await visit(`/tasks/${refunds.id}`);
    const refundsCard = page.getByRole('complementary', { name: named('Refunds on request'), exact: true });
    await expect(refundsCard.getByRole('navigation', { name: t.tracker.card.path }).getByRole('button', { name: SHORT, exact: true })).toBeVisible();
    await touchable(page, `card path ${look}`);
    await shot('card-path');

    /* The goals of the person, and the people of a department in the left panel. */
    await visit('/tasks');
    await expect(page.locator('.tr-goals .linkish').filter({ hasText: new RegExp(`^${SHORT}$`) })).toBeVisible();
    await touchable(page, `goals ${look}`);
    await shot('goals');
    await visit(`/tasks?department=${DEV.id}`);
    if (width === 375) await page.getByRole('button', { name: t.tracker.side.open, exact: true }).click();
    const people = page.locator('.tr-people .linkish').first();
    await expect(people).toBeVisible();
    await people.scrollIntoViewIfNeeded();
    await touchable(page, `people ${look}`);
    await shot('people');
  });
}

/* Where the parts of an element's words stand on the screen: the box of the first letter of each part, looked for in order
   in one of its texts; null where they are not there in that order. */
const partsAt = (locator: Locator, parts: string[]) => locator.evaluate((el, parts) => {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent!;
    const at: number[] = [];
    for (const part of parts) {
      const i = text.indexOf(part, at.length ? at[at.length - 1]! + parts[at.length - 1]!.length : 0);
      if (i < 0) break;
      at.push(i);
    }
    if (at.length < parts.length) continue;
    return at.map(i => { const range = document.createRange(); range.setStart(node!, i); range.setEnd(node!, i + 1); const r = range.getBoundingClientRect(); return { x: r.x, y: r.y, height: r.height }; });
  }
  return null;
}, parts);

/* A phrase reads in its own order in both directions: each part of it stands right of the part before on the same line, or
   on a line below it where the phrase wraps. */
async function readsInOrder(locator: Locator, parts: string[], what: string) {
  const at = await partsAt(locator, parts);
  expect(at, `${what}: ${parts.join(' ')}`).not.toBeNull();
  for (let i = 1; i < at!.length; i++) {
    const [before, part] = [at![i - 1]!, at![i]!];
    const why = `${what}: "${parts[i]}" after "${parts[i - 1]}"`;
    if (Math.abs(part.y - before.y) < before.height / 2) expect(part.x, why).toBeGreaterThan(before.x);
    else expect(part.y, why).toBeGreaterThan(before.y);
  }
}

/* An element's words stand at the start edge of its box, as the page's words do: at the right right to left. */
async function atStart(locator: Locator, dir: 'ltr' | 'rtl', what: string) {
  const [box, words] = await locator.evaluate(el => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el);
    const w = range.getBoundingClientRect();
    return [[r.left + parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft), r.right - parseFloat(s.borderRightWidth) - parseFloat(s.paddingRight)], [w.left, w.right]];
  });
  if (dir === 'rtl') expect(Math.abs(words[1]! - box[1]!), `${what}: right edge`).toBeLessThanOrEqual(1);
  else expect(Math.abs(words[0]! - box[0]!), `${what}: left edge`).toBeLessThanOrEqual(1);
}

/* What Design found reading the tracker right to left after #1300 (#1303), and that it reads the same left to right: a goal
   and its progress in words, a person's task in the left panel, the line under where the person is, and on a phone each
   value of a row with its name, "Executor: Hana", at the start side. */
for (const dir of ['ltr', 'rtl'] as const) for (const width of [1440, 375]) {
  test(`reads goals, people's tasks, the line under the heading and a row's names and values in order: ${dir} ${width}`, async ({ page }, info) => {
    const t = MESSAGES.en;
    const look = `${dir}-${width}-${info.project.name.replace('tasks-', '')}`;
    const shot = (name: string) => capture(page, info, `order-${name}-${look}`);
    const visit = async (path: string) => {
      await open(page, 'en', width, path, SKINS[0]);
      await page.evaluate(d => { document.documentElement.dir = d; }, dir);
    };
    await page.clock.setFixedTime(new Date('2026-11-16T12:00:00Z'));
    await serveTasksBoard(page);
    await serveShortNames(page);

    /* The person's own tasks: the line under the heading ends with its dot, and a goal reads with its number and its
       progress in words. */
    await visit('/tasks');
    const about = page.locator('.tr-where p');
    await expect(about).toHaveText(t.tracker.where.mineAbout);
    await readsInOrder(about, ['Open', 'waits', 'you', '.'], `line under the heading ${look}`);
    await atStart(about, dir, `line under the heading ${look}`);
    const goals = page.getByRole('region', { name: t.tracker.yourGoals, exact: true });
    const big = goals.getByRole('listitem').filter({ hasText: GOALS[0]!.title });
    await readsInOrder(big.locator('.linkish'), ['500', 'shops', 'card'], `goal ${look}`);
    await readsInOrder(big.locator('.goal-progress small'), ['212', 'of', '500', 'shops'], `goal's progress ${look}`);
    await atStart(big.locator('.goal-progress small'), dir, `goal's progress ${look}`);
    await shot('goals');

    /* A person's task in the left panel: its number, then its name. */
    await visit(`/tasks?department=${DEV.id}`);
    if (width === 375) await page.getByRole('button', { name: t.tracker.side.open, exact: true }).click();
    const task = page.locator('.tr-people .linkish').first();
    await task.scrollIntoViewIfNeeded();
    await readsInOrder(task, ['#', SHORT], `person's task ${look}`);
    await shot('people');
    if (width === 375) await page.getByRole('button', { name: t.tracker.side.close, exact: true }).click();

    /* A row of the list: where it is narrow each value with its name before it, "Executor: Hana", at the start side; where
       it is wide the names stand above the list and each value at the start side of its column. */
    const row = page.getByRole('region', { name: t.tracker.views.list, exact: true }).getByRole('listitem', { name: named('Take card payments'), exact: true });
    await row.scrollIntoViewIfNeeded();
    const cells = row.locator('.tr-cells > .tr-cell');
    await expect(cells).toHaveCount(4);
    for (const cell of await cells.all()) {
      const value = (await cell.locator('.tr-v').textContent())!;
      const parts = await cell.evaluate(el => [...el.children].map(c => { const r = c.getBoundingClientRect(); return { left: r.left, right: r.right, shown: getComputedStyle(c).position !== 'absolute' }; }));
      const box = await cell.evaluate(el => { const r = el.getBoundingClientRect(); return [r.left, r.right]; });
      const [name, words] = parts as [typeof parts[0], typeof parts[0]];
      if (name.shown) {
        expect(name.right, `${value}: its name before it ${look}`).toBeLessThanOrEqual(words.left);
        if (dir === 'rtl') expect(Math.abs(words.right - box[1]!), `${value}: at the right ${look}`).toBeLessThanOrEqual(1);
        else expect(Math.abs(name.left - box[0]!), `${value}: at the left ${look}`).toBeLessThanOrEqual(1);
      } else if (dir === 'rtl') expect(Math.abs(words.right - box[1]!), `${value}: at the right of its column ${look}`).toBeLessThanOrEqual(1);
      else expect(Math.abs(words.left - box[0]!), `${value}: at the left of its column ${look}`).toBeLessThanOrEqual(1);
    }
    await shot('list');
  });
}

for (const lang of LANGUAGES.map(l => l.id)) {
  test(`opens the lists as a drawer on a phone and closes it on a choice: ${lang} 375`, async ({ page }, info) => {
    const t = MESSAGES[lang];
    await serveTasksBoard(page);
    await open(page, lang, 375, '/tasks');
    const side = page.getByRole('navigation', { name: t.tracker.side.label });
    await expect(side).toBeHidden();
    await page.getByRole('button', { name: t.tracker.side.open, exact: true }).click();
    await expect(side).toBeVisible();
    const box = (await side.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(16);
    expect(box.x + box.width).toBeLessThanOrEqual(375 - 16);
    /* It runs to the bottom of the screen, so nothing of the page shows under it. */
    expect(box.y + box.height).toBe(page.viewportSize()!.height);
    expect(await page.evaluate(() => [16, 187, 358].every(x => !!document.elementFromPoint(x, innerHeight - 1)?.closest('.tr-side')))).toBe(true);
    await touchable(page, `drawer ${lang}`);
    await capture(page, info, `drawer-${lang}-375`);
    await side.getByRole('button', { name: new RegExp(`^${t.tracker.side.working}`) }).click();
    await expect(side).toBeHidden();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(t.tracker.where.working);
    await inside(page, `working ${lang}`);
  });
}

/* What waits for the person: the question on the urgent task, and the cards Hornhoof kept, inside the page in every
   language, at a desk and on a phone, and mirrored right to left. */
test('shows what waits for the person and the cards kept for them inside the page', async ({ page }, info) => {
  await serveTasksBoard(page);
  const top = TASKS.find(x => x.turn !== null && !x.parentId)!;
  const kept = { taskId: top.id, number: top.number, kind: null, level: null, at: '2026-11-14T10:00:00.000Z' };
  const cards = [
    { ...kept, id: 'c1', about: 'release_tag', turn: { number: 24, version: null }, tag: { version: 'v1.7.0', why: 'unrecorded' } },
    { ...kept, id: 'c2', about: 'turn_summary', turn: { number: 23, version: 'v1.6.0' }, tag: null },
  ];
  await page.route('**/api/wait-cards', route => route.fulfill({ json: { cards, next: null } }));
  for (const lang of LANGUAGES.map(l => l.id)) for (const width of [1440, 375]) {
    const t = MESSAGES[lang];
    await open(page, lang, width, '/tasks?show=waits');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(t.tracker.where.waits);
    const waiting = page.getByRole('region', { name: t.tasks.waiting });
    await expect(waiting).toContainText(QUESTION);
    await expect(page.getByRole('region', { name: t.tasks.cards.tagTitle })).toContainText(t.tasks.cards.tag('v1.7.0', 24, 'unrecorded'));
    await expect(page.getByRole('region', { name: t.tasks.cards.summaryTitle(23) })).toContainText(t.tasks.cards.summary(23, 'v1.6.0', t.tracker.side.turns));
    await inside(page, `waits ${lang} ${width}`);
    await capture(page, info, `waits-${lang}-${width}`);
  }
  await open(page, 'en', 375, '/tasks?show=waits');
  await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
  const tag = page.getByRole('region', { name: MESSAGES.en.tasks.cards.tagTitle });
  /* Its edge line moves to the right, where the text starts. */
  expect(await tag.evaluate(el => getComputedStyle(el).borderRightWidth)).toBe('2px');
  await inside(page, 'waits rtl');
  await capture(page, info, 'waits-rtl-375');
});

test('says what to do when there is no work yet, and when a search finds nothing', async ({ page }) => {
  const t = MESSAGES.en;
  await serveTasksBoard(page);
  await page.route('**/api/tasks?*', route => route.fulfill({ json: { tasks: [] } }));
  await page.route('**/api/turns', route => route.fulfill({ json: { turns: [] } }));
  await open(page, 'en', 1440, '/tasks');
  await expect(page.getByText(t.tracker.noMine)).toBeVisible();
  await page.getByRole('navigation', { name: t.tracker.side.label }).getByRole('button', { name: t.tracker.side.turns, exact: true }).click();
  await expect(page.getByText(t.tasks.board.nothingYet)).toBeVisible();
  await page.getByRole('searchbox', { name: t.tasks.search }).fill('anything');
  await expect(page.locator('.tr-found').getByRole('status')).toHaveText(t.tasks.noSearchResults);
});
