import { expect, type Page } from '@playwright/test';
import type { ComputerAccessView } from '../src/types';
import { chooseTerminal, serveApi, writeToOrchestrator } from './api';

/* The orchestrator's window with its terminal, and access to a machine as the server keeps it. */

export type Settings = { lang: 'en' | 'ru'; theme: 'light' | 'dark'; width: number };

const view = (name: string, over: Partial<Omit<ComputerAccessView, 'machine'>> = {}): ComputerAccessView => ({
  machine: { id: name, networkId: `n-${name}`, name, hostname: name, personId: 'p1', role: 'worker', os: 'linux', data: false },
  reachable: true, open: false, scope: null, employees: [], canOpen: true, canClose: true,
  ...over,
});
export const OPEN = view('node-a', { open: true, scope: 'orchestrator' });
export const CLOSED = view('node-a');
export const SECOND = view('node-b', { open: true, scope: 'orchestrator' });
export const MANY: ComputerAccessView[] = Array.from({ length: 12 }, (_, i) => view(`host-${i + 1}`, { open: true, scope: 'orchestrator' }));

export const WORDS = {
  en: {
    orchestrator: 'Orchestrator', tasks: 'Tasks',
    open: 'Access to node-a', asks: 'The orchestrator asks for access to node-a', second: 'Access to node-b',
    close: 'Close access', openDay: 'Open for a day', notNow: 'Not now', more: 'More about access to node-a',
    others: 'Other machines with access: 1', oneMore: '1 more', decided: 'Decided by the CEO or the CEO delegate.',
    what: /For a day it runs commands as root on node-a/, until: /Access to node-a is open until/,
  },
  ru: {
    orchestrator: 'Оркестратор', tasks: 'Задачи',
    open: 'Доступ к машине node-a', asks: 'Оркестратор просит доступ к машине node-a', second: 'Доступ к машине node-b',
    close: 'Закрыть доступ', openDay: 'Открыть на сутки', notNow: 'Не сейчас', more: 'Подробнее о доступе к машине node-a',
    others: 'Другие машины с доступом: 1', oneMore: 'еще 1', decided: /заместитель/,
    what: /На сутки он сможет выполнять команды с полными правами на машине node-a/, until: /Доступ к машине node-a открыт до/,
  },
};

export const SETTINGS: Settings[] = (['en', 'ru'] as const).flatMap(lang => (['light', 'dark'] as const).flatMap(theme => [1440, 375].map(width => ({ lang, theme, width }))));

/* The window of the orchestrator with its terminal, and the machines' access as the server keeps it, changed by the
   buttons: each answers for its own machine. */
/* terminal: what the program says of itself (running, or asleep until its next turn) and what its terminal shows. */
export type TerminalShows = { program?: Record<string, unknown>; data?: string };

export async function openWindow(page: Page, { lang, theme, width }: Settings, first: ComputerAccessView, others: ComputerAccessView[] = [], extra: Record<string, unknown> = {}, terminal: TerminalShows = {}) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, { lang, theme });
  await chooseTerminal(page);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url}`); });
  const posts: string[] = [];
  let views = [first, ...others];
  const ACCESS = /^\/api\/machines\/([^/]+)\/access\/(open|close)$/;
  await serveApi(page);
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const answered = ACCESS.exec(path);
    if (answered) {
      const [, id, action] = answered;
      posts.push(path);
      const next = view(id!, action === 'open' ? { open: true, scope: 'orchestrator' } : {});
      views = views.map(one => (one.machine.id === id ? next : one));
      return route.fulfill({ json: next });
    }
    if (path === '/api/machines/access') return route.fulfill({ json: { views } });
    if (path in extra) return route.fulfill({ json: extra[path] });
    if (path === '/api/nodes/commands') return route.fulfill({ json: { commands: [] } });
    if (path === '/api/version') return route.fulfill({ json: { version: '0.5.0', commit: 'b77ce08' } });
    if (path === '/api/updates') return route.fulfill({ json: { current: { version: '0.5.0', commit: 'b77ce08' }, available: false, latest: null, updater: { status: null, waiting: null } } });
    if (path === '/api/agents/orchestrator/start') return route.fulfill({ json: { started: false } });
    if (path === '/api/agents/orchestrator/events') return route.fulfill({ json: { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0, terminal: true } } });
    return route.fallback();
  });
  await page.routeWebSocket('**/api/agents/orchestrator/terminal*', ws => {
    ws.send(JSON.stringify({ type: 'ready', write: true }));
    ws.send(JSON.stringify({ type: 'program', ...(terminal.program ?? { running: true }) }));
    ws.send(JSON.stringify({ type: 'data', data: terminal.data ?? 'The orchestrator is at work.\r\n> ' }));
  });
  await page.goto('/');
  const words = WORDS[lang];
  await page.getByRole('navigation').getByRole('button', { name: words.tasks, exact: true }).click();
  await writeToOrchestrator(page, lang);
  const window = page.getByRole('complementary', { name: words.orchestrator, exact: true });
  await expect(window).toBeVisible();
  return { words, window, errors, posts };
}
