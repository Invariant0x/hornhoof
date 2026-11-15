import { expect, test, type Locator, type Page } from '@playwright/test';
import { LANGUAGES, type Language, type Messages } from '../../src/i18n';
import { en } from '../../src/i18n/en';
import { ru } from '../../src/i18n/ru';
import { collectionText } from '../../src/skins/collection';
import { BUILTIN_SKINS, builtinSkin } from '../../src/skins/registry';
import type { Skin } from '../../src/skins/roles';
import { builtinFile } from '../../src/skins/validate';
import { captureWith } from '../capture';
import { QUESTION, serveTasksBoard, TASKS } from './api';

/* The tracker as a person meets it: three numbers at a glance, the goals of every department with the one that waits for the
   person's answer first and their related tasks folded under them as short lines, three views to switch, a department to
   pick by department and by release, a search, and what is over folded apart. 138 tasks never spill into one long list.
   Shots of every built-in skin and one of a person's own, at a desk and on a phone, also mirrored right to left, go to
   HH_SCREENSHOT_DIR when it is set. */

const MESSAGES: Record<Language, Messages> = { en, ru };
const capture = captureWith('tasks-board', process.env.HH_SCREENSHOT_DIR);
const CYBERPUNK = builtinSkin('cyberpunk')!;
const OWN: Skin = { ...builtinFile(CYBERPUNK, { ru: 'Сумерки', en: 'Dusk' }), cut: 1.5 };
const SKINS = [...BUILTIN_SKINS.map(skin => skin.id), 'custom-1'];

async function open(page: Page, lang: Language, width: number, skin = 'cyberpunk') {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ language, skin, collection }) => {
    localStorage.setItem('hh-lang', language);
    localStorage.setItem('hh-theme', skin);
    localStorage.setItem('hh-skins', collection);
  }, { language: lang, skin, collection: collectionText([{ id: 'custom-1', skin: OWN }]) });
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { level: 1, name: MESSAGES[lang].tasks.heading })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

const board = (page: Page, t: Messages) => page.getByRole('region', { name: t.tasks.board.label });
/* Cards at the top of what shows, and the short lines of related tasks unfolded under them. */
const goals = (page: Page) => page.locator('article.goal');
const related = (page: Page) => page.locator('.goal-subs > .goal-row');
const row = (page: Page, number: number) => page.getByRole('listitem', { name: `#${number} ${TASKS.find(x => x.number === number)!.title}`, exact: true });
/* A goal's card on the board, not the card of a question about the same task in what waits for the person. */
const card = (page: Page, number: number) => page.locator('article.goal').and(page.getByRole('article', { name: `#${number} ${TASKS.find(x => x.number === number)!.title}`, exact: true }));
const sideways = (page: Page) => page.getByRole('main').evaluate(el => el.scrollWidth - el.clientWidth);
const goalOf = (title: string) => TASKS.find(x => x.title === title)!;

/* Every card and every control of the board stays inside the board, from its start edge to its end edge. */
async function inside(page: Page, t: Messages) {
  const frame = (await board(page, t).boundingBox())!;
  for (const box of await page.locator('article.goal, .goal button').evaluateAll(els => els.map(e => e.getBoundingClientRect()).map(r => ({ x: r.x, right: r.right })))) {
    expect(box.x).toBeGreaterThanOrEqual(frame.x - 1);
    expect(box.right).toBeLessThanOrEqual(frame.x + frame.width + 1);
  }
}

for (const lang of LANGUAGES.map(l => l.id)) {
  test(`folds 138 tasks to their goals, unfolds one in a click, and switches views and departments: ${lang}`, async ({ page }, info) => {
    const t = MESSAGES[lang];
    const served = await serveTasksBoard(page);
    await open(page, lang, 1440);
    const view = page.getByRole('group', { name: t.tasks.board.view });
    await expect(view.getByRole('radio', { name: t.tasks.board.views.active })).toBeChecked();

    /* At a glance: one goal waits for the person's answer, seven go on now, nothing is ready for release yet. */
    const summary = page.getByRole('list', { name: t.tasks.board.summary.label });
    await expect(summary.getByRole('listitem')).toHaveText([`1 ${t.tasks.board.summary.you}`, `7 ${t.tasks.board.summary.running}`, `0 ${t.tasks.board.summary.ready}`]);

    /* In progress: the goals alone, the related tasks folded, the one that waits for the person first with the question. */
    await expect(goals(page)).toHaveCount(9);
    await expect(related(page)).toHaveCount(0);
    const signIn = card(page, goalOf('Fix the sign-in page').number);
    await expect(goals(page).first()).toHaveAttribute('aria-label', `#${goalOf('Fix the sign-in page').number} Fix the sign-in page`);
    await expect(signIn).toContainText(t.tasks.board.statuses.waitingYou);
    await expect(signIn.getByRole('group', { name: t.tasks.board.askHead })).toContainText(QUESTION);
    await expect(signIn).toContainText(t.tasks.board.urgent);
    await expect(signIn).toContainText(t.tasks.board.outsideTurns);
    const payments = card(page, goalOf('Take card payments').number);
    await expect(payments).toContainText('Take card payments: what it does for the shop and why it is needed.');
    await expect(payments).toContainText(t.tasks.board.statuses.working);
    await expect(payments).toContainText('Development');
    await expect(payments).toContainText(t.tasks.board.assignee('Hana'));
    await expect(payments.getByRole('progressbar', { name: t.tasks.board.progress(1, 3) })).toHaveAttribute('aria-valuemax', '3');
    await expect(payments.getByRole('button', { name: t.tasks.board.openTask })).toHaveCount(0);
    /* A department names where a goal is, in the neutral colour, not in the colour of attention. */
    const badge = payments.locator('.badge.goal-place');
    expect(await badge.evaluate(el => getComputedStyle(el).color)).toBe(await page.locator('.goal-no').first().evaluate(el => getComputedStyle(el).color));
    await expect(page.getByRole('combobox', { name: t.tasks.department })).toHaveCount(0);
    await capture(page, info, `active-${lang}`);
    await signIn.evaluate(el => el.scrollIntoView({ block: 'center' }));
    await capture(page, info, `active-goal-${lang}`);

    /* One click opens the related tasks of a goal as short lines; the work under one of them is not unfolded here, a link
       opens its task. Another click folds them again. */
    const fold = payments.getByRole('button', { name: t.tasks.board.related(1, 3) });
    await expect(fold).toHaveAttribute('aria-expanded', 'false');
    await fold.click();
    await expect(related(page)).toHaveCount(3);
    const build = row(page, goalOf('Build: take card payments').number);
    await expect(build).toContainText(t.tasks.board.statuses.working);
    await expect(build).toContainText(t.tasks.board.assignee('Bruno'));
    await expect(build).not.toContainText('what it does for the shop');
    await expect(build.getByRole('progressbar')).toHaveCount(0);
    await expect(build.getByRole('button', { name: /^Related tasks|^Сопутствующие/ })).toHaveCount(0);
    await expect(build.getByRole('button', { name: t.tasks.board.openTask })).toBeVisible();
    await payments.locator('.goal-subs').evaluate(el => el.scrollIntoView({ block: 'center' }));
    await capture(page, info, `unfolded-${lang}`);
    await fold.click();
    await expect(related(page)).toHaveCount(0);

    /* What is over waits folded under the goals. */
    await board(page, t).getByRole('button', { name: t.tasks.board.closed(2) }).click();
    await expect(goals(page)).toHaveCount(11);
    await expect(card(page, goalOf('Old checkout').number)).toContainText(t.tasks.board.statuses.done);

    /* By department: every department under its own name, with what is in progress in it; one department at a time, the
       orchestrator's own work among them for someone with the whole company. */
    await view.getByRole('radio', { name: t.tasks.board.views.departments }).check({ force: true });
    const sections = board(page, t).getByRole('heading', { level: 2 });
    await expect(sections).toHaveText(['Development', 'Sales', t.tasks.board.orchestrator]);
    await expect(board(page, t).getByRole('region', { name: 'Development' })).toContainText(t.tasks.board.inProgress(7));
    await capture(page, info, `departments-${lang}`);
    const department = page.getByRole('combobox', { name: t.tasks.department });
    await department.selectOption({ label: 'Sales' });
    await expect(goals(page)).toHaveCount(1);
    await expect(card(page, goalOf('Call the shop owners back').number)).toContainText(t.tasks.board.statuses.review);
    await department.selectOption({ label: t.tasks.board.orchestrator });
    await expect(goals(page)).toHaveCount(1);
    await department.selectOption({ label: t.tasks.board.allDepartments });

    /* Turns and releases: the next release of Development getting ready with its goals counted, the release out already
       folded to a line, and on its own choice the work outside releases. */
    await view.getByRole('radio', { name: t.tasks.board.views.releases }).check({ force: true });
    await expect(board(page, t).getByText(t.tasks.board.relsWhy)).toBeVisible();
    await expect(sections).toHaveText([t.tasks.board.preparing(3, 'v1.2.0'), t.tasks.board.closedReleases]);
    const next = board(page, t).getByRole('region', { name: t.tasks.board.preparing(3, 'v1.2.0') });
    await expect(next.getByRole('progressbar', { name: t.tasks.board.goalsDone(0, 7) })).toHaveAttribute('aria-valuemax', '7');
    await expect(next.getByRole('listitem')).toHaveCount(7);
    const closed = board(page, t).getByRole('region', { name: t.tasks.board.closedReleases });
    await expect(closed.getByRole('listitem')).toHaveCount(0);
    await closed.getByRole('button', { name: new RegExp(`${t.tasks.board.released(2, 'v1.2.0')}.*${t.tasks.board.relCount(1)}`) }).click();
    await expect(row(page, goalOf('Old checkout').number)).toContainText(t.tasks.board.statuses.done);
    await expect(board(page, t).getByText(t.tasks.board.pickDepartment)).toBeVisible();
    await department.selectOption({ label: 'Development' });
    await expect(page.getByRole('table', { name: t.backlog.heading })).toContainText('Gift cards for shops');
    await capture(page, info, `releases-${lang}`);
    await department.selectOption({ label: t.tasks.board.allDepartments });
    const show = board(page, t).getByRole('group', { name: t.tasks.board.show });
    await show.getByRole('radio', { name: t.tasks.board.showOutside, exact: true }).check({ force: true });
    await expect(goals(page)).toHaveCount(2);
    await expect(card(page, goalOf('Call the shop owners back').number)).toBeVisible();
    await expect(next).toHaveCount(0);
    await show.getByRole('radio', { name: t.tasks.board.showReleases, exact: true }).check({ force: true });
    await expect(next).toBeVisible();

    /* A search looks through every task, the related ones too, by number or words. */
    const deep = goalOf('Part 4 of build');
    await page.getByRole('searchbox', { name: t.tasks.search }).fill(`#${deep.number}`);
    await expect(board(page, t).getByRole('heading', { name: t.tasks.searchResults })).toBeVisible();
    await expect(card(page, deep.number)).toBeVisible();
    await card(page, deep.number).getByRole('button', { name: deep.title, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${deep.id}$`));
    await page.keyboard.press('Escape');

    expect(await sideways(page)).toBeLessThanOrEqual(0);
    /* One read of all the tasks the person reads, whatever view or department shows. */
    expect([...new Set(served.reads)]).toEqual(['?status=all']);
  });

  /* On a phone the three views stand as three equal tabs in one row, a long name wrapping inside its own tab. */
  test(`shows what is in progress on a phone, the three views as equal tabs: ${lang} 375`, async ({ page }, info) => {
    const t = MESSAGES[lang];
    await serveTasksBoard(page);
    await open(page, lang, 375);
    await expect(goals(page).first()).toHaveAttribute('aria-label', `#${goalOf('Fix the sign-in page').number} Fix the sign-in page`);
    const tabs = await page.getByRole('group', { name: t.tasks.board.view }).locator('label').evaluateAll(els => els.map(e => e.getBoundingClientRect()).map(r => ({ y: r.y, width: r.width })));
    expect(tabs).toHaveLength(3);
    /* Each tab after the first reaches 1 px back over its neighbour, so they share one border line. */
    for (const [i, tab] of tabs.entries()) {
      expect(Math.abs(tab.y - tabs[0]!.y)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(tab.width - (i ? 1 : 0) - tabs[0]!.width)).toBeLessThanOrEqual(0.5);
    }
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await inside(page, t);
    await capture(page, info, `active-${lang}-375`);
    /* Clear of the header, which stays over the top of the page. */
    await goals(page).first().evaluate(el => { el.style.scrollMarginTop = '80px'; el.scrollIntoView({ block: 'start' }); });
    await capture(page, info, `active-goal-${lang}-375`);
  });
}

test('keeps every card and control inside the board in every skin, at a desk and on a phone, and mirrored right to left', async ({ page }, info) => {
  const t = MESSAGES.en;
  await serveTasksBoard(page);
  for (const skin of SKINS) for (const width of [1440, 375]) {
    await open(page, 'en', width, skin);
    await card(page, goalOf('Take card payments').number).getByRole('button', { name: t.tasks.board.related(1, 3) }).click();
    await expect(related(page)).toHaveCount(3);
    expect(await sideways(page), `${skin} ${width}`).toBeLessThanOrEqual(0);
    await inside(page, t);
    await capture(page, info, `${skin}-${width}`);
  }
  await open(page, 'en', 1440);
  /* The bar of a goal keeps its own width whatever width each engine gives the words beside it: 360 px less the gap
     and the 8em of words, so the engines differ by at most 1 px (style book, section 9). */
  const bar = (await card(page, goalOf('Take card payments').number).getByRole('progressbar').boundingBox())!;
  expect(Math.abs(bar.width - 250)).toBeLessThanOrEqual(0.5);
  await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
  const payments = card(page, goalOf('Take card payments').number);
  const frame = (await board(page, t).boundingBox())!;
  const box = (await payments.boundingBox())!;
  const title = (await payments.getByRole('button', { name: 'Take card payments', exact: true }).boundingBox())!;
  /* The title starts at the right edge of its card. */
  expect(Math.abs(box.x + box.width - (title.x + title.width))).toBeLessThanOrEqual(box.width / 4);
  expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
  await inside(page, t);
  await capture(page, info, 'rtl-1440');
});

test('shows a clean empty board and says what to do', async ({ page }) => {
  const t = MESSAGES.en;
  await serveTasksBoard(page);
  await page.route('**/api/tasks?*', route => route.fulfill({ json: { tasks: [] } }));
  await page.route('**/api/turns', route => route.fulfill({ json: { turns: [] } }));
  await open(page, 'en', 1440);
  await expect(board(page, t).getByText(t.tasks.board.noneActive)).toBeVisible();
  const view = page.getByRole('group', { name: t.tasks.board.view });
  await view.getByRole('radio', { name: t.tasks.board.views.releases }).check({ force: true });
  await expect(board(page, t).getByText(t.tasks.board.nothingYet)).toBeVisible();
  const found: Locator = board(page, t);
  await page.getByRole('searchbox', { name: t.tasks.search }).fill('anything');
  await expect(found.getByRole('status')).toHaveText(t.tasks.noSearchResults);
});

/* The cards Hornhoof kept for the person: a version marked in the code that released nothing, and a turn that is over. */
test('shows the cards kept for the person inside the page, at a desk and on a phone, in every language and mirrored right to left', async ({ page }, info) => {
  await serveTasksBoard(page);
  const goal = TASKS.find(x => x.turn !== null && !x.parentId)!;
  const kept = { taskId: goal.id, number: goal.number, kind: null, level: null, at: '2026-11-14T10:00:00.000Z' };
  const cards = [
    { ...kept, id: 'c1', about: 'release_tag', turn: { number: 24, version: null }, tag: { version: 'v1.7.0', why: 'unrecorded' } },
    { ...kept, id: 'c2', about: 'turn_summary', turn: { number: 23, version: 'v1.6.0' }, tag: null },
  ];
  await page.route('**/api/wait-cards', route => route.fulfill({ json: { cards, next: null } }));
  const within = async (t: Messages) => {
    const frame = (await page.getByRole('region', { name: t.tasks.waiting }).boundingBox())!;
    for (const box of await page.locator('.wait-card, .wait-card button').evaluateAll(els => els.map(e => e.getBoundingClientRect()).map(r => ({ x: r.x, right: r.right })))) {
      expect(box.x).toBeGreaterThanOrEqual(frame.x - 1);
      expect(box.right).toBeLessThanOrEqual(frame.x + frame.width + 1);
    }
  };
  for (const lang of LANGUAGES.map(l => l.id)) for (const width of [1440, 375]) {
    const t = MESSAGES[lang];
    await open(page, lang, width);
    await expect(page.getByRole('region', { name: t.tasks.cards.tagTitle })).toContainText(t.tasks.cards.tag('v1.7.0', 24, 'unrecorded'));
    await expect(page.getByRole('region', { name: t.tasks.cards.summaryTitle(23) })).toContainText(t.tasks.cards.summary(23, 'v1.6.0', t.tasks.board.views.releases));
    expect(await sideways(page), `${lang} ${width}`).toBeLessThanOrEqual(0);
    await within(t);
    await capture(page, info, `cards-${lang}-${width}`);
  }
  await open(page, 'en', 375);
  await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
  const tag = page.getByRole('region', { name: MESSAGES.en.tasks.cards.tagTitle });
  /* Its edge line moves to the right, where the text starts. */
  expect(await tag.evaluate(el => getComputedStyle(el).borderRightWidth)).toBe('2px');
  expect(await sideways(page)).toBeLessThanOrEqual(0);
  await within(MESSAGES.en);
  await capture(page, info, 'cards-rtl-375');
});
