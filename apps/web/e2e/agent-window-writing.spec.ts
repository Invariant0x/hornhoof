import { expect, test, type Locator, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { ComputerView } from '../src/types';
import { AGENT_HIDDEN, box } from './api';
import { serveAgentWindow, SUB, type AgentFixture } from './agent-window-api';
import { checkPage, open, ORCHESTRATOR, ORCHESTRATOR_CARD, shot, VIEWERS, watchErrors, type Agent, type Settings, type Viewer } from './agent-window-steps';

const ASKED: ComputerView = { available: true, until: null, asked: { reason: 'Restart the nodes outside AppArmor.', at: '2026-11-04T14:30:00.000Z' }, machine: 'a-host', canAnswer: true };

/* What reached the server from this person, and the keys that reached the terminal. */
type Sent = { messages: { agent: string; text: string }[]; keys: string[] };

async function serve(page: Page, viewer: Viewer, settings: Settings): Promise<Sent> {
  const { me, types } = VIEWERS[viewer];
  const sent: Sent = { messages: [], keys: [] };
  await page.setViewportSize({ width: settings.width, height: 900 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, settings);
  const live: AgentFixture = { awake: true, hasTask: false, messages: [], connections: 0, canType: types, orchestrator: ORCHESTRATOR, viewer: me };
  await serveAgentWindow(page, live);
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const said = /^\/api\/agents\/(orchestrator|b1)\/messages$/.exec(url.pathname);
    if (said && route.request().method() === 'POST') {
      sent.messages.push({ agent: said[1]!, ...(route.request().postDataJSON() as { text: string }) });
      return route.fulfill({ status: 202, json: { jobId: 'j2' } });
    }
    if (url.pathname.startsWith('/api/agents/s1')) return route.fulfill({ status: 403, json: AGENT_HIDDEN });
    if (url.pathname === '/api/me') return route.fulfill({ json: me });
    if (url.pathname === '/api/computer') return route.fulfill({ json: { available: false, until: null, asked: null } });
    if (url.pathname === '/api/agents/orchestrator') return route.fulfill({ json: ORCHESTRATOR_CARD });
    if (url.pathname === '/api/agents/orchestrator/start') return route.fulfill({ json: { started: false } });
    if (url.pathname === '/api/agents/orchestrator/events') return route.fulfill({ json: { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0, terminal: true, canType: types } } });
    return route.fallback();
  });
  await page.routeWebSocket('**/api/agents/*/terminal*', ws => {
    ws.onMessage(raw => {
      const frame = JSON.parse(String(raw)) as { type: string; data?: string };
      if (frame.type === 'input') sent.keys.push(frame.data!);
    });
    ws.send(JSON.stringify({ type: 'ready', write: types, message: true }));
    ws.send(JSON.stringify({ type: 'program', running: true }));
    ws.send(JSON.stringify({ type: 'data', data: 'The program runs on its plan.\r\n> ' }));
  });
  return sent;
}

/* Someone on the plan of another: words and Enter go into the terminal, whose server opens their turn, and no second line
   stands under it. A key that steers stays here, and the window says why. */
async function checkWrites(page: Page, window: Locator, agent: Agent, settings: Settings, sent: Sent) {
  const t = settings.lang === 'en' ? en : ru;
  const name = agent === 'orchestrator' ? t.window.placeholder : t.window.writeTo('Bruno');
  await expect(window.locator('.xterm-screen')).toBeVisible();
  await expect(window.getByRole('textbox', { name, exact: true })).toHaveCount(0);
  await expect(window.locator('form.t-in')).toHaveCount(0);
  await expect(window.getByText(t.window.hint)).toHaveCount(0);
  await window.locator('.xterm-screen').click();
  await page.keyboard.type('Please check');
  await page.keyboard.press('Enter');
  await expect.poll(() => sent.keys.join('')).toBe('Please check\r');
  await page.keyboard.press('Escape');
  await expect(window.getByRole('alert').filter({ hasText: t.window.controlDenied })).toBeVisible();
  expect(sent.keys.join('')).toBe('Please check\r');
  expect(sent.messages).toEqual([]);
}

for (const lang of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1440, 375]) {
  const settings = { lang, theme, width };
  const t = lang === 'en' ? en : ru;
  test.describe(`writing to an agent in ${lang}, ${theme}, at ${width}px`, () => {
    for (const agent of ['orchestrator', 'b1'] as const) {
      test(`the CEO delegate writes to ${agent} in its terminal`, async ({ page }, info) => {
        const errors = watchErrors(page);
        const sent = await serve(page, 'delegate', settings);
        const window = await open(page, agent, lang);
        await checkWrites(page, window, agent, settings, sent);
        await shot(page, info, `delegate-${agent}`, settings);
        await checkPage(page, errors);
      });

      test(`the plan's owner types into the terminal of ${agent}, with no line under it`, async ({ page }, info) => {
        const errors = watchErrors(page);
        const sent = await serve(page, 'owner', settings);
        const window = await open(page, agent, lang);
        await expect(window.locator('.xterm-screen')).toBeVisible();
        await expect(window.getByRole('textbox', { name: agent === 'orchestrator' ? t.window.placeholder : t.window.writeTo('Bruno'), exact: true })).toHaveCount(0);
        await expect(window.locator('form.t-in')).toHaveCount(0);
        await window.locator('.xterm-screen').click();
        await page.keyboard.type('hi');
        await page.keyboard.press('Enter');
        await expect.poll(() => sent.keys.join('')).toBe('hi\r');
        expect(sent.messages).toEqual([]);
        await shot(page, info, `owner-${agent}`, settings);
        await checkPage(page, errors);
      });
    }

    test('the strip of a machine the orchestrator asks for stands under the terminal, inside the window', async ({ page }, info) => {
      const errors = watchErrors(page);
      const sent = await serve(page, 'delegate', settings);
      await page.route('**/api/computer', route => route.fulfill({ json: ASKED }));
      const window = await open(page, 'orchestrator', lang);
      const strip = window.getByRole('region', { name: t.window.computerAsks(ASKED.machine!) });
      await expect(strip).toBeVisible();
      const below = await box(strip);
      const terminal = await box(window.locator('.t-term'));
      const frame = await box(window);
      expect(terminal.y + terminal.height).toBeLessThanOrEqual(below.y);
      expect(below.y + below.height).toBeLessThanOrEqual(frame.y + frame.height);
      expect(terminal.height).toBeGreaterThan(200);
      await checkWrites(page, window, 'orchestrator', settings, sent);
      await shot(page, info, 'delegate-orchestrator-strip', settings);
      await checkPage(page, errors);
    });

    test('a department alone does not let a person open an employee on another plan', async ({ page }, info) => {
      const errors = watchErrors(page);
      const sent = await serve(page, 'department', settings);
      await page.goto('/departments/d2');
      await expect(page.getByRole('region', { name: lang === 'en' ? 'Members' : 'Сотрудники' })).not.toContainText('Bruno');
      await expect(page.locator('body')).not.toContainText('Bruno');
      await expect(page.getByRole('button', { name: /Bruno/ })).toHaveCount(0);
      await expect(page.getByRole('complementary', { name: /Bruno/ })).toHaveCount(0);
      await expect(page.locator('.xterm-screen')).toHaveCount(0);
      await expect(page.locator('form.t-in')).toHaveCount(0);
      expect(sent.keys).toEqual([]);
      expect(sent.messages).toEqual([]);
      await shot(page, info, 'department-b1', settings);
      await checkPage(page, errors);
    });

    test('a person with the department is not offered the orchestrator', async ({ page }, info) => {
      const errors = watchErrors(page);
      await serve(page, 'department', settings);
      await page.goto('/');
      await expect(page.locator('.hub')).toBeVisible();
      await expect(page.getByRole('button', { name: t.map.openOrchestrator, exact: true })).toHaveCount(0);
      await expect(page.getByRole('complementary', { name: t.window.title })).toHaveCount(0);
      await expect(page.locator('form.t-in')).toHaveCount(0);
      await shot(page, info, 'department-orchestrator', settings);
      await checkPage(page, errors);
    });

    test('a person is turned away from an employee of another department, with no line', async ({ page }, info) => {
      await serve(page, 'department', settings);
      await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [{ ...SUB, agents: [{ id: 's1', canOpen: true, name: 'Sam', title: { en: 'Seller', ru: 'Продавец' }, department: { id: 'd3', name: 'Sales' }, provider: 'codex', busy: true, since: null, task: null, withCeo: false }] }] } }));
      await page.goto('/');
      await page.getByRole('navigation', { name: lang === 'en' ? 'Sections' : 'Разделы' }).getByRole('button', { name: t.shell.tabs.subscriptions, exact: true }).click();
      await page.getByRole('button', { name: new RegExp(`${lang === 'en' ? 'Open the card of' : 'Открыть карточку'}.*Codex`) }).click();
      await page.getByRole('button', { name: t.window.openAgent('Sam'), exact: true }).click();
      await expect(page.getByRole('heading', { name: t.routes.accessDenied })).toBeVisible();
      await expect(page.locator('form.t-in')).toHaveCount(0);
      await expect(page.locator('.xterm-screen')).toHaveCount(0);
      await shot(page, info, 'department-other-employee', settings);
    });
  });
}

test('the line of the log keeps its draft while the person looks at the terminal, which has no line', async ({ page }) => {
  const settings = { lang: 'en', theme: 'light', width: 1440 } as const;
  const errors = watchErrors(page);
  await serve(page, 'delegate', settings);
  const window = await open(page, 'orchestrator', 'en');
  const line = window.getByRole('textbox', { name: en.window.placeholder, exact: true });
  await expect(line).toHaveCount(0);
  await window.getByRole('button', { name: en.window.showLog, exact: true }).click();
  await expect(window.getByRole('log')).toBeVisible();
  await line.fill('A draft');
  await window.getByRole('button', { name: en.window.showTerminal, exact: true }).click();
  await expect(window.locator('.xterm-screen')).toBeVisible();
  await expect(line).toHaveCount(0);
  await window.getByRole('button', { name: en.window.showLog, exact: true }).click();
  await expect(line).toHaveValue('A draft');
  await checkPage(page, errors);
});
