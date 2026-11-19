import { expect, test, type Page } from '@playwright/test';
import type { Messages } from '../src/i18n/en';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { PersonView } from '../src/types';
import { box, serveApi } from './api';

const WHOLE = { whole: true, departments: [], teams: [] };
/* The CEO, a person the CEO may make the deputy, the deputy, and a deputy switched off. */
const PEOPLE: PersonView[] = [
  { id: 'p1', name: 'Ivan', email: 'ivan@acme.com', title: 'CEO', status: 'active', isOwner: true, access: WHOLE },
  { id: 'p2', name: 'Dana', email: 'dana@acme.com', title: 'COO', status: 'active', isOwner: false, isCeoDelegate: false, access: WHOLE },
  { id: 'p3', name: 'Ruth', email: 'ruth@acme.com', title: 'CFO', status: 'active', isOwner: false, isCeoDelegate: true, access: WHOLE },
  { id: 'p4', name: 'Mia', email: 'mia@acme.com', title: 'CTO', status: 'disabled', isOwner: false, isCeoDelegate: true, access: WHOLE },
];
const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };
const routes = (people: PersonView[]): Record<string, unknown> => ({
  '/api/people': { people },
  '/api/version': { version: '0.5.0', commit: 'task-180' },
  '/api/updates': { current: { version: '0.5.0', commit: 'task-180' }, available: false, latest: null, updater: { status: null, waiting: null } },
});
type Rect = { x: number; y: number; width: number; height: number };

/* The People screen as the CEO meets it, with the errors the page logs. */
async function openPeople(page: Page, lang: 'en' | 'ru', theme: 'light' | 'dark', width: number, people = PEOPLE): Promise<string[]> {
  const ROUTES = routes(people);
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, { lang, theme });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await serveApi(page);
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const path = url.pathname + url.search;
    return path in ROUTES ? route.fulfill({ json: ROUTES[path] }) : route.fallback();
  });
  await page.goto('/');
  await page.getByRole('button', { name: MESSAGES[lang].shell.tabs.people, exact: true }).click();
  await expect(page.locator('table.ptable')).toBeVisible();
  /* The words take their own font only once it has loaded, and with it their width. */
  await page.evaluate(async () => { await document.fonts.ready; });
  return errors;
}

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      test(`the deputy CEO has a short mark on the name's line and a switch in Edit, in ${lang}, ${theme}, at ${width}px`, async ({ page }, info) => {
        const t = MESSAGES[lang];
        const errors = await openPeople(page, lang, theme, width);
        const table = page.locator('table.ptable');
        /* The rows as people see them, taken before the checks so that a failing run shows them too. */
        await table.screenshot({ path: info.outputPath(`people-${width}-${lang}-${theme}.png`) });
        /* No tick in the rows: the deputy is set in Edit. */
        await expect(table.getByRole('checkbox')).toHaveCount(0);
        await expect(table.getByRole('switch')).toHaveCount(0);
        await expect(table.getByRole('img', { name: t.people.ceoDelegate, exact: true })).toHaveCount(2);
        const nameOf = (name: string) => table.locator('.pname', { hasText: name });
        const plain = await box(nameOf('Dana'));
        for (const name of ['Ruth', 'Mia']) {
          const mark = nameOf(name).getByRole('img', { name: t.people.ceoDelegate, exact: true });
          await expect(mark, `${name}: the whole name of the post on hover`).toHaveAttribute('title', t.people.ceoDelegate);
          await expect(mark).toHaveText(t.people.deputyShort);
          const line = await box(nameOf(name));
          const m = await box(mark);
          const cell = await box(nameOf(name).locator('xpath=ancestor::td[1]'));
          /* One line: the name with its mark is no taller than a name without one, and the mark sits inside it. */
          expect(Math.abs(line.height - plain.height), `${name}: height of the name's line`).toBeLessThanOrEqual(1);
          expect(m.y, `${name}: top of the mark`).toBeGreaterThanOrEqual(line.y - 1);
          expect(m.y + m.height, `${name}: bottom of the mark`).toBeLessThanOrEqual(line.y + line.height + 1);
          /* It does not run into the next column. */
          expect(m.x + m.width, `${name}: end of the mark`).toBeLessThanOrEqual(cell.x + cell.width + 1);
          /* The hat stands before the word, in the middle of its height and as tall as its letters, with a little room between. */
          const { hat, word, letters } = await mark.evaluate(el => {
            const rect = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
            const range = document.createRange();
            range.selectNodeContents(el.lastChild!);
            return { hat: rect(el.querySelector('svg')!.getBoundingClientRect()), word: rect(range.getBoundingClientRect()), letters: parseFloat(getComputedStyle(el).fontSize) };
          });
          expect(word.x - (hat.x + hat.width), `${name}: room between the hat and the word`).toBeGreaterThanOrEqual(2);
          expect(Math.abs(hat.y + hat.height / 2 - (word.y + word.height / 2)), `${name}: hat in the middle of the word`).toBeLessThanOrEqual(1);
          expect(hat.height, `${name}: hat as tall as the letters`).toBeLessThanOrEqual(letters);
        }
        /* The switch is in Edit, right after the access, under its whole name. */
        await page.getByRole('button', { name: t.people.editLabel('Dana'), exact: true }).click();
        const deputy = page.getByRole('switch', { name: t.people.ceoDelegate, exact: true });
        await expect(deputy).toBeVisible();
        await expect(deputy).not.toBeChecked();
        const panel = page.locator('.panel', { has: deputy });
        await panel.screenshot({ path: info.outputPath(`edit-${width}-${lang}-${theme}.png`) });
        const accessGroup = panel.getByRole('group', { name: t.people.access, exact: true });
        const access = await box(accessGroup);
        /* The ticks of the access, in the column of the fields of the form's grid. */
        const ticks = await box(accessGroup.locator('.field-control'));
        const label = deputy.locator('xpath=ancestor::label[1]');
        await expect(label).toContainText(t.people.deputyAbout);
        const whole = await box(label);
        expect(whole.y, 'the switch right after the access').toBeGreaterThanOrEqual(access.y + access.height - 1);
        /* The interface's switch: the box on the left, the name with what it gives under it, in the column of the fields on the
           edge and as wide as the ticks of the access. */
        const parts = await label.evaluate(el => {
          const rect = (e: Element): Rect => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
          const [input, name, about] = ['input', 'b', 'small'].map(s => el.querySelector(s)!);
          return { input: rect(input!), name: rect(name!), about: rect(about!), aboutSize: getComputedStyle(about!).fontSize, nameWeight: getComputedStyle(name!).fontWeight };
        });
        expect(parts.input.x + parts.input.width, 'the box before the name').toBeLessThan(parts.name.x);
        expect(parts.about.y, 'what it gives under the name').toBeGreaterThanOrEqual(parts.name.y + parts.name.height - 1);
        expect(parts.input.width, 'the size of the box').toBe(16);
        expect(parts).toMatchObject({ aboutSize: '12px', nameWeight: '600' });
        expect(Math.abs(whole.x - ticks.x), 'on the edge of the access ticks').toBeLessThanOrEqual(1);
        expect(Math.abs(whole.width - ticks.width), 'as wide as the access ticks').toBeLessThanOrEqual(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      });
    }
  }
}

test('a long name wraps at its words on a phone, and the mark stays whole on its line', async ({ page }) => {
  const long: PersonView = { id: 'p5', name: 'Maya Chen Alderbrook-Riverstone Willowmere-Cedarfield-Park', email: 'maya@moonfern.example', title: 'CMO', status: 'active', isOwner: false, isCeoDelegate: true, access: WHOLE };
  const errors = await openPeople(page, 'en', 'light', 375, [...PEOPLE, long]);
  const table = page.locator('table.ptable');
  const markOf = (name: string) => table.locator('.pname', { hasText: name }).getByRole('img', { name: en.people.ceoDelegate, exact: true });
  const short = await box(markOf('Ruth'));
  const longName = table.locator('.pname', { hasText: long.name });
  const mark = await box(markOf(long.name));
  const line = await box(longName);
  const cell = await box(longName.locator('xpath=ancestor::td[1]'));
  expect(line.height, 'the long name takes more than one line').toBeGreaterThan(short.height * 1.5);
  expect(Math.abs(mark.height - short.height), 'the mark stays one line').toBeLessThanOrEqual(1);
  expect(Math.abs(mark.width - short.width), 'the mark keeps its width').toBeLessThanOrEqual(1);
  expect(mark.x + mark.width, 'the mark inside its cell').toBeLessThanOrEqual(cell.x + cell.width + 1);
  expect(errors).toEqual([]);
});
