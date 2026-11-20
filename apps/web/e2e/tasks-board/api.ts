import type { Page } from '@playwright/test';
import { taskRoute } from '../../test/task-route';
import type { BacklogItem, Decisions, Employee, GoalView, Me, Org, PersonView, Pipeline, TaskDepartments, TaskLine, TaskLogLine, TurnView, WaitingRequest } from '../../src/types';
import { detail, ME, serveApi } from '../api';

/* A company of two departments and the orchestrator's own work, with 138 tasks: Development runs turn 3 with six pieces of
   work, each with three subtasks of six tasks each, finished turn 2 as release v1.2.0, and has urgent work outside turns that
   waits for the person's answer; Sales, with no repository, runs turn 5 outside releases. The company aims at 500 shops on card
   payments, Development at card payments and refunds under it; card payments go through the pipeline "Payments way". Ivan,
   the person, answers for Development and its work; Maria for Sales. He has Development of his own; Sales he only reads. */
export const DEV = { id: 'd2', name: 'Development' };
export const SALES = { id: 'd3', name: 'Sales' };
const IVAN = { id: ME.person.id, name: ME.person.name };
const MARIA = { id: 'p2', name: 'Maria' };
const BRUNO = { id: 'b1', name: 'Bruno', kind: 'worker' as const, role: { en: 'Developer', ru: 'Разработчик' } };
const ROSA = { id: 'b2', name: 'Rosa', kind: 'worker' as const, role: { en: 'Seller', ru: 'Продавец' } };
const HANA = { id: 'h1', name: 'Hana', kind: 'head' as const, role: { en: 'Head of development', ru: 'Глава разработки' } };

const department = (d: { id: string; name: string }) => ({
  id: d.id, name: d.name, templateKey: null, roleCode: 'CTO', about: '', agents: { total: 1, working: 1 }, products: [], teams: [], people: [], employees: [], roles: [],
});
const ORG: Org = {
  company: ME.company,
  orchestrator: { id: 'a1', name: 'Orchestrator', model: 'claude-opus-5-5', effort: null, subscription: null, context: null, program: null, alarm: null, retry: null, failure: null },
  agents: { total: 3, working: 3 }, people: [], departments: [DEV, SALES].map(department),
};

const turn = (number: number, status: TurnView['status'], title: string, goal: string, tasks: TurnView['tasks'], departmentId = DEV.id): TurnView => ({
  id: `u${number}`, number, title, goal, status, version: status === 'closed' ? `v1.${number}.0` : null, commit: null, baseVersion: status === 'closed' ? null : 'v1.2.0', departmentId, releases: departmentId === DEV.id, messages: [], taskId: null, tasks,
  startedAt: '2026-11-14T07:00:00.000Z', openedAt: '2026-11-14T07:00:00.000Z', closedAt: status === 'closed' ? '2026-11-14T08:00:00.000Z' : null,
});
export const TURNS: TurnView[] = [
  turn(2, 'closed', 'First shop', 'Open the shop.', { total: 1, done: 1 }),
  turn(3, 'open', 'Payments', 'Take card payments in the shop.', { total: 6, done: 0 }),
  turn(5, 'open', 'Spring sale', 'Tell the shop owners about the sale.', { total: 1, done: 0 }, SALES.id),
];

const WORK = ['Take card payments', 'Refunds on request', 'Receipts by email', 'Gift cards', 'Pay in parts', 'Delivery dates'];

const goal = (id: string, number: number, title: string, over: Partial<GoalView>): GoalView => ({
  id, number, title, why: '', department: DEV, parentId: 'g1', responsible: IVAN, target: null, current: null, unit: '', dueAt: null, status: 'active', progress: 0, done: 0, total: 0, version: 1, mayEdit: true, ...over,
});
export const GOALS: GoalView[] = [
  goal('g1', 1, '500 shops pay by card', { why: 'Shops that take cards sell twice as much.', department: null, parentId: null, target: 500, current: 212, unit: 'shops', progress: 0.424 }),
  goal('g2', 2, 'Card payments', { why: 'A shop takes a card in one step.', dueAt: '2026-11-10T00:00:00.000Z' }),
  goal('g3', 3, 'Refunds', { why: 'A shop gives the money back the same day.' }),
];
const SERVES = (g: GoalView) => ({ id: g.id, number: g.number, title: g.title });
export const PIPELINE: Pipeline = {
  id: 'pl1', department: DEV, name: 'Payments way', why: 'Every payment change is built, then checked.', archived: false, version: 1, mayEdit: true,
  stages: [{ id: 's1', parentId: null, name: 'Build', ownerRole: null, owner: null, position: 0 }, { id: 's2', parentId: 's1', name: 'Check', ownerRole: null, owner: null, position: 0 }],
};

let made = 0;
const task = (title: string, place: { id: string; name: string } | null, extra: Partial<TaskLine>): TaskLine => {
  const number = ++made;
  return {
    echelons: taskRoute(), id: `t${number}`, number, title, brief: `${title}: what it does for the shop and why it is needed.`,
    status: 'working', department: place, product: null, assignee: place === SALES ? ROSA : place ? BRUNO : null, turn: 3,
    parentId: null, waitsFor: [], createdAt: '2026-11-14T08:00:00.000Z', updatedAt: '2026-11-14T09:00:00.000Z',
    responsible: place === SALES ? MARIA : IVAN, goal: null, why: '', dueAt: null, pipelineId: null, pipelineStageId: null,
    time: { inStatusSince: '2026-11-14T08:00:00.000Z', workSeconds: 3600, waitsOn: [] }, ...extra,
  };
};

function company(): TaskLine[] {
  made = 0;
  const all: TaskLine[] = [];
  for (const [w, title] of WORK.entries()) {
    const served = w === 0 ? SERVES(GOALS[1]!) : w === 1 ? SERVES(GOALS[2]!) : null;
    const way = w === 0 ? { pipelineId: PIPELINE.id, pipelineStageId: 's1' } : {};
    const top = task(title, DEV, { assignee: HANA, goal: served, why: `${title} for every shop.`, dueAt: w === 0 ? '2026-11-20T00:00:00.000Z' : null, ...way });
    all.push(top);
    ['Plan', 'Build', 'Check'].forEach((step, c) => {
      const related = task(`${step}: ${title.toLowerCase()}`, DEV, { parentId: top.id, goal: served, status: c === 0 ? 'done' : 'working', ...(w === 0 ? { pipelineId: PIPELINE.id, pipelineStageId: c === 2 ? 's2' : 's1' } : {}) });
      all.push(related);
      for (let l = 0; l < 6; l++) all.push(task(`Part ${l + 1} of ${step.toLowerCase()}`, DEV, { parentId: related.id, goal: served, status: c === 0 || l < 3 ? 'done' : 'working', echelons: { ...taskRoute(), stages: [] } }));
    });
  }
  all.push(task('Fix the sign-in page', DEV, {
    turn: null, urgent: true, status: 'waiting', time: { inStatusSince: '2026-11-13T08:00:00.000Z', workSeconds: 0, waitsOn: [{ kind: 'person', who: { kind: 'person', ...IVAN }, reason: null, since: '2026-11-13T08:00:00.000Z' }] },
  }));
  all.push(task('Rename the shop', DEV, { turn: null, status: 'done' }));
  all.push(task('Old checkout', DEV, { turn: 2, status: 'done' }));
  all.push(task('Call the shop owners back', SALES, { turn: 5, status: 'review' }));
  all.push(task('Pick the next goals', null, { turn: null, status: 'working', assignee: null }));
  return all.reverse();
}

export const TASKS = company();

/* The head of development asks the person on the urgent goal outside turns. */
const SIGN_IN = TASKS.find(x => x.title === 'Fix the sign-in page')!;
export const QUESTION = 'Keep the old sign-in address for a month, or switch at once?';
const DECISIONS: Decisions = {
  requests: [{
    id: 'r1', kind: 'question', text: QUESTION, commit: null, commitUrl: null, images: [], options: [], link: null, explained: null, explaining: false,
    at: '2026-11-14T10:00:00.000Z', agent: { id: HANA.id, name: HANA.name }, task: { id: SIGN_IN.id, number: SIGN_IN.number, title: SIGN_IN.title, department: DEV },
    ownerPersonId: ME.person.id, canAnswer: true,
  }],
  proposals: [], machineAccess: [], counts: { byPerson: { [ME.person.id]: 1 }, byAgent: { [HANA.id]: 1 }, total: 1 },
};

const item = (id: string, title: string, text: string): BacklogItem => ({ id, departmentId: DEV.id, title, text, by: { id: 'p1', name: 'Ivan' }, at: '2026-11-14T10:00:00.000Z' });

/* Serves the screen to the CEO: every department, Development of their own. reads: the task lists the page asked for. */
export async function serveTasksBoard(page: Page, me: Me = ME) {
  /* The CEO plans everywhere; anyone else in their own department only. */
  const ceo = !!(me.person.isOwner || me.person.isCeoDelegate);
  const places: TaskDepartments = { whole: me.person.scopeKind === 'company', mayPlanCompany: ceo, departments: [{ ...DEV, templateKey: null, mine: true, mayPlan: true, responsible: IVAN }, { ...SALES, templateKey: null, mine: false, mayPlan: ceo, responsible: MARIA }] };
  const reads: string[] = [];
  await serveApi(page);
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/me') return route.fulfill({ json: me });
    if (path === '/api/org') return route.fulfill({ json: ORG });
    if (path === '/api/turns') return route.fulfill({ json: { turns: TURNS } });
    if (path === '/api/task-departments') return route.fulfill({ json: places });
    if (path === '/api/requests') return route.fulfill({ json: DECISIONS });
    if (path === '/api/goals') return route.fulfill({ json: { goals: GOALS } });
    if (path === '/api/pipelines') return route.fulfill({ json: { pipelines: [PIPELINE] } });
    const aim = GOALS.find(g => path === `/api/goals/${g.id}`);
    if (aim) return route.fulfill({ json: { goal: aim, log: [] } });
    if (path === '/api/tasks') {
      reads.push(url.search);
      return route.fulfill({ json: { tasks: TASKS } });
    }
    const shown = TASKS.find(x => path === `/api/tasks/${x.id}`);
    if (shown) return route.fulfill({ json: { task: { ...detail(shown), neededFor: [], mayEdit: true, version: 1 } } });
    if (path === `/api/departments/${DEV.id}/backlog`) return route.fulfill({ json: { items: [item('i1', 'Gift cards for shops', 'Sell gift cards to other shops.')] } });
    return route.fallback();
  });
  return { reads };
}

/* The people of the company, each with a question of an agent: Max, a designer, is asked by name about card payments and only
   he answers; Maria is asked, as Sales' person, about calling the shop owners back, which the CEO may take too; the CEO
   keeps the question on the sign-in page. Added after serveTasksBoard, so these answers come first. */
export const MAX_QUESTION = 'Which logo goes on the card form, the round one or the square one?';
export const MARIA_QUESTION = 'Call the shops in the morning or after lunch?';
export async function servePeopleWaits(page: Page) {
  const person = (id: string, name: string, title: string, isOwner = false): PersonView =>
    ({ id, name, email: `${name.toLowerCase()}@acme.test`, title, status: 'active', isOwner, access: { whole: true, departments: [], teams: [] } });
  const people = [person(IVAN.id, IVAN.name, 'CEO', true), person(MARIA.id, MARIA.name, 'Head of sales'), person('p-max', 'Max', 'Designer')];
  const asked = (id: string, title: string, text: string, over: Partial<WaitingRequest>): WaitingRequest => {
    const on = TASKS.find(x => x.title === title)!;
    return { ...DECISIONS.requests[0]!, id, text, task: { id: on.id, number: on.number, title: on.title, department: on.department }, ...over };
  };
  const requests = [
    ...DECISIONS.requests,
    asked('r2', 'Take card payments', MAX_QUESTION, { ownerPersonId: 'p-max', canAnswer: false, decidedBy: { kind: 'named_person', department: null } }),
    asked('r3', 'Call the shop owners back', MARIA_QUESTION, { agent: { id: ROSA.id, name: ROSA.name }, ownerPersonId: MARIA.id, decidedBy: { kind: 'department_and_ceo', department: SALES } }),
  ];
  const decisions: Decisions = { ...DECISIONS, requests, counts: { byPerson: { [IVAN.id]: 1, [MARIA.id]: 1, 'p-max': 1 }, byAgent: { [HANA.id]: 2, [ROSA.id]: 1 }, total: 2 } };
  await page.route('**/api/org', route => route.fulfill({ json: { ...ORG, people } }));
  await page.route('**/api/requests', route => route.fulfill({ json: decisions }));
}

/* The shortest words a link of the tracker holds: the goal Refunds and the task Gift cards are called QA, and Hana in
   Development works on that task. Added after serveTasksBoard, so these answers come first. */
export const SHORT = 'QA';
export async function serveShortNames(page: Page) {
  const gift = TASKS.find(x => x.title === 'Gift cards')!;
  const shortGoal = (g: GoalView) => (g.id === 'g3' ? { ...g, title: SHORT } : g);
  const shortTask = (x: TaskLine): TaskLine => ({ ...x, title: x.id === gift.id ? SHORT : x.title, goal: x.goal?.id === 'g3' ? { ...x.goal, title: SHORT } : x.goal });
  const hana: Employee = {
    id: HANA.id, name: HANA.name, roleId: null, title: HANA.role, kind: 'head', model: '', modelName: null, provider: null, effort: null,
    state: 'working', status: 'working', on: true, timer: null, task: { id: gift.id, number: gift.number, title: SHORT, echelons: gift.echelons },
    context: null, program: null, alarm: null, retry: null, failure: null,
  };
  const org: Org = { ...ORG, departments: ORG.departments.map(d => (d.id === DEV.id ? { ...d, employees: [hana] } : d)) };
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/org') return route.fulfill({ json: org });
    if (path === '/api/goals') return route.fulfill({ json: { goals: GOALS.map(shortGoal) } });
    const aim = GOALS.find(g => path === `/api/goals/${g.id}`);
    if (aim) return route.fulfill({ json: { goal: shortGoal(aim), log: [] } });
    if (path === '/api/tasks') return route.fulfill({ json: { tasks: TASKS.map(shortTask) } });
    const shown = TASKS.find(x => path === `/api/tasks/${x.id}`);
    if (shown) return route.fulfill({ json: { task: { ...detail(shortTask(shown)), neededFor: [], mayEdit: true, version: 1 } } });
    return route.fallback();
  });
}

/* The same company where Gift cards, with its three subtasks and their parts, is the orchestrator's own work: a card of the
   goal board outside every release, with its progress and its related tasks. Added after serveTasksBoard, so it answers
   first. */
export async function serveOutsideWork(page: Page) {
  const gift = TASKS.find(x => x.title === 'Gift cards')!;
  const tree = new Set([gift.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const x of TASKS) if (x.parentId && tree.has(x.parentId) && !tree.has(x.id)) { tree.add(x.id); grew = true; }
  }
  const tasks = TASKS.map(x => (tree.has(x.id) ? { ...x, department: null, turn: null } : x));
  await page.route('**/api/**', route => {
    if (new URL(route.request().url()).pathname !== '/api/tasks') return route.fallback();
    return route.fulfill({ json: { tasks } });
  });
  return gift;
}

/* Development's employees as the map lists them: Hana works in Codex now, Bruno has no plan. */
const member = (agent: typeof HANA | typeof BRUNO, provider: Employee['provider']): Employee => ({
  id: agent.id, name: agent.name, roleId: null, title: agent.role, kind: agent.kind, model: '', modelName: null, provider, effort: null,
  state: provider ? 'sleeping' : 'needs_subscription', status: 'idle', on: true, timer: null, task: null, context: null, program: null,
  alarm: null, retry: null, failure: null,
});
export async function serveStaff(page: Page) {
  const org: Org = { ...ORG, departments: ORG.departments.map(d => (d.id === DEV.id ? { ...d, employees: [member(HANA, 'codex'), member(BRUNO, null)] } : d)) };
  await page.route('**/api/org', route => route.fulfill({ json: org }));
}

/* The history of the goal Card payments: Ivan set it, moved its date, and Hana wrote a note on it, a sentence of its own. An
   edit names what changed as the server writes it (goals.ts FIELD_NAMES): "due" for the due date. more: lines after these. */
export const GOAL_NOTE = 'The bank asks for two more weeks, 3 of 5 checks are done.';
export async function serveGoalHistory(page: Page, more: TaskLogLine[] = []) {
  const by = { kind: 'person' as const, id: IVAN.id, name: IVAN.name };
  const log: TaskLogLine[] = [
    { kind: 'created', text: '', data: {}, by, at: '2026-11-10T09:00:00.000Z' },
    { kind: 'edited', text: '', data: { fields: ['due'] }, by, at: '2026-11-12T09:30:00.000Z' },
    { kind: 'comment', text: GOAL_NOTE, data: {}, by: { kind: 'agent', id: HANA.id, name: HANA.name }, at: '2026-11-14T16:45:00.000Z' },
    ...more,
  ];
  await page.route('**/api/**', route => {
    if (new URL(route.request().url()).pathname !== `/api/goals/${GOALS[1]!.id}`) return route.fallback();
    return route.fulfill({ json: { goal: GOALS[1], log } });
  });
}
