import { expect, test, type Page } from '@playwright/test';
import type { AgentCardView, EventView } from '../src/types';
import { chooseTerminal, serveApi } from './api';
import { bigCompany } from './big-company-api';
import { growth, installRenderProbe, listenersGrown, readListeners, readProbe, sendLiveApart, settled, type RenderProbe } from './render-probe';

const AT = '2026-11-14T18:00:00.000Z';
const COMPANY = bigCompany();
const DEPT = COMPANY.departments[0]!;
const HEAD = DEPT.employees[0]!;
const AGENT_IDS = COMPANY.departments.flatMap(d => d.employees.map(e => e.id));
const CYCLES = 10;

const HEAD_CARD: AgentCardView = {
  id: HEAD.id, currentTask: null, kind: 'head', name: HEAD.name,
  role: { id: HEAD.roleId ?? 'r0-head', title: { en: 'Head', ru: 'Глава' }, description: { en: '', ru: '' } },
  department: { id: DEPT.id, name: DEPT.name ?? 'Department 1' }, product: null, team: null, teams: [],
  model: 'claude-opus-5-5', effort: null, subscription: null, machine: null, state: 'working', retry: null, failure: null,
  skills: [], parts: [], raw: '', instructions: { length: 1200, max: 200_000 }, runsOn: [], changes: [], interrupted: [], timer: null,
  canEdit: true, canRemove: false,
};
const HEAD_EVENTS: EventView[] = [{ seq: 1, kind: 'text', data: { text: 'Working on it.' }, jobId: 'j1', person: null, at: AT }];
const HEAD_STATE = { ready: true, reason: null, busy: true, runningJobId: 'j1', queued: 0, terminal: true, canType: true, turnRefused: null };

/* The company of 120 agents, its head's window with a live terminal, and every request it makes counted by path. */
async function bigCompanyServer(page: Page): Promise<Map<string, number>> {
  const asked = new Map<string, number>();
  page.on('request', r => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith('/api/')) asked.set(path, (asked.get(path) ?? 0) + 1);
  });
  await chooseTerminal(page);
  await serveApi(page);
  await page.route('**/api/org', route => route.fulfill({ json: COMPANY }));
  await page.route('**/api/link', route => route.fulfill({ json: { domain: 'hornhoof.app', link: null } }));
  await page.route(`**/api/agents/${HEAD.id}`, route => route.fulfill({ json: HEAD_CARD }));
  await page.route(`**/api/agents/${HEAD.id}/events*`, route => route.fulfill({ json: { events: HEAD_EVENTS, state: HEAD_STATE } }));
  await page.routeWebSocket(`**/api/agents/${HEAD.id}/terminal*`, ws => {
    ws.onMessage(() => {});
    ws.send(JSON.stringify({ type: 'ready', write: true, message: true }));
    ws.send(JSON.stringify({ type: 'program', running: true }));
    ws.send(JSON.stringify({ type: 'data', data: 'READY\r\n> ' }));
  });
  return asked;
}

/* The head's window opens from its department with its terminal, as the person last chose, and closes, back to the map. */
async function windowCycle(page: Page) {
  await page.locator('.map .dept').first().click();
  await page.locator('button.shead').click();
  const window = page.locator('aside.orch');
  await expect(window).toBeVisible();
  await expect(window.locator('.xterm-rows')).toContainText('READY');
  await window.getByRole('button', { name: 'Close', exact: true }).first().click();
  await expect(window).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to the map' }).click();
  await expect(page.locator('.map .dept')).toHaveCount(COMPANY.departments.length);
}

/* The company settings open from the account menu and close. */
async function formCycle(page: Page) {
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Company settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Company settings', exact: true });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

/* The map goes away for the tasks and comes back with all 12 departments. */
async function mapCycle(page: Page) {
  const nav = page.getByRole('navigation', { name: 'Sections' });
  await nav.getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(page.locator('.map')).toHaveCount(0);
  await nav.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.locator('.map .dept')).toHaveCount(COMPANY.departments.length);
}

/* Nothing is left to happen: no timer waits, no request is on its way, and the screen drew what came. */
async function quiet(page: Page) {
  await settled(page);
  await expect.poll(async () => (await readProbe(page)).timeouts).toBe(0);
  await page.waitForLoadState('networkidle');
  await settled(page);
}

/* A burst of the stream as 120 working agents make it in a moment: context bars, states, tasks, questions, the company. */
const burst = (): unknown[] => [
  ...AGENT_IDS.map((agentId, i) => ({ type: 'context', agentId, used: (i % 10) / 10 + 0.05 })),
  ...Array.from({ length: 60 }, (_, i) => ({ type: 'working', working: 40 + (i % 20) })),
  ...Array.from({ length: 40 }, () => ({ type: 'task' })),
  ...Array.from({ length: 40 }, () => ({ type: 'requests' })),
  ...Array.from({ length: 20 }, () => ({ type: 'org' })),
];

const report = (label: string, values: unknown) => {
  test.info().annotations.push({ type: label, description: JSON.stringify(values) });
  console.log(`RENDER-HEALTH ${test.info().project.name} ${label} ${JSON.stringify(values)}`);
};

test.describe('a 120-agent company in the browser', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('leaves nothing alive behind its windows, forms and map after ten rounds', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(installRenderProbe);
    await bigCompanyServer(page);
    await page.goto('/');
    await expect(page.locator('.map .dept')).toHaveCount(COMPANY.departments.length);
    /* One round first: what loads once, the code of a screen or a cache it fills, is no leak. */
    await windowCycle(page);
    await formCycle(page);
    await mapCycle(page);
    await quiet(page);
    const before = await readProbe(page);
    const listenersBefore = await readListeners(page);
    for (let i = 0; i < CYCLES; i++) {
      await windowCycle(page);
      await formCycle(page);
      await mapCycle(page);
    }
    await quiet(page);
    const after = await readProbe(page);
    const grew = growth(before, after);
    report('baseline', before);
    report('after-10', after);
    report('growth', grew);
    report('listeners-grown', listenersGrown(listenersBefore, await readListeners(page)));
    expect(errors).toEqual([]);
    const held: Partial<RenderProbe> = {
      timeouts: grew.timeouts <= 0 ? 0 : grew.timeouts,
      intervals: grew.intervals,
      frames: grew.frames <= 0 ? 0 : grew.frames,
      resizeTargets: grew.resizeTargets,
      mutationObservers: grew.mutationObservers,
      globalListeners: grew.globalListeners,
      streams: grew.streams,
      sockets: grew.sockets,
      xterms: grew.xterms,
    };
    expect(held).toEqual({ timeouts: 0, intervals: 0, frames: 0, resizeTargets: 0, mutationObservers: 0, globalListeners: 0, streams: 0, sockets: 0, xterms: 0 });
    expect(grew.nodes).toBeLessThanOrEqual(0);
  });

  test('rides out a storm of the stream with few renders and one company fetch at a time', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(installRenderProbe);
    const asked = await bigCompanyServer(page);
    await page.goto('/');
    await expect(page.locator('.map .dept')).toHaveCount(COMPANY.departments.length);
    await quiet(page);
    const before = await readProbe(page);
    const orgBefore = asked.get('/api/org') ?? 0;
    const requestsBefore = asked.get('/api/requests') ?? 0;
    const messages = burst();
    await sendLiveApart(page, messages);
    await quiet(page);
    const after = await readProbe(page);
    const storm = {
      messages: messages.length,
      commits: after.commits - before.commits,
      orgFetches: (asked.get('/api/org') ?? 0) - orgBefore,
      requestFetches: (asked.get('/api/requests') ?? 0) - requestsBefore,
    };
    report('storm', storm);
    expect(errors).toEqual([]);
    expect(storm.orgFetches).toBeLessThanOrEqual(3);
    expect(storm.commits).toBeLessThanOrEqual(12);
  });
});
