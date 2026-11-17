import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { AgentCardView, Employee, MachineView, Org, SubView } from '../src/types';
import { ME, serveApi, serveOwnerKey } from './api';

/* A machine's limit of turns at once (#1212), as each engine draws it: its card has the field Turns at once, a touch high,
   with its hint and the turns that wait for a place there, kept on Enter; an employee whose turn waits for a place shows
   "waiting for a place on its machine" on its chip and its card, calm, with no word of a hang. In both languages, right to
   left, in the dark skin and the light one, wide and on a phone, with nothing out of its box. A picture of each look is
   kept, in the folder SHOTS names when it is set. */

const SHOTS = process.env.SHOTS;
const NOW = Date.parse('2026-11-17T06:00:00.000Z');
const GIB = 1024 ** 3;
const messages = { en, ru };
const HOST = 'dev-mac';

type Look = { lang: 'en' | 'ru'; dir: 'ltr' | 'rtl'; skin: 'cyberpunk' | 'light'; width: 1440 | 375 };
const LOOKS: Look[] = (['cyberpunk', 'light'] as const).flatMap(skin => ([1440, 375] as const).flatMap(width => [
  { lang: 'en' as const, dir: 'ltr' as const, skin, width }, { lang: 'ru' as const, dir: 'ltr' as const, skin, width }, { lang: 'ru' as const, dir: 'rtl' as const, skin, width },
]));
const lookName = ({ lang, dir, skin, width }: Look) => `${lang}-${dir}-${skin}-${width}`;

const MACHINE = {
  id: 'm1', hostname: HOST, os: 'linux', arch: 'x86_64', owner: { id: ME.person.id, name: ME.person.name }, online: true, lastSeenAt: null,
  plans: [{ id: 's1', provider: 'codex', status: 'ready', online: true }],
  load: { cpus: 10, load: 9, memFree: 3 * GIB, memTotal: 12 * GIB, jobs: 2, tests: 0, cpuModel: 'Apple M2 Pro', diskFree: 200 * GIB, diskTotal: 500 * GIB },
  lendsTests: true, running: { agents: [], parts: [] }, programs: [], keepsBackups: null, heldBackups: null, turnLimit: 2, turnsWaiting: 3,
} as unknown as MachineView;
const SUBS = [{
  id: 's1', provider: 'codex', kind: 'personal', label: 'Codex', status: 'ready', online: true, last4: null, owner: { id: ME.person.id, name: ME.person.name },
  place: { kind: 'company', id: null, name: 'Whole company' }, machines: [{ id: 'm1', hostname: HOST, status: 'ready', online: true }], limits: null,
  limitsUpdatedAt: null, budget: null, isOrchestrator: false, accounts: [], tier: null, accountsDiffer: false, signedInOnce: true, leaseMachine: null, agents: [],
}] as unknown as SubView[];

const ROLE = { en: 'Developer', ru: 'Разработчик' };
const BRUNO: Employee = {
  id: 'b1', name: 'Bruno', roleId: 'DEV-ENG', title: ROLE, kind: 'worker', model: '', modelName: null, provider: 'codex', effort: null,
  state: 'sleeping', status: 'queued', on: true, timer: null, task: null, context: null, program: null, alarm: null, retry: null, failure: null, held: null, slotWait: true,
};
const CARD: AgentCardView = {
  currentTask: null, id: BRUNO.id, name: BRUNO.name, kind: 'worker', role: null, department: { id: 'd2', name: 'Development' }, product: null, model: '', effort: null,
  subscription: null, machine: null, state: 'sleeping', retry: null, failure: null, slotWait: true, skills: [], parts: [], raw: '', instructions: { length: 0, max: 200_000 },
  runsOn: [], changes: [], interrupted: [], canEdit: false, canRemove: false, timer: null,
};
const ORG: Org = {
  company: ME.company, orchestrator: null, agents: { total: 1, working: 0 }, people: [], serverNow: new Date(NOW).toISOString(),
  departments: [{
    id: 'd2', name: null, templateKey: 'development', roleCode: 'DEV', about: '', agents: { total: 1, working: 0 }, products: [], teams: [], people: [],
    employees: [BRUNO], roles: [{ id: 'DEV-ENG', title: ROLE, description: ROLE, kind: 'member', gate: null }],
  }],
};

async function serve(page: Page, look: Look, limits: unknown[]): Promise<void> {
  await page.setViewportSize({ width: look.width, height: look.width === 375 ? 1400 : 1000 });
  await page.clock.install({ time: NOW });
  await serveApi(page);
  await serveOwnerKey(page);
  await page.addInitScript(({ lang, skin, dir }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', skin);
    if (dir === 'rtl') document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = 'rtl'; });
  }, look);
  await page.route('**/api/org', route => route.fulfill({ json: ORG }));
  await page.route('**/api/machines', route => route.fulfill({ json: { machines: [MACHINE], builtin: null, priority: false } }));
  await page.route('**/api/machines/m1/turn-limit', route => {
    const body = route.request().postDataJSON() as { limit: number | null };
    limits.push(body);
    return route.fulfill({ json: { turnLimit: body.limit } });
  });
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: SUBS } }));
  await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/machines/access', route => route.fulfill({ json: { views: [] } }));
  await page.route('**/api/agents/b1', route => route.fulfill({ json: CARD }));
  await page.route('**/api/agents/b1/events?last=300', route => route.fulfill({ json: { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 1, terminal: false, slotWait: true } } }));
  await page.route('**/api/tasks?status=open&department=d2', route => route.fulfill({ json: { tasks: [] } }));
}

async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.evaluate(async () => { await document.fonts.ready; });
  const file = `${info.project.name}-${name}.png`;
  await page.screenshot({ path: SHOTS ? `${SHOTS}/${file}` : info.outputPath(file) });
}

/* Nothing of the page runs past the screen's width, and the box lies inside the one around it. */
async function fits(page: Page, inner: ReturnType<Page['locator']>, outer: ReturnType<Page['locator']>): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const a = (await inner.boundingBox())!;
  const b = (await outer.boundingBox())!;
  expect(a.x).toBeGreaterThanOrEqual(b.x - 1);
  expect(a.x + a.width).toBeLessThanOrEqual(b.x + b.width + 1);
}

for (const look of LOOKS) {
  test(`a machine's card sets how many turns it runs at once: ${lookName(look)}`, async ({ page }, info) => {
    const t = messages[look.lang];
    const limits: unknown[] = [];
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await serve(page, look, limits);
    await page.goto('/');
    await page.getByRole('navigation').getByRole('button', { name: t.shell.tabs.machines, exact: true }).click();
    await page.getByRole('button', { name: new RegExp(`^(Open the card of |Открыть карточку )${HOST}$`) }).click();
    const card = page.getByRole('article', { name: HOST });
    const field = card.getByRole('spinbutton', { name: t.machines.turnLimitLabel(HOST) });
    await field.scrollIntoViewIfNeeded();
    await expect(field).toHaveValue('2');
    expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(card.getByText(t.machines.turnLimitHint)).toBeVisible();
    await expect(card.getByText(t.machines.turnsWaiting(3))).toBeVisible();
    await fits(page, card.locator('.turn-limit'), card);
    await shot(page, info, `machine-${lookName(look)}`);
    await field.fill('4');
    await field.press('Enter');
    await expect.poll(() => limits).toEqual([{ limit: 4 }]);
    expect(errors).toEqual([]);
  });

  test(`an employee whose turn waits for a place on its machine says so, calm: ${lookName(look)}`, async ({ page }, info) => {
    const t = messages[look.lang];
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await serve(page, look, []);
    await page.goto('/');
    await page.getByRole('button', { name: look.lang === 'en' ? /^Development/ : /^Разработка/ }).click();
    const chip = page.getByRole('region', { name: look.lang === 'en' ? 'Members' : 'Сотрудники' }).getByRole('button', { name: /Bruno/ });
    await expect(chip).toContainText(t.dept.now.slotWait);
    await expect(chip.locator('.ast')).toHaveClass(/calm/);
    await shot(page, info, `map-${lookName(look)}`);
    await chip.click();
    await page.getByRole('button', { name: look.lang === 'en' ? 'Card' : 'Карточка', exact: true }).click();
    /* Wide, the card stands beside the agent's window, inside its panel in the page but not in its box. */
    const side = page.getByRole('complementary', { name: /^(Card|Карточка): Bruno$/ });
    const line = side.getByText(t.dept.now.slotWait, { exact: true });
    await expect(line).toBeVisible();
    await expect(line).toHaveClass(/calm/);
    await fits(page, line, side);
    await shot(page, info, `card-${lookName(look)}`);
    expect(errors).toEqual([]);
  });
}
