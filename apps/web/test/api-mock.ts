import { vi } from 'vitest';
import type { AgentCardView, AgentTime, DepartmentTree, Decisions, IdleStretch, SegmentKind, TreeAgent, TreeLine, TreeReview, TreeSegment, MachineView, Me, Org, PersonView, Roster, RunningAgent, Serving, SubView, TaskDetail, TaskLine, TurnView, WaitingRequest } from '../src/types';

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
    subscription: { id: 's1', provider: 'anthropic_api', kind: 'api_key', label: 'Orchestrator', status: 'ready', online: false, last4: '9f3a', owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company', id: null, name: 'Whole company' }, machines: [], limits: null, budget: null, isOrchestrator: true, accounts: [], tier: null, accountsDiffer: false, signedInOnce: false, leaseMachine: null },
    context: null,
    program: null, alarm: null,
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

export const RUNNING_AGENTS: RunningAgent[] = [
  { id: 'b1', name: 'Bruno', busy: true, title: { en: 'Backend engineer', ru: 'Бэкенд-разработчик' }, department: { id: 'd2', name: 'Development' }, provider: 'claude', since: new Date(Date.now() - 12 * 60_000).toISOString(), task: { number: 12, title: 'Checkout API' }, withCeo: false },
  { id: 'b2', name: 'Vera', busy: false, title: { en: 'Reviewer', ru: 'Рецензент' }, department: { id: 'd2', name: 'Development' }, provider: 'claude', since: null, task: null, withCeo: false },
];

const SUB_BASE = { kind: 'personal' as const, last4: null, owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company' as const, id: null, name: 'Whole company' }, limits: null, budget: null, isOrchestrator: false, accounts: [], tier: null, accountsDiffer: false, signedInOnce: false, leaseMachine: null };

export const MACHINE = { id: 'm1', hostname: 'ivan-mbp', status: 'ready' as const, online: true };

export const SUBS: SubView[] = [
  {
    ...SUB_BASE, agents: RUNNING_AGENTS, id: 's-claude', provider: 'claude', label: 'Claude', status: 'ready', online: true, machines: [MACHINE],
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
      agents: RUNNING_AGENTS,
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
        { id: 'b0', name: 'Dana', roleId: 'DEV-HEAD', title: HEAD_TITLE, kind: 'head', model: '', modelName: null, provider: 'claude', effort: null, state: 'working', status: 'working', on: true, timer: null, task: null, context: null, program: null, alarm: null },
        { id: 'b1', name: 'Bruno', roleId: 'DEV-BE', title: BE_TITLE, kind: 'worker', model: 'claude-sonnet-5-5', modelName: 'Claude Sonnet 5.5', provider: 'anthropic_api', effort: null, state: 'sleeping', status: 'idle', on: true, timer: null, task: null, context: null, program: null, alarm: null },
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
  role: { id: 'DEV-BE', title: BE_TITLE, description: about('Builds the API.'), effort: 'xhigh' },
  department: { id: 'd2', name: 'Development' },
  product: null,
  team: null,
  teams: [],
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
  interrupted: [],
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


/* The approved example, timed from 09:00 on one day. TREE_ORG adds its other employees to Development. */
type TreeExample = {
  id: string; agent: TreeAgent; number: number; part: number; created: number; cut?: number; merged?: number; done?: number; after?: number;
  title: string; segments: [number, number, SegmentKind][]; moves: [number, string, string][];
};

const treeAt = (minute: number) => new Date(Date.UTC(2026, 9, 30, 9, minute)).toISOString();
const TREE_TURN = { id: 'u3', number: 3, branch: 'turn-3', startedAt: treeAt(0) };

const DEV_EXAMPLES: TreeExample[] = [
  {
    id: 'b42',
    agent: { id: 'b1', name: 'Bruno' },
    number: 42,
    part: 41,
    created: 20,
    cut: 20,
    merged: 190,
    title: 'Payment gateway on the server',
    segments: [ [ 20, 190, 'work' ] ],
    moves: [
      [ 70, 'comment', 'The gateway charges a test card' ],
      [ 140, 'comment', 'Bank replies and retries on a dropped line are done' ]
    ]
  },
  {
    id: 'b43',
    agent: { id: 'b2', name: 'Timur' },
    number: 43,
    part: 41,
    created: 22,
    cut: 22,
    merged: 360,
    title: 'Payment screen in the app',
    segments: [ [ 22, 108, 'work' ], [ 108, 150, 'stall' ], [ 150, 360, 'work' ] ],
    moves: [
      [ 60, 'comment', 'Screen layout and the card number field' ],
      [ 150, 'comment', 'Checking the card number and expiry date' ],
      [ 230, 'comment', 'Payment done and error screens' ],
      [ 300, 'comment', 'Dark theme and texts in two languages' ]
    ]
  },
  {
    id: 'b44',
    agent: { id: 'b3', name: 'Lev' },
    number: 44,
    part: 41,
    created: 25,
    cut: 25,
    merged: 410,
    title: 'Receipts and emails after payment',
    segments: [ [ 25, 190, 'work' ], [ 190, 340, 'stall' ], [ 340, 410, 'work' ] ],
    moves: [
      [ 80, 'comment', 'Receipt template and the email after payment' ],
      [ 185, 'comment', 'Receipt as a PDF, sending emails is next' ],
      [ 340, 'comment', 'Emails go out through a queue' ]
    ]
  },
  {
    id: 'b49',
    agent: { id: 'b4', name: 'Eva' },
    number: 49,
    part: 48,
    created: 95,
    cut: 95,
    merged: 375,
    title: 'Refunds on the server',
    segments: [ [ 95, 270, 'work' ], [ 270, 335, 'person' ], [ 335, 375, 'work' ] ],
    moves: [
      [ 160, 'comment', 'Partial refunds and the refund log' ],
      [ 270, 'asked', 'How many days after paying may a customer get the money back: 14 or 30?' ],
      [ 335, 'answered', '30 days, as in the contract.' ]
    ]
  },
  {
    id: 'b50',
    agent: { id: 'b5', name: 'Ostap' },
    number: 50,
    part: 48,
    created: 100,
    cut: 375,
    merged: 435,
    after: 49,
    title: 'Refund button in the app',
    segments: [ [ 100, 375, 'after' ], [ 375, 435, 'work' ] ],
    moves: [ [ 375, 'started', '' ], [ 405, 'comment', 'The refund confirmation window' ] ]
  }
];

const SALES_EXAMPLES: TreeExample[] = [
  {
    id: 's61',
    agent: { id: 's1', name: 'Nina' },
    number: 61,
    part: 60,
    created: 30,
    title: 'An email to customers about the new payment',
    segments: [ [ 30, 900, 'work' ] ],
    moves: [
      [ 120, 'comment', 'The email draft is ready' ],
      [ 250, 'comment', 'The email is shorter and plainer now' ]
    ]
  },
  {
    id: 's62',
    agent: { id: 's2', name: 'Artem' },
    number: 62,
    part: 60,
    created: 35,
    done: 190,
    title: 'Customers for the first email',
    segments: [ [ 35, 190, 'work' ] ],
    moves: [
      [ 100, 'comment', 'Picked those who paid in the last year' ],
      [ 190, 'report', 'The list is ready: 240 customers' ]
    ]
  },
  {
    id: 's63',
    agent: { id: 's3', name: 'Sonya' },
    number: 63,
    part: 60,
    created: 40,
    title: 'Answers to common questions about payment',
    segments: [ [ 40, 270, 'work' ], [ 270, 900, 'stall' ] ],
    moves: [ [ 150, 'comment', 'First answers about payment' ], [ 265, 'comment', 'Answers about refunds' ] ]
  }
];

function exampleSegments(segments: TreeExample['segments'], now: number): TreeSegment[] {
  return segments.filter(s => s[0] < now).map(([from, to, kind]) => ({ kind, from: treeAt(from), to: to <= now ? treeAt(to) : null }));
}

function exampleLine(e: TreeExample, now: number, repository: boolean): TreeLine {
  const end = (at: number | undefined) => at != null && at <= now ? treeAt(at) : null;
  const segments = exampleSegments(e.segments, now);
  const active = currentExampleSegment(segments, treeAt(now));
  const live = e.agent.id === 'b2' && now === 320 || e.agent.id === 's1';
  return {
    taskId: e.id, number: e.number, title: e.title, agent: e.agent,
    part: { id: 't' + e.part, number: e.part, title: e.part === 41 ? 'Card payments' : e.part === 48 ? 'Refunds' : 'Tell customers about card payments' },
    branch: repository && end(e.cut) ? 'task-' + e.number : null,
    createdAt: treeAt(e.created), cutAt: end(e.cut), mergedAt: end(e.merged), doneAt: end(e.done),
    waitsFor: e.after ? [e.after] : [], segments,
    moves: e.moves.filter(m => m[0] <= now).map(([at, kind, text]) => ({ at: treeAt(at), kind, text })),
    lastActionAt: live ? treeAt(now - 1) : active?.from ?? treeAt(e.created), live,
  };
}

const currentExampleSegment = (segments: TreeSegment[], now: string) => segments.find(s => s.from <= now && (!s.to || s.to > now));
const exampleSeconds = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 1000;

function exampleTime(agent: TreeAgent, segments: TreeSegment[], now: string): AgentTime {
  const seconds = (kind: SegmentKind) => segments.filter(s => s.kind === kind).reduce((n, s) => n + exampleSeconds(s.from, s.to ?? now), 0);
  return { agent, work: seconds('work'), after: seconds('after'), person: seconds('person'), stall: seconds('stall') };
}

function exampleIdle(lines: TreeLine[], now: string): IdleStretch[] {
  const idle = lines.flatMap(line => line.segments.filter((s): s is TreeSegment & { kind: IdleStretch['kind'] } => s.kind !== 'work').map(s => ({
    agent: line.agent, taskId: line.taskId, number: line.number, title: line.title, kind: s.kind, from: s.from, to: s.to,
    waitsFor: line.waitsFor, question: s.kind === 'person' ? line.moves.find(m => m.kind === 'asked')?.text ?? null : null,
  })));
  const rank = { lost: 0, alarm: 0, stall: 1, person: 2, after: 3, queued: 4, unknown: 5 };
  const length = (i: IdleStretch) => exampleSeconds(i.from, i.to ?? now);
  return idle.sort((a, b) => Number(!!a.to) - Number(!!b.to) || (!a.to ? rank[a.kind] - rank[b.kind] : 0) || length(b) - length(a));
}

function exampleReview(): TreeReview {
  const panel: [TreeAgent, number, number][] = [
    [{ id: 'b6', name: 'Vera' }, 454, 2], [{ id: 'b7', name: 'Gleb' }, 472, 3], [{ id: 'b8', name: 'Rita' }, 451, 0],
  ];
  return { taskId: 'r54', number: 54, openedAt: treeAt(435), closedAt: null, head: { id: 'b0', name: 'Dana' },
    reviewers: panel.map(([agent, end, findings]) => ({
      agent, verdict: end <= 460 ? { at: treeAt(end), pass: findings === 0, findings } : null,
      segments: exampleSegments([[435, end, 'work']], 460), lastActionAt: treeAt(Math.min(459, end)), live: end > 460,
    })),
  };
}

function exampleTree(examples: TreeExample[], now: number, repository: boolean, review: TreeReview | null = null): DepartmentTree {
  const lines = examples.map(e => exampleLine(e, now, repository)), at = treeAt(now);
  const time = [...lines.map(l => exampleTime(l.agent, l.segments, at)), ...(review?.reviewers ?? []).map(r => exampleTime(r.agent, r.segments, at))];
  return { now: at, turn: TREE_TURN, repository, stage: review ? 'review' : 'work', lines, review, time, idle: exampleIdle(lines, at) };
}

export const DEV_TREE = exampleTree(DEV_EXAMPLES, 320, true);
export const REVIEW_TREE = exampleTree(DEV_EXAMPLES, 460, true, exampleReview());
export const SALES_TREE = exampleTree(SALES_EXAMPLES, 320, false);

/* Extra employees keep existing two-person schema examples small. */
export const TREE_ORG: Org = {
  ...DEV_ORG,
  departments: DEV_ORG.departments.map(d => ({ ...d, employees: [
    ...d.employees,
    ...[...DEV_TREE.time, ...REVIEW_TREE.time].filter((a, i, all) => !d.employees.some(e => e.id === a.agent.id) && all.findIndex(b => b.agent.id === a.agent.id) === i).map(a => ({ ...d.employees[1]!, ...a.agent })),
  ] })),
};
