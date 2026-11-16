import { expect, type Locator, type Page } from '@playwright/test';
import type { AgentCardView, NoteView } from '../src/types';
import { CARD, serveAgentWindow, type AgentFixture } from './agent-window-api';
import { box, chooseTerminal } from './api';
import { CLOSED, openWindow, SETTINGS, type Settings } from './computer-strip-api';

/* The side panels of an agent's window, for the orchestrator and for an employee who heads a department and so keeps a
   notebook too. */

export type Who = 'orchestrator' | 'employee';
export const PEOPLE: Who[] = ['orchestrator', 'employee'];
export const WIDE = SETTINGS.filter(s => s.width === 1440);
export const NARROW = SETTINGS.filter(s => s.width === 375);
type Rect = { x: number; y: number; width: number; height: number };

const WORDS = {
  en: { card: 'Card', notebook: 'Notebook', task: 'Task', close: 'Close', log: 'Chat', terminal: 'Terminal', full: 'Full screen', size: 'Restore size', minimize: 'Minimize', restore: 'Restore', members: 'Members', notes: 'Notebook', back: 'Back to terminal', backToChat: 'Back to conversation' },
  ru: { card: 'Карточка', notebook: 'Блокнот', task: 'Задача', close: 'Закрыть', log: 'Чат', terminal: 'Терминал', full: 'На весь экран', size: 'Обычный размер', minimize: 'Свернуть', restore: 'Развернуть', members: 'Сотрудники', notes: 'Блокнот', back: 'К терминалу', backToChat: 'К переписке' },
};

const NOTES: NoteView[] = [{ number: 1, text: 'Turns stay small.', by: { kind: 'orchestrator' }, updatedAt: '2026-11-04T00:00:00.000Z' }];
const CURRENT = { id: 't1', number: 1, title: 'Checkout step 1' };
const ORCHESTRATOR_CARD: AgentCardView = { ...CARD, id: 'a1', kind: 'orchestrator', name: 'Orchestrator', role: null, department: null, currentTask: CURRENT };

export const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/* The stack the panels stand in tells nothing a person sees, so a panel is found by its name, inside this window. */
const panelNames = (who: Who, words: (typeof WORDS)['en']) => ({
  task: '#1 Checkout step 1',
  card: `${words.card}: ${who === 'orchestrator' ? (words === WORDS.en ? 'Orchestrator' : 'Оркестратор') : 'Bruno'}`,
  notebook: words.notes,
});

async function openOrchestrator(page: Page, settings: Settings) {
  const { window, errors } = await openWindow(page, settings, CLOSED, [], {
    '/api/agents/orchestrator': ORCHESTRATOR_CARD,
    '/api/notebook': { notes: NOTES },
    '/api/subscriptions': { subscriptions: [] },
    '/api/machines': { machines: [] },
  });
  return { window, errors, connections: () => 1, stops: [] as string[], sent: [] as string[] };
}

async function openEmployee(page: Page, { lang, theme, width }: Settings) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, { lang, theme });
  await chooseTerminal(page);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url}`); });
  const sent: string[] = [];
  const live: AgentFixture = { awake: true, hasTask: true, messages: [], connections: 0, head: true, sent };
  await serveAgentWindow(page, live);
  const stops: string[] = [];
  await page.route('**/api/agents/b1/stop', route => { stops.push(route.request().method()); return route.fulfill({ json: {} }); });
  await page.goto('/');
  await page.getByRole('button', { name: /^Development/ }).click();
  await page.getByRole('region', { name: WORDS[lang].members }).getByRole('button', { name: /Bruno/ }).click();
  return { window: page.getByRole('complementary', { name: /^Bruno,/ }), errors, connections: () => live.connections, stops, sent };
}

export async function openAgent(page: Page, settings: Settings, who: Who) {
  const { window, errors, connections, stops, sent } = await (who === 'orchestrator' ? openOrchestrator(page, settings) : openEmployee(page, settings));
  const words = WORDS[settings.lang];
  const names = panelNames(who, words);
  await expect(window.locator('.xterm-screen')).toBeVisible();
  const toggle = (name: keyof typeof names) => window.locator(':scope > .t-bar').getByRole('button', { name: words[name], exact: true });
  const panel = (name: keyof typeof names) => window.getByRole('complementary', { name: names[name], exact: true });
  const openPanel = async (name: keyof typeof names) => {
    await toggle(name).click();
    await expect(panel(name)).toBeVisible();
    return panel(name);
  };
  const bar = window.locator(':scope > .t-bar');
  return { window, errors, connections, stops, sent, words, names, bar, back: bar.getByRole('button', { name: words.back, exact: true }), toggle, panel, openPanel, terminal: window.locator('.t-term') };
}

/* Where each button of a window's bar stands. */
export const barButtons = (bar: Locator) => bar.getByRole('button').evaluateAll(buttons => buttons.map(b => { const r = b.getBoundingClientRect(); return { name: b.getAttribute('aria-label') ?? b.textContent, x: r.x, y: r.y, width: r.width, height: r.height }; }));

/* Each panel stands on the screen and clear of the others. */
export async function expectApart(page: Page, panels: Locator[]) {
  const rects = await Promise.all(panels.map(box));
  const width = page.viewportSize()!.width;
  for (const [i, rect] of rects.entries()) {
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(width);
    for (const other of rects.slice(i + 1)) expect(overlaps(rect, other)).toBe(false);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  return rects;
}

const IN_THE_LIST = 'panels: sidePanels';

/* A panel made only through the shared mechanism: one line in the window's list, with no layout of its own. */
export async function addTestPanel(page: Page) {
  await page.route('**/src/screens/AgentWindow.tsx*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    if (!source.includes(IN_THE_LIST)) throw new Error(`The window's panels are no longer passed as "${IN_THE_LIST}".`);
    await route.fulfill({ response, body: source.replace(IN_THE_LIST, 'panels: [...sidePanels, framedPanel("test", "Test panel", "M4 4h16v16H4z", "What the test panel says")]') });
  });
}
