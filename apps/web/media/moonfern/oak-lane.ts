import type {
  AgentCardView,
  BuiltinView,
  Company,
  Department,
  DeptRole,
  Employee,
  EmployeeStatus,
  Lang,
  MachineView,
  Me,
  Org,
  PersonView,
  SubView,
  TaskDetail,
  TaskLine,
  TurnView,
  WaitingRequest,
} from '../../src/types';
import { BASE_ISO, BASE_MS, isoMinutes } from './clock';
import { GIB } from './machines';
import { emptyEchelonFindings } from '@hornhoof/protocol/echelons';
import { employeeTask, routeAt } from './route';
import { buildDecisions } from './tasks';

const L = (en: string): Lang => ({ en, ru: en });
const gb = (n: number) => Math.round(n * GIB);

export const OAK_COMPANY: Company = {
  id: 'comp-oak-lane',
  name: 'Oak Lane home',
};

export const NINA_VIEW: PersonView = {
  id: 'p-nina',
  name: 'Nina Park',
  email: 'nina@oaklane.home',
  title: 'CEO',
  status: 'active',
  isOwner: true,
  isCeoDelegate: false,
  access: { whole: true, departments: [], teams: [] },
  pendingDecisions: 2,
};

export const TOM_VIEW: PersonView = {
  id: 'p-tom',
  name: 'Tom Park',
  email: 'tom@oaklane.home',
  title: 'Household & Network',
  status: 'active',
  isOwner: false,
  isCeoDelegate: true,
  access: { whole: true, departments: [], teams: [] },
  pendingDecisions: 0,
};

export const OAK_ME: Me = {
  person: {
    id: NINA_VIEW.id,
    companyId: OAK_COMPANY.id,
    name: NINA_VIEW.name,
    email: NINA_VIEW.email ?? '',
    title: NINA_VIEW.title,
    status: 'active',
    scopeKind: 'company',
    isOwner: true,
  },
  company: OAK_COMPANY,
  canDecideCompany: true,
};

export const OAK_PEOPLE: PersonView[] = [NINA_VIEW, TOM_VIEW];

export const OAK_SUBSCRIPTIONS: SubView[] = [
  {
    id: 'sub-nina-claude',
    provider: 'claude',
    kind: 'personal',
    label: 'Claude Pro',
    status: 'ready',
    online: true,
    last4: null,
    owner: { id: NINA_VIEW.id, name: NINA_VIEW.name },
    place: { kind: 'company', id: null, name: 'Whole company' },
    machines: [
      { id: 'm-home-server', hostname: 'home-server', status: 'ready', online: true },
      { id: 'm-home-rpi', hostname: 'raspberry-pi', status: 'ready', online: true },
    ],
    limits: {
      status: 'allowed',
      complete: true,
      windows: [
        { name: 'five_hour', utilization: 0.34, resetsAt: isoMinutes(160) },
        { name: 'seven_day', utilization: 0.21, resetsAt: isoMinutes(4320) },
      ],
    },
    limitsUpdatedAt: isoMinutes(-2),
    budget: 80,
    isOrchestrator: true,
    accounts: [{ nodeId: 'n-oak-1', hostname: 'home-server', tier: 'pro', email: 'nina@oaklane.home' }],
    tier: 'pro',
    accountsDiffer: false,
    signedInOnce: true,
    leaseMachine: null,
    agents: [],
  },
  {
    id: 'sub-tom-kimi',
    provider: 'kimi',
    kind: 'personal',
    label: 'Kimi Code',
    status: 'ready',
    online: true,
    last4: null,
    owner: { id: TOM_VIEW.id, name: TOM_VIEW.name },
    place: { kind: 'company', id: null, name: 'Whole company' },
    machines: [{ id: 'm-old-macbook', hostname: 'old-macbook', status: 'ready', online: true }],
    limits: {
      status: 'allowed',
      complete: true,
      windows: [
        { name: 'five_hour', utilization: 0.28, resetsAt: isoMinutes(195) },
        { name: 'seven_day', utilization: 0.16, resetsAt: isoMinutes(5100) },
      ],
    },
    limitsUpdatedAt: isoMinutes(-2),
    budget: 80,
    isOrchestrator: false,
    accounts: [{ nodeId: 'n-oak-2', hostname: 'old-macbook', tier: null, email: 'tom@oaklane.home' }],
    tier: null,
    accountsDiffer: false,
    signedInOnce: true,
    leaseMachine: null,
    agents: [],
  },
];

export const OAK_MACHINES: MachineView[] = [
  {
    id: 'm-home-server',
    hostname: 'home-server',
    os: 'linux',
    arch: 'x86_64',
    owner: { id: NINA_VIEW.id, name: NINA_VIEW.name },
    online: true,
    lastSeenAt: isoMinutes(-1),
    plans: [{ id: 'sub-nina-claude', provider: 'claude', status: 'ready', online: true }],
    load: { cpus: 4, load: 1.4, memTotal: gb(16), memFree: gb(9.8), diskTotal: gb(512), diskFree: gb(380), tests: 0, jobs: 3, cpuModel: 'Intel N100' },
    lendsTests: true,
    running: { agents: [], parts: [] },
  },
  {
    id: 'm-old-macbook',
    hostname: 'old-macbook',
    os: 'darwin',
    arch: 'arm64',
    owner: { id: TOM_VIEW.id, name: TOM_VIEW.name },
    online: true,
    lastSeenAt: isoMinutes(-1),
    plans: [{ id: 'sub-tom-kimi', provider: 'kimi', status: 'ready', online: true }],
    load: { cpus: 8, load: 2.3, memTotal: gb(8), memFree: gb(3.6), diskTotal: gb(256), diskFree: gb(142), tests: 0, jobs: 3, cpuModel: 'Apple M1' },
    lendsTests: true,
    running: { agents: [], parts: [] },
  },
  {
    id: 'm-home-rpi',
    hostname: 'raspberry-pi',
    os: 'linux',
    arch: 'arm64',
    owner: { id: NINA_VIEW.id, name: NINA_VIEW.name },
    online: true,
    lastSeenAt: isoMinutes(-1),
    plans: [{ id: 'sub-nina-claude', provider: 'claude', status: 'ready', online: true }],
    load: { cpus: 4, load: 0.8, memTotal: gb(8), memFree: gb(5.9), diskTotal: gb(128), diskFree: gb(98), tests: 0, jobs: 1, cpuModel: 'Raspberry Pi 5' },
    lendsTests: true,
    running: { agents: [], parts: [] },
  },
];

export const OAK_BUILTIN: BuiltinView = {
  online: true,
  load: OAK_MACHINES[0]!.load,
  running: { agents: [], parts: [] },
  machine: { id: 'm-home-server', hostname: 'home-server' },
};

const emp = (
  id: string,
  name: string,
  roleId: string,
  title: string,
  kind: 'head' | 'worker',
  provider: 'claude' | 'kimi',
  status: EmployeeStatus,
  task?: { number: number; title: string },
): Employee => ({
  id,
  name,
  roleId,
  title: L(title),
  kind,
  model: provider === 'claude' ? 'claude-sonnet-4-6' : 'kimi-k2.5',
  modelName: provider === 'claude' ? 'Claude Sonnet 4.6' : 'Kimi K2.5',
  provider,
  effort: null,
  state: status === 'working' ? 'working' : 'sleeping',
  status,
  on: true,
  timer: roleId === 'OPS-WATCH' ? 10 : null,
  task: task ? employeeTask(`oak-t-${task.number}`, task.number, task.title, 0, 0) : null,
  context: 0.31,
  program: status === 'working'
    ? { state: 'tool', since: BASE_MS - 180_000, tool: 'Bash', screenAt: BASE_MS - 5000, signAt: BASE_MS - 5000, retry: null, reportedAt: BASE_MS - 2000 }
    : null,
  alarm: null,
  retry: null,
  failure: null,
});

const roles = (defs: [string, string, 'head' | 'member'][]): DeptRole[] =>
  defs.map(([id, title, kind]) => ({ id, title: L(title), description: L(title), kind, gate: null }));

function oakDept(
  id: string,
  templateKey: Department['templateKey'],
  roleCode: string,
  about: string,
  employees: Employee[],
  deptRoles: DeptRole[],
): Department {
  const head = employees[0]!;
  const working = employees.filter(e => e.status === 'working').length;
  return {
    id,
    name: null,
    templateKey,
    roleCode,
    about,
    agents: { total: employees.length, working },
    products: [],
    teams: [],
    people: [],
    employees,
    roles: deptRoles,
    workLines: employees.slice(1).map(e => ({
      upstreamAgentId: head.id,
      downstreamAgentId: e.id,
      working: e.status === 'working',
      workEpoch: 2,
      returnedEpoch: null,
      returnedAt: null,
    })),
    current: head.task ? { id: head.task.id, number: head.task.number, title: head.task.title } : null,
  };
}

export const OAK_DEPARTMENTS: Department[] = [
  oakDept(
    'oak-ops',
    'operations',
    'OPS',
    'Watches the home server, backups and agent schedules.',
    [
      emp('oak-ops-head', 'Arthur', 'OPS-HEAD', 'Head of operations', 'head', 'claude', 'working', { number: 45, title: 'Verify nightly encrypted photo backup' }),
      emp('oak-ops-watch', 'Pip', 'OPS-WATCH', 'Task watchdog', 'worker', 'claude', 'idle'),
    ],
    roles([
      ['OPS-HEAD', 'Head of operations', 'head'],
      ['OPS-WATCH', 'Task watchdog', 'member'],
    ]),
  ),
  oakDept(
    'oak-hom',
    'home_devices',
    'HOM',
    'Looks after Wi-Fi, routers, cameras and family computers; changes wait for a person.',
    [
      emp('oak-hom-head', 'Felix', 'HOM-HEAD', 'Head of home devices', 'head', 'claude', 'working', { number: 40, title: 'Weekly check of network, cameras and laptops' }),
      emp('oak-hom-net', 'Mina', 'HOM-NET', 'Network and Wi-Fi', 'worker', 'claude', 'waiting', { number: 41, title: 'Router firmware 7.2 is ready: update tonight?' }),
      emp('oak-hom-smart', 'Gus', 'HOM-SMART', 'Smart devices', 'worker', 'kimi', 'working', { number: 46, title: 'Living room camera offline since 09:40' }),
      emp('oak-hom-clean', 'Cleo', 'HOM-CLEAN', 'Device cleanup', 'worker', 'claude', 'waiting', { number: 42, title: "3 unknown browser extensions on Mia's laptop: remove?" }),
    ],
    roles([
      ['HOM-HEAD', 'Head of home devices', 'head'],
      ['HOM-NET', 'Network and Wi-Fi', 'member'],
      ['HOM-SMART', 'Smart devices', 'member'],
      ['HOM-CLEAN', 'Device cleanup', 'member'],
    ]),
  ),
  oakDept(
    'oak-hhd',
    'household',
    'HHD',
    'Shopping lists, utility bills, winter schedules and family reminders.',
    [
      emp('oak-hhd-head', 'Martha', 'HHD-HEAD', 'Head of household', 'head', 'kimi', 'working', { number: 43, title: 'Shopping list for Saturday' }),
      emp('oak-hhd-shop', 'June', 'HHD-SUPPLY', 'Shopping and supplies', 'worker', 'kimi', 'working', { number: 43, title: 'Shopping list for Saturday' }),
      emp('oak-hhd-bills', 'Ben', 'HHD-BILLS', 'Bills and subscriptions', 'worker', 'claude', 'working', { number: 44, title: 'Electricity bill due on the 12th' }),
      emp('oak-hhd-cal', 'Sunny', 'HHD-CAL', 'Calendar and chores', 'worker', 'kimi', 'working', { number: 45, title: 'Thermostat schedule for winter' }),
    ],
    roles([
      ['HHD-HEAD', 'Head of household', 'head'],
      ['HHD-SUPPLY', 'Shopping and supplies', 'member'],
      ['HHD-BILLS', 'Bills and subscriptions', 'member'],
      ['HHD-CAL', 'Calendar and chores', 'member'],
    ]),
  ),
];

export const OAK_ORG: Org = {
  company: OAK_COMPANY,
  orchestrator: {
    id: 'oak-orch',
    name: 'Orchestrator',
    model: 'claude-opus-4-6',
    effort: null,
    subscription: OAK_SUBSCRIPTIONS[0]!,
    machine: { id: 'm-home-server', hostname: 'home-server' },
    context: 0.25,
    program: null,
    alarm: null,
    retry: null,
    failure: null,
  },
  agents: {
    total: OAK_DEPARTMENTS.reduce((s, d) => s + d.agents.total, 0),
    working: OAK_DEPARTMENTS.reduce((s, d) => s + d.agents.working, 0),
  },
  people: [NINA_VIEW, TOM_VIEW],
  departments: OAK_DEPARTMENTS,
  turn: {
    id: 'oak-turn-4',
    number: 4,
    goal: 'Week 45 home checkup and Saturday prep',
  },
  serverNow: BASE_ISO,
  workLines: OAK_DEPARTMENTS.map(d => ({
    upstreamAgentId: 'oak-orch',
    downstreamAgentId: d.employees[0]!.id,
    working: d.agents.working > 0,
    workEpoch: 4,
    returnedEpoch: null,
    returnedAt: null,
  })),
};

const HOM_PLACE = { id: 'oak-hom', name: 'Home devices' };
const HHD_PLACE = { id: 'oak-hhd', name: 'Household' };

export const OAK_TASKS: TaskLine[] = [
  {
    id: 'oak-t-41', number: 41, title: 'Router firmware 7.2 is ready: update tonight?',
    brief: 'ASUS main router has security update 7.2.0; reboot takes 3 minutes after 23:30.',
    status: 'waiting', department: HOM_PLACE, product: null,
    assignee: { id: 'oak-hom-net', name: 'Mina', kind: 'worker', role: L('Network and Wi-Fi') },
    echelons: routeAt(0, 0), turn: 4, parentId: null, waitsFor: [],
    createdAt: isoMinutes(-95), updatedAt: isoMinutes(-14),
  },
  {
    id: 'oak-t-42', number: 42, title: "3 unknown browser extensions on Mia's laptop: remove?",
    brief: 'Found three ad-injector extensions added to Chrome profile on old-macbook.',
    status: 'waiting', department: HOM_PLACE, product: null,
    assignee: { id: 'oak-hom-clean', name: 'Cleo', kind: 'worker', role: L('Device cleanup') },
    echelons: routeAt(0, 0), turn: 4, parentId: null, waitsFor: [],
    createdAt: isoMinutes(-80), updatedAt: isoMinutes(-9),
  },
  {
    id: 'oak-t-46', number: 46, title: 'Living room camera offline since 09:40',
    brief: 'Check 2.4 GHz Wi-Fi lease and PoE port draw for living room camera.',
    status: 'working', department: HOM_PLACE, product: null,
    assignee: { id: 'oak-hom-smart', name: 'Gus', kind: 'worker', role: L('Smart devices') },
    echelons: routeAt(0, 0), turn: 4, parentId: null, waitsFor: [],
    createdAt: isoMinutes(-60), updatedAt: isoMinutes(-5),
  },
  {
    id: 'oak-t-43', number: 43, title: 'Shopping list for Saturday',
    brief: 'Pantry staples, dishwasher salt, coffee beans and ingredients for Sunday roast.',
    status: 'working', department: HHD_PLACE, product: null,
    assignee: { id: 'oak-hhd-shop', name: 'June', kind: 'worker', role: L('Shopping and supplies') },
    echelons: routeAt(0, 0), turn: 4, parentId: null, waitsFor: [],
    createdAt: isoMinutes(-110), updatedAt: isoMinutes(-12),
  },
  {
    id: 'oak-t-44', number: 44, title: 'Electricity bill due on the 12th',
    brief: 'Compare October kWh usage against September and prepare payment reminder.',
    status: 'working', department: HHD_PLACE, product: null,
    assignee: { id: 'oak-hhd-bills', name: 'Ben', kind: 'worker', role: L('Bills and subscriptions') },
    echelons: routeAt(0, 0), turn: 4, parentId: null, waitsFor: [],
    createdAt: isoMinutes(-130), updatedAt: isoMinutes(-20),
  },
  {
    id: 'oak-t-45', number: 45, title: 'Thermostat schedule for winter',
    brief: 'Set 20.5 C at 06:30 on weekdays and 18 C overnight starting Monday.',
    status: 'done', department: HOM_PLACE, product: null,
    assignee: { id: 'oak-hom-smart', name: 'Gus', kind: 'worker', role: L('Smart devices') },
    echelons: routeAt(0, 0), turn: 4, parentId: null, waitsFor: [],
    createdAt: isoMinutes(-200), updatedAt: isoMinutes(-50),
  },
];

export const OAK_TURNS: TurnView[] = [
  {
    id: 'oak-turn-4',
    number: 4,
    title: 'Week 45 home checkup and Saturday prep',
    goal: 'Check home devices and laptops, set winter heating schedule and prepare Saturday errands.',
    status: 'open',
    messages: [],
    taskId: null,
    startedAt: isoMinutes(-220),
    openedAt: isoMinutes(-218),
    closedAt: null,
    version: null,
    commit: null,
    baseVersion: null,
    departmentId: 'oak-hom',
    releases: false,
    tasks: { total: 6, done: 1 },
  },
];

export const INITIAL_OAK_REQUESTS: WaitingRequest[] = [
  {
    id: 'oak-req-router',
    kind: 'choice',
    text: 'Router firmware 7.2 is ready: update tonight? Wi-Fi will restart for about 3 minutes at 23:30.',
    commit: null,
    commitUrl: null,
    images: [],
    options: [
      { label: 'Yes, update tonight at 23:30', image: null },
      { label: 'Wait until the weekend', image: null },
    ],
    link: null,
    explained: null,
    explaining: false,
    at: isoMinutes(-14),
    agent: { id: 'oak-hom-net', name: 'Mina' },
    task: { id: 'oak-t-41', number: 41, title: 'Router firmware 7.2 is ready: update tonight?', department: HOM_PLACE },
    ownerPersonId: NINA_VIEW.id,
    canAnswer: true,
    decidedBy: { kind: 'ceo_and_delegate', department: HOM_PLACE },
  },
  {
    id: 'oak-req-ext',
    kind: 'choice',
    text: "3 unknown browser extensions on Mia's laptop: remove? They inject search banners and are not on the school list.",
    commit: null,
    commitUrl: null,
    images: [],
    options: [
      { label: 'Yes, remove all 3 extensions', image: null },
      { label: 'Keep them for now', image: null },
    ],
    link: null,
    explained: null,
    explaining: false,
    at: isoMinutes(-9),
    agent: { id: 'oak-hom-clean', name: 'Cleo' },
    task: { id: 'oak-t-42', number: 42, title: "3 unknown browser extensions on Mia's laptop: remove?", department: HOM_PLACE },
    ownerPersonId: NINA_VIEW.id,
    canAnswer: true,
    decidedBy: { kind: 'ceo_and_delegate', department: HOM_PLACE },
  },
];

export const buildOakDecisions = buildDecisions;

export function oakTaskDetail(taskId: string): TaskDetail | null {
  const line = OAK_TASKS.find(t => t.id === taskId);
  if (!line) return null;
  return {
    ...line,
    body: line.brief,
    parent: null,
    after: [],
    executor: line.assignee,
    echelonFindings: emptyEchelonFindings(),
    createdBy: { kind: 'person', id: NINA_VIEW.id, name: NINA_VIEW.name },
    subtasks: [],
    log: [],
    requests: [],
  };
}

export function oakAgentCard(agentId: string): AgentCardView | null {
  const empItem = OAK_DEPARTMENTS.flatMap(d => d.employees.map(e => ({ e, d }))).find(x => x.e.id === agentId);
  if (!empItem) return null;
  const { e, d } = empItem;
  return {
    id: e.id,
    canRemove: false,
    currentTask: e.task ? { id: e.task.id, number: e.task.number, title: e.task.title } : null,
    kind: e.kind,
    name: e.name,
    role: e.roleId && e.title ? { id: e.roleId, title: e.title, description: e.title } : null,
    department: { id: d.id, name: d.name ?? 'Home' },
    product: null,
    model: e.model,
    effort: null,
    subscription: OAK_SUBSCRIPTIONS[0]!,
    machine: { id: 'm-home-server', hostname: 'home-server' },
    state: e.state,
    program: e.program,
    alarm: null,
    retry: null,
    failure: null,
    skills: [],
    parts: [],
    raw: '',
    runsOn: [],
    changes: [],
    interrupted: [],
    canEdit: true,
    timer: null,
  };
}
