import type { Page } from '@playwright/test';
import type {
  BuiltinView,
  DepartmentTree,
  EventView,
  MachineView,
  OrchestratorState,
  Org,
  SubView,
  TaskLine,
  TurnView,
  WaitingRequest,
} from '../../src/types';
import {
  MOONFERN_DEPARTMENTS,
  MOONFERN_MACHINES,
  MOONFERN_ORG,
  MOONFERN_SUBSCRIPTIONS,
  moonfernAgentCard,
} from './agents';
import { BASE_ISO, isoMinutes } from './clock';
import { ATTACHMENT_SVGS } from './images';
import { MOONFERN_BUILTIN } from './machines';
import {
  buildOakDecisions,
  INITIAL_OAK_REQUESTS,
  OAK_BUILTIN,
  OAK_MACHINES,
  OAK_ME,
  OAK_ORG,
  OAK_PEOPLE,
  OAK_SUBSCRIPTIONS,
  OAK_TASKS,
  OAK_TURNS,
  oakAgentCard,
  oakTaskDetail,
} from './oak-lane';
import { MOONFERN_ME, MOONFERN_PEOPLE } from './people';
import { starterKitOrg } from './starter-kit';
import { pushStream } from './stream';
import {
  buildDecisions,
  INITIAL_MOONFERN_REQUESTS,
  MOONFERN_GOALS,
  MOONFERN_TASK_DEPARTMENTS,
  MOONFERN_TASKS,
  MOONFERN_TURNS,
  moonfernTaskDetail,
} from './tasks';
import { buildDevelopmentTreeSnapshots } from './tree';

/* What every page of the app asks on the side, answered with nothing to show: no cards kept, no machine here, the company
   stays where it runs, no phones, no link certificate, no saved sign-ins. */
const QUIET: Record<string, unknown> = {
  '/api/wait-cards': { cards: [], next: null },
  '/api/machines/access': { views: [] },
  '/api/machines/here': { machine: null, view: null },
  '/api/backups/recovery': { recoveryNeeded: false, linkChanged: false },
  '/api/backups': { last: null, recovery: null, recoveryNeeded: false, linkChanged: false, restore: null, kept: [], bundles: [] },
  '/api/network/switch': { self: null, moving: false, from: null, to: null, since: null, cut: false, question: false },
  '/api/network/switched': { switched: null },
  '/api/network/question': { question: null, canAnswer: false },
  '/api/phones': { phones: [] },
  '/api/link': { link: null, domain: 'hornhoof.org' },
  '/api/feedback': { inbox: false },
  '/api/map/layout': { blocks: {} },
  '/api/repo-host': { host: null },
  '/api/google-sheets': { google: null },
  '/api/vault': { entries: [] },
};

export type MoonfernController = {
  setOrg: (next: Org) => void;
  getOrg: () => Org;
  setMachines: (next: MachineView[], nextBuiltin?: BuiltinView) => void;
  getMachines: () => MachineView[];
  setSubscriptions: (next: SubView[]) => void;
  getSubscriptions: () => SubView[];
  setRequests: (next: WaitingRequest[]) => void;
  setTasks: (next: TaskLine[]) => void;
  setTurns: (next: TurnView[]) => void;
  setTree: (next: DepartmentTree) => void;
  setOrchestratorEvents: (events: EventView[], state?: Partial<OrchestratorState>) => void;
  appendOrchestratorEvent: (event: EventView, state?: Partial<OrchestratorState>) => Promise<void>;
  onMessage?: (agentId: string, text: string) => void | Promise<void>;
  onBuild?: (items: unknown[]) => void | Promise<void>;
};

export type ServeMoonfernOptions = {
  setupNeeded?: boolean;
  initialOrg?: Org;
  initialRequests?: WaitingRequest[];
  initialTurns?: TurnView[];
  initialTasks?: TaskLine[];
  initialTree?: DepartmentTree;
  terminalAgentIds?: string[];
  orchestratorEvents?: EventView[];
  onMessage?: (agentId: string, text: string) => void | Promise<void>;
  onBuild?: (items: unknown[]) => void | Promise<void>;
};

export async function serveMoonfern(page: Page, opts: ServeMoonfernOptions = {}): Promise<MoonfernController> {
  let setupNeeded = opts.setupNeeded ?? false;
  let org: Org = structuredClone(opts.initialOrg ?? MOONFERN_ORG);
  let requests: WaitingRequest[] = structuredClone(opts.initialRequests ?? INITIAL_MOONFERN_REQUESTS);
  let turns: TurnView[] = structuredClone(opts.initialTurns ?? MOONFERN_TURNS);
  let tasks: TaskLine[] = structuredClone(opts.initialTasks ?? MOONFERN_TASKS);
  let subs: SubView[] = structuredClone(MOONFERN_SUBSCRIPTIONS);
  let machines: MachineView[] = structuredClone(MOONFERN_MACHINES);
  let builtin: BuiltinView = structuredClone(MOONFERN_BUILTIN);
  let tree: DepartmentTree = structuredClone(opts.initialTree ?? buildDevelopmentTreeSnapshots()[0]!.tree);
  let orchEvents: EventView[] = structuredClone(opts.orchestratorEvents ?? []);
  let orchState: OrchestratorState = {
    ready: true,
    reason: null,
    busy: false,
    runningJobId: null,
    queued: 0,
    terminal: false,
  };
  const terminalAgents = new Set(opts.terminalAgentIds ?? []);

  const controller: MoonfernController = {
    setOrg: next => { org = next; },
    getOrg: () => org,
    setMachines: (next, nextBuiltin) => {
      machines = next;
      const studio = next.find(m => m.id === 'm-studio-server');
      builtin = nextBuiltin ?? (studio ? { ...builtin, load: studio.load } : builtin);
    },
    getMachines: () => machines,
    setSubscriptions: next => { subs = next; },
    getSubscriptions: () => subs,
    setRequests: next => { requests = next; },
    setTasks: next => { tasks = next; },
    setTurns: next => { turns = next; },
    setTree: next => { tree = next; },
    setOrchestratorEvents: (events, state) => {
      orchEvents = events;
      if (state) orchState = { ...orchState, ...state };
    },
    appendOrchestratorEvent: async (event, state) => {
      orchEvents = [...orchEvents, event];
      if (state) orchState = { ...orchState, ...state };
      await pushStream(page, { type: 'agent_event', agentId: org.orchestrator?.id ?? 'agent-orch', event });
    },
    onMessage: opts.onMessage,
    onBuild: opts.onBuild,
  };

  await page.route('**/api/**', async route => {
    const req = route.request();
    const method = req.method();
    const url = new URL(req.url());
    const pathname = url.pathname;

    if (pathname === '/api/stream') return;

    if (pathname.startsWith('/api/attachments/')) {
      const id = pathname.slice('/api/attachments/'.length);
      const svg = ATTACHMENT_SVGS[id];
      if (svg) {
        return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg });
      }
    }

    if (pathname in QUIET) return route.fulfill({ json: QUIET[pathname] });
    if (pathname === '/api/goals') return route.fulfill({ json: { goals: MOONFERN_GOALS } });
    const goalId = /^\/api\/goals\/([^/]+)$/.exec(pathname)?.[1];
    const goal = goalId ? MOONFERN_GOALS.find(g => g.id === goalId) : undefined;
    if (goal) return route.fulfill({ json: { goal, log: [] } });
    if (pathname === '/api/pipelines') return route.fulfill({ json: { pipelines: org.departments.flatMap(d => d.pipelines ?? []) } });
    if (pathname === '/api/task-departments') return route.fulfill({ json: MOONFERN_TASK_DEPARTMENTS });
    if (/^\/api\/tasks\/[^/]+\/phone-recordings$/.test(pathname)) return route.fulfill({ json: { recordings: [] } });
    if (/^\/api\/departments\/[^/]+\/backlog$/.test(pathname)) return route.fulfill({ json: { items: [] } });
    if (pathname === '/api/version') {
      return route.fulfill({ json: { version: '0.32.0', commit: '1d4ec7a' } });
    }
    if (pathname === '/api/updates') {
      return route.fulfill({
        json: {
          current: { version: '0.32.0', commit: '1d4ec7a', migrations: 141 },
          available: false,
          checkedAt: BASE_ISO,
          latest: null,
          versions: [],
          error: null,
          updater: { present: true, status: null, waiting: null },
        },
      });
    }
    if (pathname === '/api/setup' && method === 'GET') {
      return route.fulfill({ json: { needed: setupNeeded, linkDomain: 'hornhoof.org' } });
    }
    if (pathname === '/api/setup' && method === 'POST') {
      const { template, companyName } = JSON.parse(req.postData() ?? '{}') as { template?: string; companyName?: string };
      if (template === 'startup') {
        org = starterKitOrg(companyName ?? 'Moonfern');
        requests = [];
        turns = [];
        tasks = [];
        subs = [];
      }
      setupNeeded = false;
      return route.fulfill({ json: {} });
    }
    if (pathname.startsWith('/api/setup/names/')) {
      const name = decodeURIComponent(pathname.slice('/api/setup/names/'.length));
      return route.fulfill({ json: { name, free: true } });
    }
    if (pathname === '/api/orchestrator/first-contact') {
      return route.fulfill({ json: { offers: ['planLaunch', 'sketchProduct', 'findCustomers', 'setUpPipeline', 'telegram', 'assistant'] } });
    }
    if (pathname === '/api/me') {
      return route.fulfill({ json: { ...MOONFERN_ME, company: org.company } });
    }
    if (pathname === '/api/org') {
      return route.fulfill({ json: org });
    }
    if (pathname === '/api/people') {
      return route.fulfill({ json: { people: MOONFERN_PEOPLE } });
    }
    if (pathname === '/api/subscriptions') {
      return route.fulfill({ json: { subscriptions: subs } });
    }
    if (pathname.startsWith('/api/subscriptions/') && method === 'PATCH') {
      const id = pathname.slice('/api/subscriptions/'.length);
      const body = JSON.parse(req.postData() ?? '{}') as { budget?: number | null };
      subs = subs.map(s => (s.id === id && 'budget' in body ? { ...s, budget: body.budget ?? null } : s));
      const updated = subs.find(s => s.id === id);
      return route.fulfill({ json: { subscription: updated } });
    }
    if (pathname === '/api/machines') {
      return route.fulfill({ json: { machines, builtin } });
    }
    if (/^\/api\/machines\/[^/]+\/connections$/.test(pathname)) {
      return route.fulfill({ json: { summary: { drops: 0, averageMs: null, cause: null }, events: [] } });
    }
    if (pathname === '/api/nodes/commands') {
      return route.fulfill({ json: { commands: [] } });
    }
    if (pathname === '/api/computer') {
      return route.fulfill({ json: { available: false, until: null, asked: null } });
    }
    if (pathname === '/api/improvements') {
      return route.fulfill({ json: { improvements: [] } });
    }
    if (pathname === '/api/notebook' || /^\/api\/departments\/[^/]+\/notebook$/.test(pathname)) {
      return route.fulfill({
        json: {
          notes: [
            { number: 1, text: 'Keep Moonfern local-first: watering schedules and plant journals work without an account.', by: { kind: 'person', id: 'p-maya', name: 'Maya Chen' }, updatedAt: isoMinutes(-600) },
            { number: 2, text: 'Every Development task passes cross-maker code review, security and TestFlight smoke tests.', by: { kind: 'orchestrator' }, updatedAt: isoMinutes(-480) },
          ],
        },
      });
    }
    if (pathname === '/api/requests' && method === 'GET') {
      return route.fulfill({ json: buildDecisions(requests) });
    }
    if (pathname.startsWith('/api/requests/') && method === 'POST') {
      const id = pathname.slice('/api/requests/'.length);
      const target = requests.find(r => r.id === id);
      requests = requests.filter(r => r.id !== id);
      if (target) {
        tasks = tasks.map(t => (t.id === target.task.id ? { ...t, status: target.kind === 'approval' ? 'done' : 'working' } : t));
        if (target.kind === 'approval') {
          turns = turns.map(u => (u.number === 6 ? { ...u, tasks: { ...u.tasks, done: u.tasks.done + 1 } } : u));
        }
      }
      await route.fulfill({ json: { ok: true } });
      await pushStream(page, { type: 'requests' });
      await pushStream(page, { type: 'task', id: target?.task.id ?? 't-218', spot: { departmentId: target?.task.department?.id ?? null } });
      return;
    }
    if (pathname === '/api/turns') {
      return route.fulfill({ json: { turns } });
    }
    if (pathname === '/api/tasks') {
      const dept = url.searchParams.get('department');
      const status = url.searchParams.get('status');
      let list = tasks;
      if (dept) list = list.filter(t => t.department?.id === dept);
      if (status === 'open') list = list.filter(t => t.status !== 'done' && t.status !== 'cancelled');
      return route.fulfill({ json: { tasks: list } });
    }
    if (pathname.startsWith('/api/tasks/')) {
      const taskId = pathname.slice('/api/tasks/'.length);
      const detail = moonfernTaskDetail(taskId, tasks);
      if (detail) return route.fulfill({ json: { task: detail } });
    }
    if (/^\/api\/departments\/[^/]+\/tree$/.test(pathname)) {
      return route.fulfill({ json: { tree } });
    }
    if (pathname === '/api/departments/build' && method === 'POST') {
      const body = JSON.parse(req.postData() ?? '{}') as { proposalId?: string; items?: unknown[] };
      await controller.onBuild?.(body.items ?? []);
      return route.fulfill({ json: { created: MOONFERN_DEPARTMENTS.length } });
    }
    if (pathname === '/api/agents/orchestrator/start' && method === 'POST') {
      return route.fulfill({ json: { started: false } });
    }
    if (pathname === '/api/agents/orchestrator/events') {
      const after = Number(url.searchParams.get('after') ?? '0');
      return route.fulfill({
        json: {
          events: orchEvents.filter(e => e.seq > after),
          state: orchState,
        },
      });
    }
    if (pathname.startsWith('/api/agents/') && pathname.endsWith('/messages') && method === 'POST') {
      const agentId = pathname.slice('/api/agents/'.length, -'/messages'.length);
      const body = JSON.parse(req.postData() ?? '{}') as { text?: string };
      await route.fulfill({ json: { queued: false } });
      await controller.onMessage?.(agentId, body.text ?? '');
      return;
    }
    if (pathname.startsWith('/api/agents/') && pathname.endsWith('/events')) {
      const agentId = pathname.slice('/api/agents/'.length, -'/events'.length);
      const after = Number(url.searchParams.get('after') ?? '0');
      const isTerm = terminalAgents.has(agentId);
      const card = moonfernAgentCard(agentId);
      const events: EventView[] = after > 0 || isTerm
        ? []
        : [
            {
              seq: 1,
              kind: 'tool',
              data: { name: 'Read', input: 'apps/ios/Moonfern/Camera/PlantCameraView.swift' },
              jobId: 'job-1',
              person: null,
              at: isoMinutes(-8),
            },
            {
              seq: 2,
              kind: 'tool_result',
              data: { summary: '142 lines read' },
              jobId: 'job-1',
              person: null,
              at: isoMinutes(-8),
            },
            {
              seq: 3,
              kind: 'text',
              data: { text: `Working on ${card?.currentTask ? `#${card.currentTask.number} ${card.currentTask.title}` : 'current assignment'}.` },
              jobId: 'job-1',
              person: null,
              at: isoMinutes(-4),
            },
          ];
      return route.fulfill({
        json: {
          events,
          state: {
            ready: true,
            reason: null,
            busy: card?.state === 'working',
            runningJobId: card?.state === 'working' ? 'job-1' : null,
            queued: 0,
            terminal: isTerm,
            canType: isTerm,
          },
        },
      });
    }
    if (pathname.startsWith('/api/agents/')) {
      const agentId = pathname.slice('/api/agents/'.length);
      const card = moonfernAgentCard(agentId);
      if (card) return route.fulfill({ json: card });
    }

    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: `Unmocked ${method} ${pathname}` } } });
  });

  return controller;
}

export type OakLaneController = {
  reset: () => Promise<void>;
};

export async function serveOakLane(page: Page): Promise<OakLaneController> {
  let org: Org = structuredClone(OAK_ORG);
  let requests: WaitingRequest[] = structuredClone(INITIAL_OAK_REQUESTS);
  let tasks: TaskLine[] = structuredClone(OAK_TASKS);
  let turns: TurnView[] = structuredClone(OAK_TURNS);

  await page.route('**/api/**', async route => {
    const req = route.request();
    const method = req.method();
    const url = new URL(req.url());
    const pathname = url.pathname;

    if (pathname === '/api/stream') return;
    if (pathname in QUIET) return route.fulfill({ json: QUIET[pathname] });
    if (pathname === '/api/version') return route.fulfill({ json: { version: '0.7.0', commit: '070f4e2' } });
    if (pathname === '/api/updates') {
      return route.fulfill({
        json: {
          current: { version: '0.7.0', commit: '070f4e2', migrations: 42 },
          available: false,
          checkedAt: BASE_ISO,
          latest: null,
          versions: [],
          error: null,
          updater: { present: true, status: null, waiting: null },
        },
      });
    }
    if (pathname === '/api/setup') return route.fulfill({ json: { needed: false, linkDomain: 'hornhoof.org' } });
    if (pathname === '/api/me') return route.fulfill({ json: OAK_ME });
    if (pathname === '/api/org') return route.fulfill({ json: org });
    if (pathname === '/api/goals') return route.fulfill({ json: { goals: [] } });
    if (pathname === '/api/pipelines') return route.fulfill({ json: { pipelines: [] } });
    if (pathname === '/api/task-departments') return route.fulfill({ json: {
      whole: true, departments: org.departments.map(({ id, name, templateKey }) => ({ id, name, templateKey, mine: true })),
    } });
    if (pathname === '/api/people') return route.fulfill({ json: { people: OAK_PEOPLE } });
    if (pathname === '/api/subscriptions') return route.fulfill({ json: { subscriptions: OAK_SUBSCRIPTIONS } });
    if (pathname === '/api/machines') return route.fulfill({ json: { machines: OAK_MACHINES, builtin: OAK_BUILTIN } });
    if (/^\/api\/machines\/[^/]+\/connections$/.test(pathname)) {
      return route.fulfill({ json: { summary: { drops: 0, averageMs: null, cause: null }, events: [] } });
    }
    if (pathname === '/api/nodes/commands') return route.fulfill({ json: { commands: [] } });
    if (pathname === '/api/computer') return route.fulfill({ json: { available: false, until: null, asked: null } });
    if (pathname === '/api/improvements') return route.fulfill({ json: { improvements: [] } });
    if (pathname === '/api/notebook' || /^\/api\/departments\/[^/]+\/notebook$/.test(pathname)) {
      return route.fulfill({ json: { notes: [] } });
    }
    if (pathname === '/api/requests' && method === 'GET') {
      return route.fulfill({ json: buildOakDecisions(requests) });
    }
    if (pathname.startsWith('/api/requests/') && method === 'POST') {
      const id = pathname.slice('/api/requests/'.length);
      const target = requests.find(r => r.id === id);
      requests = requests.filter(r => r.id !== id);
      if (target) {
        tasks = tasks.map(t => (t.id === target.task.id ? { ...t, status: 'working' } : t));
        org = {
          ...org,
          people: org.people.map(p => (p.id === target.ownerPersonId ? { ...p, pendingDecisions: requests.length } : p)),
        };
      }
      await route.fulfill({ json: { ok: true } });
      await pushStream(page, { type: 'requests' });
      await pushStream(page, { type: 'org' });
      if (target) {
        await pushStream(page, { type: 'task', id: target.task.id, spot: { departmentId: target.task.department?.id ?? null } });
      }
      return;
    }
    if (pathname === '/api/turns') return route.fulfill({ json: { turns } });
    if (pathname === '/api/tasks') {
      const dept = url.searchParams.get('department');
      const status = url.searchParams.get('status');
      let list = tasks;
      if (dept) list = list.filter(t => t.department?.id === dept);
      if (status === 'open') list = list.filter(t => t.status !== 'done' && t.status !== 'cancelled');
      return route.fulfill({ json: { tasks: list } });
    }
    if (pathname.startsWith('/api/tasks/')) {
      const detail = oakTaskDetail(pathname.slice('/api/tasks/'.length));
      if (detail) return route.fulfill({ json: { task: detail } });
    }
    if (pathname.startsWith('/api/agents/') && pathname.endsWith('/events')) {
      return route.fulfill({
        json: { events: [], state: { ready: true, reason: null, busy: true, runningJobId: 'oak-j1', queued: 0, terminal: false } },
      });
    }
    if (pathname.startsWith('/api/agents/')) {
      const card = oakAgentCard(pathname.slice('/api/agents/'.length));
      if (card) return route.fulfill({ json: card });
    }
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: `Unmocked ${method} ${pathname}` } } });
  });

  return {
    reset: async () => {
      org = structuredClone(OAK_ORG);
      requests = structuredClone(INITIAL_OAK_REQUESTS);
      tasks = structuredClone(OAK_TASKS);
      turns = structuredClone(OAK_TURNS);
      await pushStream(page, { type: 'requests' });
      await pushStream(page, { type: 'org' });
    },
  };
}
