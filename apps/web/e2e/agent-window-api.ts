import { emptyEchelonFindings } from '@hornhoof/protocol/echelons';
import { taskRoute } from '../test/task-route';
import type { Page, Route } from '@playwright/test';
import type { AgentCardView, Employee, EventView, MachineView, Me, Org, PersonView, RunningAgent, SubView, TaskDetail, TurnRefusal } from '../src/types';
import { AGENT_HIDDEN, ME, TASKS, serveApi } from './api';

const ROLE = { en: 'Developer', ru: 'Разработчик' };
const EMPLOYEE: Employee = {
  id: 'b1', name: 'Bruno', roleId: 'DEV-ENG', title: ROLE, kind: 'worker', model: '', modelName: null, provider: 'codex', effort: null,
  state: 'sleeping', status: 'idle', on: true, timer: null, task: { id: 't1', number: 1, title: 'Checkout step 1', echelons: taskRoute() },
  context: null, program: null, alarm: null, retry: null, failure: null,
};
const AGENT: RunningAgent = { id: 'b1', canOpen: true, name: 'Bruno', title: ROLE, department: { id: 'd2', name: 'Development' }, provider: 'codex', busy: false, since: null, task: null, withCeo: false };
export const SUB: SubView = {
  id: 's1', provider: 'codex', kind: 'personal', label: 'Codex', status: 'ready', online: true, last4: null, owner: { id: 'p1', name: 'Ivan' },
  place: { kind: 'company', id: null, name: 'Whole company' }, machines: [{ id: 'm1', hostname: 'test-machine', status: 'ready', online: true }],
  limits: null, budget: null, isOrchestrator: false, accounts: [], tier: null, accountsDiffer: false, signedInOnce: true, leaseMachine: null,
};
const MACHINE: MachineView = { id: 'm1', hostname: 'test-machine', os: 'linux', arch: 'x86_64', owner: { id: 'p1', name: 'Ivan' }, online: true, lastSeenAt: null, plans: [{ id: 's1', provider: 'codex', status: 'ready', online: true }], load: null, lendsTests: true, running: { agents: [], parts: [] } };
export const CARD: AgentCardView = { id: 'b1', currentTask: null, kind: 'worker', name: 'Bruno', role: { id: 'DEV-ENG', title: ROLE, description: ROLE }, department: { id: 'd2', name: 'Development' }, product: null, model: '', effort: null, subscription: SUB, machine: null, state: 'sleeping', retry: null, failure: null, skills: [], parts: [], raw: '', runsOn: [], changes: [], interrupted: [], timer: null, canEdit: false, canRemove: false };
export const DETAIL: TaskDetail = { ...TASKS[0]!, echelonFindings: emptyEchelonFindings(), body: 'The task details stay beside the terminal on a wide screen.', parent: null, after: [], executor: TASKS[0]!.assignee, createdBy: null, subtasks: [], requests: [], log: [{ kind: 'comment', text: 'The checkout form is being checked.', data: {}, by: { kind: 'agent', id: 'b1', name: 'Bruno' }, at: '2026-11-04T00:00:00Z' }] };

/* canType: whether this person types into the terminal, as the owner of its plan; so by default. orchestrator: the company's, for its window. */
export type AgentFixture = { turnRefused?: TurnRefusal | null; awake: boolean; hasTask: boolean; messages: unknown[]; connections: number; events?: EventView[]; productOnly?: boolean; privateAgent?: boolean; orgFailure?: boolean; head?: boolean; sent?: string[]; canType?: boolean; orchestrator?: Org['orchestrator']; viewer?: Me };

function seesEmployee(live: AgentFixture): boolean {
  const { person } = live.viewer ?? ME;
  return person.isOwner || Boolean(person.isCeoDelegate && person.scopeKind === 'company') || person.id === SUB.owner?.id;
}

function agentRoutes(live: AgentFixture): Record<string, unknown> {
  const employee = { ...EMPLOYEE, task: live.hasTask ? EMPLOYEE.task : null };
  const agent = { ...AGENT, busy: live.awake };
  const me = live.viewer ?? ME;
  const visible = seesEmployee(live);
  const listed = visible ? [agent] : [];
  const people: PersonView[] = me.person.scopeKind === 'listed' ? [{ ...me.person, access: { whole: false, departments: [{ id: 'd2', name: 'Development' }], teams: [] } }] : [];
  const org: Org = { company: ME.company, orchestrator: me.person.scopeKind === 'company' ? live.orchestrator ?? null : null, agents: { total: Number(visible), working: Number(visible && live.awake) }, people: [], departments: [{ id: 'd2', name: 'Development', templateKey: null, roleCode: 'DEV', about: '', agents: { total: Number(visible), working: Number(visible && live.awake) }, products: [], teams: [], people, employees: visible ? [employee] : [], roles: [{ id: 'DEV-ENG', title: ROLE, description: ROLE, kind: 'member', gate: null }] }] };
  const routes: Record<string, unknown> = {
    '/api/org': org,
    '/api/me': me,
    '/api/version': { version: '0.5.0', commit: 'b77ce08' },
    '/api/updates': { current: { version: '0.5.0', commit: 'b77ce08' }, available: false, latest: null, updater: { status: null, waiting: null } },
    '/api/subscriptions': { subscriptions: visible ? [{ ...SUB, agents: listed }] : [] },
    '/api/machines': { machines: [{ ...MACHINE, running: { agents: listed, parts: [] } }] },
    '/api/nodes/commands': { commands: [] },
    '/api/agents/b1': { ...CARD, kind: live.head ? 'head' : 'worker', product: live.productOnly ? { id: 'p2', name: 'Checkout' } : null, currentTask: live.hasTask ? { id: 't1', number: 1, title: 'Checkout step 1' } : null },
    '/api/departments/d2/notebook': { notes: [{ number: 1, text: 'Review every merge.', by: { kind: 'agent', id: 'b1', name: 'Bruno' }, updatedAt: '2026-11-04T00:00:00.000Z' }] },
    '/api/departments/d2/approval-policy': { departmentId: 'd2', owner: null, canSetOwner: true, canChangePolicy: true, candidates: [], rules: [{ channel: 'message', mode: 'every' }, { channel: 'price', mode: 'every' }, { channel: 'publication', mode: 'every' }, { channel: 'commit', mode: 'every' }, { channel: 'spend', mode: 'every' }, { channel: 'other', mode: 'every' }] },
    '/api/tasks/t1': { task: DETAIL },
    '/api/tasks?status=open&department=d2': { tasks: [] },
    '/api/feedback': { inbox: false },
  };
  if (live.productOnly) {
    org.departments[0]!.employees = [];
    org.departments[0]!.products = [{ id: 'p2', name: 'Checkout' }];
  }
  return routes;
}

function agentEvents(url: URL, live: AgentFixture) {
  const after = Number(url.searchParams.get('after') ?? 0);
  return { events: (live.events ?? []).filter(e => e.seq > after), state: { ready: true, reason: null, busy: live.awake, runningJobId: live.awake ? 'j1' : null, queued: 0, terminal: live.awake, canType: live.canType ?? true, turnRefused: live.turnRefused ?? null } };
}

async function agentResponse(route: Route, live: AgentFixture): Promise<void> {
  const url = new URL(route.request().url());
  const path = url.pathname + url.search;
  const routes = agentRoutes(live);
  if (path === '/api/org' && live.orgFailure) return route.fulfill({ status: 503, json: { error: { code: 'internal', message: 'Company temporarily unavailable' } } });
  if ((!seesEmployee(live) && url.pathname.startsWith('/api/agents/b1')) || (live.privateAgent && url.pathname.startsWith('/api/agents/private'))) return route.fulfill({ status: 403, json: AGENT_HIDDEN });
  if (url.pathname === '/api/agents/b1/events') return route.fulfill({ json: agentEvents(url, live) });
  if (path === '/api/agents/b1/messages') { live.messages.push(route.request().postDataJSON()); return route.fulfill({ json: { queued: true } }); }
  if (path in routes) return route.fulfill({ json: routes[path] });
  return route.fallback();
}

export async function serveAgentWindow(page: Page, live: AgentFixture): Promise<void> {
  await serveApi(page);
  await page.route('**/api/**', async route => {
    await agentResponse(route, live);
  });
  await page.routeWebSocket('**/api/agents/b1/terminal*', ws => {
    live.connections++;
    ws.onMessage(message => { live.sent?.push(String(message)); });
    ws.send(JSON.stringify({ type: 'ready', write: live.canType ?? true, message: true }));
    ws.send(JSON.stringify({ type: 'program', running: true }));
    ws.send(JSON.stringify({ type: 'data', data: 'Bruno is checking the checkout.\r\n> ' }));
  });
}
