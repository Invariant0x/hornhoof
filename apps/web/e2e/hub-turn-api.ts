import type { Page } from '@playwright/test';
import type { ApprovalPolicyView, Briefing, Department, Employee, EmployeeStatus, Org, TurnView } from '../src/types';
import { ME, serveApi } from './api';

/* Development's open turn as the Tasks screen reads it. */
export const HUB_TURN: TurnView = {
  id: 'u3', number: 3, title: 'Payment rollout', goal: 'Ship payments', status: 'open', version: null, commit: null, baseVersion: null, departmentId: 'd1', releases: true, messages: [], taskId: null,
  startedAt: '2026-11-04T10:00:00.000Z', openedAt: '2026-11-04T10:00:00.000Z', closedAt: null,
  tasks: { done: 3, total: 17 },
};

/* The tasks of the open turn a department has done out of all, or null for one that works all the time. */
export type Progress = [done: number, total: number] | null;
/* The departments on the map in the order of their cards, each with its turn. */
export type Company = { name: string; roleCode: string; progress: Progress }[];

/* Development works in the turn and Operations all the time; then Marketing and Sales join, then Support and Design. */
export const ONE: Company = [
  { name: 'Development', roleCode: 'CTO', progress: [3, 17] },
  { name: 'Operations', roleCode: 'OPS', progress: null },
];
export const THREE: Company = [...ONE, { name: 'Marketing', roleCode: 'CMO', progress: [5, 14] }, { name: 'Sales', roleCode: 'CRO', progress: [11, 16] }];
export const FIVE: Company = [...THREE, { name: 'Support', roleCode: 'SUP', progress: [3, 10] }, { name: 'Design', roleCode: 'DSN', progress: [0, 12] }];

const STATUSES: EmployeeStatus[] = ['working', 'working', 'working', 'queued', 'handed', 'idle', 'idle', 'idle'];
const employee = (dept: string, k: number): Employee => ({
  id: `${dept}-e${k}`, name: `Agent ${k}`, roleId: null, title: null, kind: k ? 'worker' : 'head', model: '', modelName: null, provider: null, effort: null,
  state: 'sleeping', status: STATUSES[k % STATUSES.length]!, on: true, timer: null, task: null, context: null, program: null, alarm: null, retry: null, failure: null,
});

const deptId = (i: number) => `d${i + 1}`;

/* A department that works in turns has no count while no turn is open. */
function department({ name, roleCode, progress }: Company[number], i: number, open: boolean): Department {
  const id = deptId(i);
  /* Development has 24 agents, two lines of squares on its card as on Ivan's map; the others fewer. */
  const employees = Array.from({ length: i ? 4 + ((i * 3) % 7) : 24 }, (_, k) => employee(id, k));
  return {
    id, name, templateKey: null, roleCode, about: '', products: [], teams: [], people: [], roles: [], employees,
    agents: { total: employees.length, working: employees.filter(e => e.status === 'working').length },
    current: { id: `${id}-t`, number: 40 + i, title: `${name} work for the payment rollout` },
    turnProgress: open && progress ? { turnNumber: HUB_TURN.number, done: progress[0], total: progress[1] } : null,
  };
}

function org(company: Company, open: boolean): Org {
  const departments = company.map((d, i) => department(d, i, open));
  const agents = departments.reduce((n, d) => ({ total: n.total + d.agents.total, working: n.working + d.agents.working }), { total: 1, working: 0 });
  return {
    company: ME.company,
    orchestrator: { id: 'a1', name: 'Orchestrator', model: '', effort: null, subscription: null, context: null, program: null, alarm: null, retry: null, failure: null },
    agents, people: [], departments,
    turn: open ? { id: HUB_TURN.id, number: HUB_TURN.number, goal: HUB_TURN.goal } : null,
  };
}

const policy = (departmentId: string): ApprovalPolicyView => ({
  departmentId, owner: null, canSetOwner: true, canChangePolicy: true, candidates: [],
  rules: (['message', 'price', 'publication', 'commit', 'spend', 'other'] as const).map(channel => ({ channel, mode: 'every' as const })),
});
const BRIEFING: Briefing = { text: '', repositories: [], connected: null, updatedAt: null, by: null };

declare global {
  interface Window { hubTaskEvent: (type: 'task' | 'org') => void }
}

/* The server stream is external to the page; the real stream listeners and refetch paths still run. */
export async function taskStream(page: Page) {
  await page.addInitScript(() => {
    const sources: (EventTarget & { readyState: number })[] = [];
    class Source extends EventTarget {
      static readonly CLOSED = 2;
      readyState = 1;
      constructor(readonly url: string) {
        super();
        sources.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
      }
      close() { this.readyState = 2; }
    }
    Object.defineProperty(window, 'EventSource', { value: Source });
    window.hubTaskEvent = type => sources.filter(s => s.readyState !== Source.CLOSED).forEach(s => s.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type }) })));
  });
}

/* The company as the server counts it for the map, changed as tasks close, departments join and the turn closes. */
export async function serveHubTurn(page: Page, start: Company = ONE) {
  let company = start;
  let open = true;
  await taskStream(page);
  await serveApi(page);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/org') return route.fulfill({ json: org(company, open) });
    if (url.pathname === '/api/turns') return route.fulfill({ json: { turns: open ? [HUB_TURN] : [] } });
    if (url.pathname === '/api/version') return route.fulfill({ json: { version: '0.18.7', commit: 'hub-turns' } });
    if (url.pathname === '/api/updates') return route.fulfill({ json: { current: { version: '0.18.7', commit: 'hub-turns' }, available: false, latest: null, updater: { status: null, waiting: null } } });
    /* The department's About shows its approvals and briefing. */
    const about = /^\/api\/departments\/(d\d+)\/(approval-policy|briefing)$/.exec(url.pathname);
    if (about?.[2] === 'approval-policy') return route.fulfill({ json: policy(about[1]!) });
    if (about) return route.fulfill({ json: BRIEFING });
    return route.fallback();
  });
  return {
    /* The company now: the page hears that tasks moved and fetches it again. */
    show: async (next: Company) => {
      company = next;
      await page.evaluate(() => window.hubTaskEvent('task'));
    },
    closeTurn: async () => {
      open = false;
      await page.evaluate(() => window.hubTaskEvent('org'));
    },
  };
}
