import { expect, test, type Locator, type Page } from '@playwright/test';
import { DICTIONARIES, LANGUAGES, type Language, type Messages } from '../../src/i18n';
import { BUILTIN_SKINS, builtinSkin, DEFAULT_SKIN } from '../../src/skins/registry';
import { captureWith } from '../capture';
import { MARIA_QUESTION, MAX_QUESTION, QUESTION, servePeopleWaits, serveTasksBoard } from './api';

/* What waits for people in the company, as the CEO meets it in the tracker: every decision with whom it waits for, and its
   count beside it, while Waits for me keeps only the CEO's own. The look goes in the default skin and one of the other
   scheme, at a desk and on a phone, in the shipped languages with the longest and the shortest words on this page. Shots go
   to HH_SCREENSHOT_DIR when it is set, from Chromium. */

const capture = captureWith('people-waits', process.env.HH_SCREENSHOT_DIR);
const SKINS = [DEFAULT_SKIN, BUILTIN_SKINS.find(skin => skin.scheme !== builtinSkin(DEFAULT_SKIN)!.scheme)!.id];

/* The words this page shows in a language, summed: the panel's lists, the section and its cards. */
const pageWords = (t: Messages) => [
  t.tracker.side.title, t.tracker.side.waits, t.tracker.side.mine, t.tracker.side.working, t.tracker.side.people, t.tracker.side.departments,
  t.tracker.side.allGoals, t.tracker.side.dates, t.tracker.side.failures, t.tracker.side.orchestrator, t.tracker.side.turns, t.tracker.search.results,
  t.tracker.peopleWaits.title, t.tracker.peopleWaits.waitingFor(''), t.tracker.peopleWaits.tasks, t.tasks.asks(''), t.tasks.decidedByNamedPerson,
  t.tasks.answerElsewhere, t.tasks.openTerminal(''), t.tracker.wait.person('', ''),
].join('').length;
const byLength = [...LANGUAGES].sort((a, b) => pageWords(DICTIONARIES[b.id]) - pageWords(DICTIONARIES[a.id]));
const LOOK_LANGUAGES = [...new Set([byLength[0]!.id, byLength[byLength.length - 1]!.id])];

async function open(page: Page, lang: Language, width: number, path: string, skin: string = DEFAULT_SKIN) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ language, skin }) => {
    localStorage.setItem('hh-lang', language);
    localStorage.setItem('hh-theme', skin);
  }, { language: lang, skin });
  await serveTasksBoard(page);
  await servePeopleWaits(page);
  await page.goto(path);
  await expect(page.locator('h1.tr-where')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/* The number at the end of a row of the panel. */
const countOn = async (side: Locator, name: string) => Number(await side.getByRole('button', { name: new RegExp(`^${name} \\d+$`) }).locator('.tr-count').textContent());

/* What a list of what waits shows, counted as its number counts it: each task once, whether it asks or waits, and every card
   without a task. */
async function listed(region: Locator) {
  const tasks = await region.locator('article.req, .tr-waits li').evaluateAll(els => els.map(e => (e.getAttribute('aria-label') ?? e.textContent ?? '').match(/#(\d+)/)?.[1]));
  return new Set(tasks).size + await region.locator('.t-card').count();
}

test('lists what waits for people with whom each waits for, counts it, and leaves out of Waits for me what others alone answer', async ({ page }) => {
  const t = DICTIONARIES.en;
  await open(page, 'en', 1440, '/tasks?show=waits');
  const side = page.getByRole('navigation', { name: t.tracker.side.label });
  const mine = page.getByRole('region', { name: t.tasks.waiting });
  await expect(mine).toContainText(QUESTION);
  await expect(mine).toContainText(MARIA_QUESTION);
  await expect(mine).not.toContainText(MAX_QUESTION);
  expect(await countOn(side, t.tracker.side.waits)).toBe(await listed(mine));

  await side.getByRole('button', { name: new RegExp(`^${t.tracker.peopleWaits.title} \\d+$`) }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(t.tracker.peopleWaits.title);
  const people = page.getByRole('region', { name: t.tracker.peopleWaits.title });
  const card = (text: string) => people.locator('article.req', { hasText: text });
  await expect(card(MAX_QUESTION)).toContainText(t.tracker.peopleWaits.waitingFor('Max'));
  await expect(card(MAX_QUESTION)).toContainText(t.tasks.decidedByNamedPerson);
  await expect(card(QUESTION)).toContainText(t.tracker.peopleWaits.waitingFor('Ivan'));
  await expect(card(MARIA_QUESTION)).toContainText(t.tracker.peopleWaits.waitingFor('Maria'));
  await expect(people.getByRole('heading', { name: t.tracker.peopleWaits.tasks })).toBeVisible();
  expect(await countOn(side, t.tracker.peopleWaits.title)).toBe(await listed(people));
  expect(await countOn(side, t.tracker.peopleWaits.title)).toBe(await countOn(side, t.tracker.side.waits) + 1);
});

for (const lang of LOOK_LANGUAGES) for (const skin of SKINS) for (const width of [1440, 375]) {
  test(`shows what waits for people whole inside the screen: ${lang} ${skin} ${width}`, async ({ page, browserName }, info) => {
    const t = DICTIONARIES[lang];
    await open(page, lang, width, '/tasks?show=people', skin);
    const people = page.getByRole('region', { name: t.tracker.peopleWaits.title });
    await expect(people.locator('article.req', { hasText: MAX_QUESTION })).toContainText(t.tracker.peopleWaits.waitingFor('Max'));
    /* Each card and its words stay inside the main area, nothing cut short, and the page never scrolls sideways. A closed
       select shows its choice on one line, as every select of the app does. */
    const frame = (await page.locator('.tr-main').boundingBox())!;
    for (const box of await people.locator('article.req, article.req header > *, .tr-waits li').evaluateAll(els => els.map(e => e.getBoundingClientRect()).map(r => ({ x: r.x, right: r.right })))) {
      expect(box.x).toBeGreaterThanOrEqual(frame.x - 1);
      expect(box.right).toBeLessThanOrEqual(frame.x + frame.width + 1);
    }
    expect(await page.locator('.tracker :not(select)').evaluateAll(els => els.filter(e => getComputedStyle(e).textOverflow === 'ellipsis').length)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    if (browserName === 'chromium') await capture(page, info, `${lang}-${skin}-${width}`);
  });
}
