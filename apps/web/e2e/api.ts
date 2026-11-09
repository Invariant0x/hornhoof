import { emptyEchelonFindings } from '@hornhoof/protocol/echelons';
import { taskRoute } from '../test/task-route';
import type { Locator, Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { AgentCardView, Decisions, Improvement, Me, Org, TaskDetail, TaskLine, TurnView } from '../src/types';

/* A company with one department and a running turn of enough tasks to scroll, answered in the page as the server would. */
export const ME: Me = {
  person: { id: 'p1', companyId: 'c1', name: 'Ivan', email: 'ivan@acme.com', title: 'CEO', status: 'active', scopeKind: 'company', isOwner: true },
  company: { id: 'c1', name: 'Acme' },
};

export const AGENT_HIDDEN = { error: { code: 'forbidden', message: 'This employee is not on a plan of yours in a department you have.', reason: 'agent_hidden' } };

const DEV = { id: 'd2', name: 'Development' };
const BRUNO = { id: 'b1', name: 'Bruno', kind: 'worker' as const, role: { en: 'Developer', ru: 'Разработчик' } };

const ORG: Org = {
  company: ME.company,
  orchestrator: { id: 'a1', name: 'Orchestrator', model: 'claude-opus-5-5', effort: null, subscription: null, context: null, program: null, alarm: null, retry: null, failure: null },
  agents: { total: 1, working: 1 },
  people: [],
  departments: [
    { id: DEV.id, name: DEV.name, templateKey: null, roleCode: 'CTO', about: '', agents: { total: 1, working: 1 }, products: [], teams: [], people: [], employees: [], roles: [] },
  ],
};

const DECISIONS: Decisions = { requests: [], proposals: [], computerAccess: null, counts: { byPerson: {}, byAgent: {}, total: 0 } };

const TURN: TurnView = {
  id: 'u3', number: 3, title: 'Payments', goal: 'Take card payments in the shop.', status: 'open', messages: [], taskId: null,
  startedAt: '2026-10-30T07:00:00.000Z', openedAt: '2026-10-30T07:00:00.000Z', closedAt: null, tasks: { total: 30, done: 0 },
};

/* Long briefs, so a row narrowed by the panel would cut them short. */
export const TASKS: TaskLine[] = Array.from({ length: 30 }, (_, i) => ({
  echelons: taskRoute(),
  id: `t${i + 1}`, number: i + 1, title: `Checkout step ${i + 1}`,
  brief: 'Take card payments in the shop, refund them on request and show every payment on the order page with its state.',
  status: 'working', department: DEV, product: null, assignee: BRUNO, turn: 3,
  parentId: null, waitsFor: [], createdAt: '2026-10-30T08:00:00.000Z', updatedAt: '2026-10-30T09:00:00.000Z',
}));

/* A body longer than any window, so the panel has to scroll. */
export const detail = (task: TaskLine): TaskDetail => ({
  echelonFindings: emptyEchelonFindings(),
  ...task,
  body: Array.from({ length: 40 }, (_, i) => `Step ${i + 1}: the card form checks the number and the date before it sends them.`).join('\n\n'),
  parent: null, after: [], executor: BRUNO, createdBy: { kind: 'agent', id: 'b0', name: 'Dana' }, subtasks: [], log: [], requests: [],
});

/* An improvement the orchestrator took into work, with the task it made. */
const IMPROVEMENT: Improvement = {
  id: 'i1', title: 'Check card numbers before sending them', text: 'The card form sends numbers the bank turns down.', seen: 2, status: 'taken',
  result: 'Made a task for it.', at: '2026-10-30T08:00:00.000Z', updatedAt: '2026-10-30T09:00:00.000Z', agent: { id: 'b1', name: 'Bruno' },
  department: DEV, decidedBy: 'Ivan', tasks: [{ id: 't3', number: 3, title: 'Checkout step 3' }], parts: null,
};

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const ROUTES: Record<string, unknown> = {
  '/api/setup': { needed: false },
  '/api/me': ME,
  '/api/org': ORG,
  '/api/requests': DECISIONS,
  '/api/nodes/commands': { commands: [] },
  '/api/computer': { available: false, until: null, asked: null },
  '/api/turns': { turns: [TURN] },
  '/api/task-departments': { whole: true, departments: [{ id: DEV.id, name: DEV.name, templateKey: null }] },
  '/api/tasks?status=all&department=d2': { tasks: TASKS },
  '/api/departments/d2/backlog': { items: [] },
  '/api/improvements': { improvements: [IMPROVEMENT] },
  '/api/agents/orchestrator': {
    id: 'a1', kind: 'orchestrator', name: 'Orchestrator', role: null, department: null, product: null, team: null, teams: [],
    model: 'claude-opus-5-5', effort: null, subscription: null, machine: null, state: 'needs_subscription', currentTask: null,
    program: null, alarm: null, retry: null, failure: null, skills: [], parts: [], raw: '', instructions: { length: 0, max: 200_000 },
    runsOn: [], changes: [], interrupted: [], canEdit: true, timer: null,
  } satisfies AgentCardView,
  '/api/agents/orchestrator/events?after=0': { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 } },
};

/* Every /api call of the page gets the answer above, a task its detail, and anything else a 404 as the server gives it. */
export async function serveApi(page: Page) {
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const path = url.pathname + url.search;
    /* A stream with nothing to say stays open. An answer would end it: the browser reconnects within seconds, and on each
       reconnect the whole app fetches what it missed, which keeps every page in every test busy. */
    if (path === '/api/stream') return;
    if (path in ROUTES) return route.fulfill(json(ROUTES[path]));
    if (/^\/api\/machines\/[^/]+\/connections$/.test(path)) return route.fulfill(json({ summary: { drops: 0, averageMs: null, cause: null }, events: [] }));
    const task = TASKS.find(x => path === `/api/tasks/${x.id}`);
    if (task) return route.fulfill(json({ task: detail(task) }));
    return route.fulfill(json({ error: { code: 'not_found', message: 'Not found.' } }, 404));
  });
}

export async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error('not on screen');
  return b;
}

const OPEN_TASK = new RegExp(`^(${en.tasks.table.open}|${ru.tasks.table.open})$`);

/* A task opens from the table of the Tasks screen: its row unfolds, and the button in what it shows opens the panel. */
export async function openTaskRow(page: Page, number: number) {
  const row = page.getByRole('row', { name: new RegExp(`^#${number} `) });
  const card = row.getByRole('button');
  if ((await card.getAttribute('aria-expanded')) !== 'true') await card.click();
  await row.locator('xpath=following-sibling::tr[1]').getByRole('button', { name: OPEN_TASK }).click();
}
