import { expect, test, type Page } from '@playwright/test';
import type { AgentCardView, Employee, Org, ProgramView, TurnAlarm } from '../src/types';
import { ME, serveApi } from './api';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const ROLE = { en: 'Developer', ru: 'Разработчик' };
const BRUNO: Employee = {
  id: 'b1', name: 'Bruno', roleId: 'DEV-ENG', title: ROLE, kind: 'worker', model: '', modelName: null,
  provider: 'codex', effort: null, state: 'working', status: 'working', on: true, timer: null, task: null,
  context: null, program: null, alarm: null, retry: null, failure: null,
};
const CARD: AgentCardView = {
  currentTask: null,
  id: BRUNO.id, name: BRUNO.name, kind: 'worker', role: null, department: { id: 'd2', name: 'Development' },
  product: null, model: '', effort: null, subscription: null, machine: null, state: 'working', retry: null, failure: null, skills: [], parts: [],
  raw: '', runsOn: [], changes: [], interrupted: [], canEdit: false, canRemove: false, timer: null,
};
const program = (state: ProgramView['state'], since: number): ProgramView => ({ state, since, tool: null, screenAt: NOW, signAt: null, retry: null, reportedAt: NOW });
const STATES: { name: string; program: ProgramView | null; alarm: TurnAlarm | null; held?: Employee['held']; en: string; ru: string; red: boolean; calm?: boolean }[] = [
  { name: 'thinking', program: program('thinking', NOW - 12 * 60_000), alarm: null, en: 'thinking 12 min', ru: 'думает 12 мин', red: false },
  { name: 'quiet-sign', program: { ...program('thinking', NOW - 32 * 60_000), signAt: NOW - 31 * 60_000 }, alarm: null, en: 'thinking 32 min, no sign 31 min', ru: 'думает 32 мин, без признаков 31 мин', red: false },
  { name: 'alarm', program: program('thinking', NOW - 50 * 60_000), alarm: { reason: 'program_stalled', since: NOW - 34 * 60_000 }, en: 'program frozen 34 min', ru: 'программа замерла 34 мин', red: true },
  { name: 'budget-hold', program: null, alarm: null, held: { reason: 'budget', since: new Date(NOW - 11 * 60_000).toISOString(), until: new Date(NOW + 65 * 60_000).toISOString() }, en: 'waiting: task share until 13:05', ru: 'ждет: доля тарифа на задачи до 13:05', red: false, calm: true },
  { name: 'limit-hold', program: null, alarm: null, held: { reason: 'limit', since: new Date(NOW - 11 * 60_000).toISOString(), until: new Date(NOW + 65 * 60_000).toISOString() }, en: 'waiting: plan limit until 13:05', ru: 'ждет: лимит тарифа до 13:05', red: false, calm: true },
];

function org(state: (typeof STATES)[number]): Org {
  return {
    company: ME.company, orchestrator: null, agents: { total: 1, working: 1 }, people: [], serverNow: new Date(NOW).toISOString(),
    departments: [{
      id: 'd2', name: null, templateKey: 'development', roleCode: 'DEV', about: '', agents: { total: 1, working: 1 },
      products: [], teams: [], people: [], employees: [{ ...BRUNO, program: state.program, alarm: state.alarm, held: state.held ?? null }],
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
    '/api/agents/b1/events?last=300': { events: [], state: { ready: true, reason: null, busy: true, runningJobId: 'j1', queued: 0, terminal: false } },
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
        await page.goto('/');
        await page.getByRole('button', { name: lang === 'en' ? /^Development/ : /^Разработка/ }).click();
        const chip = page.getByRole('region', { name: lang === 'en' ? 'Members' : 'Сотрудники' }).getByRole('button', { name: /Bruno/ });
        await chip.click();
        await page.getByRole('button', { name: lang === 'en' ? 'Card' : 'Карточка', exact: true }).click();
        const card = page.getByRole('complementary', { name: 'Bruno', exact: true });
        for (const state of STATES) {
          if (live.state !== state) {
            live.state = state;
            await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
          }
          await expect(chip).toContainText(state[lang]);
          const line = card.getByText(state[lang], { exact: true });
          await expect(line).toBeVisible();
          await expect(line).toHaveClass(state.red ? /alarm/ : state.calm ? /calm/ : /work/);
          if (state.red) await expect(line).toHaveCSS('background-color', theme === 'light' ? 'rgb(198, 40, 40)' : 'rgb(255, 107, 107)');
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          await page.screenshot({ path: info.outputPath(`agent-${width}-${lang}-${theme}-${state.name}.png`) });
        }
        expect(errors).toEqual([]);
      });
    }
  }
}
