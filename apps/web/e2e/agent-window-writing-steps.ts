import { expect, type Locator, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { AGENT_HIDDEN, chooseTerminal } from './api';
import { serveAgentWindow, type AgentFixture } from './agent-window-api';
import { ORCHESTRATOR, ORCHESTRATOR_CARD, VIEWERS, type Agent, type Settings, type Viewer } from './agent-window-steps';

/* What reached the server from this person, and the keys that reached the terminal. */
type Sent = { messages: { agent: string; text: string }[]; keys: string[] };

export async function serve(page: Page, viewer: Viewer, settings: Settings): Promise<Sent> {
  const { me, types } = VIEWERS[viewer];
  const sent: Sent = { messages: [], keys: [] };
  await page.setViewportSize({ width: settings.width, height: 900 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, settings);
  await chooseTerminal(page);
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
export async function checkWrites(page: Page, window: Locator, agent: Agent, settings: Settings, sent: Sent) {
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
