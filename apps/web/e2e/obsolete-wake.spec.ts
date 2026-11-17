import { expect, test } from '@playwright/test';
import type { AgentCardView, Employee, Org, ProgramView } from '../src/types';
import { ME, serveApi } from './api';

test.describe.configure({ timeout: 120_000 });

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const ROLE = { en: 'Developer', ru: 'Разработчик' };
const BRUNO: Employee = {
  id: 'b1', name: 'Bruno', roleId: 'DEV-ENG', title: ROLE, kind: 'worker', model: '', modelName: null,
  provider: 'codex', effort: null, state: 'working', status: 'working', on: true, timer: null, task: null,
  context: null, program: null, alarm: null, retry: null, failure: null, obsolete: { at: NOW - 60_000 },
};
const CARD: AgentCardView = {
  currentTask: null,
  id: BRUNO.id, name: BRUNO.name, kind: 'worker', role: null, department: { id: 'd2', name: 'Development' },
  product: null, model: '', effort: null, subscription: null, machine: null, state: 'working', retry: null, failure: null, obsolete: { at: NOW - 60_000 }, skills: [], parts: [],
  raw: '', runsOn: [], changes: [], interrupted: [], canEdit: false, canRemove: false, timer: null,
};
const PROGRAM: ProgramView = { state: 'thinking', since: NOW - 12 * 60_000, tool: null, screenAt: NOW, signAt: null, retry: null, reportedAt: NOW };
const ORG: Org = {
  company: ME.company, orchestrator: null, agents: { total: 1, working: 1 }, people: [], serverNow: new Date(NOW).toISOString(),
  departments: [{
    id: 'd2', name: null, templateKey: 'development', roleCode: 'DEV', about: '', agents: { total: 1, working: 1 },
    products: [], teams: [], people: [], employees: [{ ...BRUNO, program: PROGRAM }],
    roles: [{ id: 'DEV-ENG', title: ROLE, description: ROLE, kind: 'member', gate: null }],
  }],
};

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      test(`obsolete wake in ${lang}, ${theme}, at ${width}px`, async ({ page }, info) => {
        await serveApi(page);
        const routes: Record<string, unknown> = {
          '/api/org': ORG,
          '/api/version': { version: '0.6.1', commit: 'browser-test' },
          '/api/updates': { current: { version: '0.6.1', commit: 'browser-test' }, available: false, latest: null, updater: { status: null, waiting: null } },
          '/api/tasks?status=open&department=d2': { tasks: [] },
          '/api/agents/b1': CARD,
          '/api/agents/b1/events?last=300': { events: [], state: { ready: true, reason: null, busy: true, runningJobId: 'j1', queued: 0, terminal: false } },
        };
        await page.route('**/api/**', route => {
          const url = new URL(route.request().url());
          const path = url.pathname + url.search;
          return path in routes ? route.fulfill({ json: routes[path] }) : route.fallback();
        });
        await page.addInitScript(({ lang, theme }) => {
          localStorage.setItem('hh-lang', lang);
          localStorage.setItem('hh-theme', theme);
        }, { lang, theme });
        await page.setViewportSize({ width, height: 900 });
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        await page.goto('/');
        await page.getByRole('button', { name: lang === 'en' ? /^Development/ : /^Разработка/ }).click();
        await page.getByRole('region', { name: lang === 'en' ? 'Members' : 'Сотрудники' }).getByRole('button', { name: /Bruno/ }).click();
        await page.getByRole('button', { name: lang === 'en' ? 'Card' : 'Карточка', exact: true }).click();
        const card = page.getByRole('complementary', { name: 'Bruno', exact: true });
        await expect(card.getByText(lang === 'en' ? 'Wake-up became obsolete: the task moved on' : 'Побудка устарела: задача ушла дальше', { exact: true })).toBeVisible();
        await expect(card.getByText(/Last turn failed|Последний ход не удался/)).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: info.outputPath(`obsolete-wake-${width}-${lang}-${theme}.png`) });
        expect(errors).toEqual([]);
      });
    }
  }
}
