import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { chooseTerminal } from './api';
import { serveAgentWindow, SUB } from './agent-window-api';

const words = {
  en: { table: en, field: 'Concurrent turns per machine', problem: 'Enter a whole number from 1 to 5.', wait: 'Waiting for room on Codex (4 of 4)' },
  ru: { table: ru, field: 'Одновременные ходы на одной машине', problem: 'Введите целое число от 1 до 5.', wait: 'Ждет места на подписке Codex (4 из 4)' },
};

for (const lang of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1440, 375]) {
  test(`subscription turn ceiling and visible wait ${lang} ${theme} ${width}`, async ({ page }, info) => {
    const ui = words[lang];
    let turnLimit = 4;
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(({ lang, theme }) => {
      localStorage.setItem('hh-lang', lang);
      localStorage.setItem('hh-theme', theme === 'light' ? 'light' : 'cyberpunk');
    }, { lang, theme });
    await chooseTerminal(page);
    await serveAgentWindow(page, { awake: false, hasTask: false, messages: [], connections: 0 });
    await page.route('**/api/build*', route => route.fulfill({ json: { build: 'e2e-build' } }));
    await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [{ ...SUB, turnLimit }] } }));
    await page.route('**/api/subscriptions/s1', route => {
      turnLimit = route.request().postDataJSON().turnLimit;
      return route.fulfill({ json: { subscription: { ...SUB, turnLimit } } });
    });
    await page.route('**/api/agents/b1/events*', route => route.fulfill({
      json: { events: [], state: { ready: true, reason: null, busy: false, queued: 1, terminal: false, subscriptionWait: { label: SUB.label, running: 4, limit: 4 } } },
    }));
    await page.goto('/');
    await page.getByRole('navigation').getByRole('button', { name: ui.table.shell.tabs.subscriptions, exact: true }).click();
    await page.getByRole('button', { name: ui.table.tables.openCard('Codex'), exact: true }).click();
    const card = page.getByRole('article', { name: 'Codex, Ivan', exact: true });
    await expect(card).toBeVisible();
    const input = card.getByRole('spinbutton', { name: ui.field });
    expect(await input.count()).toBe(1);
    await expect(input).toHaveValue('4');
    await input.fill('6');
    await input.press('Enter');
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    const problem = card.getByText(ui.problem, { exact: true });
    await expect(problem).toBeVisible();
    const settings = card.locator('form').filter({ has: page.getByRole('spinbutton', { name: ui.field }) });
    expect(await settings.count()).toBe(1);
    await settings.evaluate(form => form.scrollIntoView({ block: 'center', inline: 'nearest' }));
    const viewport = page.viewportSize()!;
    for (const target of [input, problem]) {
      const bounds = await target.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    }
    await expect(input).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (lang === 'en') await page.screenshot({ path: shot('field-error') });
    await input.fill('5');
    await input.press('Enter');
    await expect.poll(() => turnLimit).toBe(5);
    await expect(input).toHaveValue('5');

    await page.goto('/');
    await page.getByRole('button', { name: /^Development/ }).click();
    await page.getByRole('region', { name: ui.table.dept.members }).getByRole('button', { name: /Bruno/ }).click();
    const window = page.getByRole('complementary', { name: /^Bruno,/ });
    await expect(window).toBeVisible();
    await expect(window.getByText(ui.wait, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (lang === 'en') await page.screenshot({ path: shot('wait'), fullPage: true });

    function shot(state: string): string {
      const file = `subscription-turn-limit-${state}-${lang}-${theme}-${width}.png`;
      return process.env.HH_OUT ? join(process.env.HH_OUT, file) : info.outputPath(file);
    }
  });
}
