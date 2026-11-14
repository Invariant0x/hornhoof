import { expect, test, type Locator, type Page } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { ShownCommand, SubView } from '../src/types';
import { ME, serveApi, serveOwnerKey } from './api';

const START = Date.parse('2026-11-03T10:00:00Z');
const names = { claude: 'Claude', codex: 'Codex', kimi: 'Kimi' };
const waiting = (provider: keyof typeof names): SubView => ({
  id: `plan-${provider}`, provider, kind: 'personal', label: names[provider], owner: { id: 'p1', name: 'Ivan' },
  status: 'waiting_machine', online: false, machines: [], last4: null, place: { kind: 'company', id: null, name: 'Whole company' },
  limits: null, budget: null, isOrchestrator: false, accounts: [], tier: null, accountsDiffer: false, signedInOnce: false, leaseMachine: null, agents: [],
});

async function prepare(page: Page, language: 'en' | 'ru', theme: string) {
  await page.clock.install({ time: START - 60_000 });
  await page.addInitScript(({ language, theme }) => {
    localStorage.setItem('hh-lang', language); localStorage.setItem('hh-theme', theme);
  }, { language, theme });
  await serveApi(page);
  let subscriptions: SubView[] = [];
  let commands: ShownCommand[] = [];
  let serial = 0;
  const make = (rows: SubView[]) => {
    const id = String(++serial).padStart(64, '0');
    const command: ShownCommand = { id, kind: 'plans', subscriptionIds: rows.map(s => s.id), dismissedSubscriptionIds: [], plans: rows.map(s => s.label), machine: null,
      command: `curl -fsSL https://demo.example.test/install.sh | bash -s -- --join DEMO_ONLY_${serial}`, expiresAt: new Date(START + 21 * 3600_000).toISOString() };
    commands.push(command);
    return { ...command, subscriptions: rows };
  };
  const VERSION = { version: '0.5.0', commit: 'demo181' };
  const fixed: Record<string, unknown> = {
    '/api/me': ME, '/api/version': VERSION, '/api/updates/current': VERSION,
    '/api/updates': { current: VERSION, available: false, latest: null, updater: { status: null, waiting: null } },
    '/api/machines': { machines: [], builtin: null },
  };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON() as { providers?: (keyof typeof names)[]; subscriptionId?: string } | null;
    if (path in fixed) return route.fulfill({ json: fixed[path] });
    if (path === '/api/subscriptions') return route.fulfill({ json: { subscriptions } });
    if (path === '/api/nodes/commands') return route.fulfill({ json: { commands } });
    if (path === '/api/subscriptions/connect') {
      const rows = body!.providers!.map(provider => subscriptions.find(s => s.provider === provider) ?? waiting(provider));
      subscriptions = [...subscriptions.filter(s => !rows.some(row => row.id === s.id)), ...rows];
      return route.fulfill({ status: 201, json: make(rows) });
    }
    const again = path.match(/^\/api\/subscriptions\/([^/]+)\/command$/);
    if (again) return route.fulfill({ status: 201, json: make(subscriptions.filter(s => s.id === again[1])) });
    const hide = path.match(/^\/api\/nodes\/commands\/([^/]+)\/hide$/);
    if (hide) {
      commands = commands.map(c => c.id === hide[1] ? { ...c, dismissedSubscriptionIds: [...(c.dismissedSubscriptionIds ?? []), body!.subscriptionId!] } : c);
      return route.fulfill({ status: 204 });
    }
    return route.fallback();
  });
  await serveOwnerKey(page);
  return {
    expire: () => { commands = []; },
    join: () => { commands = []; subscriptions = subscriptions.map(s => ({ ...s, status: 'needs_login', online: true, machines: [{ id: 'demo-machine', hostname: 'demo-laptop', status: 'needs_login', online: true }] })); },
  };
}

const messages: Record<'en' | 'ru', Messages> = { en, ru };
/* The command as the server gave it, for a Mac or Linux; the one for Windows stands under it. */
const unix = (scope: Locator, t: Messages) => scope.getByRole('group', { name: t.subs.onMacLinux, exact: true });
const windows = (scope: Locator, t: Messages) => scope.getByRole('group', { name: t.subs.onWindows, exact: true });
const tab = (page: Page, t: Messages, name: 'subscriptions' | 'machines') => page.getByRole('navigation').getByRole('button', { name: t.shell.tabs[name], exact: true }).click();
const open = (page: Page, t: Messages, name: string) => page.getByRole('button', { name: t.tables.openCard(name), exact: true }).click();
async function connect(page: Page, t: Messages, name: string) {
  await page.getByRole('button', { name: t.subs.connect, exact: true }).click();
  await page.getByRole('checkbox', { name, exact: true }).check();
  await page.getByRole('button', { name: t.subs.getCommand, exact: true }).click();
}

for (const language of ['en', 'ru'] as const) for (const theme of ['light', 'dark']) for (const width of [1280, 375]) {
  test(`subscription command survives navigation and Done: ${language} ${theme} ${width}`, async ({ page }, info) => {
    const t = messages[language];
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
    await page.setViewportSize({ width, height: 900 });
    const data = await prepare(page, language, theme);
    await page.goto('/');
    await page.clock.pauseAt(START);
    await tab(page, t, 'subscriptions');
    await connect(page, t, 'Claude');
    const top = page.getByRole('region', { name: t.subs.commandHeading('Claude'), exact: true });
    const row = page.getByRole('row', { name: 'Claude', exact: true });
    await expect(row).toContainText(t.subs.states.waiting_machine);
    await expect(unix(top, t).getByRole('button', { name: t.common.copy, exact: true })).toBeVisible();
    await expect(windows(top, t).getByRole('button', { name: t.common.copy, exact: true })).toBeVisible();
    await expect(top.getByText(t.subs.runThis, { exact: true })).toBeVisible();
    const command = await unix(top, t).locator('code').textContent();
    await expect(windows(top, t).locator('code')).toHaveText(`powershell -ExecutionPolicy Bypass -c "& ([scriptblock]::Create((irm https://demo.example.test/install.ps1))) ${command!.slice(command!.indexOf('--join'))}"`);
    const screenshot = async (state: string) => {
      await page.setViewportSize({ width, height: 2200 });
      await page.locator('main').evaluate(el => { el.scrollTop = 0; });
      await page.screenshot({ path: info.outputPath(`${state}-${language}-${theme}-${width}.png`), fullPage: true });
      await page.setViewportSize({ width, height: 900 });
    };
    await screenshot('immediate');
    await tab(page, t, 'machines');
    await expect(page.getByRole('heading', { name: t.machines.heading, exact: true })).toBeVisible();
    await tab(page, t, 'subscriptions');
    await expect(unix(top, t).locator('code')).toHaveText(command!);
    await expect(top.getByRole('button', { name: t.common.done, exact: true })).toBeVisible();
    await page.reload();
    await tab(page, t, 'subscriptions');
    await expect(unix(top, t).locator('code')).toHaveText(command!);
    await top.getByRole('button', { name: t.common.done, exact: true }).click();
    await expect(top).toHaveCount(0);
    await expect(row).toContainText(t.subs.states.waiting_machine);
    await open(page, t, 'Claude');
    const card = page.getByRole('article', { name: 'Claude, Ivan', exact: true });
    await expect(unix(card, t).locator('code')).toHaveText(command!);
    await expect(card.getByText(t.subs.commandHours(21), { exact: true })).toBeVisible();
    await expect(card.getByRole('button', { name: t.subs.newCommandLabel('Claude'), exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', { name: t.common.cancel, exact: true })).toHaveCount(0);
    await screenshot('done');
    await page.reload();
    await tab(page, t, 'subscriptions');
    await open(page, t, 'Claude');
    await expect(top).toHaveCount(0);
    await expect(unix(card, t).locator('code')).toHaveText(command!);
    data.expire();
    await page.clock.fastForward(6000);
    await expect(card.locator('code')).toHaveCount(0);
    const fresh = card.getByRole('button', { name: t.subs.newCommandLabel('Claude'), exact: true });
    await expect(fresh).toHaveText(t.subs.newCommand);
    await screenshot('new');
    await fresh.click();
    await expect(unix(card, t).locator('code')).not.toHaveText(command!);
    await expect(top).toBeVisible();
    await page.context().grantPermissions(['clipboard-write']);
    const copy = unix(top, t).getByRole('button', { name: t.common.copy, exact: true });
    await copy.click();
    await expect(copy).toHaveText(t.common.copied);
    await page.clock.runFor(1000);
    await copy.click();
    await page.clock.runFor(600);
    await expect(copy).toHaveText(t.common.copied);
    await screenshot('copied-again');
    await tab(page, t, 'machines');
    await page.clock.runFor(1600);
    await tab(page, t, 'subscriptions');
    await expect(copy).toHaveText(t.common.copy);
    await open(page, t, 'Claude');
    data.join();
    await page.clock.fastForward(6000);
    await expect(top).toHaveCount(0);
    await expect(card.locator('code')).toHaveCount(0);
    await expect(row).toContainText(t.subs.states.needs_login);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('three plans keep their own row commands when two top blocks are closed', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await prepare(page, 'en', 'dark');
  await page.goto('/');
  await page.clock.pauseAt(START);
  await tab(page, en, 'subscriptions');
  for (const name of ['Claude', 'Codex', 'Kimi']) await connect(page, en, name);
  for (const name of ['Claude', 'Codex']) await page.getByRole('region', { name: en.subs.commandHeading(name), exact: true }).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('region', { name: /^Install / })).toHaveCount(1);
  for (const name of ['Claude', 'Codex', 'Kimi']) {
    await open(page, en, name);
    await expect(unix(page.getByRole('article', { name: `${name}, Ivan`, exact: true }), en).locator('code')).toHaveCount(1);
  }
  await page.reload();
  await tab(page, en, 'subscriptions');
  await expect(page.getByRole('region', { name: /^Install / })).toHaveCount(1);
});
