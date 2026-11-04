import { expect, type Page } from '@playwright/test';
import type { ComputerView } from '../src/types';
import { serveApi } from './api';

/* The orchestrator's window with its terminal, and access to a machine as the server keeps it. */

export type Settings = { lang: 'en' | 'ru'; theme: 'light' | 'dark'; width: number };

export const REASON = 'Restart the nodes outside AppArmor, then clean the Docker images that the last three releases left on the disk of this machine.';
export const UNTIL = '2026-11-05T14:30:00.000Z';
export const OPEN: ComputerView = { available: true, until: UNTIL, asked: null, machine: 'a-host', canAnswer: true };
export const ASKED: ComputerView = { available: true, until: null, asked: { reason: REASON, at: '2026-11-04T14:30:00.000Z' }, machine: 'a-host', canAnswer: true };
export const CLOSED: ComputerView = { available: true, until: null, asked: null, machine: 'a-host', canAnswer: true };
export const SECOND: ComputerView = { ...OPEN, machine: 'b-host' };
export const MANY: ComputerView[] = Array.from({ length: 12 }, (_, i) => ({ ...OPEN, machine: `host-${i + 1}` }));

export const WORDS = {
  en: {
    orchestrator: 'Orchestrator', write: 'Write to the orchestrator', tasks: 'Tasks',
    open: 'Access to a-host', asks: 'The orchestrator asks for access to a-host', second: 'Access to b-host',
    close: 'Close access', openDay: 'Open for a day', notNow: 'Not now', more: 'More about access to a-host',
    others: 'Other machines with access: 1', oneMore: '1 more', decided: 'Decided by the CEO or the CEO delegate.',
    what: /For a day it runs commands as root on a-host/, until: /The orchestrator can run commands on a-host until/,
  },
  ru: {
    orchestrator: 'Оркестратор', write: 'Написать оркестратору', tasks: 'Задачи',
    open: 'Доступ к машине a-host', asks: 'Оркестратор просит доступ к машине a-host', second: 'Доступ к машине b-host',
    close: 'Закрыть доступ', openDay: 'Открыть на сутки', notNow: 'Не сейчас', more: 'Подробнее о доступе к машине a-host',
    others: 'Другие машины с доступом: 1', oneMore: 'еще 1', decided: /заместитель/,
    what: /На сутки он сможет выполнять команды с полными правами на машине a-host/, until: /Оркестратор может выполнять команды на машине a-host до/,
  },
};

export const SETTINGS: Settings[] = (['en', 'ru'] as const).flatMap(lang => (['light', 'dark'] as const).flatMap(theme => [1440, 375].map(width => ({ lang, theme, width }))));

const ONE_MACHINE = 'machines: computer ? [computer] : []';

/* The server keeps access to one machine, so the others reach the window's own list in its source as the dev server gives
   it. Once /api/computer answers with several, they come from there and this goes. */
async function addMachines(page: Page, others: ComputerView[]) {
  await page.route('**/src/screens/AgentWindow.tsx*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    if (!source.includes(ONE_MACHINE)) throw new Error(`The window's list of machines is no longer written as "${ONE_MACHINE}".`);
    await route.fulfill({ response, body: source.replace(ONE_MACHINE, `machines: computer ? [computer, ...${JSON.stringify(others)}] : []`) });
  });
}

/* The window of the orchestrator with its terminal, and /api/computer as the server keeps it, changed by the buttons. */
export async function openWindow(page: Page, { lang, theme, width }: Settings, first: ComputerView, others: ComputerView[] = []) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
  }, { lang, theme });
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${m.text()} ${m.location().url}`); });
  const posts: string[] = [];
  let view = first;
  const answers: Record<string, ComputerView> = { '/api/computer/open': OPEN, '/api/computer/close': CLOSED, '/api/computer/decline': CLOSED };
  await serveApi(page);
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path in answers) {
      posts.push(path);
      view = answers[path]!;
      return route.fulfill({ json: view });
    }
    if (path === '/api/computer') return route.fulfill({ json: view });
    if (path === '/api/nodes/commands') return route.fulfill({ json: { commands: [] } });
    if (path === '/api/version') return route.fulfill({ json: { version: '0.5.0', commit: 'b77ce08' } });
    if (path === '/api/updates') return route.fulfill({ json: { current: { version: '0.5.0', commit: 'b77ce08' }, available: false, latest: null, updater: { status: null, waiting: null } } });
    if (path === '/api/agents/orchestrator/start') return route.fulfill({ json: { started: false } });
    if (path === '/api/agents/orchestrator/events') return route.fulfill({ json: { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0, terminal: true } } });
    return route.fallback();
  });
  await page.routeWebSocket('**/api/agents/orchestrator/terminal*', ws => {
    ws.send(JSON.stringify({ type: 'ready', write: true }));
    ws.send(JSON.stringify({ type: 'program', running: true }));
    ws.send(JSON.stringify({ type: 'data', data: 'The orchestrator is at work.\r\n> ' }));
  });
  if (others.length) await addMachines(page, others);
  await page.goto('/');
  const words = WORDS[lang];
  await page.getByRole('navigation').getByRole('button', { name: words.tasks, exact: true }).click();
  await page.getByRole('button', { name: words.write, exact: true }).click();
  const window = page.getByRole('complementary', { name: words.orchestrator, exact: true });
  await expect(window).toBeVisible();
  return { words, window, errors, posts };
}
