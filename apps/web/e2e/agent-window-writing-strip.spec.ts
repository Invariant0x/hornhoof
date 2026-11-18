import { expect, test } from '@playwright/test';
import { box } from './api';
import { checkPage, open, shot, watchErrors } from './agent-window-steps';
import { checkWrites, serve } from './agent-window-writing-steps';

/* A CEO delegate writes in the terminal. A department alone opens no employee on another plan. */

for (const lang of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1440, 375]) {
  const settings = { lang, theme, width };
  test.describe(`writing to an agent in ${lang}, ${theme}, at ${width}px`, () => {
    test('the CEO delegate writes in the terminal', async ({ page }, info) => {
      const errors = watchErrors(page);
      const sent = await serve(page, 'delegate', settings);
      const window = await open(page, 'orchestrator', lang);
      await checkWrites(page, window, 'orchestrator', settings, sent);
      expect((await box(window.locator('.t-term'))).height).toBeGreaterThan(200);
      await shot(page, info, 'delegate-orchestrator-terminal', settings);
      await checkPage(page, errors);
    });

    test('a department alone does not let a person open an employee on another plan', async ({ page }, info) => {
      const errors = watchErrors(page);
      const sent = await serve(page, 'department', settings);
      await page.goto('/departments/d2');
      await expect(page.getByRole('region', { name: lang === 'en' ? 'Members' : 'Сотрудники' })).not.toContainText('Bruno');
      await expect(page.locator('body')).not.toContainText('Bruno');
      await expect(page.getByRole('button', { name: /Bruno/ })).toHaveCount(0);
      await expect(page.getByRole('complementary', { name: /Bruno/ })).toHaveCount(0);
      await expect(page.locator('.xterm-screen')).toHaveCount(0);
      await expect(page.locator('form.t-in')).toHaveCount(0);
      expect(sent.keys).toEqual([]);
      expect(sent.messages).toEqual([]);
      await shot(page, info, 'department-b1', settings);
      await checkPage(page, errors);
    });
  });
}
