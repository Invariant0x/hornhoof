import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { serveApi } from './api';

const COMMIT = '84c8383' + 'a'.repeat(33);
const CURRENT = { version: '0.5.0', commit: COMMIT, migrations: 51 };
const BUILD = { ...CURRENT, tag: '0.5.0', created: '2026-11-03T10:00:00Z', title: 'Clearer work history' };
const NEWER = { ...BUILD, version: '0.5.1', tag: 'latest', commit: 'b'.repeat(40), migrations: 52, title: 'Updater monitoring' };
const SILENT_SINCE = '2026-11-21T10:00:00.000Z';

const SILENT_UPDATES = {
  current: CURRENT,
  latest: NEWER,
  versions: [NEWER, BUILD],
  available: true,
  checkedAt: '2026-11-21T10:05:00.000Z',
  error: null,
  updater: { present: false, status: null, waiting: null, calledOff: null, silent: { since: SILENT_SINCE } },
};

const FRESH_UPDATES = {
  ...SILENT_UPDATES,
  updater: { present: true, status: null, waiting: null, calledOff: null },
};

const SHOT_DIR = process.env.E2E_SHOT_DIR || '';
const SHOT_PREFIX = process.env.E2E_SHOT_PREFIX || 'after';
const CAPTURE_BEFORE = SHOT_PREFIX === 'before';

for (const language of ['en', 'ru'] as const) for (const theme of ['cyberpunk', 'light'] as const) for (const width of [1440, 375] as const) {
  test(`Silent updater ${SHOT_PREFIX} ${language} ${theme} ${width}`, async ({ page }, info) => {
    const problems: string[] = [];
    page.on('pageerror', error => problems.push(error.message));
    page.on('console', message => { if (message.type() === 'error') problems.push(message.text()); });
    page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 400) problems.push(`${response.status()} ${response.url()}`); });

    await page.setViewportSize({ width, height: 900 });
    await serveApi(page);
    let view: typeof SILENT_UPDATES | typeof FRESH_UPDATES = SILENT_UPDATES;
    await page.route('**/api/version', route => route.fulfill({ json: CURRENT }));
    await page.route('**/api/updates', route => route.fulfill({ json: view }));
    await page.addInitScript(({ language, theme }) => {
      localStorage.setItem('hh-lang', language);
      localStorage.setItem('hh-theme', theme);
    }, { language, theme });

    await page.goto('/');
    await page.evaluate(async () => { await document.fonts.ready; });

    const banner = page.getByRole('status', { name: language === 'en' ? 'Hornhoof update' : 'Обновление Hornhoof' });
    await expect(banner).toBeVisible();

    if (CAPTURE_BEFORE) {
      await page.getByRole('button', { name: language === 'en' ? 'Account' : 'Аккаунт', exact: true }).click();
      await page.getByRole('button', { name: language === 'en' ? 'Versions' : 'Версии', exact: true }).click();
    } else {
      await expect(banner).toContainText(language === 'en' ? 'The updater has not answered since' : 'Служба обновления не отвечает с');
      await expect(banner.getByRole('button', { name: language === 'en' ? 'Update' : 'Обновить', exact: true })).toHaveCount(0);
      await banner.getByRole('button', { name: language === 'en' ? 'Details' : 'Подробнее', exact: true }).click();
    }

    const dialog = page.getByRole('dialog', { name: language === 'en' ? 'Versions' : 'Версии' });
    await expect(dialog).toBeVisible();
    if (!CAPTURE_BEFORE) {
      await expect(dialog.getByRole('status')).toContainText(
        language === 'en' ? 'Operations has been notified.' : 'Операции предупреждены.',
      );
      await expect(dialog.getByRole('button', { name: language === 'en' ? 'Install' : 'Установить', exact: true })).toHaveCount(0);
    }

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);

    const shotName = `${SHOT_PREFIX}-${language}-${theme}-${width}.png`;
    const shotPath = SHOT_DIR ? (mkdirSync(SHOT_DIR, { recursive: true }), join(SHOT_DIR, shotName)) : info.outputPath(shotName);
    await page.screenshot({ path: shotPath, fullPage: true });

    if (!CAPTURE_BEFORE && width === 1440 && theme === 'cyberpunk') {
      /* When the updater recovers, checking updates clears the silent status automatically and restores Install. */
      view = FRESH_UPDATES;
      await page.route('**/api/updates/check', route => route.fulfill({ json: view }));
      await dialog.getByRole('button', { name: language === 'en' ? 'Check now' : 'Проверить сейчас', exact: true }).click();
      await expect(dialog.getByRole('status')).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: language === 'en' ? 'Install' : 'Установить', exact: true })).toBeVisible();
    }

    expect(problems).toEqual([]);
  });
}
