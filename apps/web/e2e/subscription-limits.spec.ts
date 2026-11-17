import { expect, test } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { BUILTIN_SKINS } from '../src/skins/registry';
import type { SubView } from '../src/types';
import { openAgent } from './agent-window-panels-api';
import { CARD } from './agent-window-api';
import { box, serveApi } from './api';
import { cutByNavigation } from './look-steps';

const BEFORE = process.env.LIMITS_BEFORE === '1';
const NOW = Date.parse('2026-11-04T22:00:00.000Z');
const messages = { en, ru };

const stalePlan = (): SubView => ({
  id: 's-antigravity', provider: 'antigravity', kind: 'personal', label: 'Antigravity', status: 'ready', online: true,
  last4: null, owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company', id: null, name: 'Whole company' },
  machines: [{ id: 'node-a', hostname: 'node-a', status: 'ready', online: true }],
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

const CLAUDE_NOW = Date.parse('2026-11-13T21:06:00.000Z');

function claudePlans(): SubView[] {
  const agent = {
    id: 'b1', canOpen: true, name: 'Leo', busy: false,
    title: { en: 'Developer', ru: 'Разработчик' },
    department: { id: 'd2', name: 'Development' },
    provider: 'claude' as const, since: null, task: null, withCeo: false,
  };
  const base = {
    provider: 'claude' as const, kind: 'personal' as const, label: 'Claude', status: 'ready' as const,
    last4: null, place: { kind: 'company' as const, id: null, name: 'Whole company' },
    budget: null, isOrchestrator: false, accounts: [], tier: 'Max', accountsDiffer: false, signedInOnce: true, leaseMachine: null,
  };
  return [
    {
      ...base, id: 's-1-claude', online: true, owner: { id: 'p1', name: 'Ivan' },
      machines: [{ id: 'm-1', hostname: 'work-laptop', status: 'ready', online: true }],
      limits: { status: 'allowed', windows: [{ name: 'seven_day', utilization: 0.96, resetsAt: '2026-11-18T12:00:00.000Z' }], complete: true },
      limitsUpdatedAt: '2026-11-13T21:02:00.000Z', agents: [agent],
    },
    {
      ...base, id: 's-clara-claude', online: false, owner: { id: 'p2', name: 'Clara' },
      machines: [{ id: 'm-clara', hostname: 'workstation-eu', status: 'ready', online: false }],
      limits: { status: 'allowed', windows: [{ name: 'seven_day', utilization: 0.72, resetsAt: '2026-11-17T12:00:00.000Z' }], complete: true },
      limitsUpdatedAt: '2026-11-13T17:22:00.000Z', agents: [agent],
    },
    {
      ...base, id: 's-max-claude', online: false, owner: { id: 'p3', name: 'Max' },
      machines: [{ id: 'm-max', hostname: 'win-desktop-01', status: 'ready', online: false }],
      limits: { status: 'allowed', windows: [{ name: 'seven_day', utilization: 0.55, resetsAt: '2026-11-18T00:00:00.000Z' }], complete: true },
      limitsUpdatedAt: '2026-11-13T18:51:00.000Z', agents: [],
    },
  ];
}

for (const lang of ['en', 'ru'] as const) for (const skin of BUILTIN_SKINS.map(s => s.id)) for (const width of [1440, 375]) {
  const mode = skin === 'light' ? 'light' : `dark ${skin}`;
  test(`Subscriptions complete single-window Claude and offline machines: ${lang} ${mode} ${width}`, async ({ page }, info) => {
    const t = messages[lang];
    const errors: string[] = [];
    page.on('pageerror', error => { if (!cutByNavigation(page, error)) errors.push(error.message); });
    page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text()); });
    page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install({ time: CLAUDE_NOW });
    await page.addInitScript(({ lang, skin }) => {
      localStorage.setItem('hh-lang', lang);
      localStorage.setItem('hh-theme', skin);
    }, { lang, skin });
    await serveApi(page);
    await page.route('**/api/version', route => route.fulfill({ json: { version: '0.23.5', commit: 'task-802' } }));
    await page.route('**/api/updates', route => route.fulfill({ json: { current: { version: '0.23.5', commit: 'task-802' }, available: false, latest: null, updater: { status: null, waiting: null } } }));
    await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: claudePlans() } }));
    await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: [] } }));
    await page.goto('/');
    await page.getByRole('navigation').getByRole('button', { name: t.shell.tabs.subscriptions, exact: true }).click();

    const ivanRow = page.locator('tr.rm', { hasText: 'Ivan' });
    const claraRow = page.locator('tr.rm', { hasText: 'Clara' });
    const maxRow = page.locator('tr.rm').filter({ has: page.locator('td', { hasText: /^Max$/ }) });
    const claraOffline = t.subs.offlineLimit(lang === 'en' ? '05:22 PM' : '17:22');
    const maxOffline = t.subs.offlineLimit(lang === 'en' ? '06:51 PM' : '18:51');

    await expect(ivanRow).toContainText(t.subs.notOnPlan);
    await expect(ivanRow).toContainText('96%');
    await expect(ivanRow).not.toContainText(/Unknown,|Неизвестно,/);

    await expect(claraRow).toContainText(t.subs.states.offline);
    await expect(claraRow).toContainText(claraOffline);
    await expect(claraRow).not.toContainText(/Unknown,|Неизвестно,/);

    await expect(maxRow).toContainText(t.subs.states.offline);
    await expect(maxRow).toContainText(maxOffline);
    await expect(maxRow).not.toContainText(/Unknown,|Неизвестно,/);

    await ivanRow.locator('button.rowbtn').click();
    await claraRow.locator('button.rowbtn').click();

    const ivanCard = page.getByRole('article', { name: 'Claude, Ivan', exact: true });
    const claraCard = page.getByRole('article', { name: 'Claude, Clara', exact: true });
    await expect(ivanCard).toContainText(t.subs.notOnPlan);
    await expect(ivanCard).toContainText('96%');
    await expect(ivanCard).not.toContainText(/Unknown,|Неизвестно,/);

    await expect(claraCard).toContainText(t.cards.notes.offline('workstation-eu'));
    await expect(claraCard).toContainText(claraOffline);
    await expect(claraCard).not.toContainText(/Unknown,|Неизвестно,/);

    for (const card of [ivanCard, claraCard]) {
      const blocks = await box(card.locator('.blocks'));
      for (const blk of await card.locator('.blocks > .blk').all()) {
        const own = await box(blk);
        expect(own.x + own.width).toBeLessThanOrEqual(blocks.x + blocks.width + 1);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`subscriptions-claude-${lang}-${skin}-${width}.png`), fullPage: true });
    await ivanCard.screenshot({ path: info.outputPath(`subscriptions-ivan-${lang}-${skin}-${width}.png`) });
    expect(errors).toEqual([]);
  });
}
