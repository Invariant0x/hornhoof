import { expect, test } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { checkPage, open, shot, watchErrors } from './agent-window-steps';
import { serve } from './agent-window-writing-steps';

/* The owner of the plan types into an agent's terminal, with no line under it. */

for (const lang of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1440, 375]) {
  const settings = { lang, theme, width };
  const t = lang === 'en' ? en : ru;
  test.describe(`writing to an agent in ${lang}, ${theme}, at ${width}px`, () => {
    for (const agent of ['orchestrator', 'b1'] as const) {
      test(`the plan's owner types into the terminal of ${agent}, with no line under it`, async ({ page }, info) => {
        const errors = watchErrors(page);
        const sent = await serve(page, 'owner', settings);
        const window = await open(page, agent, lang);
        await expect(window.locator('.xterm-screen')).toBeVisible();
        await expect(window.getByRole('textbox', { name: agent === 'orchestrator' ? t.window.placeholder : t.window.writeTo('Bruno'), exact: true })).toHaveCount(0);
        await expect(window.locator('form.t-in')).toHaveCount(0);
        await window.locator('.xterm-screen').click();
        await page.keyboard.type('hi');
        await page.keyboard.press('Enter');
        await expect.poll(() => sent.keys.join('')).toBe('hi\r');
        expect(sent.messages).toEqual([]);
        await shot(page, info, `owner-${agent}`, settings);
        await checkPage(page, errors);
      });
    }
  });
}
