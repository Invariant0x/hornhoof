import { expect, test } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { SubView } from '../src/types';
import { openAgent } from './agent-window-panels-api';
import { CARD } from './agent-window-api';

const BEFORE = process.env.LIMITS_BEFORE === '1';
const NOW = Date.parse('2026-11-04T22:00:00.000Z');
const messages = { en, ru };

const stalePlan = (): SubView => ({
  id: 's-antigravity', provider: 'antigravity', kind: 'personal', label: 'Antigravity', status: 'ready', online: true,
  last4: null, owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company', id: null, name: 'Whole company' },
  machines: [{ id: 'a-host', hostname: 'a-host', status: 'ready', online: true }],
  limits: { status: 'rejected', windows: [{ name: 'five_hour', utilization: 1, resetsAt: '2026-11-03T00:53:03.947Z' }] },
  limitsUpdatedAt: '2026-11-04T21:44:00.000Z', budget: null, isOrchestrator: false,
  accounts: [], tier: null, accountsDiffer: false, signedInOnce: false, leaseMachine: null, agents: [],
});

for (const lang of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1440, 375]) {
  test(`Antigravity limits ${BEFORE ? 'before' : 'after'}: ${lang} ${theme} ${width}`, async ({ page }, info) => {
    const t = messages[lang];
    const plan = stalePlan();
    const problems: string[] = [];
    page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 400) problems.push(`${response.status()} ${response.url()}`); });
    await page.clock.install({ time: NOW });
    const { errors, openPanel, panel } = await openAgent(page, { lang, theme, width }, 'employee');
    await page.route('**/api/agents/b1', route => route.fulfill({ json: { ...CARD, subscription: plan, runsOn: [{ subscription: plan, models: [] }] } }));
    await openPanel('card');
    const agentCard = panel('card');
    if (BEFORE) {
      await expect(agentCard.getByRole('group', { name: t.subs.limits, exact: true })).toHaveCount(0);
      await expect(agentCard.getByText(/Unknown,|Неизвестно,/)).toHaveCount(0);
    } else {
      await expect(agentCard.getByRole('group', { name: t.subs.limits, exact: true })).toContainText(t.subs.unknown(lang === 'en' ? '09:44 PM' : '21:44'));
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`agent-${BEFORE ? 'before' : 'after'}-${lang}-${theme}-${width}.png`), fullPage: true });

    await page.reload();
    await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [plan] } }));
    await page.getByRole('navigation').getByRole('button', { name: t.shell.tabs.subscriptions, exact: true }).click();
    await page.getByRole('button', { name: t.tables.openCard('Antigravity'), exact: true }).click();
    const card = page.getByRole('article', { name: 'Antigravity, Ivan', exact: true });
    await expect(card).toBeVisible();
    if (BEFORE) {
      await expect(card.getByText(/No data yet|Пока нет данных/).first()).toBeVisible();
      await expect(card.getByText(/Unknown,|Неизвестно,/)).toHaveCount(0);
    } else {
      await expect(card.getByRole('group', { name: t.subs.limits, exact: true })).toContainText(t.subs.unknown(lang === 'en' ? '09:44 PM' : '21:44'));
      await expect(card.getByText(t.subs.limitReached(null), { exact: true })).toHaveCount(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`subscription-${BEFORE ? 'before' : 'after'}-${lang}-${theme}-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
    expect(problems).toEqual([]);
  });
}

test('fresh Antigravity limits replace the stale snapshot without a reload of the app', async ({ page }) => {
  const plan = stalePlan();
  await page.clock.install({ time: NOW });
  await page.addInitScript(() => { localStorage.setItem('hh-lang', 'en'); localStorage.setItem('hh-theme', 'light'); });
  const { serveApi } = await import('./api');
  await serveApi(page);
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [plan] } }));
  await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: en.shell.tabs.subscriptions, exact: true }).click();
  await page.getByRole('button', { name: en.tables.openCard('Antigravity'), exact: true }).click();
  const card = page.getByRole('article', { name: 'Antigravity, Ivan', exact: true });
  await expect(card).toContainText('Unknown, last data from 09:44 PM');

  Object.assign(plan, {
    limits: { status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.3, resetsAt: '2026-11-05T02:19:23.000Z' }], complete: true },
    limitsUpdatedAt: '2026-11-04T22:00:00.000Z',
  });
  await page.reload();
  await page.getByRole('navigation').getByRole('button', { name: en.shell.tabs.subscriptions, exact: true }).click();
  await page.getByRole('button', { name: en.tables.openCard('Antigravity'), exact: true }).click();
  await expect(card).toContainText('30%');
  await expect(card).not.toContainText('Unknown,');
});
