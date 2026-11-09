import type { Page } from '@playwright/test';
import { taskRoute } from '../../test/task-route';
import type { BacklogItem, Me, Org, TaskDepartments, TaskLine, TurnView } from '../../src/types';
import { detail, ME, serveApi } from '../api';

/* A company of two departments in its third turn, a fourth one planned and the second one over, with a list of work kept
   for later in Development. The page asks it as it asks the server; the list changes as the server would change it. */
export const DEV = { id: 'd2', name: 'Development' };
export const SALES = { id: 'd3', name: 'Sales' };
const BRUNO = { id: 'b1', name: 'Bruno', kind: 'worker' as const, role: { en: 'Developer', ru: 'Разработчик' } };
const ROSA = { id: 'b2', name: 'Rosa', kind: 'worker' as const, role: { en: 'Seller', ru: 'Продавец' } };

/* Someone with the Development department only. */
export const ONE_DEPARTMENT: Me = { ...ME, person: { ...ME.person, id: 'p3', name: 'Sasha', email: 'sasha@acme.com', title: 'Product lead', scopeKind: 'listed', isOwner: false } };

const department = (d: { id: string; name: string }) => ({
  id: d.id, name: d.name, templateKey: null, roleCode: 'CTO', about: '', agents: { total: 1, working: 1 }, products: [], teams: [], people: [], employees: [], roles: [],
});
const orgOf = (departments: { id: string; name: string }[]): Org => ({
  company: ME.company,
  orchestrator: { id: 'a1', name: 'Orchestrator', model: 'claude-opus-5-5', effort: null, subscription: null, context: null, program: null, alarm: null, retry: null, failure: null },
  agents: { total: 2, working: 2 }, people: [], departments: departments.map(department),
});

const turn = (number: number, status: TurnView['status'], title: string, goal: string, tasks: TurnView['tasks']): TurnView => ({
  id: `u${number}`, number, title, goal, status, messages: [], taskId: null, tasks,
  startedAt: '2026-10-30T07:00:00.000Z', openedAt: status === 'planned' ? null : '2026-10-30T07:00:00.000Z', closedAt: status === 'closed' ? '2026-10-30T08:00:00.000Z' : null,
});
export const TURNS: TurnView[] = [
  turn(2, 'closed', 'First shop', 'Open the shop.', { total: 1, done: 1 }),
  turn(3, 'open', 'Payments', 'Take card payments in the shop.', { total: 5, done: 1 }),
  turn(4, 'planned', 'Receipts', 'Send a receipt for every payment.', { total: 1, done: 0 }),
];

const task = (number: number, title: string, place: { id: string; name: string }, extra: Partial<TaskLine>): TaskLine => ({
  echelons: taskRoute(), id: `t${number}`, number, title, brief: `${title}: what the department does and how it is checked.`,
  status: 'working', department: place, product: null, assignee: place === SALES ? ROSA : BRUNO, turn: 3,
  parentId: null, waitsFor: [], createdAt: '2026-10-30T08:00:00.000Z', updatedAt: '2026-10-30T09:00:00.000Z', ...extra,
});
export const TASKS: Record<string, TaskLine[]> = {
  [DEV.id]: [
    task(1, 'Take card payments', DEV, {}),
    task(2, 'Card form', DEV, { parentId: 't1', status: 'done' }),
    task(3, 'Bank answers', DEV, { parentId: 't2', status: 'open', waitsFor: [2] }),
    task(4, 'Refunds', DEV, { status: 'review' }),
    task(5, 'Receipts by email', DEV, { status: 'planned', turn: 4 }),
    task(6, 'Old checkout', DEV, { status: 'done', turn: 2 }),
  ],
  [SALES.id]: [task(7, 'Call the shop owners back', SALES, {})],
};

const item = (id: string, title: string, text: string): BacklogItem => ({ id, departmentId: DEV.id, title, text, by: { id: 'p1', name: 'Ivan' }, at: '2026-10-30T10:00:00.000Z' });
const BACKLOG = (): Record<string, BacklogItem[]> => ({
  [DEV.id]: [
    item('i1', 'Gift cards', 'Sell gift cards and take them at checkout.'),
    item('i2', 'Pay in parts', 'Let a buyer pay in three parts.'),
    item('i3', 'Price list', 'Write the price list as a page of the shop.'),
  ],
  [SALES.id]: [],
});

export type Call = { method: string; path: string; body: unknown };

/* Serves the screen for the CEO, or for someone with Development only, and keeps every change of a list it was asked. */
export async function serveTasksTable(page: Page, me: Me = ME) {
  const whole = me.person.scopeKind === 'company';
  const places: TaskDepartments = { whole, departments: (whole ? [DEV, SALES] : [DEV]).map(d => ({ ...d, templateKey: null })) };
  const lists = BACKLOG();
  const calls: Call[] = [];
  const reads: string[] = [];
  let next = 4;
  await serveApi(page);
  await page.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postDataJSON() as unknown;
    if (path === '/api/me') return route.fulfill({ json: me });
    if (path === '/api/org') return route.fulfill({ json: orgOf(places.departments.map(d => ({ id: d.id, name: d.name! }))) });
    if (path === '/api/turns') return route.fulfill({ json: { turns: TURNS } });
    if (path === '/api/task-departments') return route.fulfill({ json: places });
    if (path === '/api/tasks' && url.searchParams.get('status') === 'all') {
      const id = url.searchParams.get('department')!;
      reads.push(id);
      return route.fulfill({ json: { tasks: TASKS[id] ?? [] } });
    }
    const shown = Object.values(TASKS).flat().find(x => path === `/api/tasks/${x.id}`);
    if (shown) return route.fulfill({ json: { task: detail(shown) } });
    const match = /^\/api\/departments\/([^/]+)\/backlog(?:\/([^/]+))?$/.exec(path);
    if (!match) return route.fallback();
    const [, id, rest] = match as unknown as [string, string, string | undefined];
    const list = lists[id] ?? [];
    if (method !== 'GET') calls.push({ method, path, body });
    if (method === 'GET') return route.fulfill({ json: { items: list } });
    if (method === 'POST' && !rest) {
      const added = { ...item(`i${next++}`, '', ''), departmentId: id, ...(body as { title: string; text: string }) };
      list.push(added);
      return route.fulfill({ status: 201, json: { item: added } });
    }
    if (method === 'PUT' && rest === 'order') {
      const ids = (body as { ids: string[] }).ids;
      lists[id] = ids.map(x => list.find(i => i.id === x)!);
      return route.fulfill({ json: { items: lists[id] } });
    }
    if (method === 'POST' && rest === 'schedule') {
      const ids = (body as { ids: string[] }).ids;
      lists[id] = list.filter(i => !ids.includes(i.id));
      return route.fulfill({ json: { turn: { number: 4 }, tasks: ids.map((x, n) => ({ id: `n${n}`, number: 31 + n })) } });
    }
    if (method === 'DELETE' && rest) {
      lists[id] = list.filter(i => i.id !== rest);
      return route.fulfill({ json: { items: lists[id] } });
    }
    return route.fallback();
  });
  return { calls, reads };
}
