import { expect, test, type Page } from '@playwright/test';
import type { MachineConnectionHistory, MachineView, SubView } from '../src/types';
import { serveApi } from './api';

const HISTORY: MachineConnectionHistory = {
  summary: { since: '2026-11-03T10:00:00.000Z', disconnects: 5, averageOfflineMs: 40_000, topCause: 'abnormal_close' },
  events: [
    { id: 'e2', nodeId: 'n1', kind: 'connected', happenedAt: '2026-11-04T10:00:40.000Z', actor: null, cause: null, closeCode: null, closeReason: null, error: null, offlineMs: 40_000, nodeReport: null },
    {
      id: 'e1', nodeId: 'n1', kind: 'disconnected', happenedAt: '2026-11-04T10:00:00.000Z', actor: 'network', cause: 'abnormal_close',
      closeCode: 1006, closeReason: 'abnormal', error: null, offlineMs: 40_000,
      nodeReport: {
        disconnectedAt: '2026-11-04T10:00:00.000Z', reconnectedAt: '2026-11-04T10:00:40.000Z', offlineMs: 40_000,
        attempts: 3, cause: 'dns_error', closeCode: 1006, closeReason: 'abnormal', errorCode: 'ENOTFOUND', error: 'DNS lookup failed with a long explanation that wraps',
        dnsFailed: true, watchdogTimedOut: false, clockJumpMs: null, networkChanged: true,
      },
    },
  ],
};

async function openMachine(page: Page, language: 'en' | 'ru', theme: 'light' | 'dark', history: MachineConnectionHistory = HISTORY) {
  await serveApi(page);
  await page.addInitScript(({ language, theme }) => {
    localStorage.setItem('hh-lang', language);
    localStorage.setItem('hh-theme', theme);
  }, { language, theme });
  const plans: SubView[] = [{
    id: 'plan-1', provider: 'claude', kind: 'personal', label: 'Claude', status: 'ready', online: true,
    last4: null, owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company', id: null, name: 'Whole company' },
    machines: [], limits: null, budget: null, isOrchestrator: false, accounts: [], tier: null, accountsDiffer: false, signedInOnce: true, leaseMachine: null,
  }];
  const machine: MachineView = {
    id: 'm1', hostname: 'home-api', os: 'linux', arch: 'x86_64', owner: { id: 'p1', name: 'Ivan' }, online: true, lastSeenAt: null,
    plans: [{ id: 'plan-1', provider: 'claude', status: 'ready', online: true }],
    load: { cpus: 8, load: 1, memFree: 10 * 1024 ** 3, memTotal: 16 * 1024 ** 3, jobs: 0, tests: 0, cpuModel: 'AMD EPYC', diskFree: 200 * 1024 ** 3, diskTotal: 500 * 1024 ** 3 },
    lendsTests: true, running: { agents: [], parts: [] },
  };
  await page.route('**/api/machines', route => route.fulfill({ json: { machines: [machine], builtin: null } }));
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: plans } }));
  await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/machines/m1/connection-history', route => route.fulfill({ json: history }));
  await page.route('**/api/version', route => route.fulfill({ json: { version: '0.6.1', commit: 'abc1234' } }));
  await page.route('**/api/updates', route => route.fulfill({ json: {
    current: { version: '0.6.1', commit: 'abc1234', migrations: 58 }, available: false, checkedAt: null, latest: null, versions: [], error: null,
    updater: { present: false, status: null, waiting: null },
  } }));
  await page.goto('/');
  await page.getByRole('button', { name: language === 'en' ? 'Machines' : 'Машины', exact: true }).click();
  await page.getByRole('button', { name: `${language === 'en' ? 'Open the card of' : 'Открыть карточку'} home-api`, exact: true }).click();
  return page.getByRole('article', { name: 'home-api' });
}

for (const language of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1440, 375]) {
  test(`connection history ${language} ${theme} ${width}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.setViewportSize({ width, height: width === 375 ? 1800 : 1150 });
    const card = await openMachine(page, language, theme);
    const summary = language === 'en'
      ? 'Last 24 hours: 5 disconnects, average offline 40 s. Most often: the network ended the connection.'
      : 'За сутки: 5 обрывов, в среднем офлайн 40 с. Чаще всего: сеть оборвала соединение.';
    await expect(card.getByText(summary, { exact: true })).toBeVisible();
    await expect(card.getByText(language === 'en' ? /The machine reported: DNS lookup failed/ : /Машина сообщила: DNS lookup failed/)).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const textBox = await card.locator('.connection-event > span').first().boundingBox();
    const timeBox = await card.locator('.connection-event > time').first().boundingBox();
    expect(textBox).not.toBeNull();
    expect(timeBox).not.toBeNull();
    if (width === 375) expect(timeBox!.y).toBeGreaterThan(textBox!.y + textBox!.height - 2);
    else expect(Math.abs(timeBox!.y - textBox!.y)).toBeLessThan(2);
    await card.locator('.connection-summary').locator('..').screenshot({ path: info.outputPath(`connection-${language}-${theme}-${width}.png`) });
    expect(errors).toEqual([]);
  });
}

test('empty connection history explains what appears later', async ({ page }, info) => {
  await page.setViewportSize({ width: 375, height: 1200 });
  const card = await openMachine(page, 'en', 'light', { summary: { since: '2026-11-03T10:00:00.000Z', disconnects: 0, averageOfflineMs: null, topCause: null }, events: [] });
  await expect(card.getByText('No disconnects in the last 24 hours.', { exact: true })).toBeVisible();
  await expect(card.getByText('No connections recorded yet. They will appear after the machine connects.', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('connection-empty.png'), fullPage: true });
});
