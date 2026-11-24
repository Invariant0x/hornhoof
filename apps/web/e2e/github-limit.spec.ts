import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { LANGUAGES } from '../src/i18n';
import { DICTIONARIES } from '../src/i18n/dictionaries';
import { serveApi } from './api';
import { taskStream } from './hub-turn-api';

const repository = `${'a'.repeat(39)}/${'b'.repeat(100)}`;
const resetAt = Date.UTC(2030, 0, 1, 23, 45);
const languages = LANGUAGES.map(({ id }) => {
  const { githubLimit, githubLimitRetry } = DICTIONARIES[id].tasks;
  return { id, length: githubLimit(repository).length + githubLimitRetry('23:45').length };
}).sort((a, b) => a.length - b.length);
const extremes = new Set([languages[0]!.id, languages.at(-1)!.id]);

for (const language of extremes) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [375, 1280]) {
      test(`shows a GitHub limit in Failures in ${language} ${theme} ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(({ language, theme }) => {
          localStorage.setItem('hh-lang', language);
          localStorage.setItem('hh-theme', theme);
        }, { language, theme });
        await taskStream(page);
        await serveApi(page);
        await page.route('**/api/requests', route => route.fulfill({ json: {
          requests: [], proposals: [], counts: { byPerson: {}, byAgent: {}, total: 0 },
          githubLimits: [{ repository, resetAt }],
        } }));
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('/tasks?show=failures');
        const words = DICTIONARIES[language].tasks;
        const card = page.getByRole('region', { name: words.githubLimit(repository) });
        await expect(card).toContainText(words.githubLimitRetry('23:45'));
        expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        expect(errors).toEqual([]);
        const name = `github-limit-${language}-${theme}-${width}.png`;
        await card.screenshot({ path: process.env.HH_OUT ? join(process.env.HH_OUT, name) : info.outputPath(name) });
      });
    }
  }
}
