import { vi } from 'vitest';
import type { AgentCardView, Decisions, MachineView, Me, Org, PersonView, Roster, Serving, SubView, TaskDetail, TaskLine, TurnView, WaitingRequest } from '../src/types';

type Reply = [status: number, body?: unknown];
type Route = Reply | ((body: unknown) => Reply | Promise<Reply>);

export type Call = { method: string; path: string; body: unknown };

/* Stubs fetch with routes keyed by "METHOD /path" and records every call. */
export function mockApi(routes: Record<string, Route>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const route = routes[`${method} ${path}`];
    const [status, data] = typeof route === 'function' ? await route(body) : route ?? [404, { error: { code: 'not_found', message: 'Not found.' } }];
    return new Response(data === undefined ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}

export const ME: Me = {
  person: { id: 'p1', companyId: 'c1', name: 'Ivan', email: 'ivan@acme.com', title: 'CEO', status: 'active', scopeKind: 'company', isOwner: true },
  company: { id: 'c1', name: 'Acme' },
};

export const WHOLE = { whole: true, departments: [], teams: [] };

export const signedOut = { error: { code: 'unauthorized', message: 'Sign in to continue.' } };

export const PEOPLE: PersonView[] = [
  { id: 'p1', name: 'Ivan', email: 'ivan@acme.com', title: 'CEO', status: 'active', isOwner: true, access: WHOLE },
  { id: 'p2', name: 'Maria', email: 'maria@acme.com', title: 'Deputy CEO', status: 'active', isOwner: false, access: WHOLE },
  { id: 'p3', name: 'Sasha', email: 'sasha@acme.com', title: 'SMM', status: 'invited', isOwner: false, access: { whole: false, departments: [], teams: [{ id: 't1', name: 'Social', departmentId: 'd1' }] } },
];

export const ORG: Org = {
  company: { id: 'c1', name: 'Acme' },
  orchestrator: {
    id: 'a1',
    name: 'Orchestrator',
    model: 'claude-opus-5-5',
    effort: null,
    subscription: { id: 's1', provider: 'anthropic_api', kind: 'api_key', label: 'Orchestrator', status: 'ready', online: false, last4: '9f3a', owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company', id: null, name: 'Whole company' }, machines: [], limits: null, budget: null, isOrchestrator: true },
    context: null,
  },
  agents: { total: 1, working: 0 },
  people: PEOPLE.slice(0, 2),
  departments: [],
};

export const ORG_WITH_TEAMS: Org = {
  ...ORG,
  departments: [
    { id: 'd1', name: 'Marketing', templateKey: null, roleCode: 'CMO', about: '', agents: { total: 0, working: 0 }, products: [], teams: [{ id: 't1', name: 'Social', about: '', stage: 0, gate: false }, { id: 't2', name: 'Content', about: '', stage: 0, gate: false }], people: [], employees: [], roles: [] },
    { id: 'd2', name: 'Development', templateKey: null, roleCode: 'CTO', about: '', agents: { total: 0, working: 0 }, products: [], teams: [], people: [], employees: [], roles: [] },
  ],
};

const SUB_BASE = { kind: 'personal' as const, last4: null, owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company' as const, id: null, name: 'Whole company' }, limits: null, budget: null, isOrchestrator: false };

export const MACHINE = { id: 'm1', hostname: 'ivan-mbp', status: 'ready' as const, online: true };

export const SUBS: SubView[] = [
  {
    ...SUB_BASE, id: 's-claude', provider: 'claude', label: 'Claude', status: 'ready', online: true, machines: [MACHINE],
    limits: { status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.42, resetsAt: '2099-10-29T18:00:00.000Z' }, { name: 'seven_day', utilization: 0.1, resetsAt: null }] },
  },
  { ...SUB_BASE, id: 's-codex', provider: 'codex', label: 'Codex', status: 'needs_login', online: true, machines: [{ ...MACHINE, status: 'needs_login' }] },
  { ...SUB_BASE, id: 's-kimi', provider: 'kimi', label: 'Kimi', status: 'waiting_machine', online: false, machines: [] },
  { ...SUB_BASE, id: 's-key', provider: 'anthropic_api', kind: 'api_key', label: 'Orchestrator', status: 'ready', online: true, last4: '9f3a', machines: [], isOrchestrator: true },
];

const GIB = 1024 ** 3;

/* Ivan's Mac, whose Docker gets 8 of its 10 cores and 12 of its 32 GB, and Maria's offline build box with no plan. */
export const MACHINES: MachineView[] = [
  { id: 'm1', hostname: 'ivan-mbp', os: 'darwin', arch: 'arm64', owner: { id: 'p1', name: 'Ivan' }, online: true, lastSeenAt: null,
    plans: [{ id: 's-claude', provider: 'claude', status: 'ready', online: true }, { id: 's-codex', provider: 'codex', status: 'needs_login', online: true }],
    load: { cpus: 8, load: 2, memFree: 6 * GIB, memTotal: 12 * GIB, tests: 1, jobs: 2, cpuModel: 'Apple M2 Pro', diskFree: 120 * GIB, diskTotal: 460 * GIB, hostCpus: 10, hostMemory: 32 * GIB },
    lendsTests: true,
    running: {
      agents: [{ id: 'b1', name: 'Bruno', busy: true }, { id: 'b2', name: 'Vera', busy: false }],
      parts: [{ run: 3, kind: 'tests', task: 12, part: 1, parts: 2, agent: 'Bruno', startedAt: '2026-11-01T10:00:00.000Z' }],
    } },
  { id: 'm2', hostname: 'build-box', os: 'linux', arch: 'x86_64', owner: { id: 'p2', name: 'Maria' }, online: false, lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(), plans: [], load: null, lendsTests: false,
    running: { agents: [], parts: [] } },
];

const OPUS = { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' };
const SONNET = { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: ['low', 'high', 'max'] };
const SOL = { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' };
const HEAD_TITLE = { en: 'Head of development', ru: 'Руководитель разработки' };
const BE_TITLE = { en: 'Backend engineer', ru: 'Бэкенд-разработчик' };

/* Development with Dana at its head and Bruno, a backend engineer on the team key; Sasha reaches only Development. */
export const DEV_ORG: Org = {
  ...ORG,
  agents: { total: 3, working: 1 },
  departments: [
    {
      id: 'd2',
      name: null,
      templateKey: 'development',
      roleCode: 'CTO',
      about: '',
      agents: { total: 2, working: 1 },
      products: [{ id: 'pd1', name: 'Mascot' }],
      teams: [],
      people: [PEOPLE[2]!],
      employees: [
        { id: 'b0', name: 'Dana', roleId: 'DEV-HEAD', title: HEAD_TITLE, kind: 'head', model: '', modelName: null, provider: 'claude', effort: null, state: 'working', status: 'working', on: true, timer: null, task: null, context: null },
        { id: 'b1', name: 'Bruno', roleId: 'DEV-BE', title: BE_TITLE, kind: 'worker', model: 'claude-sonnet-5-5', modelName: 'Claude Sonnet 5.5', provider: 'anthropic_api', effort: null, state: 'sleeping', status: 'idle', on: true, timer: null, task: null, context: null },
      ],
      roles: [
        { id: 'DEV-HEAD', title: HEAD_TITLE, description: { en: 'Leads development.', ru: 'Ведет разработку.' }, kind: 'head', gate: null },
        { id: 'DEV-BE', title: BE_TITLE, description: { en: 'Builds the server side.', ru: 'Делает серверную часть.' }, kind: 'member', gate: null },
      ],
    },
  ],
};

export const SERVING: Serving[] = [
  { id: 's-key', provider: 'anthropic_api', kind: 'api_key', label: 'Team key', owner: 'Ivan', models: [OPUS, SONNET] },
  { id: 's-codex', provider: 'codex', kind: 'personal', label: 'Codex', owner: 'Oleg', models: [SOL] },
];

export const ROSTER: Roster = {
  people: [
    { role: 'DEV-HEAD', name: 'Head of development', product: null, model: '', subscription: 's-key', skills: ['hh-report-to-head', 'hh-break-down'] },
    { role: 'DEV-BE', name: 'Backend engineer', product: null, model: '', subscription: 's-key', skills: ['hh-report-to-head', 'dev-tdd'] },
  ],
  roles: [
    { id: 'DEV-HEAD', title: HEAD_TITLE, kind: 'head', tier: 'deep', perProduct: false, skills: ['hh-report-to-head', 'hh-break-down'], subscription: 's-key' },
    { id: 'DEV-BE', title: BE_TITLE, kind: 'member', tier: 'standard', perProduct: false, skills: ['hh-report-to-head', 'dev-tdd'], subscription: 's-key' },
    { id: 'DEV-FE', title: { en: 'Frontend engineer', ru: 'Фронтенд-разработчик' }, kind: 'member', tier: 'standard', perProduct: true, skills: ['hh-report-to-head'], subscription: 's-key' },
  ],
  products: [{ id: 'pd1', name: 'Mascot' }],
  subscriptions: SERVING,
};

export const TEAM_KEY: SubView = { ...SUBS[3]!, id: 's-key', label: 'Team key', isOrchestrator: false };
const OLEG_CODEX: SubView = { ...SUBS[1]!, status: 'ready', owner: { id: 'p4', name: 'Oleg' } };

const skillPart = (id: string, title: string, body: string, extra = {}) => ({
  kind: 'skill' as const,
  id,
  title: { en: title, ru: title },
  text: `<!-- hh:skill ${id} -->\n## ${title}\n\n${body}\n<!-- /hh:skill -->`,
  overridden: false,
  templateChanged: false,
  ...extra,
});
const PARTS = [
  { kind: 'header' as const, id: null, title: null, text: 'You are Bruno, the Backend engineer of the Development department at Acme.', overridden: false, templateChanged: false },
  { kind: 'base' as const, id: 'DEV-BE', title: BE_TITLE, text: 'You build the API.', overridden: false, templateChanged: false },
  skillPart('hh-report-to-head', 'Report to your head', 'Report when done.'),
  skillPart('dev-tdd', 'Test first', 'Write the test first.', { overridden: true, templateChanged: true }),
];
const about = (en: string) => ({ en, ru: en });

export const CARD: AgentCardView = {
  id: 'b1',
  kind: 'worker',
  name: 'Bruno',
  role: { id: 'DEV-BE', title: BE_TITLE, description: about('Builds the API.') },
  department: { id: 'd2', name: 'Development' },
  product: null,
  model: 'claude-sonnet-5-5',
  effort: null,
  subscription: TEAM_KEY,
  machine: null,
  state: 'sleeping',
  skills: [
    { id: 'hh-report-to-head', title: about('Report to your head'), description: about('Tell the head what was done.'), on: true, locked: true, overridden: false, templateChanged: false },
    { id: 'dev-tdd', title: about('Test first'), description: about('A failing test before the code.'), on: true, locked: false, overridden: true, templateChanged: true },
    { id: 'dev-api-design', title: about('API design'), description: about('Plain, stable APIs.'), on: false, locked: false, overridden: false, templateChanged: false },
  ],
  parts: PARTS,
  raw: PARTS.map(p => p.text).join('\n\n'),
  instructions: { length: 12_345, max: 200_000 },
  runsOn: [
    { subscription: TEAM_KEY, models: [OPUS, SONNET] },
    { subscription: OLEG_CODEX, models: [SOL] },
  ],
  changes: [{ field: 'hired', personName: 'Ivan', byOrchestrator: false, at: '2026-10-30T08:00:00.000Z' }],
  timer: null,
  canEdit: true,
};

/* Tasks as /api/tasks lists them: Development's #12 at its second gate, #11 with Bruno, #9 waiting for a person, #8 done. */
const DANA = { id: 'b0', name: 'Dana', kind: 'head' as const, role: HEAD_TITLE };
const BRUNO = { id: 'b1', name: 'Bruno', kind: 'worker' as const, role: BE_TITLE };
const RITA = { id: 'b2', name: 'Rita', kind: 'worker' as const, role: { en: 'Code reviewer', ru: 'Ревьюер кода' } };
const TOM = { id: 'b3', name: 'Tom', kind: 'worker' as const, role: { en: 'Test engineer', ru: 'Инженер по тестам' } };
const DEV = { id: 'd2', name: 'Development' };
const line = (over: Partial<TaskLine>): TaskLine => ({
  id: 't0', number: 0, title: '', brief: '', status: 'open', department: DEV, product: null, assignee: BRUNO, stage: 0, gateCount: 0, merging: false, bounces: 0, turn: 3, parentId: 't10', waitsFor: [],
  createdAt: '2026-10-30T08:00:00.000Z', updatedAt: '2026-10-30T09:00:00.000Z', ...over,
});

export const TASKS: TaskLine[] = [
  line({ id: 't12', number: 12, title: 'Checkout API', brief: 'Take card payments.', status: 'review', assignee: TOM, stage: 2, gateCount: 3, bounces: 1 }),
  line({ id: 't11', number: 11, title: 'Cart page', brief: 'Show the cart.', status: 'working' }),
  line({ id: 't9', number: 9, title: 'Pick a payment provider', status: 'waiting', assignee: DANA, parentId: null }),
];
export const CLOSED_TASKS: TaskLine[] = [line({ id: 't8', number: 8, title: 'Login page', status: 'done', assignee: null })];

export const TASK_DETAIL: TaskDetail = {
  ...TASKS[0]!,
  body: 'POST /checkout takes a **card token**.',
  parent: { id: 't10', number: 10, title: 'Payments' },
  after: [],
  executor: BRUNO,
  gates: [
    { ...RITA, state: 'passed' },
    { ...TOM, state: 'current' },
    { id: 'b4', name: 'Sam', kind: 'worker', role: { en: 'Security engineer', ru: 'Инженер безопасности' }, state: 'next' },
  ],
  createdBy: { kind: 'agent', id: 'b0', name: 'Dana' },
  subtasks: [line({ id: 't13', number: 13, title: 'Refunds', status: 'open', parentId: 't12' })],
  log: [
    { kind: 'created', text: 'Take card payments.', data: {}, by: { kind: 'agent', id: 'b0', name: 'Dana' }, at: '2026-10-30T08:00:00.000Z' },
    { kind: 'submitted', text: 'Endpoint done.', data: { evidence: 'npm test: 42 passed' }, by: { kind: 'agent', id: 'b1', name: 'Bruno' }, at: '2026-10-30T08:30:00.000Z' },
    { kind: 'verdict', text: 'Looks right.', data: { pass: true, stage: 1 }, by: { kind: 'agent', id: 'b2', name: 'Rita' }, at: '2026-10-30T08:40:00.000Z' },
    { kind: 'comment', text: 'EUR only.', data: {}, by: { kind: 'person', id: 'p1', name: 'Ivan' }, at: '2026-10-30T08:50:00.000Z' },
  ],
  requests: [],
};

export const REQUESTS: WaitingRequest[] = [
  { id: 'r1', kind: 'question', text: 'Stripe or Adyen?', commit: null, commitUrl: null, images: [], options: [], link: null, explained: null, explaining: false, at: '2026-10-30T09:10:00.000Z', agent: { id: 'b0', name: 'Dana' }, task: { id: 't9', number: 9, title: 'Pick a payment provider', department: DEV }, ownerPersonId: 'p1', canAnswer: true },
  { id: 'r2', kind: 'approval', text: 'Release 0.5.0 to main.', commit: 'a'.repeat(40), commitUrl: null, images: [], options: [], link: null, explained: null, explaining: false, at: '2026-10-30T09:20:00.000Z', agent: { id: 'b0', name: 'Dana' }, task: { id: 't10', number: 10, title: 'Payments', department: DEV }, ownerPersonId: 'p1', canAnswer: true },
];

/* What GET /api/requests answers: the requests, the orchestrator's cards and his request for the computer, counted per
   owner and per asking agent as the server counts them. */
export function decisions(requests: WaitingRequest[], more: Partial<Pick<Decisions, 'proposals' | 'computerAccess'>> = {}): Decisions {
  const all = { proposals: [], computerAccess: null, ...more };
  const items = [...requests, ...all.proposals, ...(all.computerAccess ? [all.computerAccess] : [])];
  const byPerson: Record<string, number> = {};
  const byAgent: Record<string, number> = {};
  for (const i of items) {
    byPerson[i.ownerPersonId] = (byPerson[i.ownerPersonId] ?? 0) + 1;
    byAgent[i.agent.id] = (byAgent[i.agent.id] ?? 0) + 1;
  }
  return { requests, ...all, counts: { byPerson, byAgent, total: items.length } };
}

export const TURN: TurnView = {
  id: 'u3',
  number: 3,
  title: 'Payments',
  goal: 'Take card payments in the shop.',
  status: 'open',
  messages: [{ by: 'Ivan', text: 'We need card payments.\nStripe is fine.', at: '2026-10-30T06:50:00.000Z' }],
  taskId: null,
  startedAt: '2026-10-30T07:00:00.000Z',
  openedAt: '2026-10-30T07:00:00.000Z',
  closedAt: null,
  tasks: { total: 5, done: 2 },
};
export const PLANNED_TURN: TurnView = { ...TURN, id: 'u4', number: 4, title: 'Refunds', goal: 'Money goes back.', status: 'planned', messages: [], openedAt: null, tasks: { total: 1, done: 0 } };
export const FINISHED_TURN: TurnView = { ...TURN, id: 'u2', number: 2, title: 'Login', goal: 'People sign in.', status: 'closed', messages: [], closedAt: '2026-10-29T20:00:00.000Z', tasks: { total: 1, done: 1 } };
