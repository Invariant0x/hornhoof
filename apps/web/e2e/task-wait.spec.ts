import { emptyEchelonFindings } from '@hornhoof/protocol/echelons';
import { expect, test } from '@playwright/test';
import type { ExternalWait, TaskDetail } from '../src/types';
import { openTaskCard, serveApi, streamEndedByPage, TASKS } from './api';

for (const language of ['en', 'ru'] as const) for (const theme of ['light', 'dark']) for (const width of [1440, 375]) {
  test(`named task wait ${language} ${theme} ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(({ language, theme }) => {
      localStorage.setItem('hh-lang', language);
      localStorage.setItem('hh-theme', theme);
    }, { language, theme });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('requestfailed', request => { if (!streamEndedByPage(request)) errors.push(request.url()); });
    await serveApi(page);
    await page.route('**/api/version', route => route.fulfill({ json: { version: '0.6.1', commit: 'task-241' } }));
    await page.route('**/api/updates', route => route.fulfill({ json: { current: { version: '0.6.1', commit: 'task-241' }, available: false, latest: null, updater: { status: null, waiting: null } } }));
    const employee = 'Hana with a long employee name for acceptance';
    let wait: ExternalWait | null = { reason: 'Acceptance on node-a', since: '2026-11-04T16:00:00Z', until: '2026-11-04T16:30:00Z', on: { kind: 'employee', employee: 'head', name: employee } };
    const detail = (): TaskDetail => ({ ...TASKS[0]!, echelonFindings: emptyEchelonFindings(), body: 'Check acceptance and submit the work.', parent: null, after: [], executor: TASKS[0]!.assignee, createdBy: null, subtasks: [], requests: [], log: [], externalWait: wait });
    await page.route('**/api/tasks/t1', route => route.fulfill({ json: { task: detail() } }));
    await page.route('**/api/tasks/t1/comments', route => {
      wait = null;
      return route.fulfill({ status: 201, json: { task: detail() } });
    });
    /* The page's clock stands inside the wait, so the wait is still running: past its end the card says time ran out. */
    await page.clock.setFixedTime(new Date('2026-11-04T16:10:00Z'));
    await page.goto('/');
    await page.getByRole('button', { name: language === 'en' ? /^Tasks/ : /^Задачи/ }).click();
    await openTaskCard(page, 1);
    const panel = page.getByRole('complementary', { name: '#1 Checkout step 1' });
    const text = panel.getByText('Acceptance on node-a');
    await expect(text).toContainText(employee);
    await expect(panel.getByText(language === 'en' ? 'set by Bruno, until 16:30' : 'ожидание поставил Bruno, до 16:30', { exact: true })).toBeVisible();
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`task-wait-${language}-${theme}-${width}.png`), fullPage: true });
    await panel.getByLabel(language === 'en' ? 'Comment' : 'Комментарий', { exact: true }).fill('Acceptance is available.');
    await panel.getByRole('button', { name: language === 'en' ? 'Add comment' : 'Добавить комментарий', exact: true }).click();
    await expect(text).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
