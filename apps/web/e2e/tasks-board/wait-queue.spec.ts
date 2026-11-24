import { expect, test, type Locator, type Page } from '@playwright/test';
import { LANGUAGES, type ShippedLanguage } from '../../src/i18n';
import { DICTIONARIES } from '../../src/i18n/dictionaries';
import type { WaitingRequest } from '../../src/types';
import { captureWith } from '../capture';
import { MAX_QUESTION, QUESTION, servePeopleWaits, serveTasksBoard, TASKS } from './api';

const capture = captureWith('wait-queue', process.env.HH_SCREENSHOT_DIR);
const LONG_QUESTION = 'Какой текст показать покупателю перед подтверждением заказа, если адрес доставки изменился, а новый срок доставки пока неизвестен?';
const LAST_QUESTION = 'Can we send the receipts on Monday?';
const PREVIEW = 'https://acme.test/checkout-preview';

async function openQueue(page: Page, lang: ShippedLanguage, skin: string, width: number, rtl: boolean) {
  await page.setViewportSize({ width, height: width === 375 ? 1260 : 1100 });
  await page.addInitScript(({ lang, skin, rtl }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', skin);
    if (rtl) document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = 'rtl'; });
  }, { lang, skin, rtl });
  await serveTasksBoard(page);
  const base = await servePeopleWaits(page);
  const first = base.requests.find(request => request.text === QUESTION)!;
  const addition = (id: string, title: string, text: string, extra: Partial<WaitingRequest> = {}): WaitingRequest => {
    const task = TASKS.find(task => task.title === title)!;
    return { ...first, id, task: { id: task.id, number: task.number, title: task.title, department: task.department }, text, ...extra };
  };
  const requests = [
    { ...first, link: PREVIEW },
    addition('long', 'Delivery dates', LONG_QUESTION),
    addition('stuck', 'Gift cards', 'A task is stuck.', { kind: 'stuck' }),
    addition('last', 'Receipts by email', LAST_QUESTION),
    { ...base.requests.find(request => request.text === MAX_QUESTION)!, link: PREVIEW },
  ];
  await page.route('**/api/tasks?status=all', route => route.fulfill({ json: { tasks: TASKS.filter(task => task.id !== first.task.id) } }));
  await page.route('**/api/requests', route => route.fulfill({ json: { ...base, requests, counts: { ...base.counts, total: requests.filter(request => request.canAnswer).length } } }));
  await page.route('**/api/requests/*', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const requestId = new URL(route.request().url()).pathname.split('/').at(-1);
    const index = requests.findIndex(request => request.id === requestId && request.canAnswer);
    if (index < 0) return route.fulfill({ status: 403, json: { error: { code: 'forbidden', message: 'This decision is not yours.' } } });
    requests.splice(index, 1);
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/tasks?show=waits');
  await page.evaluate(() => document.fonts.ready);
  return { firstId: first.id, readonlyTitle: addition('ro', 'Take card payments', '').task };
}

async function fits(region: Locator) {
  const overflow = await region.evaluate(root => {
    const frame = root.getBoundingClientRect();
    const bad = [...root.querySelectorAll('p, bdi, button, textarea, .wait-question-copy')]
      .filter(el => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && (box.left < frame.left - 1 || box.right > frame.right + 1 || getComputedStyle(el).textOverflow === 'ellipsis');
      }).map(el => el.textContent);
    return { bad, document: document.documentElement.scrollWidth - window.innerWidth };
  });
  expect(overflow.bad).toEqual([]);
  expect(overflow.document).toBeLessThanOrEqual(0);
}

async function choosePeople(page: Page, t: typeof DICTIONARIES[ShippedLanguage], width: number) {
  const side = page.getByRole('navigation', { name: t.tracker.side.label });
  if (width === 375) await page.getByRole('button', { name: t.tracker.side.open, exact: true }).click();
  await side.getByRole('button', { name: new RegExp(`^${t.tracker.peopleWaits.title}`) }).click();
  return page.getByRole('region', { name: t.tracker.peopleWaits.title });
}

for (const { id: lang, rtl } of [...LANGUAGES.map(({ id }) => ({ id, rtl: false })), { id: 'en' as const, rtl: true }]) {
  for (const skin of ['cyberpunk', 'light']) for (const width of [1440, 375]) {
    test(`works through the waiting queue and a read-only request in ${rtl ? 'rtl' : lang} ${skin} ${width}`, async ({ page, browserName }, info) => {
      const t = DICTIONARIES[lang];
      const { firstId, readonlyTitle } = await openQueue(page, lang, skin, width, rtl);
      const id = `${rtl ? 'rtl' : lang}-${skin}-${width}`;
      const shot = async (name: string) => {
        if (browserName === 'chromium') await capture(page, info, `${id}-${name}`);
      };
      const mine = page.getByRole('region', { name: t.tasks.waiting, exact: true });
      const open = mine.locator('article.req');
      const strips = mine.getByRole('button', { expanded: false });
      await expect(open).toHaveCount(1);
      await expect(open).toContainText(QUESTION);
      await expect(open.getByRole('region', { name: t.tasks.queue.materials })).toBeVisible();
      await expect(strips).toHaveCount(3);
      await expect(strips.first()).toContainText(LONG_QUESTION);
      await expect(mine.getByText(MAX_QUESTION)).toHaveCount(0);
      await fits(mine);
      await shot('queue');

      await mine.getByRole('button', { name: t.tasks.queue.defer, exact: true }).click();
      await expect(open).toContainText(LONG_QUESTION);
      await expect(strips.last()).toContainText(QUESTION);
      await expect(strips.last()).toContainText(t.tasks.queue.deferred);
      await expect(mine.locator('.wait-current > h3')).toBeFocused();
      await shot('deferred');
      await page.keyboard.press('Tab');
      await strips.last().focus();
      expect(await strips.last().evaluate(el => el.matches(':focus-visible'))).toBe(true);
      await shot('focus');
      await page.keyboard.press('Enter');
      await expect(open).toContainText(QUESTION);
      await expect(mine.locator('.wait-current > h3')).toBeFocused();
      await open.getByRole('textbox', { name: t.tasks.yourAnswer, exact: true }).fill('Keep it for a month.');
      const scroll = () => mine.evaluate(el => el.closest('.body')?.scrollTop ?? 0);
      const beforeAnswer = await scroll();
      const response = page.waitForResponse(res => new URL(res.url()).pathname === `/api/requests/${firstId}` && res.request().method() === 'POST');
      await open.getByRole('button', { name: t.tasks.sendAnswer, exact: true }).click();
      expect((await response).ok()).toBe(true);
      await expect(open).toContainText(LONG_QUESTION);
      await expect(strips).toHaveCount(2);
      expect(await scroll()).toBe(beforeAnswer);

      const people = await choosePeople(page, t, width);
      const row = people.getByRole('article', { name: `#${readonlyTitle.number} ${readonlyTitle.title}`, exact: true });
      await expect(row).toContainText(MAX_QUESTION);
      await expect(row).toContainText('Max');
      await expect(row).toContainText(t.tasks.decidedByNamedPerson);
      await expect(row.getByRole('button')).toHaveCount(1);
      await fits(people);
      await row.scrollIntoViewIfNeeded();
      await shot('people');
      await row.getByRole('button', { name: t.tasks.queue.open, exact: true }).click();
      const panel = page.getByRole('complementary', { name: `#${readonlyTitle.number} ${readonlyTitle.title}`, exact: true });
      const readOnly = panel.getByRole('article', { name: `#${readonlyTitle.number} ${readonlyTitle.title}`, exact: true });
      await expect(readOnly.getByText(t.tasks.queue.readOnly, { exact: true })).toBeVisible();
      await expect(readOnly).toContainText(t.tasks.decidedByNamedPerson);
      await expect(readOnly.getByRole('region', { name: t.tasks.materials.heading })).toBeVisible();
      await expect(readOnly.getByRole('textbox')).toHaveCount(0);
      await expect(readOnly.getByRole('button', { name: t.tasks.sendAnswer, exact: true })).toHaveCount(0);
      await fits(readOnly);
      await readOnly.scrollIntoViewIfNeeded();
      await shot('read-only');

      await page.route('**/api/requests', route => route.fulfill({ json: { requests: [], proposals: [], counts: { byPerson: {}, byAgent: {}, total: 0 } } }));
      await page.goto('/tasks?show=waits');
      await expect(page.getByText(t.tasks.queue.empty, { exact: true })).toBeVisible();
      await shot('empty');
    });
  }
}
