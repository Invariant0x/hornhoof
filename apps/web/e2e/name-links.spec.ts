import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { PersonView } from '../src/types';
import { serveTree } from './tree-api';

const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };
const PHASE = process.env.HH_NAME_LINK_PHASE ?? 'after';
const SCREENSHOT_DIR = process.env.HH_SCREENSHOT_DIR;
const PEOPLE: PersonView[] = [
  { id: 'p1', name: 'Ivan', email: 'ivan@acme.test', title: 'CEO', status: 'active', isOwner: true, access: { whole: true, departments: [], teams: [] } },
  { id: 'p2', name: 'Dana', email: 'dana@acme.test', title: 'COO', status: 'active', isOwner: false, access: { whole: true, departments: [], teams: [] } },
];

async function capture(page: Page, info: TestInfo, name: string) {
  const file = `${PHASE}-${name}.png`;
  const path = SCREENSHOT_DIR ? `${SCREENSHOT_DIR}/${file}` : info.outputPath(file);
  await page.screenshot({ path });
  await info.attach(file, { path, contentType: 'image/png' });
}

async function styles(link: Locator) {
  return link.evaluate(el => {
    const style = getComputedStyle(el);
    return { color: style.color, decoration: style.textDecorationLine, cursor: style.cursor, outline: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
}

async function expectNameHover(link: Locator) {
  await link.page().mouse.move(0, 0);
  const resting = await styles(link);
  await link.hover();
  await expect(link).toHaveCSS('cursor', 'pointer');
  await expect(link).toHaveCSS('text-decoration-line', 'none');
  expect((await styles(link)).color).not.toBe(resting.color);
  await link.focus();
  await link.page().keyboard.press('Shift+Tab');
  await link.page().keyboard.press('Tab');
  await expect(link).toBeFocused();
  await expect(link).toHaveCSS('outline-style', 'solid');
  await expect(link).toHaveCSS('outline-width', '2px');
  await expect(link).toHaveCSS('text-decoration-line', 'none');
}

async function openTree(page: Page, lang: 'en' | 'ru') {
  await page.goto('/');
  await page.getByRole('button', { name: lang === 'en' ? /Development/ : /Разработка/ }).click();
  await page.getByRole('button', { name: lang === 'en' ? 'Tree' : 'Дерево', exact: true }).click();
  const graph = page.getByRole('group', { name: lang === 'en' ? 'Tree of turn 4' : 'Дерево хода 4' });
  await expect(graph).toBeVisible();
  const review = graph.getByRole('button', { name: /Vera, #121/ }).first();
  await review.scrollIntoViewIfNeeded();
  await review.click();
  const card = page.locator('.tv-card');
  await expect(card).toBeVisible();
  return card;
}

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      const look = `${lang}-${theme}-${width}`;
      test(`a person's name has color and focus but no hover underline: ${look}`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        await page.addInitScript(({ lang, theme }) => {
          localStorage.setItem('hh-lang', lang);
          localStorage.setItem('hh-theme', theme);
        }, { lang, theme });
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        await serveTree(page, { during: true });
        await page.route('**/api/people', route => route.fulfill({ json: { people: PEOPLE } }));
        await page.goto('/people');
        const name = page.locator('table.ptable').getByRole('button', { name: /^Dana/ });
        await expect(name).toBeVisible();
        await page.mouse.move(0, 0);
        await name.hover();
        await capture(page, info, `people-${look}`);
        await expectNameHover(name);
        await name.click();
        await expect(page.getByRole('heading', { name: MESSAGES[lang].people.editHeading('Dana') })).toBeVisible();
        expect(errors).toEqual([]);
      });

      test(`agent names have color and focus but no hover underline, task links keep it: ${look}`, async ({ page }, info) => {
        test.setTimeout(120_000);
        await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
        await page.addInitScript(({ lang, theme }) => {
          localStorage.setItem('hh-lang', lang);
          localStorage.setItem('hh-theme', theme);
        }, { lang, theme });
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        await serveTree(page, { during: true });
        const card = await openTree(page, lang);
        const lane = card.locator('h4').getByRole('button', { name: /^Vera/ });
        const reviewer = card.getByRole('button', { name: /^Rita/ });
        const task = card.getByRole('button', { name: /#121/ });
        await lane.hover();
        await capture(page, info, `tree-lane-${look}`);
        await reviewer.hover();
        await capture(page, info, `tree-reviewer-${look}`);
        await expectNameHover(lane);
        await expectNameHover(reviewer);
        await task.hover();
        await expect(task).toHaveCSS('text-decoration-line', 'underline');
        await reviewer.click();
        const reviewerWindow = page.getByRole('complementary', { name: 'Rita', exact: true });
        await expect(reviewerWindow).toBeVisible();
        await reviewerWindow.getByRole('button', { name: lang === 'en' ? 'Close' : 'Закрыть', exact: true }).click();
        const laneCard = await openTree(page, lang);
        await laneCard.locator('h4').getByRole('button', { name: /^Vera/ }).click();
        await expect(laneCard).toHaveCount(0);
        await expect(page.getByRole('complementary', { name: 'Vera', exact: true })).toBeVisible();
        expect(errors).toEqual([]);
      });
    }
  }
}
