import { expect, test } from '@playwright/test';
import type { Me, PersonView } from '../src/types';
import { ME, serveApi } from './api';

test.describe.configure({ timeout: 0 });

const LISA: Me = {
  ...ME,
  person: { ...ME.person, name: 'Lisa', title: 'Designer', scopeKind: 'listed', isOwner: false },
};
const ACCESS = { whole: false, departments: [{ id: 'd2', name: 'Development' }], teams: [] };
const VIEW: PersonView = { ...LISA.person, access: ACCESS };

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      test(`self rename in ${lang}, ${theme}, at ${width}px`, async ({ page }, info) => {
        let person = VIEW;
        await serveApi(page);
        await page.addInitScript(({ lang, theme }) => {
          localStorage.setItem('hh-lang', lang);
          localStorage.setItem('hh-theme', theme);
        }, { lang, theme });
        await page.setViewportSize({ width, height: 900 });
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
        await page.route('**/api/version', route => route.fulfill({ json: { version: '0.6.1', commit: 'browser-test' } }));
        await page.route('**/api/me', route => route.fulfill({ json: LISA }));
        await page.route('**/api/people', route => route.fulfill({ json: { people: [person] } }));
        await page.route('**/api/people/p1', async route => {
          if (route.request().method() !== 'PATCH') return route.fallback();
          const body = route.request().postDataJSON() as { name: string };
          person = { ...person, name: body.name };
          await route.fulfill({ json: { person } });
        });
        await page.goto('/');
        await page.getByRole('button', { name: lang === 'en' ? 'People' : 'Люди' }).click();
        await expect(page.getByText('Lisa', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: lang === 'en' ? 'Account' : 'Аккаунт' }).click();
        await page.getByRole('button', { name: lang === 'en' ? 'Settings' : 'Настройки' }).click();
        const dialog = page.getByRole('dialog', { name: lang === 'en' ? 'Settings' : 'Настройки' });
        /* Settings opens on Profile, one's own name. */
        await expect(dialog.getByRole('button', { name: lang === 'en' ? 'Profile' : 'Профиль', exact: true })).toHaveAttribute('aria-current', 'page');
        const field = dialog.getByLabel(lang === 'en' ? 'Name' : 'Имя', { exact: true });
        await expect(field).toHaveValue('Lisa');
        await page.screenshot({ path: info.outputPath(`self-rename-field-${width}-${lang}-${theme}.png`) });
        await field.fill(lang === 'en' ? '  Lisa Ray  ' : '  Лиза Рей  ');
        await dialog.getByRole('button', { name: lang === 'en' ? 'Save' : 'Сохранить', exact: true }).click();
        await dialog.getByRole('button', { name: lang === 'en' ? 'Done' : 'Готово' }).click();
        await expect(page.getByText(lang === 'en' ? 'Lisa Ray' : 'Лиза Рей', { exact: true })).toBeVisible();
        await page.getByRole('button', { name: lang === 'en' ? 'Account' : 'Аккаунт' }).click();
        await expect(page.locator('.account-menu').getByText(lang === 'en' ? 'Lisa Ray' : 'Лиза Рей', { exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`self-rename-menu-${width}-${lang}-${theme}.png`) });
        expect(errors).toEqual([]);
      });
    }
  }
}
