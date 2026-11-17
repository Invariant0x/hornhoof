import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { LANGUAGES, type Language, type Messages } from '../src/i18n';
import type { AgentCardView, Employee, Org } from '../src/types';
import { ME, serveApi } from './api';

const HEAD = `Hana-${'long-head-name-'.repeat(12)}`;
const PERSON = `Dana-${'long-owner-name-'.repeat(12)}`;
const AT = '2026-10-30T09:00:00.000Z';
const WORKER: Employee = {
  id: 'b1', name: 'Bruno', roleId: 'DEV-ENG', title: { en: 'Engineer', ru: 'Инженер' }, kind: 'worker', model: '', modelName: null,
  provider: 'codex', effort: null, state: 'sleeping', status: 'idle', on: true, timer: null, task: null,
  context: null, program: null, alarm: null, retry: null, failure: null,
};
const ORG: Org = {
  company: ME.company, orchestrator: null, agents: { total: 1, working: 0 }, people: [],
  departments: [{ id: 'd2', name: 'Development', templateKey: null, roleCode: 'DEV', about: '', agents: { total: 1, working: 0 },
    products: [], teams: [], people: [], employees: [WORKER], roles: [] }],
};
const CARD: AgentCardView = {
  id: WORKER.id, name: WORKER.name, kind: 'worker', role: null, department: { id: 'd2', name: 'Development' },
  currentTask: null, product: null, team: null, teams: [], model: '', effort: null, subscription: null, machine: null,
  state: 'sleeping', program: null, alarm: null, retry: null, failure: null, skills: [], parts: [], raw: '',
  instructions: { length: 0, max: 200_000 }, runsOn: [], interrupted: [], canEdit: false, canRemove: false, timer: null,
  changes: [
    { field: 'name', personName: PERSON, actingAgent: { id: 'removed-head', name: HEAD }, byOrchestrator: false, at: AT },
    { field: 'skills', personName: 'Ivan', actingAgent: null, byOrchestrator: false, at: AT },
    { field: 'switch', personName: null, actingAgent: null, byOrchestrator: true, at: AT },
    { field: 'reset', personName: null, actingAgent: null, byOrchestrator: false, at: AT },
  ],
};

async function wordsFor(locale: Language): Promise<Messages> {
  return (await import(`../src/i18n/${locale}.ts`) as Record<string, Messages>)[locale]!;
}

/* Rank the actual history sentences of every shipped locale, so adding a language changes this check's matrix. */
const ranking = await Promise.all(LANGUAGES.map(async ({ id }) => {
  const t = await wordsFor(id);
  const strings = [t.agent.history, ...CARD.changes.map(c => t.agent.changed(t.agent.fields[c.field]!, c.actingAgent ? t.agent.byHead(c.actingAgent.name, c.personName) : c.byOrchestrator ? t.agent.byOrchestrator : c.personName, AT))];
  return { id, characters: strings.join('').length };
}));
ranking.sort((a, b) => a.characters - b.characters || a.id.localeCompare(b.id));
const rtl = LANGUAGES.find(({ id }) => /^(ar|he|fa|ur)(-|$)/.test(id));
const locales = [...new Set([ranking[0]!.id, ranking.at(-1)!.id, ...(rtl ? [rtl.id] : [])])];

/* Leave the app before removing its held SSE route, as the other real-page checks do. */
test.afterEach(async ({ page }) => {
  await page.goto('about:blank');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

for (const locale of locales) {
  for (const theme of ['light', 'cyberpunk']) {
    for (const width of [375, 1280]) {
      test(`employee history in ${locale}, ${theme}, at ${width}px`, async ({ page }, info) => {
        const t = await wordsFor(locale);
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
        await page.setViewportSize({ width, height: 900 });
        await page.clock.install({ time: new Date('2026-11-17T08:00:00.000Z') });
        await page.addInitScript(({ locale, theme }) => {
          localStorage.setItem('hh-lang', locale);
          localStorage.setItem('hh-theme', theme);
        }, { locale, theme });
        await serveApi(page);
        const routes: Record<string, unknown> = {
          '/api/org': ORG,
          '/api/version': { version: '0.31.1', commit: 'employee-history-fixture' },
          '/api/updates': { current: { version: '0.31.1', commit: 'employee-history-fixture' }, available: false, latest: null, updater: { status: null, waiting: null } },
          '/api/tasks?status=open&department=d2': { tasks: [] },
          '/api/agents/b1': CARD,
          '/api/agents/b1/events?last=300': { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0, terminal: false } },
        };
        await page.route('**/api/**', route => {
          const url = new URL(route.request().url());
          const path = url.pathname + url.search;
          return path in routes ? route.fulfill({ json: routes[path] }) : route.fallback();
        });
        await page.goto('/departments/d2');
        await page.getByRole('region', { name: t.dept.members, exact: true }).getByRole('button', { name: /Bruno/ }).click();
        await page.getByRole('button', { name: t.window.card, exact: true }).click();
        const card = page.getByRole('complementary', { name: t.window.cardOf('Bruno'), exact: true });
        const history = card.locator('section.ac-history').filter({ has: page.getByRole('heading', { name: t.agent.history, exact: true }) });
        await history.scrollIntoViewIfNeeded();
        await page.evaluate(() => document.fonts.ready);
        const lines = history.getByRole('listitem');
        await expect(lines).toHaveCount(4);
        await expect(lines.nth(0)).toContainText(t.agent.byHead(HEAD, PERSON));
        await expect(lines.nth(1)).toContainText('Ivan');
        await expect(lines.nth(2)).toContainText(t.agent.byOrchestrator);
        await expect(lines.nth(3)).not.toContainText(PERSON);
        const fits = () => history.evaluate(root => [root, root.closest('.ac-body')!, ...root.querySelectorAll('li')].every(element => element.scrollWidth <= element.clientWidth));
        expect(await fits()).toBe(true);
        /* Prove the geometry assertion detects the long actor being clipped or overflowing. */
        await lines.nth(0).evaluate(li => { li.style.whiteSpace = 'nowrap'; });
        expect(await fits()).toBe(false);
        await lines.nth(0).evaluate(li => { li.style.removeProperty('white-space'); });
        expect(await fits()).toBe(true);
        const geometry = await history.evaluate(root => {
          const body = root.closest('.ac-body')!;
          const list = root.querySelector('ul')!;
          return { width: root.getBoundingClientRect().width, height: root.getBoundingClientRect().height,
            clientWidth: body.clientWidth, scrollWidth: body.scrollWidth, color: getComputedStyle(list).color,
            font: getComputedStyle(list).fontFamily, gap: getComputedStyle(list).gap,
            token: getComputedStyle(root).getPropertyValue('--muted').trim() };
        });
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const look = `${locale}-${theme}-${width}`;
        await writeFile(info.outputPath('sizes.json'), JSON.stringify([{ browser: info.project.name, look, screen: 'employee-history', sizes: { width: geometry.width, height: geometry.height } }]));
        await info.attach('geometry', { body: JSON.stringify({ geometry, ranking, rtl: rtl?.id ?? 'NOT_AVAILABLE' }), contentType: 'application/json' });
        await page.screenshot({ path: info.outputPath(`${look}.png`), animations: 'disabled' });
        expect(errors).toEqual([]);
      });
    }
  }
}
