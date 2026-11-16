import { expect, test } from '@playwright/test';
import { en } from '../src/i18n/en';
import { checkPage, open, shot, watchErrors } from './agent-window-steps';
import { checkWrites, serve } from './agent-window-writing-steps';

/* The CEO delegate writes to an agent in its terminal, and the line of the chat keeps its draft beside it. */

for (const lang of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1440, 375]) {
  const settings = { lang, theme, width };
  test.describe(`writing to an agent in ${lang}, ${theme}, at ${width}px`, () => {
    for (const agent of ['orchestrator', 'b1'] as const) {
      test(`the CEO delegate writes to ${agent} in its terminal`, async ({ page }, info) => {
        const errors = watchErrors(page);
        const sent = await serve(page, 'delegate', settings);
        const window = await open(page, agent, lang);
        await checkWrites(page, window, agent, settings, sent);
        await shot(page, info, `delegate-${agent}`, settings);
        await checkPage(page, errors);
      });
    }
  });
}

test('the line of the chat keeps its draft while the person looks at the terminal, which has no line', async ({ page }) => {
  const settings = { lang: 'en', theme: 'light', width: 1440 } as const;
  const errors = watchErrors(page);
  await serve(page, 'delegate', settings);
  const window = await open(page, 'orchestrator', 'en');
  const line = window.getByRole('textbox', { name: en.window.placeholder, exact: true });
  await window.getByRole('button', { name: en.window.showChat, exact: true }).click();
  await expect(window.getByRole('log')).toBeVisible();
  await line.fill('A draft');
  await window.getByRole('button', { name: en.window.showTerminal, exact: true }).click();
  await expect(window.locator('.xterm-screen')).toBeVisible();
  await expect(line).toHaveCount(0);
  await window.getByRole('button', { name: en.window.showChat, exact: true }).click();
  await expect(line).toHaveValue('A draft');
  await checkPage(page, errors);
});
