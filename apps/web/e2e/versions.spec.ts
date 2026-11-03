import { expect, test } from '@playwright/test';
import { serveApi } from './api';

const COMMIT = '84c8383' + 'a'.repeat(33);
const CURRENT = { version: '0.5.0', commit: COMMIT, migrations: 51 };
const BUILD = { ...CURRENT, tag: '0.5.0', created: '2026-11-03T10:00:00Z', title: 'Clearer work history' };
const UPDATES = { current: CURRENT, latest: BUILD, versions: [BUILD], available: false, checkedAt: '2026-11-03T10:00:00Z', error: null, updater: { present: true, status: null, waiting: null } };

for (const language of ['en', 'ru']) for (const theme of ['light', 'dark']) for (const width of [1280, 375]) {
  test(`Versions ${language} ${theme} ${width}`, async ({ page }, info) => {
    const problems: string[] = [];
    page.on('pageerror', error => problems.push(error.message));
    page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
    page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 400) problems.push(`${response.status()} ${response.url()}`); });
    await page.setViewportSize({ width, height: 900 });
    await serveApi(page);
    await page.route('**/api/version', route => route.fulfill({ json: CURRENT }));
    await page.route('**/api/updates', route => route.fulfill({ json: UPDATES }));
    await page.addInitScript(({ language, theme }) => {
      localStorage.setItem('hh-lang', language);
      localStorage.setItem('hh-theme', theme);
    }, { language, theme });
    await page.goto('/');
    const account = page.getByRole('button', { name: language === 'en' ? 'Account' : 'Аккаунт', exact: true });
    await account.click();
    await expect(page.getByText(`${language === 'en' ? 'Version' : 'Версия'} 0.5.0 (84c8383)`, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: language === 'en' ? 'Versions' : 'Версии', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: language === 'en' ? 'Versions' : 'Версии' });
    await expect(dialog.getByText(`${language === 'en' ? 'Running now:' : 'Сейчас работает:'} 0.5.0 (84c8383)`, { exact: true })).toBeVisible();
    await expect(dialog.getByRole('listitem').getByText('0.5.0 (84c8383)', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('listitem')).toContainText(language === 'en' ? 'Running now' : 'Работает сейчас');
    await page.evaluate(async () => { await document.fonts.ready; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`versions-${language}-${theme}-${width}.png`), fullPage: true });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(problems).toEqual([]);
  });
}
