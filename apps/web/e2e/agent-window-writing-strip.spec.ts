import { expect, test } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { box } from './api';
import { checkPage, open, shot, watchErrors } from './agent-window-steps';
import { STANDING, checkWrites, serve } from './agent-window-writing-steps';

/* Standing access is a note under the terminal that leads to Machines, and a
   department alone that opens no employee on another plan. */

for (const lang of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1440, 375]) {
  const settings = { lang, theme, width };
  const t = lang === 'en' ? en : ru;
  test.describe(`writing to an agent in ${lang}, ${theme}, at ${width}px`, () => {
    test('standing access is a note under the terminal, inside the window, with no buttons of access', async ({ page }, info) => {
      const errors = watchErrors(page);
      const sent = await serve(page, 'delegate', settings);
      await page.route('**/api/machines/access', route => route.fulfill({ json: { views: [STANDING] } }));
      const window = await open(page, 'orchestrator', lang);
      const note = window.getByText(t.window.computerStanding(STANDING.machine.hostname));
      await expect(note).toBeVisible();
      await expect(window.getByRole('button', { name: t.window.computerClose, exact: true })).toHaveCount(0);
      await expect(window.getByRole('link', { name: t.window.notes.manage, exact: true })).toBeVisible();
      const below = await box(note);
      const terminal = await box(window.locator('.t-term'));
      const frame = await box(window);
      expect(terminal.y + terminal.height).toBeLessThanOrEqual(below.y);
      expect(below.y + below.height).toBeLessThanOrEqual(frame.y + frame.height);
      expect(terminal.height).toBeGreaterThan(200);
      await checkWrites(page, window, 'orchestrator', settings, sent);
      await shot(page, info, 'delegate-orchestrator-access-note', settings);
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
