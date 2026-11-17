import { expect, test } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { SUB } from './agent-window-api';
import { checkPage, shot, watchErrors } from './agent-window-steps';
import { serve } from './agent-window-writing-steps';

/* A person with a department is not offered the orchestrator nor an employee of another department. */

for (const lang of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1440, 375]) {
  const settings = { lang, theme, width };
  const t = lang === 'en' ? en : ru;
  test.describe(`writing to an agent in ${lang}, ${theme}, at ${width}px`, () => {
    test('a person with the department is not offered the orchestrator', async ({ page }, info) => {
      const errors = watchErrors(page);
      await serve(page, 'department', settings);
      await page.goto('/');
      await expect(page.locator('.hub')).toBeVisible();
      await expect(page.getByRole('button', { name: t.map.openOrchestrator, exact: true })).toHaveCount(0);
      await expect(page.getByRole('complementary', { name: t.window.title })).toHaveCount(0);
      await expect(page.locator('form.t-in')).toHaveCount(0);
      await shot(page, info, 'department-orchestrator', settings);
      await checkPage(page, errors);
    });

    test('a person is turned away from an employee of another department, with no line', async ({ page }, info) => {
      await serve(page, 'department', settings);
      await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [{ ...SUB, agents: [{ id: 's1', canOpen: true, name: 'Sam', title: { en: 'Seller', ru: 'Продавец' }, department: { id: 'd3', name: 'Sales' }, provider: 'codex', busy: true, since: null, task: null, withCeo: false }] }] } }));
      await page.goto('/');
      await page.getByRole('navigation', { name: lang === 'en' ? 'Sections' : 'Разделы' }).getByRole('button', { name: t.shell.tabs.subscriptions, exact: true }).click();
      await page.getByRole('button', { name: new RegExp(`${lang === 'en' ? 'Open the card of' : 'Открыть карточку'}.*Codex`) }).click();
      await page.getByRole('button', { name: t.window.openAgent('Sam'), exact: true }).click();
      await expect(page.getByRole('heading', { name: t.routes.accessDenied })).toBeVisible();
      await expect(page.locator('form.t-in')).toHaveCount(0);
      await expect(page.locator('.xterm-screen')).toHaveCount(0);
      await shot(page, info, 'department-other-employee', settings);
    });
  });
}
