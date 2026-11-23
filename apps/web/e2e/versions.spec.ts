import { expect, test } from '@playwright/test';
import { serveApi } from './api';

const COMMIT = '84c8383' + 'a'.repeat(33);
const CURRENT = { version: '0.5.0', commit: COMMIT, migrations: 51 };
const BUILD = { ...CURRENT, tag: '0.5.0', created: '2026-11-03T10:00:00Z', title: 'Clearer work history' };
const UPDATES = { current: CURRENT, latest: BUILD, versions: [BUILD], available: false, checkedAt: '2026-11-03T10:00:00Z', error: null, updater: { present: true, status: null, waiting: null, calledOff: null } };

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

for (const language of ['en', 'ru']) for (const theme of ['light', 'dark']) for (const state of ['waiting', 'running', 'rolled_back', 'confirm']) {
  test(`Version states ${state} ${language} ${theme}`, async ({ page }, info) => {
    const problems: string[] = [];
    page.on('pageerror', error => problems.push(error.message));
    page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
    page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 400) problems.push(`${response.status()} ${response.url()}`); });
    const width = theme === 'light' ? 1280 : 375;
    await page.setViewportSize({ width, height: 900 });
    await serveApi(page);
    const target = { ...BUILD, version: '0.5.1', tag: '0.5.1', commit: 'b'.repeat(40), migrations: 52 };
    const old = { ...BUILD, version: '0.4.0', tag: '0.4.0', commit: 'c'.repeat(40), migrations: 50 };
    /* A running update stands at the step with the longest words. */
    const status = { id: 'update', version: target.version, commit: target.commit, state, step: state === 'running' ? 'promise' : 'backup', log: '', at: '2026-11-03T10:00:00Z' };
    /* An update that waits for the agents says for which turns and until when. */
    const waiting = { version: target.version, commit: target.commit, since: '2026-11-03T10:00:00Z', until: '2026-11-03T10:30:00Z', turns: [{ agent: 'Zed', task: 1051 }], lost: [] };
    const updater = { present: true, status: ['running', 'rolled_back'].includes(state) ? status : null, waiting: state === 'waiting' ? waiting : null, calledOff: null };
    await page.route('**/api/version', route => route.fulfill({ json: CURRENT }));
    await page.route('**/api/updates', route => route.fulfill({ json: { ...UPDATES, latest: target, versions: [target, BUILD, old], updater } }));
    await page.addInitScript(({ language, theme }) => {
      localStorage.setItem('hh-lang', language);
      localStorage.setItem('hh-theme', theme);
    }, { language, theme });
    await page.goto('/');
    const banner = page.getByRole('status', { name: language === 'en' ? 'Hornhoof update' : 'Обновление Hornhoof' });
    if (state !== 'confirm') await expect(banner).toContainText('0.5.1 (bbbbbbb)');
    await page.getByRole('button', { name: language === 'en' ? 'Account' : 'Аккаунт', exact: true }).click();
    await page.getByRole('button', { name: language === 'en' ? 'Versions' : 'Версии', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: language === 'en' ? 'Versions' : 'Версии' });
    if (state === 'confirm') {
      await dialog.getByRole('listitem').filter({ hasText: '0.4.0 (ccccccc)' }).getByRole('button', { name: language === 'en' ? 'Install' : 'Установить', exact: true }).click();
      const confirm = page.getByRole('alertdialog', { name: language === 'en' ? 'Do you really want to go back to this build?' : 'Вы действительно хотите вернуться к этой сборке?' });
      await expect(confirm).toContainText('0.4.0 (ccccccc)');
      await expect(confirm.getByRole('button', { name: language === 'en' ? 'Go back' : 'Вернуться', exact: true })).toBeVisible();
    }
    if (state === 'running') {
      await expect(dialog.getByText(`${language === 'en' ? 'Updating Hornhoof to' : 'Hornhoof обновляется до'} 0.5.1 (bbbbbbb)`, { exact: true })).toBeVisible();
      /* The bar of five steps and its words lie inside the dialog, the second step under way. */
      const bar = dialog.getByRole('progressbar');
      await expect(bar).toHaveAttribute('aria-valuetext', language === 'en' ? 'Step 2 of 5: asking the copies to wait' : 'Шаг 2 из 5: прошу копии подождать');
      await expect(bar.locator('i')).toHaveCount(5);
      const [inner, outer, words] = [await bar.boundingBox(), await dialog.boundingBox(), await dialog.locator('.uprog-text').boundingBox()];
      for (const one of [inner!, words!]) expect(one.x >= outer!.x - 1 && one.x + one.width <= outer!.x + outer!.width + 1).toBe(true);
    }
    if (state === 'rolled_back') {
      const result = language === 'en'
        ? 'The update to 0.5.1 (bbbbbbb) did not start. Hornhoof went back to 0.5.0 (84c8383).'
        : 'Версия 0.5.1 (bbbbbbb) не запустилась. Hornhoof вернулся к 0.5.0 (84c8383).';
      await expect(dialog.getByText(result, { exact: true })).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const active = state === 'confirm' ? page.getByRole('alertdialog').locator('.dialog') : dialog;
    expect(await active.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`versions-${state}-${language}-${theme}.png`), fullPage: true });
    expect(problems).toEqual([]);
  });
}
