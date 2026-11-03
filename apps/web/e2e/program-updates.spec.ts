import { expect, test, type Page } from '@playwright/test';
import type { ProgramInfo } from '@hornhoof/protocol';
import type { MachineView, SubView } from '../src/types';
import { ME, serveApi } from './api';

const HOST = 'build-station';
const INITIAL: ProgramInfo[] = [
  { id: 'claude', version: '2.0.0', updating: false, failed: false },
  { id: 'codex', version: '3.0.0', updating: false, failed: false },
  { id: 'kimi', version: '1.0.0', updating: false, failed: false },
];
const VERSION = { version: '0.5.0', commit: 'abc1234' };
const GIB = 1024 ** 3;

async function prepare(page: Page, language: string, theme: string, options: { online?: boolean; programs?: ProgramInfo[] | null; readonly?: boolean; hostname?: string; activeCommand?: boolean } = {}) {
  await serveApi(page);
  await page.addInitScript(({ language, theme }) => {
    localStorage.setItem('hh-lang', language);
    localStorage.setItem('hh-theme', theme);
  }, { language, theme });
  let programs = options.programs === undefined ? INITIAL.map(p => ({ ...p })) : options.programs;
  const online = options.online ?? true;
  const hostname = options.hostname ?? HOST;
  const plans: SubView[] = (['claude', 'codex', 'kimi'] as const).map((provider, i) => ({
    id: `plan-${i}`, provider, kind: 'personal', label: provider, status: 'ready', online,
    last4: null, owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company', id: null, name: 'Whole company' },
    machines: [], limits: null, budget: null, isOrchestrator: false, accounts: [], tier: null, accountsDiffer: false, signedInOnce: true, leaseMachine: null,
  }));
  const machine: MachineView = {
    id: 'm1', hostname, os: 'linux', arch: 'x86_64', owner: { id: 'p1', name: 'Ivan' }, online, lastSeenAt: null,
    plans: plans.map(p => ({ id: p.id, provider: p.provider, status: 'ready', online })),
    load: { cpus: 8, load: 2, memFree: 6 * GIB, memTotal: 16 * GIB, jobs: 0, tests: 0, cpuModel: 'AMD Ryzen', diskFree: 120 * GIB, diskTotal: 500 * GIB },
    lendsTests: true, running: { agents: [], parts: [] },
  };
  await page.route('**/api/machines', route => route.fulfill({ json: { machines: [{ ...machine, programs }], builtin: null } }));
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: plans } }));
  const commands = options.activeCommand ? [{ id: 'a'.repeat(64), kind: 'add', plans: ['Kimi'], machineId: 'm1', machine: hostname, command: 'connect-the-pending-plan', expiresAt: new Date(Date.now() + 3600_000).toISOString() }] : [];
  await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands } }));
  await page.route('**/api/version', route => route.fulfill({ json: VERSION }));
  await page.route('**/api/updates', route => route.fulfill({ json: {
    current: { ...VERSION, migrations: 51 }, available: false, checkedAt: null, latest: null, versions: [], error: null,
    updater: { present: false, status: null, waiting: null },
  } }));
  if (options.readonly) await page.route('**/api/me', route => route.fulfill({ json: { ...ME, person: { ...ME.person, id: 'reader', scopeKind: 'listed', isOwner: false } } }));
  let requests = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/machines/m1/programs/update', async route => {
    requests++;
    await pending;
    programs = INITIAL.map(p => ({ ...p, version: p.id === 'claude' ? '2.0.1' : p.version }));
    await route.fulfill({ status: 202, json: { updating: true } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: language === 'en' ? 'Machines' : 'Машины', exact: true }).click();
  if (!options.activeCommand) await page.getByRole('button', { name: `${language === 'en' ? 'Open the card of' : 'Открыть карточку'} ${hostname}`, exact: true }).click();
  return { card: page.getByRole('article', { name: hostname }), release, requests: () => requests };
}

for (const language of ['en', 'ru']) for (const theme of ['light', 'dark']) for (const width of [1280, 375]) {
  test(`programs ${language} ${theme} ${width}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', response => { if (response.url().includes('/api/') && response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.setViewportSize({ width, height: 1000 });
    const { card, release, requests } = await prepare(page, language, theme);
    const heading = card.getByRole('heading', { name: language === 'en' ? 'Agent programs' : 'Программы агентов' });
    await heading.scrollIntoViewIfNeeded();
    const update = card.getByRole('button', { name: language === 'en' ? 'Update programs' : 'Обновить программы', exact: true });
    await update.focus();
    await expect(update).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(update).toBeDisabled();
    await expect(card.getByRole('status')).toContainText(language === 'en' ? 'Updating programs...' : 'Обновляем программы...');
    expect(requests()).toBe(1);
    await page.screenshot({ path: info.outputPath(`programs-progress-${language}-${theme}-${width}.png`), fullPage: true });
    release();
    await expect(card.getByText('2.0.1', { exact: true })).toBeVisible();
    await expect(update).toBeEnabled();
    await page.evaluate(async () => { await document.fonts.ready; });
    await expect(heading).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    if (width === 375) {
      await page.setViewportSize({ width, height: 1800 });
      await card.scrollIntoViewIfNeeded();
    }
    await page.screenshot({ path: info.outputPath(`programs-${language}-${theme}-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
}

test('long versions fit a phone card', async ({ page }, info) => {
  await page.setViewportSize({ width: 375, height: 1000 });
  const version = '2026.11.03+' + 'a'.repeat(53);
  const { card } = await prepare(page, 'ru', 'light', { programs: [{ ...INITIAL[0]!, version }], hostname: 'integration-and-release-computer-with-a-long-name' });
  await card.getByText(version, { exact: true }).scrollIntoViewIfNeeded();
  expect(await card.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('programs-long-version.png'), fullPage: true });
});

for (const state of ['offline', 'unknown', 'empty'] as const) {
  test(`programs ${state}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 375, height: 1000 });
    const { card } = await prepare(page, 'en', 'dark', { online: state !== 'offline', programs: state === 'empty' ? [] : null });
    const text = state === 'offline' ? 'Reconnect this machine to see its program versions.' : state === 'unknown' ? 'This machine has not reported its program versions yet.' : 'There are no programs to update here.';
    await expect(card.getByText(text, { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Update programs' })).toBeDisabled();
    await page.screenshot({ path: info.outputPath(`programs-${state}.png`), fullPage: true });
  });
}

test('a failed request can be retried from the card', async ({ page }, info) => {
  await page.setViewportSize({ width: 375, height: 1000 });
  const { card } = await prepare(page, 'ru', 'dark');
  let attempts = 0;
  await page.route('**/api/machines/m1/programs/update', route => ++attempts === 1
    ? route.fulfill({ status: 409, json: { error: { code: 'conflict', reason: 'programs_unavailable' } } })
    : route.fulfill({ status: 202, json: { updating: true } }));
  const button = card.getByRole('button', { name: 'Обновить программы' });
  await button.click();
  await expect(card.getByRole('alert')).toHaveText('Программы на этой машине сейчас обновить нельзя.');
  await expect(button).toBeEnabled();
  await page.screenshot({ path: info.outputPath('programs-request-failed.png'), fullPage: true });
  await button.click();
  await expect(card.getByRole('alert')).toHaveCount(0);
  expect(attempts).toBe(2);
});

test('a person who cannot change the machine sees versions without an update button', async ({ page }) => {
  const { card } = await prepare(page, 'en', 'light', { readonly: true });
  await expect(card.getByText('2.0.0', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Update programs' })).toHaveCount(0);
});


test('keeps an active connection command while updating the programs', async ({ page }) => {
  const { card, release } = await prepare(page, 'en', 'light', { activeCommand: true });
  await expect(card.getByText('connect-the-pending-plan')).toBeVisible();
  await card.getByRole('button', { name: 'Update programs', exact: true }).click();
  release();
  await expect(card.getByText('2.0.1', { exact: true })).toBeVisible();
  await expect(card.getByText('connect-the-pending-plan')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
});
