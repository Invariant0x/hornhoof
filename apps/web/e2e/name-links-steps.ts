import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { PersonView } from '../src/types';
import { serveTree } from './tree-api';
import { captureWith } from './capture';

/* A name that opens a person or an agent has color and a focus ring but no hover underline, in each language, theme and width.
   name-links-people.spec.ts checks the list of people, name-links-tree-en.spec.ts and name-links-tree-ru.spec.ts the cards of
   the tree. */
type Lang = 'en' | 'ru';
type Theme = 'light' | 'dark';
export const MESSAGES: Record<Lang, Messages> = { en, ru };
const PHASE = process.env.HH_NAME_LINK_PHASE ?? 'after';
const SCREENSHOT_DIR = process.env.HH_SCREENSHOT_DIR;
export const PEOPLE: PersonView[] = [
  { id: 'p1', name: 'Ivan', email: 'ivan@acme.test', title: 'CEO', status: 'active', isOwner: true, access: { whole: true, departments: [], teams: [] } },
  { id: 'p2', name: 'Dana', email: 'dana@acme.test', title: 'COO', status: 'active', isOwner: false, access: { whole: true, departments: [], teams: [] } },
];

export const capture = captureWith(PHASE, SCREENSHOT_DIR);

/* Every look of the languages given: both themes, wide and narrow. */
export function looks(langs: Lang[]): { lang: Lang; theme: Theme; width: number; look: string }[] {
  return langs.flatMap(lang => (['light', 'dark'] as const).flatMap(theme => [1440, 375].map(width => ({ lang, theme, width, look: `${lang}-${theme}-${width}` }))));
}

/* The page at a look, with the tree's answers, and the errors it logs. */
export async function prepare(page: Page, lang: Lang, theme: Theme, width: number): Promise<string[]> {
  await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, { lang, theme });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await serveTree(page, { during: true });
  return errors;
}

async function styles(link: Locator) {
  return link.evaluate(el => {
    const style = getComputedStyle(el);
    return { color: style.color, decoration: style.textDecorationLine, cursor: style.cursor, outline: style.outlineStyle, outlineWidth: style.outlineWidth };
  });
}

export async function expectNameHover(link: Locator) {
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

export async function openTree(page: Page, lang: 'en' | 'ru', line = /Vera, #121/) {
  await page.goto('/');
  await page.getByRole('button', { name: lang === 'en' ? /^Development/ : /^Разработка/ }).click();
  await page.getByRole('button', { name: lang === 'en' ? 'Tree' : 'Дерево', exact: true }).click();
  const graph = page.getByRole('group', { name: lang === 'en' ? 'Tree of turn 4' : 'Дерево хода 4' });
  await expect(graph).toBeVisible();
  const review = graph.getByRole('button', { name: line }).first();
  await review.scrollIntoViewIfNeeded();
  await review.click();
  const card = page.locator('.tv-card');
  await expect(card).toBeVisible();
  return card;
}

/* The names on the cards of the tree: the lane's agent and, on its own card, the checker of the work; a task link keeps its
   underline. */
export async function agentNames(page: Page, info: TestInfo, lang: Lang, theme: Theme, width: number, look: string): Promise<void> {
  const errors = await prepare(page, lang, theme, width);
  const card = await openTree(page, lang);
  const lane = card.locator('h4').getByRole('button', { name: /^Vera/ });
  const task = card.getByRole('button', { name: /#121/ });
  await lane.hover();
  await capture(page, info, `tree-lane-${look}`);
  await expectNameHover(lane);
  await task.hover();
  await expect(task).toHaveCSS('text-decoration-line', 'underline');
  /* Since 0.17.0 a checker's work is its own task with its own card, not a reviewer on the card of the work it checks. */
  const checkerCard = await openTree(page, lang, /Rita, #122/);
  const reviewer = checkerCard.locator('h4').getByRole('button', { name: /^Rita/ });
  await reviewer.hover();
  await capture(page, info, `tree-reviewer-${look}`);
  await expectNameHover(reviewer);
  await reviewer.click();
  const reviewerWindow = page.getByRole('complementary', { name: 'Rita', exact: true });
  await expect(reviewerWindow).toBeVisible();
  await reviewerWindow.getByRole('button', { name: lang === 'en' ? 'Close' : 'Закрыть', exact: true }).click();
  const laneCard = await openTree(page, lang);
  await laneCard.locator('h4').getByRole('button', { name: /^Vera/ }).click();
  await expect(laneCard).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Vera', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
}
