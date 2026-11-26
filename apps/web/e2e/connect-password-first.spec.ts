import { join } from 'node:path';
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { isPseudoLocaleId, LOCALES, SOURCE_LOCALE, type Direction } from '@hornhoof/protocol';
import { en, type Messages } from '../src/i18n/en';
import type { Language, ShippedLanguage } from '../src/i18n/plural';
import { pseudoMessages } from '../src/i18n/pseudo';
import { ru } from '../src/i18n/ru';
import type { MachineView, ShownCommand, SubView } from '../src/types';
import { ME, serveApi, serveOwnerKey } from './api';
import { open as openAgentWindow } from './agent-window-steps';

const HOST = 'test-laptop';
const PASSWORD = 'fixture password';
const JOIN = 'curl -fsSL https://demo.example.test/install.sh | bash -s -- --join TEST_ONLY';
const MACHINE: MachineView = {
  id: 'm1', hostname: HOST, os: 'linux', arch: 'x86_64', online: true,
  owner: { id: 'p1', name: 'Ivan' }, lastSeenAt: null, load: null, plans: [],
  lendsTests: true, running: { agents: [], parts: [] },
};
const PLANS = [
  ['claude', 'Claude'], ['codex', 'Codex'], ['antigravity', 'Antigravity'],
] as const;
type Plan = typeof PLANS[number];
type Flow = { id: string; plan: Plan } | { id: 'add-my-plan' | 'connect-machine' };
const FLOWS: Flow[] = [...PLANS.map(plan => ({ id: plan[0], plan })), { id: 'add-my-plan' }, { id: 'connect-machine' }];
const sub = ([provider, label]: Plan): SubView => ({
  id: `plan-${provider}`, provider, label, kind: 'personal', owner: MACHINE.owner, status: 'waiting_machine', online: false,
  machines: [], last4: null, place: { kind: 'company', id: null, name: 'Whole company' }, limits: null, budget: null,
  isOrchestrator: false, accounts: [], tier: null, accountsDiffer: false, signedInOnce: false, leaseMachine: null,
});

async function serve(page: Page, flow: Flow, language: Language, theme: string, plans: readonly Plan[] = 'plan' in flow ? [flow.plan] : []) {
  let subscriptions = flow.id === 'add-my-plan' ? [sub(PLANS[0])] : [];
  let commands: ShownCommand[] = [];
  const make = (kind: ShownCommand['kind'], targets: SubView[] = []): ShownCommand => ({
    id: 'a'.repeat(64), kind, plans: targets.map(target => target.label), subscriptionIds: targets.map(target => target.id),
    dismissedSubscriptionIds: [], machine: kind === 'add' ? HOST : null, ...(kind === 'add' ? { machineId: MACHINE.id } : {}),
    command: JOIN,
    expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
  });
  let key: { publicKey: string } | null = null;
  await serveApi(page);
  await page.route('**/api/me/key', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { key } });
    const { password, ...made } = route.request().postDataJSON() as { password: string; publicKey: string };
    if (password !== PASSWORD) {
      return route.fulfill({ status: 401, json: { error: { code: 'unauthorized', reason: 'wrong_password', message: 'Wrong password' } } });
    }
    key = made;
    return route.fulfill({ status: 204 });
  });
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions } }));
  await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands } }));
  await page.route('**/api/machines', route => route.fulfill({ json: { machines: [MACHINE], builtin: null } }));
  await page.route('**/api/subscriptions/connect', route => {
    if (!('plan' in flow)) return route.fallback();
    subscriptions = plans.map(sub);
    commands = [make('plans', subscriptions)];
    return route.fulfill({ status: 201, json: { ...commands[0], subscriptions } });
  });
  await page.route('**/api/machines/command', route => {
    commands = [make('machine')];
    return route.fulfill({ status: 201, json: commands[0] });
  });
  await page.route(`**/api/machines/${MACHINE.id}/plans`, route => {
    commands = [make('add', subscriptions)];
    return route.fulfill({ status: 201, json: commands[0] });
  });
  await page.addInitScript(({ language, theme }) => {
    localStorage.setItem('hh-lang', language);
    localStorage.setItem('hh-theme', theme);
  }, { language, theme });
}

async function open(page: Page, flow: Flow, t: Messages): Promise<Locator> {
  const tab = 'plan' in flow ? 'subscriptions' : 'machines';
  await page.getByRole('navigation').getByRole('button', { name: t.shell.tabs[tab], exact: true }).click();
  if ('plan' in flow) {
    await page.getByRole('button', { name: t.subs.connect, exact: true }).click();
    await page.getByRole('checkbox', { name: flow.plan[1], exact: true }).check();
    await page.getByRole('button', { name: t.subs.getCommand, exact: true }).click();
    return page.getByRole('region', { name: t.subs.commandHeading(flow.plan[1]), exact: true });
  }
  if (flow.id === 'add-my-plan') {
    await page.getByRole('button', { name: t.tables.openCard(HOST), exact: true }).click();
    const card = page.getByRole('article', { name: HOST, exact: true });
    await card.getByRole('button', { name: t.machines.addPlanLabel(HOST), exact: true }).click();
    await card.getByRole('button', { name: t.machines.addPlanTo('Claude', HOST), exact: true }).click();
    return card.locator('.add-plan');
  }
  await page.getByRole('button', { name: t.machines.connect, exact: true }).click();
  return page.locator('.panel').filter({ has: page.getByRole('heading', { name: t.machines.connectHeading, exact: true }) });
}

function runText(flow: Flow, t: Messages): string {
  if ('plan' in flow) return t.subs.runThis;
  return flow.id === 'add-my-plan' ? t.machines.runOn(HOST) : t.machines.runThis;
}

async function fits(scope: Locator) {
  const problems = await scope.evaluate(root => {
    const overflows = [...root.querySelectorAll<HTMLElement>('p, label, code, button')].filter(el =>
      el.getClientRects().length > 0 && (getComputedStyle(el).textOverflow === 'ellipsis' || el.scrollWidth > el.clientWidth + 1));
    return { page: document.documentElement.scrollWidth > innerWidth + 1, text: overflows.map(el => el.textContent) };
  });
  expect(problems).toEqual({ page: false, text: [] });
}

async function screenshot(scope: Locator, info: TestInfo, name: string) {
  if (!process.env.HH_CONNECT_SHOTS) return;
  const path = process.env.HH_OUT ? join(process.env.HH_OUT, 'connect-shots', name) : info.outputPath(name);
  await scope.screenshot({ path, animations: 'disabled' });
}

function length(t: Messages): number {
  const steps = t.subs.steps;
  return [steps.run, steps.connect, steps.ready, steps.now.run, steps.now.password, steps.now.copy,
    t.subs.ownerKeyMake, t.subs.ownerKeyWrong, t.common.password, t.common.next, t.common.cancel,
    t.subs.onMacLinux, t.subs.onWindows, t.subs.runThis, t.machines.runOn(HOST), t.machines.runThis].join('').length;
}

const dictionaries: Record<ShippedLanguage, Messages> = { en, ru };
const shipped: { id: ShippedLanguage; dir: Direction; t: Messages }[] = LOCALES.map(({ id, dir }) => ({ id, dir, t: dictionaries[id] }));
shipped.sort((a, b) => length(a.t) - length(b.t));
const looks = new Set<Language>([SOURCE_LOCALE, shipped[0]!.id, shipped.at(-1)!.id, 'en-XL']);
const rtl = shipped.find(({ dir }) => dir === 'rtl');
if (rtl) looks.add(rtl.id);

for (const flow of FLOWS) for (const language of looks) {
  const t = isPseudoLocaleId(language) ? pseudoMessages(language, en) : dictionaries[language];
  for (const theme of ['light', 'dark']) for (const width of [1440, 375]) {
    test(`${flow.id}: password then command at ${width}, ${language}, ${theme}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 1000 });
      await serve(page, flow, language, theme);
      await page.goto('/');
      const scope = await open(page, flow, t);
      const step = scope.locator('[aria-current="step"]').first();
      const password = scope.getByLabel(t.common.password, { exact: true });
      const firstCopy = 'plan' in flow ? t.subs.steps.now.run : t.subs.steps.now.copy;
      const copyLine = scope.getByText(firstCopy, { exact: true });
      await expect(password).toBeVisible();
      expect(await copyLine.count()).toBe(0);
      expect(await scope.locator('code').count()).toBe(0);
      await expect(step.getByText(t.subs.steps.now.password, { exact: true })).toBeVisible();
      await expect(step.getByLabel(t.common.password, { exact: true })).toBeVisible();
      const replacement = step.locator('.command-box').first();
      await expect(replacement.getByLabel(t.common.password, { exact: true })).toBeVisible();
      const explanation = scope.getByText(runText(flow, t), { exact: true });
      await expect(explanation).toBeVisible();
      expect((await password.boundingBox())!.y).toBeLessThan((await explanation.boundingBox())!.y);
      await page.evaluate(() => document.fonts.ready);
      await fits(scope);
      const name = `${flow.id}-${theme}-${width}`;
      if (language === SOURCE_LOCALE) await screenshot(scope, info, `${name}-locked.png`);

      if (flow.id === 'claude' && language === SOURCE_LOCALE) {
        await password.fill('wrong fixture password');
        await password.press('Enter');
        await expect(scope.getByText(t.subs.ownerKeyWrong, { exact: true })).toBeVisible();
        await expect(password).toBeFocused();
        await expect(password).toHaveCSS('outline-style', 'solid');
        await expect(password).toHaveCSS('outline-width', '2px');
        await screenshot(scope, info, `${name}-error-focus.png`);
      }

      await password.fill(PASSWORD);
      await scope.getByRole('button', { name: t.common.next, exact: true }).click();
      const code = replacement.locator('code').first();
      await expect(code).toBeVisible();
      await expect(code).toContainText('--join TEST_ONLY --owner-key');
      await expect(copyLine).toBeVisible();
      await expect(password).toHaveCount(0);
      await expect(step.getByText(t.subs.steps.now.password, { exact: true })).toHaveCount(0);
      await page.evaluate(() => document.fonts.ready);
      await fits(scope);
      if (language === SOURCE_LOCALE) await screenshot(scope, info, `${name}-unlocked.png`);
    });
  }
}

test('one install command asks for the password in every selected plan at 375, en, dark', async ({ page }, info) => {
  await page.setViewportSize({ width: 375, height: 1000 });
  await serve(page, { id: 'claude', plan: PLANS[0] }, 'en', 'dark', PLANS);
  await page.goto('/');
  await page.getByRole('navigation').getByRole('button', { name: en.shell.tabs.subscriptions, exact: true }).click();
  await page.getByRole('button', { name: en.subs.connect, exact: true }).click();
  for (const [, name] of PLANS) await page.getByRole('checkbox', { name, exact: true }).check();
  await page.getByRole('button', { name: en.subs.getCommand, exact: true }).click();

  const cards = PLANS.map(([, name]) => page.getByRole('region', { name: en.subs.commandHeading(name), exact: true }));
  for (const card of cards) {
    const step = card.getByRole('listitem').first();
    await expect(step.getByLabel(en.common.password, { exact: true })).toBeVisible();
    await expect(step.getByText(en.subs.steps.now.password, { exact: true })).toBeVisible();
    await expect(step.locator('code')).toHaveCount(0);
  }
  const codex = cards[1]!;
  await screenshot(codex, info, 'shared-command-codex-dark-375-locked.png');
  await codex.getByLabel(en.common.password, { exact: true }).fill(PASSWORD);
  await codex.getByRole('button', { name: en.common.next, exact: true }).click();
  for (const card of cards) {
    const step = card.getByRole('listitem').first();
    await expect(step.locator('code').first()).toBeVisible();
    await expect(step.getByText(en.subs.steps.now.run, { exact: true })).toBeVisible();
    await expect(step.getByLabel(en.common.password, { exact: true })).toHaveCount(0);
  }
  await screenshot(codex, info, 'shared-command-codex-dark-375-unlocked.png');
});

for (const theme of ['light', 'dark']) for (const width of [1440, 375]) {
  test(`setup reuses the account password at ${width}, en, ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(skin => {
      localStorage.setItem('hh-lang', 'en');
      localStorage.setItem('hh-theme', skin);
    }, theme);
    await serveApi(page);
    await page.route('**/api/setup', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 201, json: { ...ME, command: JOIN } })
      : route.fulfill({ json: { needed: true } }));
    await page.route('**/api/me/key', route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { key: null } });
      expect(route.request().postDataJSON()).toMatchObject({ password: PASSWORD });
      return route.fulfill({ status: 204 });
    });
    await page.goto('/setup?code=FIXTURE_ONLY');
    await page.getByLabel(en.setup.companyName, { exact: true }).fill('Acme');
    await page.getByRole('checkbox', { name: en.link.open, exact: true }).uncheck();
    await page.getByRole('button', { name: en.common.next, exact: true }).click();
    await page.getByLabel(en.setup.yourName, { exact: true }).fill('Ivan');
    await page.getByLabel(en.common.email, { exact: true }).fill('ivan@example.test');
    await page.getByLabel(en.common.password, { exact: true }).fill(PASSWORD);
    await page.getByRole('button', { name: en.common.next, exact: true }).click();
    await page.getByRole('radio', { name: en.setup.modes.personal.label, exact: true }).check();
    await page.getByRole('button', { name: en.setup.finish, exact: true }).click();
    const scope = page.locator('.card').filter({ has: page.getByRole('heading', { name: en.setup.connectMachine, exact: true }) });
    await expect(scope.locator('code').first()).toContainText('--join TEST_ONLY --owner-key');
    await expect(scope.getByText(en.subs.steps.now.copy, { exact: true })).toBeVisible();
    expect(await scope.getByLabel(en.common.password, { exact: true }).count()).toBe(0);
    await page.evaluate(() => document.fonts.ready);
    await fits(scope);
    await screenshot(scope, info, `setup-${theme}-${width}-unlocked.png`);
  });
}

for (const state of ['pending', 'refused', 'failed', 'finished']) for (const control of ['done', 'close']) {
  test(`${control} dismisses a ${state} agent connect command through the next refresh`, async ({ page }) => {
    await page.clock.install();
    await page.addInitScript(() => localStorage.setItem('hh-lang', 'en'));
    await serveApi(page);
    await serveOwnerKey(page);
    const command: ShownCommand = {
      id: 'b'.repeat(64), kind: 'add', plans: ['Codex'], machine: HOST, machineId: MACHINE.id,
      command: JOIN, expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
    };
    const other: ShownCommand = { ...command, id: 'c'.repeat(64), plans: ['Claude'] };
    let commands = [command];
    let cancelled = false;
    await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands } }));
    await page.route(`**/api/nodes/commands/${command.id}/hide`, route => {
      cancelled = true;
      return route.fulfill({ status: 204 });
    });

    const agent = await openAgentWindow(page, 'orchestrator', 'en');
    const card = agent.getByRole('region', { name: en.window.commandAdd('Codex', HOST), exact: true });
    await expect(card.locator('code').first()).toContainText('--owner-key');
    await card.getByRole('button', { name: control === 'done' ? en.common.done : en.window.close, exact: true }).click();
    expect(await card.count()).toBe(0);
    /* The installer runs outside the web app. Its pending, refused and failed attempts leave the command active.
       A successful join consumes it, so the next command list leaves it out. */
    commands = state === 'finished' ? [other] : [command, other];
    await page.clock.fastForward(15_000);
    await expect(agent.getByRole('region', { name: en.window.commandAdd('Claude', HOST), exact: true })).toBeVisible();
    await expect(card).toHaveCount(0);
    const reopened = await openAgentWindow(page, 'orchestrator', 'en');
    await expect(reopened.getByRole('region', { name: en.window.commandAdd('Claude', HOST), exact: true })).toBeVisible();
    await expect(reopened.getByRole('region', { name: en.window.commandAdd('Codex', HOST), exact: true })).toHaveCount(0);
    expect(cancelled).toBe(false);
  });
}
