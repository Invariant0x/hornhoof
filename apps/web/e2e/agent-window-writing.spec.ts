import { expect, test, type Locator, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { ComputerView } from '../src/types';
import { box } from './api';
import { serveAgentWindow, SUB, type AgentFixture } from './agent-window-api';
import { checkPage, open, ORCHESTRATOR, ORCHESTRATOR_CARD, shot, VIEWERS, watchErrors, type Agent, type Settings, type Viewer } from './agent-window-steps';

const ASKED: ComputerView = { available: true, until: null, asked: { reason: 'Restart the nodes outside AppArmor.', at: '2026-11-04T14:30:00.000Z' }, machine: 'a-host', canAnswer: true };
const REFUSED = { error: { code: 'forbidden', message: 'This employee works in a department you do not have.', reason: 'not_your_department' } };

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
  const live: AgentFixture = { awake: true, hasTask: false, messages: [], connections: 0, canType: types, orchestrator: ORCHESTRATOR };
  await serveAgentWindow(page, live);
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const said = /^\/api\/agents\/(orchestrator|b1)\/messages$/.exec(url.pathname);
    if (said && route.request().method() === 'POST') {
      sent.messages.push({ agent: said[1]!, ...(route.request().postDataJSON() as { text: string }) });
      return route.fulfill({ status: 202, json: { jobId: 'j2' } });
    }
    if (url.pathname.startsWith('/api/agents/s1')) return route.fulfill({ status: 403, json: REFUSED });
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
    ws.send(JSON.stringify({ type: 'ready', write: types }));
    ws.send(JSON.stringify({ type: 'program', running: true }));
    ws.send(JSON.stringify({ type: 'data', data: 'The program runs on its plan.\r\n> ' }));
  });
  return sent;
}

/* The line stands under the terminal inside the window, with room left for the terminal. */
async function checkLineUnderTerminal(window: Locator, line: Locator) {
  const frame = await box(window);
  const screen = await box(window.locator('.t-term'));
  const form = await box(line.locator('xpath=ancestor::form'));
  expect(form.y).toBeGreaterThanOrEqual(screen.y + screen.height);
  expect(form.y + form.height).toBeLessThanOrEqual(frame.y + frame.height);
  expect(form.x).toBeGreaterThanOrEqual(frame.x);
  expect(form.x + form.width).toBeLessThanOrEqual(frame.x + frame.width);
  expect(screen.height).toBeGreaterThan(200);
}

/* Someone who only watches: keys in the terminal go nowhere, and the line sends to the agent in the person's name. */
async function checkWrites(page: Page, window: Locator, agent: Agent, settings: Settings, sent: Sent) {
  const t = settings.lang === 'en' ? en : ru;
  const name = agent === 'orchestrator' ? t.window.placeholder : t.window.writeTo('Bruno');
  const line = window.getByRole('textbox', { name, exact: true });
  await expect(line).toBeVisible();
  await expect(line).toBeFocused();
  await expect(window.getByText(t.window.hint)).toBeVisible();
  await checkLineUnderTerminal(window, line);
  await expect(window.locator('.xterm-screen')).toBeVisible();
  await window.locator('.xterm-screen').click();
  await page.keyboard.type('keys');
  await page.keyboard.press('Enter');
  await line.fill('Please check the release');
  await line.press('Enter');
  await expect.poll(() => sent.messages).toEqual([{ agent, text: 'Please check the release' }]);
  await expect(line).toHaveValue('');
  expect(sent.keys).toEqual([]);
}

for (const lang of ['en', 'ru'] as const) for (const theme of ['light', 'dark'] as const) for (const width of [1440, 375]) {
  const settings = { lang, theme, width };
  const t = lang === 'en' ? en : ru;
  test.describe(`writing to an agent in ${lang}, ${theme}, at ${width}px`, () => {
    for (const agent of ['orchestrator', 'b1'] as const) {
      test(`the CEO delegate writes to ${agent} under its terminal`, async ({ page }, info) => {
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

    test('the line stands under the strip of a machine the orchestrator asks for', async ({ page }, info) => {
      const errors = watchErrors(page);
      const sent = await serve(page, 'delegate', settings);
      await page.route('**/api/computer', route => route.fulfill({ json: ASKED }));
      const window = await open(page, 'orchestrator', lang);
      const line = window.getByRole('textbox', { name: t.window.placeholder, exact: true });
      const strip = window.getByRole('region', { name: t.window.computerAsks(ASKED.machine!) });
      await expect(strip).toBeVisible();
      const below = await box(strip);
      const form = await box(line.locator('xpath=ancestor::form'));
      expect(below.y + below.height).toBeLessThanOrEqual(form.y);
      await checkLineUnderTerminal(window, line);
      await checkWrites(page, window, 'orchestrator', settings, sent);
      await shot(page, info, 'delegate-orchestrator-strip', settings);
      await checkPage(page, errors);
    });

    test('a person with the department writes to its employee on another plan', async ({ page }, info) => {
      const errors = watchErrors(page);
      const sent = await serve(page, 'department', settings);
      const window = await open(page, 'b1', lang);
      await checkWrites(page, window, 'b1', settings, sent);
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
      const alert = page.getByRole('alert').filter({ hasText: t.errors.not_your_department });
      await expect(alert).toBeVisible();
      await expect(page.locator('form.t-in')).toHaveCount(0);
      await expect(page.locator('.xterm-screen')).toHaveCount(0);
      await shot(page, info, 'department-other-employee', settings);
    });
  });
}

test('the line grows with a long message and leaves the terminal on a phone', async ({ page }) => {
  const settings = { lang: 'en', theme: 'dark', width: 375 } as const;
  const errors = watchErrors(page);
  const sent = await serve(page, 'delegate', settings);
  const window = await open(page, 'orchestrator', 'en');
  const line = window.getByRole('textbox', { name: en.window.placeholder, exact: true });
  await line.fill(Array.from({ length: 20 }, (_, i) => `Line ${i + 1}, a long one that wraps at phone width`).join('\n'));
  await checkLineUnderTerminal(window, line);
  await line.press('Enter');
  await expect.poll(() => sent.messages.length).toBe(1);
  await checkPage(page, errors);
});

test('the line stays when the person looks at the log and comes back to the terminal', async ({ page }) => {
  const settings = { lang: 'en', theme: 'light', width: 1440 } as const;
  const errors = watchErrors(page);
  await serve(page, 'delegate', settings);
  const window = await open(page, 'orchestrator', 'en');
  const line = window.getByRole('textbox', { name: en.window.placeholder, exact: true });
  await expect(line).toBeFocused();
  await line.fill('A draft');
  await window.getByRole('button', { name: en.window.showLog, exact: true }).click();
  await expect(window.getByRole('log')).toBeVisible();
  await expect(line).toHaveValue('A draft');
  await window.getByRole('button', { name: en.window.showTerminal, exact: true }).click();
  await expect(window.locator('.xterm-screen')).toBeVisible();
  await expect(line).toHaveValue('A draft');
  await expect(line).toBeFocused();
  await checkPage(page, errors);
});
