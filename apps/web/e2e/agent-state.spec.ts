import { expect, test, type Page } from '@playwright/test';
import type { AgentCardView, Employee, Org, ProgramView, TurnAlarm } from '../src/types';
import { ME, serveApi } from './api';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const ROLE = { en: 'Developer', ru: 'Разработчик' };
const BRUNO: Employee = {
  id: 'b1', name: 'Bruno', roleId: 'DEV-ENG', title: ROLE, kind: 'worker', model: '', modelName: null,
  provider: 'codex', effort: null, state: 'working', status: 'working', on: true, timer: null, task: null,
  context: null, program: null, alarm: null,
};
const CARD: AgentCardView = {
  id: BRUNO.id, name: BRUNO.name, kind: 'worker', role: null, department: { id: 'd2', name: 'Development' },
  product: null, model: '', effort: null, subscription: null, machine: null, state: 'working', skills: [], parts: [],
  raw: '', instructions: { length: 0, max: 200_000 }, runsOn: [], changes: [], interrupted: [], canEdit: false, timer: null,
};
const program = (state: ProgramView['state'], since: number): ProgramView => ({ state, since, tool: null, screenAt: NOW, reportedAt: NOW });
const STATES: { name: string; program: ProgramView; alarm: TurnAlarm | null; en: string; ru: string; red: boolean }[] = [
  { name: 'thinking', program: program('thinking', NOW - 12 * 60_000), alarm: null, en: 'thinking 12 min', ru: 'думает 12 мин', red: false },
  { name: 'lost-end', program: program('idle', NOW - 61_000), alarm: null, en: 'turn end lost: waiting for input', ru: 'конец хода потерян: ждет ввода', red: true },
  { name: 'alarm', program: program('thinking', NOW - 50 * 60_000), alarm: { reason: 'program_stalled', since: NOW - 34 * 60_000 }, en: 'program frozen 34 min', ru: 'программа замерла 34 мин', red: true },
];

function org(state: (typeof STATES)[number]): Org {
  return {
    company: ME.company, orchestrator: null, agents: { total: 1, working: 1 }, people: [], serverNow: new Date(NOW).toISOString(),
    departments: [{
      id: 'd2', name: null, templateKey: 'development', roleCode: 'DEV', about: '', agents: { total: 1, working: 1 },
      products: [], teams: [], people: [], employees: [{ ...BRUNO, program: state.program, alarm: state.alarm }],
      roles: [{ id: 'DEV-ENG', title: ROLE, description: ROLE, kind: 'member', gate: null }],
    }],
  };
}

async function serveAgent(page: Page, live: { state: (typeof STATES)[number] }) {
  await serveApi(page);
  const routes: Record<string, unknown> = {
    get '/api/org'() { return org(live.state); },
    '/api/version': { version: '0.5.0', commit: 'task-124' },
    '/api/updates': { current: { version: '0.5.0', commit: 'task-124' }, available: false, latest: null, updater: { status: null, waiting: null } },
    '/api/tasks?status=open&department=d2': { tasks: [] },
    '/api/agents/b1': CARD,
    '/api/agents/b1/events?after=0': { events: [], state: { ready: true, reason: null, busy: true, runningJobId: 'j1', queued: 0, terminal: false } },
  };
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const path = url.pathname + url.search;
    return path in routes ? route.fulfill({ json: routes[path] }) : route.fallback();
  });
}

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      test(`numeric program times in ${lang}, ${theme}, at ${width}px`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(({ lang, theme }) => {
          localStorage.setItem('hh-lang', lang);
          localStorage.setItem('hh-theme', theme);
        }, { lang, theme });
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        const live = { state: STATES[0]! };
        await serveAgent(page, live);
        for (const state of STATES) {
          live.state = state;
          await page.goto('/');
          await page.getByRole('button', { name: lang === 'en' ? /Development/ : /Разработка/ }).click();
          await page.getByRole('region', { name: lang === 'en' ? 'Members' : 'Сотрудники' }).getByRole('button', { name: /Bruno/ }).click();
          await page.getByRole('button', { name: lang === 'en' ? 'Card' : 'Карточка', exact: true }).click();
          const card = page.getByRole('complementary', { name: 'Bruno', exact: true });
          const line = card.getByText(state[lang], { exact: true });
          await expect(line).toBeVisible();
          await expect(line).toHaveClass(state.red ? /alarm/ : /work/);
          if (state.red) await expect(line).toHaveCSS('background-color', theme === 'light' ? 'rgb(211, 47, 47)' : 'rgb(255, 107, 107)');
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          await page.screenshot({ path: info.outputPath(`agent-${width}-${lang}-${theme}-${state.name}.png`) });
        }
        expect(errors).toEqual([]);
      });
    }
  }
}
