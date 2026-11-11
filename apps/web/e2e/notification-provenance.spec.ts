import { expect, test } from '@playwright/test';
import type { EventView, MessageParty } from '../src/types';
import { serveAgentWindow } from './agent-window-api';

const to: MessageParty = { kind: 'agent', id: 'b1', name: 'Bruno', role: null, department: null };
const actor: MessageParty = { ...to, id: 'a2', name: 'Hana with a long employee name' };
const hornhoof: MessageParty = { kind: 'hornhoof', id: null, name: 'Hornhoof', role: null, department: null };
const task = { id: 't1', number: 226 };
const event = (seq: number, from: MessageParty, notification: NonNullable<EventView['message']>['notification'], text: string): EventView => ({ seq, kind: 'message', data: { text }, jobId: 'j1', person: null, at: '2026-11-04T14:00:00Z', message: { direction: 'in', from, to, notification } });

for (const language of ['en', 'ru'] as const) for (const theme of ['light', 'dark']) for (const width of [1440, 375]) {
  test(`notification authors and sources ${language} ${theme} ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(({ language, theme }) => {
      localStorage.setItem('hh-lang', language);
      localStorage.setItem('hh-theme', theme);
    }, { language, theme });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('requestfailed', request => errors.push(request.url()));
    await serveAgentWindow(page, { awake: false, hasTask: true, messages: [], connections: 0, events: [
      event(1, actor, { source: 'reported', tasks: [task] }, 'Hana reported work done on #226. Release verified.'),
      event(2, hornhoof, { source: 'wait_ended', tasks: [task], detail: { en: 'set by Hana, until 15:39', ru: 'поставил Hana, до 15:39' } }, 'The wait ended.'),
      event(3, hornhoof, { source: 'go_on', tasks: [{ id: 't2', number: 223 }] }, 'Continue your work.'),
      event(4, hornhoof, { source: 'program_operator', tasks: [task] }, 'The program needs an operator.'),
    ] });
    await page.goto('/');
    await page.getByRole('button', { name: /^Development/ }).click();
    await page.getByRole('region', { name: language === 'en' ? 'Members' : 'Сотрудники' }).getByRole('button', { name: /Bruno/ }).click();
    const window = page.getByRole('complementary', { name: /^Bruno,/ });
    const author = window.getByRole('button', { name: language === 'en' ? 'Message from Hana with a long employee name via Hornhoof to Bruno' : 'Сообщение от Hana with a long employee name через Hornhoof для Bruno' });
    const timer = window.getByRole('button', { name: language === 'en' ? 'Hornhoof, wait timer on #226 (set by Hana, until 15:39) to Bruno' : 'Hornhoof, таймер ожидания по #226 (поставил Hana, до 15:39) для Bruno' });
    await expect(author).toBeVisible();
    await expect(timer).toBeVisible();
    await expect(author).toHaveAttribute('aria-expanded', 'false');
    await author.click();
    await expect(window.getByText('Hana reported work done on #226. Release verified.', { exact: true })).toBeVisible();
    await author.click();
    await timer.focus();
    await page.keyboard.press('Enter');
    await expect(window.getByText('The wait ended.', { exact: true })).toBeVisible();
    await page.keyboard.press('Enter');
    expect(await window.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath(`notifications-${language}-${theme}-${width}.png`), fullPage: true });
  });
}
