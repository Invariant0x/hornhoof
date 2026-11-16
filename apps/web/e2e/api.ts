import { emptyEchelonFindings } from '@hornhoof/protocol/echelons';
import { taskRoute } from '../test/task-route';
import type { Locator, Page } from '@playwright/test';
import type { AgentCardView, BackupsView, Briefing, Decisions, Improvement, Me, Org, SwitchWord, TaskDetail, TaskLine, TokenPeriods, TurnView } from '../src/types';

/* A company with one department and a running turn of enough tasks to scroll, answered in the page as the server would. */
export const ME: Me = {
  person: { id: 'p1', companyId: 'c1', name: 'Ivan', email: 'ivan@acme.com', title: 'CEO', status: 'active', scopeKind: 'company', isOwner: true },
  company: { id: 'c1', name: 'Acme' },
};

/* The key of the person at the browser as the server keeps it: a command that joins a machine is shown with its public part. */
export const OWNER_KEY = { publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE'.padEnd(122, 'k'), wrapped: 'd3JhcHBlZA', salt: 'c2FsdA', iv: 'aXY', iterations: 600_000 };
export const withKey = (command: string): string => `${command} --owner-key ${OWNER_KEY.publicKey}`;
/* For a scenario that shows such a command: the server holds the person's key. The others have none, as before the
   person made one, so nothing in them waits for a password. */
export const serveOwnerKey = (page: Page) => page.route('**/api/me/key', route => route.fulfill({ json: { key: OWNER_KEY } }));

/* A person who last chose the terminal in this browser: an agent's window opens with it rather than with the chat. */
export const chooseTerminal = (page: Page) => page.addInitScript(() => localStorage.setItem('hh-agent-view', 'terminal'));

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

const DECISIONS: Decisions = { requests: [], proposals: [], machineAccess: [], counts: { byPerson: {}, byAgent: {}, total: 0 } };

const TURN: TurnView = {
  id: 'u3', number: 3, title: 'Payments', goal: 'Take card payments in the shop.', status: 'open', version: null, commit: null, baseVersion: null, departmentId: DEV.id, releases: true, messages: [], taskId: null,
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
  department: DEV, decidedBy: 'Ivan', tasks: [{ id: 't3', number: 3, title: 'Checkout step 3' }], parts: null, scope: 'company', code: null,
};

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

/* What a subscription's turns used, as its open card asks for it: nothing yet. */
const NO_TURNS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0, noData: 0 };
const NO_TOKENS: TokenPeriods = { today: NO_TURNS, week: NO_TURNS, month: NO_TURNS, all: NO_TURNS };

const ROUTES: Record<string, unknown> = {
  '/api/setup': { needed: false },
  '/api/me': ME,
  '/api/org': ORG,
  '/api/requests': DECISIONS,
  /* No card is kept for the person. */
  '/api/wait-cards': { cards: [], next: null },
  '/api/nodes/commands': { commands: [] },
  '/api/machines/access': { views: [] },
  /* What the CEO's reminder of the recovery file asks at the start: nothing to remind of. */
  '/api/backups/recovery': { recoveryNeeded: false, linkChanged: false },
  '/api/machines/here': { machine: null, view: null },
  /* What every page asks about where the company runs: it stays on its machine, and nothing waits for the CEO. */
  '/api/network/switch': { self: null, moving: false, from: null, to: null, since: null, cut: false, question: false } satisfies SwitchWord,
  '/api/network/switched': { switched: null },
  '/api/network/question': { question: null, canAnswer: false },
  '/api/machines': { machines: [] },
  /* The link's certificate, asked beside the machines, and the backups a wide look at every screen opens. */
  '/api/link': { link: null, domain: 'hornhoof.org' },
  '/api/backups': { last: null, recovery: null, recoveryNeeded: false, linkChanged: false, restore: null, kept: [], bundles: [] } satisfies BackupsView,
  '/api/turns': { turns: [TURN] },
  '/api/task-departments': { whole: true, mayPlanCompany: true, departments: [{ id: DEV.id, name: DEV.name, templateKey: null, mine: true, mayPlan: true, responsible: null }] },
  /* The tracker's goals and pipelines: none set yet. */
  '/api/goals': { goals: [] },
  '/api/pipelines': { pipelines: [] },
  '/api/tasks?status=all': { tasks: TASKS },
  '/api/departments/d2/backlog': { items: [] },
  '/api/departments/d2/briefing': { briefing: { text: '', repositories: [], connected: null, updatedAt: null, by: null } satisfies Briefing },
  '/api/improvements': { improvements: [IMPROVEMENT] },
  '/api/feedback': { inbox: false },
  '/api/map/layout': { blocks: {} },
  /* No GitHub key is saved, so the orchestrator creates no repository. */
  '/api/repo-host': { host: null },
  '/api/google-sheets': { google: null },
  /* What the departments send outside: nothing yet. Settings asks it to know whether to show External messaging. */
  '/api/outbound': { channels: [], messages: [], escalations: [], approvals: [] },
  '/api/agents/orchestrator': {
    id: 'a1', kind: 'orchestrator', name: 'Orchestrator', role: null, department: null, product: null, team: null, teams: [],
    model: 'claude-opus-5-5', effort: null, subscription: null, machine: null, state: 'needs_subscription', currentTask: null,
    program: null, alarm: null, retry: null, failure: null, skills: [], parts: [], raw: '', instructions: { length: 0, max: 200_000 },
    runsOn: [], changes: [], interrupted: [], canEdit: true, canRemove: true, timer: null,
  } satisfies AgentCardView,
  '/api/agents/orchestrator/events?last=300': { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 } },
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
    if (/^\/api\/subscriptions\/[^/]+\/tokens(\?|$)/.test(path)) return route.fulfill(json({ tokens: NO_TOKENS }));
    /* A department has no task branch outside main unless a test says otherwise. */
    if (/^\/api\/departments\/[^/]+\/branches$/.test(path)) return route.fulfill(json({ branches: [], problem: null }));
    /* A department's screen asks what it sends outside and who runs it: nothing, and nobody here. */
    if (/^\/api\/outbound\?department=[^&]+$/.test(path)) return route.fulfill(json({ channels: [], messages: [], escalations: [], approvals: [], departments: [] }));
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

/* The words of the table's headers that stand on more than one line: a word broken in its middle. */
export const brokenHeaderWords = (page: Page) => page.evaluate(() => {
  const broken: string[] = [];
  for (const th of document.querySelectorAll('.dt > thead th')) {
    const walker = document.createTreeWalker(th, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const word of (node.textContent ?? '').matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(node, word.index);
        range.setEnd(node, word.index + word[0].length);
        const lines = new Set([...range.getClientRects()].filter(r => r.width > 0).map(r => Math.round(r.top)));
        if (lines.size > 1) broken.push(word[0]);
      }
    }
  }
  return broken;
});

/* Whether a sorting table stands inside its frame. */
export const tableFits = (page: Page) => page.locator('.tbl').evaluate(el => el.scrollWidth <= el.clientWidth + 1);

/* A task opens from the Tasks board, not from a request above it that names the same number: the title of its card
   opens the panel. */
/* Opens a task from the tracker as a person does: finds it by its number and clicks its title, then clears the search. */
export async function openTaskCard(page: Page, number: number) {
  const search = page.getByRole('searchbox');
  await search.fill(String(number));
  await page.locator('.tr-found').getByRole('listitem', { name: new RegExp(`^#${number} `) }).first().locator('.tr-title').click();
  await search.fill('');
}
