import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { NoteView } from '../src/types';
import { openAgent } from './agent-window-panels-api';
import { serveApi, TASKS } from './api';

const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };
const PHASE = process.env.HH_PANEL_PHASE ?? 'after';
const SCREENSHOT_DIR = process.env.HH_SCREENSHOT_DIR;
const LONG_URL = `https://example.invalid/reports/${'Evidence'.repeat(20)}`;
const LONG_TEXT = `Keep the full delivery report at ${LONG_URL}`;
const NOTES: NoteView[] = [
  { number: 1, text: LONG_TEXT, by: { kind: 'person', id: 'p-long', name: 'Alexandria Example Long Display Name' }, updatedAt: '2026-11-04T00:00:00.000Z' },
  { number: 2, text: 'Short note.', by: { kind: 'orchestrator' }, updatedAt: '2026-11-04T00:00:00.000Z' },
];

test.use({ hasTouch: true });

async function capture(page: Page, info: TestInfo, name: string) {
  const file = `${PHASE}-${name}.png`;
  const path = SCREENSHOT_DIR ? `${SCREENSHOT_DIR}/${file}` : info.outputPath(file);
  await page.screenshot({ path });
  await info.attach(file, { path, contentType: 'image/png' });
}

async function expectInside(container: Locator, elements: Locator[]) {
  const outer = await container.boundingBox();
  expect(outer).not.toBeNull();
  for (const element of elements) {
    const rect = await element.boundingBox();
    expect(rect, 'the measured element is visible').not.toBeNull();
    expect(rect!.x, 'left edge stays inside').toBeGreaterThanOrEqual(outer!.x - 1);
    expect(rect!.x + rect!.width, 'right edge stays inside').toBeLessThanOrEqual(outer!.x + outer!.width + 1);
  }
}

async function expectWrappedText(element: Locator) {
  await expect(element).toHaveCSS('white-space', 'normal');
  await expect(element).toHaveCSS('overflow-wrap', 'anywhere');
  expect(await element.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
}

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      for (const panel of ['narrow', 'wide'] as const) {
        const look = `${lang}-${theme}-${width}-${panel}`;
        test(`Notebook content and its whole action group fit: ${look}`, async ({ page }, info) => {
          const m = MESSAGES[lang];
          const { errors, openPanel, window } = await openAgent(page, { lang, theme, width }, 'orchestrator');
          const panelWidth = panel === 'narrow' ? 280 : width === 375 ? 375 : 640;
          await window.evaluate((el, value) => el.style.setProperty('--panel-width', `${value}px`), panelWidth);
          const removed: string[] = [];
          await page.route('**/api/notebook', route => route.fulfill({ json: { notes: NOTES } }));
          await page.route('**/api/notebook/1', route => {
            if (route.request().method() !== 'DELETE') return route.fallback();
            removed.push(route.request().url());
            return route.fulfill({ status: 204 });
          });
          const notebook = await openPanel('notebook');
          const body = notebook.locator('.ac-body');
          const list = notebook.locator('.notebook ul');
          await expect(list).toBeVisible();
          await capture(page, info, `notebook-${look}`);
          const first = list.locator('li').nth(0);
          const second = list.locator('li').nth(1);
          const text = first.locator(':scope > span');
          const change = first.getByRole('button', { name: m.notebook.changeNote(1), exact: true });
          const remove = first.getByRole('button', { name: m.notebook.removeNote(1), exact: true });
          await expectInside(body, [notebook.locator('.notebook'), first, text, change, remove]);
          await expectWrappedText(text);
          const textBox = (await text.boundingBox())!;
          const changeBox = (await change.boundingBox())!;
          const removeBox = (await remove.boundingBox())!;
          expect(changeBox.y, 'the action group starts below the full note').toBeGreaterThanOrEqual(textBox.y + textBox.height - 1);
          expect(removeBox.y, 'actions share one row').toBe(changeBox.y);
          expect(removeBox.x).toBeGreaterThan(changeBox.x);
          const secondChangeBox = (await second.getByRole('button', { name: m.notebook.changeNote(2), exact: true }).boundingBox())!;
          expect(changeBox.x, 'all action groups use one edge').toBe(secondChangeBox.x);

          await change.click();
          await expect(notebook.getByRole('textbox', { name: m.notebook.note(1), exact: true })).toBeVisible();
          await notebook.getByRole('button', { name: m.notebook.cancel, exact: true }).click();
          await change.focus();
          await page.keyboard.press('Enter');
          await expect(notebook.getByRole('textbox', { name: m.notebook.note(1), exact: true })).toBeVisible();
          await notebook.getByRole('button', { name: m.notebook.cancel, exact: true }).click();
          if (width === 375) {
            await change.tap();
            await expect(notebook.getByRole('textbox', { name: m.notebook.note(1), exact: true })).toBeVisible();
            await notebook.getByRole('button', { name: m.notebook.cancel, exact: true }).tap();
          }
          await remove.click();
          await expect.poll(() => removed.length).toBe(1);
          expect(errors).toEqual([]);
        });
      }

      const look = `${lang}-${theme}-${width}`;
      test(`Task text wraps without clipping and still opens: ${look}`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(({ lang, theme }) => {
          localStorage.setItem('hh-lang', lang);
          localStorage.setItem('hh-theme', theme);
        }, { lang, theme });
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
        const task = { ...TASKS[0]!, brief: LONG_TEXT };
        await serveApi(page);
        const current = { version: '0.7.0', commit: 'panel-overflow-test' };
        await page.route('**/api/version', route => route.fulfill({ json: current }));
        await page.route('**/api/updates', route => route.fulfill({ json: { current, available: false, latest: null, updater: { status: null, waiting: null } } }));
        await page.route('**/api/tasks?status=all', route => route.fulfill({ json: { tasks: [task, ...TASKS.slice(1)] } }));
        await page.route('**/api/tasks/t1', route => route.fulfill({ json: { task: { ...task, body: LONG_TEXT, parent: null, after: [], executor: task.assignee, gates: [], createdBy: null, subtasks: [], log: [], requests: [] } } }));
        await page.goto('/tasks');
        const row = page.locator('button.trow').first();
        const brief = row.locator('.trow-brief');
        await expect(brief).toBeVisible();
        await capture(page, info, `tasks-${look}`);
        await expectWrappedText(brief);
        await expectInside(row, [brief]);
        await row.click();
        const detail = page.getByRole('complementary', { name: /#1 Checkout step 1/ });
        await expect(detail.locator('.tp-brief')).toHaveText(LONG_TEXT);
        await capture(page, info, `task-detail-${look}`);
        await expectWrappedText(detail.locator('.tp-brief'));
        await expectInside(detail.locator('.ac-body'), [detail.locator('.tp-brief')]);
        expect(errors).toEqual([]);
      });
    }
  }
}
