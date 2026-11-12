import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Org, Question } from '../src/types';
import { ME, box, serveApi } from './api';

const SIZES = [[1440, 900], [375, 900]] as const;
const LONG = 'build-box-with-a-rather-long-name-of-its-own';
const [A, B, C, D] = ['a', 'b', 'c', 'd'].map(letter => letter.repeat(64)) as [string, string, string, string];
/* Three copies are up, one of them with a long name and one that never said how far it reaches. */
const QUESTION: Question = {
  since: '2026-11-12T14:02:30.000Z',
  leader: { networkId: A, host: 'rack-01', heard: '2026-11-12T14:02:00.000Z' },
  copies: [
    { networkId: B, host: 'ivan-studio', number: 2, reach: '2026-11-12T14:01:40.000Z', self: true },
    { networkId: C, host: LONG, number: 3, reach: '2026-11-12T14:01:00.000Z', self: false },
    { networkId: D, host: 'lab-nuc', number: null, reach: null, self: false },
  ],
  waiting: null,
};
const WORDS = {
  en: { title: 'The server stopped answering', wait: 'Wait for rack-01', last: 'Go on from the copy on lab-nuc', ceoOnly: 'Only the CEO answers this, from their own session.' },
  ru: { title: 'Сервер перестал отвечать', wait: 'Ждать rack-01', last: 'Продолжить с копии на lab-nuc', ceoOnly: 'Ответить может только CEO, из своей сессии.' },
};

async function openWith(page: Page, language: 'en' | 'ru', theme: 'light' | 'dark', canAnswer: boolean): Promise<void> {
  await serveApi(page);
  await page.addInitScript(({ language, theme }) => {
    localStorage.setItem('hh-lang', language);
    localStorage.setItem('hh-theme', theme);
  }, { language, theme });
  const org: Org = { company: ME.company, orchestrator: null, agents: { total: 0, working: 0 }, people: [], departments: [] };
  await page.route('**/api/org', route => route.fulfill({ json: org }));
  await page.route('**/api/network/question', route => route.fulfill({ json: { question: QUESTION, canAnswer } }));
  await page.goto('/');
}

/* Whether one box lies within another, to the pixel a browser may round by. */
async function within(inner: Locator, outer: Locator): Promise<boolean> {
  const [a, b] = [await box(inner), await box(outer)];
  return a.x >= b.x - 1 && a.x + a.width <= b.x + b.width + 1 && a.y >= b.y - 1 && a.y + a.height <= b.y + b.height + 1;
}
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

for (const language of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const [width, height] of SIZES) {
  const place = `${language} ${theme} ${width}`;
  const w = WORDS[language];

  test(`asks the CEO which copy to go on from, ${place}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await openWith(page, language, theme, true);
    const banner = page.getByRole('group', { name: w.title, exact: true });
    await expect(banner).toBeVisible();
    const buttons = banner.getByRole('button');
    await expect(buttons).toHaveCount(4);
    /* Every answer stands whole inside the banner, below its text, and nothing is cut. */
    const text = banner.locator('p').first();
    for (const button of await buttons.all()) {
      expect(await within(button, banner)).toBe(true);
      expect((await box(button)).y).toBeGreaterThanOrEqual((await box(text)).y + (await box(text)).height - 1);
      expect(await button.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    }
    await expect(banner.getByRole('button', { name: w.last, exact: true })).toBeVisible();
    await expect(banner.getByRole('button', { name: w.wait, exact: true })).toBeVisible();
    expect((await box(banner)).x).toBeGreaterThanOrEqual(0);
    expect((await box(banner)).x + (await box(banner)).width).toBeLessThanOrEqual(width + 1);
    expect(await noSideScroll(page)).toBe(true);
    await page.screenshot({ path: info.outputPath(`question-${language}-${theme}-${width}.png`), fullPage: true });
  });

  test(`shows the question without answers to anyone else, ${place}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openWith(page, language, theme, false);
    const banner = page.getByRole('group', { name: w.title, exact: true });
    await expect(banner.getByText(w.ceoOnly, { exact: true })).toBeVisible();
    await expect(banner.getByRole('button')).toHaveCount(0);
    expect(await noSideScroll(page)).toBe(true);
  });
}
