import { expect, test, type Locator, type Page } from '@playwright/test';
import { en, type Messages } from '../../src/i18n/en';
import { ru } from '../../src/i18n/ru';
import { captureWith } from '../capture';
import { ONE_DEPARTMENT, serveTasksTable } from './api';

/* The Tasks screen of one department: a table by turn whose rows open to their details and subtasks, a choice of the
   departments the person has, and the department's list for later turns, put in order by dragging a row or by its
   buttons, and put into the next turn. Shots of each look go to HH_SCREENSHOT_DIR when it is set. */

const MESSAGES: Record<'en' | 'ru', Messages> = { en, ru };
const capture = captureWith('tasks-table', process.env.HH_SCREENSHOT_DIR);

async function open(page: Page, lang: 'en' | 'ru', width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(language => localStorage.setItem('hh-lang', language), lang);
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { level: 1, name: MESSAGES[lang].tasks.heading })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}
const row = (page: Page, name: string) => page.getByRole('row', { name, exact: true });
const list = (page: Page, t: Messages) => page.getByRole('table', { name: t.backlog.heading });
const titles = (table: Locator) => table.locator('tbody tr.bl-row').evaluateAll(rows => rows.map(r => r.getAttribute('aria-label')));
/* What the page asked for, a request repeated at once counted once. */
const asked = (reads: string[]) => reads.filter((x, i) => x !== reads[i - 1]);
const sideways = (page: Page) => page.getByRole('main').evaluate(el => el.scrollWidth - el.clientWidth);

for (const lang of ['en', 'ru'] as const) {
  test(`picks a department, opens a row with its subtasks, drags the list into order and puts items into the next turn: ${lang}`, async ({ page }, info) => {
    const t = MESSAGES[lang];
    const served = await serveTasksTable(page);
    await open(page, lang, 1440);

    /* Development first, by turn: the running and the planned turn with their tasks, the finished one folded. */
    const choice = page.getByRole('group', { name: t.tasks.department });
    await expect(choice.getByRole('radio')).toHaveCount(3);
    await expect(page.getByRole('radio', { name: 'Development' })).toBeChecked();
    const current = page.getByRole('table', { name: t.tasks.table.current });
    await expect(current.getByRole('row', { name: /^#\d+ / })).toHaveText([/#1 Take card payments/, /#4 Refunds/, /#5 Receipts by email/]);
    await expect(current.locator('tr.grp', { hasText: t.tasks.turn(4) })).toContainText(t.tasks.plannedTasks(1));
    await expect(current.locator('tr.grp', { hasText: t.tasks.turn(3) }).getByRole('progressbar', { name: t.tasks.turnProgress(1, 5) })).toBeVisible();
    await expect(row(page, '#6 Old checkout')).toHaveCount(0);
    await capture(page, info, `turns-${lang}`);
    await page.getByRole('table', { name: t.tasks.table.finished }).getByRole('button', { name: new RegExp(t.tasks.turn(2)) }).click();
    await expect(row(page, '#6 Old checkout')).toBeVisible();

    /* A row opens to its brief and the work under it, two levels deep; a subtask opens in the panel. */
    await row(page, '#1 Take card payments').getByRole('button').click();
    const details = row(page, '#1 Take card payments').locator('xpath=following-sibling::tr[1]');
    await expect(details).toContainText('Take card payments: what the department does and how it is checked.');
    const subtasks = details.getByRole('region', { name: t.tasks.subtasks });
    await expect(subtasks.getByRole('button', { name: /^#2 Card form/ })).toBeVisible();
    await expect(subtasks.getByRole('button', { name: /^#3 Bank answers/ })).toBeVisible();
    await capture(page, info, `row-open-${lang}`);
    await subtasks.getByRole('button', { name: /^#2 Card form/ }).click();
    await expect(page).toHaveURL(/\/tasks\/t2$/);
    await expect(page.getByRole('complementary', { name: '#2 Card form' })).toBeVisible();
    await page.keyboard.press('Escape');

    /* Another department shows only its own tasks and list. */
    await choice.locator('label', { hasText: 'Sales' }).click();
    await expect(row(page, '#7 Call the shop owners back')).toBeVisible();
    await expect(row(page, '#1 Take card payments')).toHaveCount(0);
    await expect(page.getByText(t.backlog.empty)).toBeVisible();
    await capture(page, info, `department-${lang}`);
    await choice.locator('label', { hasText: 'Development' }).click();
    expect(asked(served.reads)).toEqual(['d2', 'd3', 'd2']);

    /* The last item is dragged above the first: the list goes to the server in its new order. */
    const items = list(page, t);
    await expect.poll(() => titles(items)).toEqual(['Gift cards', 'Pay in parts', 'Price list']);
    await items.getByRole('row', { name: 'Price list', exact: true }).locator('.bl-grip').hover();
    const target = await items.getByRole('row', { name: 'Gift cards', exact: true }).boundingBox();
    await page.mouse.down();
    await page.mouse.move(target!.x + target!.width / 2, target!.y + 6, { steps: 4 });
    await expect(items.locator('tr.dragging')).toHaveAttribute('aria-label', 'Price list');
    await expect(items.locator('tr.drop-before')).toHaveAttribute('aria-label', 'Gift cards');
    await capture(page, info, `dragging-${lang}`);
    await page.mouse.up();
    await expect.poll(() => titles(items)).toEqual(['Price list', 'Gift cards', 'Pay in parts']);
    expect(served.calls.at(-1)).toEqual({ method: 'PUT', path: '/api/departments/d2/backlog/order', body: { ids: ['i3', 'i1', 'i2'] } });

    /* A new item goes to the end; the chosen ones go into the next turn and leave the list. */
    await page.getByRole('button', { name: t.backlog.add, exact: true }).click();
    await page.getByLabel(t.common.title, { exact: true }).fill('Delivery dates');
    await page.getByLabel(t.backlog.text, { exact: true }).fill('Show when the parcel comes.');
    await page.getByRole('button', { name: t.backlog.save, exact: true }).click();
    await expect.poll(() => titles(items)).toEqual(['Price list', 'Gift cards', 'Pay in parts', 'Delivery dates']);
    expect(served.calls.at(-1)).toEqual({ method: 'POST', path: '/api/departments/d2/backlog', body: { title: 'Delivery dates', text: 'Show when the parcel comes.' } });
    await page.getByRole('checkbox', { name: t.backlog.choose('Delivery dates') }).check();
    await page.getByRole('checkbox', { name: t.backlog.choose('Price list') }).check();
    await page.getByRole('button', { name: t.backlog.schedule(2), exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: t.backlog.scheduled(4, '#31, #32') })).toBeVisible();
    await expect.poll(() => titles(items)).toEqual(['Gift cards', 'Pay in parts']);
    expect(served.calls.at(-1)).toEqual({ method: 'POST', path: '/api/departments/d2/backlog/schedule', body: { ids: ['i3', 'i4'] } });
    await capture(page, info, `scheduled-${lang}`);

    /* Removing an item asks the server to take it out. */
    await page.getByRole('button', { name: t.backlog.removeLabel('Pay in parts'), exact: true }).click();
    await expect.poll(() => titles(items)).toEqual(['Gift cards']);
    expect(served.calls.at(-1)).toEqual({ method: 'DELETE', path: '/api/departments/d2/backlog/i2', body: null });
    expect(await sideways(page)).toBeLessThanOrEqual(0);
  });

  test(`someone with one department sees only it, and on a 375 px phone moves items with Up and Down: ${lang}`, async ({ page }, info) => {
    const t = MESSAGES[lang];
    const served = await serveTasksTable(page, ONE_DEPARTMENT);
    await open(page, lang, 1440);
    await expect(page.locator('.dept-one')).toHaveText(`${t.tasks.department} Development`);
    await expect(page.getByRole('radio')).toHaveCount(0);
    await expect(row(page, '#1 Take card payments')).toBeVisible();
    await capture(page, info, `one-department-${lang}`);

    await page.setViewportSize({ width: 375, height: 812 });
    const items = list(page, t);
    await expect.poll(() => titles(items)).toEqual(['Gift cards', 'Pay in parts', 'Price list']);
    await page.getByRole('button', { name: t.backlog.down('Gift cards'), exact: true }).click();
    await expect.poll(() => titles(items)).toEqual(['Pay in parts', 'Gift cards', 'Price list']);
    expect(served.calls.at(-1)?.body).toEqual({ ids: ['i2', 'i1', 'i3'] });
    await page.getByRole('button', { name: t.backlog.up('Price list'), exact: true }).click();
    await expect.poll(() => titles(items)).toEqual(['Pay in parts', 'Price list', 'Gift cards']);
    expect(served.calls.at(-1)?.body).toEqual({ ids: ['i2', 'i3', 'i1'] });
    await expect(page.getByRole('button', { name: t.backlog.up('Pay in parts'), exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: t.backlog.down('Gift cards'), exact: true })).toBeDisabled();
    expect(await sideways(page)).toBeLessThanOrEqual(0);
    await items.scrollIntoViewIfNeeded();
    await capture(page, info, `phone-${lang}`);
    expect(asked(served.reads)).toEqual(['d2']);
  });
}
