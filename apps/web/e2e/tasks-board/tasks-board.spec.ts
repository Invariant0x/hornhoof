import { expect, test, type Page } from '@playwright/test';
import { LANGUAGES, type Language, type Messages } from '../../src/i18n';
import { en } from '../../src/i18n/en';
import { ru } from '../../src/i18n/ru';
import { BUILTIN_SKINS } from '../../src/skins/registry';
import { NODE } from '../../src/tracker';
import { captureWith } from '../capture';
import { DEV, GOALS, QUESTION, serveTasksBoard, TASKS } from './api';

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

/* What a finger presses is at least 44 px high. */
async function touchable(page: Page, what: string) {
  for (const height of await page.locator('.tr-item, .tr-views label, .tr-chip, .tr-menu:visible, .tr-canvas .zbtn').evaluateAll(els =>
    els.filter(e => e.getClientRects().length).map(e => e.getBoundingClientRect().height))) {
    expect(height, what).toBeGreaterThanOrEqual(43.5);
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
