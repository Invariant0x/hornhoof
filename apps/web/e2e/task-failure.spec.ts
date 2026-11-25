import { emptyEchelonFindings } from '@hornhoof/protocol/echelons';
import type { TaskWaitFact } from '@hornhoof/protocol/waits';
import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { TaskDetail, TaskLine } from '../src/types';
import { openTaskCard, serveApi, streamEndedByPage, TASKS } from './api';

/* The failure card says what happened and what to do, in plain words, and fits the narrowest screen. */
const SINCE = '2026-11-23T10:42:00.000Z';
const FAILED: TaskWaitFact = { kind: 'work', who: null, since: SINCE, reason: '587', failure: 'run' };
const failing = (task: TaskLine): TaskLine => ({ ...task, time: { inStatusSince: SINCE, workSeconds: 0, waitsOn: [FAILED] } });

for (const language of ['en', 'ru'] as const) for (const theme of ['light', 'dark']) for (const width of [1440, 375]) {
  test(`failure card ${language} ${theme} ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(({ language, theme }) => {
      localStorage.setItem('hh-lang', language);
      localStorage.setItem('hh-theme', theme);
    }, { language, theme });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    /* The other screens ask for answers e2e/api.ts leaves out, which it answers 404 on purpose: the browser's line for each
       says no address. The two answers this card is drawn from must come whole. */
    page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text()); });
    page.on('response', response => {
      const { pathname, search } = new URL(response.url());
      if (!response.ok() && ['/api/tasks?status=all', '/api/tasks/t1'].includes(pathname + search)) errors.push(`${response.status()} ${pathname}${search}`);
    });
    page.on('requestfailed', request => { if (!streamEndedByPage(request)) errors.push(request.url()); });
    await serveApi(page);
    const line = failing(TASKS[0]!);
    await page.route('**/api/tasks?status=all', route => route.fulfill({ json: { tasks: [line, ...TASKS.slice(1)] } }));
    const detail: TaskDetail = { ...line, echelonFindings: emptyEchelonFindings(), body: 'Run the release check of the task.', parent: null, after: [], executor: line.assignee, createdBy: null, subtasks: [], requests: [], log: [] };
    await page.route('**/api/tasks/t1', route => route.fulfill({ json: { task: detail } }));
    await page.clock.setFixedTime(new Date('2026-11-23T11:00:00Z'));
    await page.goto('/');
    await page.getByRole('button', { name: language === 'en' ? /^Tasks/ : /^Задачи/ }).click();
    await openTaskCard(page, 1);
    const t = language === 'en' ? en : ru;
    const panel = page.getByRole('complementary', { name: '#1 Checkout step 1' });
    const step = panel.getByRole('list', { name: t.tasks.log }).getByRole('listitem').filter({ hasText: t.tracker.wait.failedRun('587', true) });
    await expect(step).toContainText(t.tracker.wait.todo.run);
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const name = `task-failure-${language}-${theme}-${width}.png`;
    await page.screenshot({ path: process.env.HH_OUT ? join(process.env.HH_OUT, name) : info.outputPath(name), fullPage: true });
    expect(errors).toEqual([]);
  });
}
