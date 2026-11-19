import { expect, test, type Page } from '@playwright/test';
import type { MachineView, Org, SubView } from '../src/types';
import { ME, serveApi, writeToOrchestrator } from './api';

const HOST = 'worker-linux';
const VERSION = { version: '0.6.1', commit: '6ae552b' };
const GIB = 1024 ** 3;
const ERROR = 'error while loading shared libraries: libnss3.so: cannot open shared object file';

async function openMachines(page: Page, language: 'en' | 'ru', theme: 'light' | 'dark', browserError: string | null = ERROR) {
  await serveApi(page);
  await page.addInitScript(({ language, theme }) => {
    localStorage.setItem('hh-lang', language);
    localStorage.setItem('hh-theme', theme);
  }, { language, theme });
  const plans: SubView[] = [{
    id: 'plan-1', provider: 'claude', kind: 'personal', label: 'Claude', status: 'ready', online: true,
    last4: null, owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company', id: null, name: 'Whole company' },
    machines: [{ id: 'm1', hostname: HOST, status: 'ready', online: true }], limits: null, budget: null, isOrchestrator: true, accounts: [], tier: null, accountsDiffer: false, signedInOnce: true, leaseMachine: null,
  }];
  const machine: MachineView = {
    id: 'm1', hostname: HOST, os: 'linux', arch: 'x86_64', owner: { id: 'p1', name: 'Ivan' }, online: true, lastSeenAt: null,
    plans: [{ id: 'plan-1', provider: 'claude', status: 'ready', online: true }],
    load: { cpus: 8, load: 1, memFree: 10 * GIB, memTotal: 16 * GIB, jobs: 0, tests: 0, cpuModel: 'AMD EPYC', diskFree: 200 * GIB, diskTotal: 500 * GIB },
    lendsTests: true, running: { agents: [], parts: [] }, browserError,
  };
  const org: Org = {
    company: ME.company,
    orchestrator: { id: 'a1', name: 'Orchestrator', model: 'claude-opus-5-5', effort: null, subscription: plans[0]!, machine: { id: 'm1', hostname: HOST }, context: null, program: null, alarm: null, retry: null, failure: null },
    agents: { total: 1, working: 0 },
    people: [],
    departments: [{ id: 'd2', name: 'Development', templateKey: null, roleCode: 'CTO', about: '', agents: { total: 0, working: 0 }, products: [], teams: [], people: [], employees: [], roles: [] }],
  };
  await page.route('**/api/org', route => route.fulfill({ json: org }));
  await page.route('**/api/machines', route => route.fulfill({ json: { machines: [machine], builtin: null } }));
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: plans } }));
  await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/machines/access', route => route.fulfill({ json: { views: [] } }));
  await page.route('**/api/agents/orchestrator/start', route => route.fulfill({ json: { started: false } }));
  await page.route('**/api/agents/orchestrator/events*', route => route.fulfill({ json: {
    events: [],
    state: { ready: true, reason: null, browserError, busy: false, runningJobId: null, queued: 0, terminal: false },
  } }));
  await page.route('**/api/version', route => route.fulfill({ json: VERSION }));
  await page.route('**/api/updates', route => route.fulfill({ json: {
    current: { ...VERSION, migrations: 51 }, available: false, checkedAt: null, latest: null, versions: [], error: null,
    updater: { present: false, status: null, waiting: null },
  } }));
  await page.goto('/');
  await page.getByRole('button', { name: language === 'en' ? 'Machines' : 'Машины', exact: true }).click();
  await page.getByRole('button', { name: `${language === 'en' ? 'Open the card of' : 'Открыть карточку'} ${HOST}`, exact: true }).click();
  return page.getByRole('article', { name: HOST });
}

for (const language of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1280, 375]) {
  test(`browser failure status ${language} ${theme} ${width}`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('response', res => { if (res.url().includes('/api/') && res.status() >= 400) errors.push(`${res.status()} ${res.url()}`); });
    await page.setViewportSize({ width, height: width === 375 ? 1800 : 1150 });
    const card = await openMachines(page, language, theme);
    const badge = language === 'en' ? 'Browser failed' : 'Браузер не запустился';
    const expected = language === 'en'
      ? `The browser for checks did not start (${ERROR}). Run the install command on this machine again without --join, or check the node logs.`
      : `Браузер для проверок не запустился (${ERROR}). Выполните на этой машине команду установки еще раз без --join или посмотрите журнал ноды.`;
    await expect(page.getByRole('row', { name: HOST }).locator('.marks > span')).not.toHaveClass('dim');
    await expect(card.getByText(badge, { exact: true })).toBeVisible();
    await expect(card.getByText(expected, { exact: true })).toBeVisible();
    await page.evaluate(async () => { await document.fonts.ready; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`browser-failed-${language}-${theme}-${width}.png`), fullPage: true });
    await page.getByRole('navigation').getByRole('button', { name: language === 'en' ? 'Tasks' : 'Задачи', exact: true }).click();
    await writeToOrchestrator(page, language);
    const win = page.getByRole('complementary', { name: language === 'en' ? 'Orchestrator' : 'Оркестратор', exact: true });
    const windowWarning = language === 'en'
      ? `Browser checks cannot run on Ivan's machine right now (${ERROR}).`
      : `Браузерные проверки на машине (владелец Ivan) сейчас не пойдут (${ERROR}).`;
    await expect(win.getByText(windowWarning, { exact: true })).toBeVisible();
    await expect(win.getByRole('textbox')).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`browser-warning-window-${language}-${theme}-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
  });
}
