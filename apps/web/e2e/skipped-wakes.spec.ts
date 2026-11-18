import { emptyEchelonFindings } from '@hornhoof/protocol/echelons';
import { expect, test } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { openTaskAction, openTaskCard, serveApi, TASKS } from './api';

for (const language of ['en', 'ru']) {
  for (const theme of ['light', 'dark']) {
    for (const width of [1280, 375]) {
      test(`closed task log ${language} ${theme} ${width}`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(({ language, theme }) => {
          localStorage.setItem('hh-lang', language);
          localStorage.setItem('hh-theme', theme);
        }, { language, theme });
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        page.on('requestfailed', request => errors.push(request.url()));
        await serveApi(page);
        const current = { version: '0.5.0', commit: 'a'.repeat(40), migrations: 51 };
        await page.route('**/api/version', route => route.fulfill({ json: current }));
        await page.route('**/api/updates', route => route.fulfill({ json: { current, latest: null, versions: [], available: false, checkedAt: null, error: null, updater: { present: false, status: null, waiting: null } } }));
        const task = {
          ...TASKS[0]!, echelonFindings: emptyEchelonFindings(), status: 'done', body: '', after: [], parent: null, subtasks: [], requests: [], createdBy: null, executor: null,
          log: ['restart', 'merge', 'continue', 'assigned'].map(wake => ({
            kind: 'wake_skipped', text: 'Server text stays in English.', data: { wake, job: 'aaaaaaaa-0000-4000-8000-000000000001' },
            by: { kind: 'agent', id: 'b1', name: 'Bruno with a long employee name' }, at: '2026-11-03T21:00:00.000Z',
          })),
        };
        await page.route('**/api/tasks/t1', route => route.fulfill({ json: { task } }));
        await page.goto('/');
        await page.getByRole('button', { name: /^(Tasks|Задачи)/ }).click();
        await openTaskCard(page, 1);
        const panel = page.getByRole('complementary', { name: '#1 Checkout step 1' });
        const t = language === 'ru' ? ru : en;
        await openTaskAction(panel, t, t.tasks.fullLog);
        const log = panel.getByRole('list', { name: t.tasks.fullLog });
        await expect(log.getByRole('listitem')).toHaveCount(4);
        await expect(log).toContainText(language === 'ru' ? 'Запуск пропущен: задача уже закрыта.' : 'Run skipped: task is already closed.');
        await expect(log).toContainText(language === 'ru' ? 'возобновление после перезапуска' : 'resume after a restart');
        await expect(log).toContainText(language === 'ru' ? 'слияние' : 'merge');
        await expect(log).not.toContainText('Server text');
        expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
        await page.screenshot({ path: info.outputPath(`skipped-${language}-${theme}-${width}.png`), fullPage: true });
      });
    }
  }
}
