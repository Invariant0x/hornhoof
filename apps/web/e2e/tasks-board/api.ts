import type { Page } from '@playwright/test';
import { taskRoute } from '../../test/task-route';
import type { BacklogItem, Me, Org, TaskDepartments, TaskLine, TurnView } from '../../src/types';
import { detail, ME, serveApi } from '../api';

/* A company of two departments and the orchestrator's own work, with 138 tasks: Development runs turn 3 with six goals,
   each with three related tasks of six tasks each, plans turn 4, finished turn 2, and has urgent work outside turns; Sales
   runs turn 5. The person has Development of their own, so its list for later turns shows; Sales they only read. */
export const DEV = { id: 'd2', name: 'Development' };
export const SALES = { id: 'd3', name: 'Sales' };
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
  id: `u${number}`, number, title, goal, status, version: status === 'closed' ? `v1.${number}.0` : null, commit: null, baseVersion: null, departmentId, messages: [], taskId: null, tasks,
  startedAt: '2026-11-14T07:00:00.000Z', openedAt: '2026-11-14T07:00:00.000Z', closedAt: status === 'closed' ? '2026-11-14T08:00:00.000Z' : null,
});
export const TURNS: TurnView[] = [
  turn(2, 'closed', 'First shop', 'Open the shop.', { total: 1, done: 1 }),
  turn(3, 'open', 'Payments', 'Take card payments in the shop.', { total: 6, done: 0 }),
  turn(5, 'open', 'Spring sale', 'Tell the shop owners about the sale.', { total: 1, done: 0 }, SALES.id),
];

const GOALS = ['Take card payments', 'Refunds on request', 'Receipts by email', 'Gift cards', 'Pay in parts', 'Delivery dates'];

let made = 0;
const task = (title: string, place: { id: string; name: string } | null, extra: Partial<TaskLine>): TaskLine => {
  const number = ++made;
  return {
    echelons: taskRoute(), id: `t${number}`, number, title, brief: `${title}: what it does for the shop and why it is needed.`,
    status: 'working', department: place, product: null, assignee: place === SALES ? ROSA : place ? BRUNO : null, turn: 3,
    parentId: null, waitsFor: [], createdAt: '2026-11-14T08:00:00.000Z', updatedAt: '2026-11-14T09:00:00.000Z', ...extra,
  };
};

function company(): TaskLine[] {
  made = 0;
  const all: TaskLine[] = [];
  for (const title of GOALS) {
    const goal = task(title, DEV, { assignee: HANA });
    all.push(goal);
    ['Plan', 'Build', 'Check'].forEach((step, c) => {
      const related = task(`${step}: ${title.toLowerCase()}`, DEV, { parentId: goal.id, status: c === 0 ? 'done' : 'working' });
      all.push(related);
      for (let l = 0; l < 6; l++) all.push(task(`Part ${l + 1} of ${step.toLowerCase()}`, DEV, { parentId: related.id, status: c === 0 || l < 3 ? 'done' : 'working', echelons: { ...taskRoute(), stages: [] } }));
    });
  }
  all.push(task('Fix the sign-in page', DEV, { turn: null, urgent: true, status: 'waiting' }));
  all.push(task('Rename the shop', DEV, { turn: null, status: 'done' }));
  all.push(task('Old checkout', DEV, { turn: 2, status: 'done' }));
  all.push(task('Call the shop owners back', SALES, { turn: 5, status: 'review' }));
  all.push(task('Pick the next goals', null, { turn: null, status: 'working', assignee: null }));
  return all.reverse();
}

export const TASKS = company();

const item = (id: string, title: string, text: string): BacklogItem => ({ id, departmentId: DEV.id, title, text, by: { id: 'p1', name: 'Ivan' }, at: '2026-11-14T10:00:00.000Z' });

/* Serves the screen to the CEO: every department, Development of their own. reads: the task lists the page asked for. */
export async function serveTasksBoard(page: Page, me: Me = ME) {
  const places: TaskDepartments = { whole: me.person.scopeKind === 'company', departments: [{ ...DEV, templateKey: null, mine: true }, { ...SALES, templateKey: null, mine: false }] };
  const reads: string[] = [];
  await serveApi(page);
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/me') return route.fulfill({ json: me });
    if (path === '/api/org') return route.fulfill({ json: ORG });
    if (path === '/api/turns') return route.fulfill({ json: { turns: TURNS } });
    if (path === '/api/task-departments') return route.fulfill({ json: places });
    if (path === '/api/tasks') {
      reads.push(url.search);
      return route.fulfill({ json: { tasks: TASKS } });
    }
    const shown = TASKS.find(x => path === `/api/tasks/${x.id}`);
    if (shown) return route.fulfill({ json: { task: detail(shown) } });
    if (path === `/api/departments/${DEV.id}/backlog`) return route.fulfill({ json: { items: [item('i1', 'Gift cards for shops', 'Sell gift cards to other shops.')] } });
    return route.fallback();
  });
  return { reads };
}
