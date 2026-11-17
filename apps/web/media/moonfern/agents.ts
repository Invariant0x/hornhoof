import type {
  AgentCardView,
  Department,
  DeptRole,
  Employee,
  EmployeeStatus,
  EmployeeTask,
  Lang,
  MachineView,
  ModelOption,
  Org,
  ProviderId,
  RunningAgent,
  SubView,
  WorkLine,
} from '../../src/types';
import { BASE_ISO, BASE_MS, isoMinutes } from './clock';
import { attachRunningAgents, BASE_MACHINES } from './machines';
import { LEO_VIEW, MAYA_VIEW, MOONFERN_COMPANY, SAM_VIEW } from './people';
import { BASE_SUBSCRIPTIONS, subById } from './plans';
import { employeeTask } from './route';

const L = (en: string): Lang => ({ en, ru: en });

export type AgentPlacement = {
  employee: Employee;
  departmentId: string;
  departmentName: string;
  subscriptionId: string;
  machineId: string;
  machineHost: string;
  skills: { id: string; title: string; description: string }[];
};

const programOf = (tool: string | null, minutesAgo = 4) => ({
  state: (tool ? 'tool' : 'thinking') as 'tool' | 'thinking',
  since: BASE_MS - minutesAgo * 60_000,
  tool,
  screenAt: BASE_MS - 12_000,
  signAt: BASE_MS - 8_000,
  retry: null,
  reportedAt: BASE_MS - 4_000,
});

const taskRef = (number: number, title: string, stage = 0, gateCount = 3, _bounces = 0): EmployeeTask => employeeTask(`t-${number}`, number, title, stage, gateCount);

type Spec = {
  id: string;
  name: string;
  deptId: string;
  deptName: string;
  roleId: string;
  roleTitle: string;
  kind?: 'head' | 'worker';
  teamId?: string | null;
  subId: string;
  machineId: string;
  machineHost: string;
  model: string;
  modelName: string;
  effort?: string | null;
  status: EmployeeStatus;
  timer?: number | null;
  context?: number;
  tool?: string | null;
  task?: EmployeeTask | null;
};

const SPECS: Spec[] = [
  /* Operations (5): head, task watchdog, weak point collector, program operator, reliability engineer */
  {
    id: 'ops-head', name: 'Clara', deptId: 'dept-ops', deptName: 'Operations',
    roleId: 'OPS-HEAD', roleTitle: 'Head of operations', kind: 'head',
    subId: 'sub-maya-claude', machineId: 'm-maya-mbp', machineHost: 'maya-macbook-pro',
    model: 'claude-opus-4-6', modelName: 'Claude Opus 4.6', effort: 'high',
    status: 'working', context: 0.42, tool: 'Bash',
    task: taskRef(228, 'Provision APNs push certificate for TestFlight', 0, 0),
  },
  {
    id: 'ops-watch', name: 'Wren', deptId: 'dept-ops', deptName: 'Operations',
    roleId: 'OPS-WATCH', roleTitle: 'Task watchdog',
    subId: 'sub-maya-claude', machineId: 'm-office-nuc', machineHost: 'office-nuc',
    model: 'claude-sonnet-4-6', modelName: 'Claude Sonnet 4.6',
    status: 'working', timer: 10, context: 0.24, tool: 'Read',
    task: taskRef(239, 'Check stalled task heartbeats across Turn 6', 0, 0),
  },
  {
    id: 'ops-bugs', name: 'Reed', deptId: 'dept-ops', deptName: 'Operations',
    roleId: 'OPS-BUGS', roleTitle: 'Weak point collector',
    subId: 'sub-maya-codex', machineId: 'm-maya-mbp', machineHost: 'maya-macbook-pro',
    model: 'gpt-5.3-codex', modelName: 'GPT-5.3 Codex',
    status: 'idle', timer: 180, context: 0.18,
  },
  {
    id: 'ops-prog', name: 'Milo', deptId: 'dept-ops', deptName: 'Operations',
    roleId: 'OPS-PROGRAM', roleTitle: 'Program operator',
    subId: 'sub-leo-claude', machineId: 'm-rpi', machineHost: 'raspberry-pi',
    model: 'claude-haiku-4-5', modelName: 'Claude Haiku 4.5',
    status: 'idle', context: 0.11,
  },
  {
    id: 'ops-fix', name: 'Nora', deptId: 'dept-ops', deptName: 'Operations',
    roleId: 'OPS-FIX', roleTitle: 'Reliability engineer',
    subId: 'sub-maya-codex', machineId: 'm-old-thinkpad', machineHost: 'old-thinkpad',
    model: 'gpt-5.3-codex', modelName: 'GPT-5.3 Codex', effort: 'high',
    status: 'working', context: 0.51, tool: 'Edit',
    task: taskRef(233, 'Alert on crash-free session dip below 99.5%', 0, 0),
  },

  /* Development (17): head, architect, 8 developers across all 7 plans, 4 reviewers, security, test, performance */
  {
    id: 'dev-head', name: 'Dana', deptId: 'dept-dev', deptName: 'Development',
    roleId: 'DEV-HEAD', roleTitle: 'Head of development', kind: 'head',
    subId: 'sub-maya-claude', machineId: 'm-maya-mbp', machineHost: 'maya-macbook-pro',
    model: 'claude-opus-4-6', modelName: 'Claude Opus 4.6', effort: 'high',
    status: 'working', context: 0.58, tool: null,
    task: taskRef(201, 'Coordinate Turn 6 iOS beta tasks and merges', 0, 0),
  },
  {
    id: 'dev-arch', name: 'Victor', deptId: 'dept-dev', deptName: 'Development',
    roleId: 'DEV-ARCH', roleTitle: 'Architect',
    subId: 'sub-maya-codex', machineId: 'm-maya-mbp', machineHost: 'maya-macbook-pro',
    model: 'gpt-5.4', modelName: 'GPT-5.4', effort: 'high',
    status: 'working', context: 0.46, tool: 'Edit',
    task: taskRef(219, 'Sync schema for offline watering logs'),
  },
  {
    id: 'dev-1', name: 'Iris', deptId: 'dept-dev', deptName: 'Development',
    roleId: 'DEV-ENG', roleTitle: 'Developer',
    subId: 'sub-maya-claude', machineId: 'm-maya-mbp', machineHost: 'maya-macbook-pro',
    model: 'claude-sonnet-4-6', modelName: 'Claude Sonnet 4.6', effort: 'high',
    status: 'working', context: 0.63, tool: 'Bash',
    task: taskRef(221, 'Plant identification camera flow'),
  },
  {
    id: 'dev-8', name: 'Tessa', deptId: 'dept-dev', deptName: 'Development',
    roleId: 'DEV-ENG', roleTitle: 'Developer',
    subId: 'sub-sam-glm', machineId: 'm-gpu-tower', machineHost: 'gpu-tower',
    model: 'glm-5', modelName: 'GLM-5',
    status: 'idle', context: 0.29,
  },
  {
    id: 'dev-5', name: 'Priya', deptId: 'dept-dev', deptName: 'Development',
    roleId: 'DEV-ENG', roleTitle: 'Developer',
    subId: 'sub-leo-claude', machineId: 'm-leo-air', machineHost: 'leo-macbook-air',
    model: 'claude-sonnet-4-6', modelName: 'Claude Sonnet 4.6',
    status: 'waiting', context: 0.41,
    task: taskRef(225, 'Import plants from CSV and Apple Notes'),
  },
  {
    id: 'dev-7', name: 'Owen', deptId: 'dept-dev', deptName: 'Development',
    roleId: 'DEV-ENG', roleTitle: 'Developer',
    subId: 'sub-sam-codex', machineId: 'm-sam-ws', machineHost: 'sam-workstation',
    model: 'gpt-5.3-codex', modelName: 'GPT-5.3 Codex',
    status: 'queued', context: 0.22,
    task: taskRef(227, 'Shareable plant care card for friends'),
  },
  {
    id: 'dev-6', name: 'Liam', deptId: 'dept-dev', deptName: 'Development',
    roleId: 'DEV-ENG', roleTitle: 'Developer',
    subId: 'sub-sam-glm', machineId: 'm-studio-server', machineHost: 'studio-server',
    model: 'glm-5', modelName: 'GLM-5',
    status: 'working', context: 0.57, tool: 'Bash',
    task: taskRef(226, 'Batch photo upload compression'),
  },
  {
    id: 'dev-2', name: 'Theo', deptId: 'dept-dev', deptName: 'Development',
    roleId: 'DEV-ENG', roleTitle: 'Developer',
    subId: 'sub-maya-codex', machineId: 'm-maya-mbp', machineHost: 'maya-macbook-pro',
    model: 'gpt-5.3-codex', modelName: 'GPT-5.3 Codex', effort: 'high',
    status: 'working', context: 0.49, tool: 'Edit',
    task: taskRef(222, 'Local push reminders for watering schedules'),
  },
  {
    id: 'dev-3', name: 'Jules', deptId: 'dept-dev', deptName: 'Development',
    roleId: 'DEV-ENG', roleTitle: 'Developer',
    subId: 'sub-leo-kimi', machineId: 'm-leo-mini', machineHost: 'leo-mac-mini',
    model: 'kimi-k2.5', modelName: 'Kimi K2.5',
    status: 'working', context: 0.54, tool: 'Edit',
    task: taskRef(223, 'Soil moisture chart and care streak card', 0, 3, 1),
  },
  {
    id: 'dev-4', name: 'Soren', deptId: 'dept-dev', deptName: 'Development',
    roleId: 'DEV-ENG', roleTitle: 'Developer',
    subId: 'sub-leo-google', machineId: 'm-leo-mini', machineHost: 'leo-mac-mini',
    model: 'gemini-3-pro', modelName: 'Gemini 3 Pro', effort: 'high',
    status: 'working', context: 0.37, tool: 'Bash',
    task: taskRef(224, 'Sunlight meter calibration on iPhone'),
  },
  {
    id: 'rev-claude', name: 'Vera', deptId: 'dept-dev', deptName: 'Development',
    roleId: 'DEV-REV', roleTitle: 'Code reviewer',
    subId: 'sub-leo-claude', machineId: 'm-leo-mini', machineHost: 'leo-mac-mini',
    model: 'claude-opus-4-6', modelName: 'Claude Opus 4.6', effort: 'high',
    status: 'working', context: 0.44, tool: 'Read',
    task: taskRef(216, 'Review offline care schedule diff', 1, 3),
  },
  {
    id: 'rev-codex', name: 'Marcus', deptId: 'dept-dev', deptName: 'Development',
    roleId: 'DEV-REV', roleTitle: 'Code reviewer',
    subId: 'sub-sam-codex', machineId: 'm-studio-server', machineHost: 'studio-server',
    model: 'gpt-5.3-codex', modelName: 'GPT-5.3 Codex', effort: 'high',
    status: 'working', context: 0.39, tool: 'Read',
    task: taskRef(223, 'Soil moisture chart and care streak card', 1, 3, 1),
  },
  {
    id: 'rev-kimi', name: 'Hana', deptId: 'dept-dev', deptName: 'Development',
    roleId: 'DEV-REV', roleTitle: 'Code reviewer',
    subId: 'sub-leo-kimi', machineId: 'm-leo-air', machineHost: 'leo-macbook-air',
    model: 'kimi-k2.5', modelName: 'Kimi K2.5',
    status: 'working', context: 0.35, tool: 'Read',
    task: taskRef(217, 'Review species search tokenizer', 1, 3),
  },
  {
    id: 'rev-google', name: 'Kiran', deptId: 'dept-dev', deptName: 'Development',
    roleId: 'DEV-REV', roleTitle: 'Code reviewer',
    subId: 'sub-leo-google', machineId: 'm-leo-mini', machineHost: 'leo-mac-mini',
    model: 'gemini-3-pro', modelName: 'Gemini 3 Pro',
    status: 'handed', context: 0.31,
    task: taskRef(215, 'Review push permission onboarding', 2, 3),
  },
  {
    id: 'dev-sec', name: 'Petra', deptId: 'dept-dev', deptName: 'Development',
    roleId: 'DEV-SEC', roleTitle: 'Security engineer',
    subId: 'sub-maya-claude', machineId: 'm-old-thinkpad', machineHost: 'old-thinkpad',
    model: 'claude-opus-4-6', modelName: 'Claude Opus 4.6', effort: 'high',
    status: 'working', context: 0.48, tool: 'Bash',
    task: taskRef(215, 'Audit signed photo upload URLs', 2, 3),
  },
  {
    id: 'dev-test', name: 'Gideon', deptId: 'dept-dev', deptName: 'Development',
    roleId: 'DEV-TEST', roleTitle: 'Test engineer',
    subId: 'sub-maya-codex', machineId: 'm-maya-mbp', machineHost: 'maya-macbook-pro',
    model: 'gpt-5.3-codex', modelName: 'GPT-5.3 Codex',
    status: 'working', context: 0.52, tool: 'Bash',
    task: taskRef(214, 'Run iOS beta smoke suite on TestFlight build', 3, 3),
  },
  {
    id: 'dev-perf', name: 'Caleb', deptId: 'dept-dev', deptName: 'Development',
    roleId: 'DEV-PERF', roleTitle: 'Performance engineer', teamId: 'team-perf',
    subId: 'sub-sam-glm', machineId: 'm-gpu-tower', machineHost: 'gpu-tower',
    model: 'glm-5', modelName: 'GLM-5',
    status: 'working', context: 0.45, tool: 'Bash',
    task: taskRef(220, 'Profile cold start and CoreML leaf model memory', 0, 0),
  },

  /* Design (4): head + 3 designers on Claude, Codex and Google */
  {
    id: 'dsn-head', name: 'Claire', deptId: 'dept-dsn', deptName: 'Design',
    roleId: 'DSN-HEAD', roleTitle: 'Head of design', kind: 'head',
    subId: 'sub-leo-claude', machineId: 'm-leo-mini', machineHost: 'leo-mac-mini',
    model: 'claude-opus-4-6', modelName: 'Claude Opus 4.6',
    status: 'working', context: 0.38, tool: null,
    task: taskRef(229, 'Review App Store visual set and icon badge', 0, 0),
  },
  {
    id: 'dsn-1', name: 'Nadia', deptId: 'dept-dsn', deptName: 'Design',
    roleId: 'DSN-UI', roleTitle: 'Interface designer',
    subId: 'sub-leo-claude', machineId: 'm-leo-air', machineHost: 'leo-macbook-air',
    model: 'claude-sonnet-4-6', modelName: 'Claude Sonnet 4.6',
    status: 'waiting', context: 0.47,
    task: taskRef(230, 'Onboarding plant card layout', 0, 0),
  },
  {
    id: 'dsn-2', name: 'Julian', deptId: 'dept-dsn', deptName: 'Design',
    roleId: 'DSN-UI', roleTitle: 'Interface designer',
    subId: 'sub-maya-codex', machineId: 'm-maya-mbp', machineHost: 'maya-macbook-pro',
    model: 'gpt-5.4', modelName: 'GPT-5.4',
    status: 'working', context: 0.33, tool: 'Edit',
    task: taskRef(231, 'App Store 6.9-inch beta screenshots', 0, 0),
  },
  {
    id: 'dsn-3', name: 'Esme', deptId: 'dept-dsn', deptName: 'Design',
    roleId: 'DSN-SYS', roleTitle: 'Design systems',
    subId: 'sub-leo-google', machineId: 'm-leo-mini', machineHost: 'leo-mac-mini',
    model: 'gemini-3-pro', modelName: 'Gemini 3 Pro',
    status: 'working', context: 0.29, tool: 'Edit',
    task: taskRef(232, 'Watering badge icons and leaf palette tokens', 0, 0),
  },

  /* Marketing (4): head, content writer, SEO specialist, social media */
  {
    id: 'mkt-head', name: 'Robin', deptId: 'dept-mkt', deptName: 'Marketing',
    roleId: 'MKT-HEAD', roleTitle: 'Head of marketing', kind: 'head',
    subId: 'sub-leo-kimi', machineId: 'm-leo-mini', machineHost: 'leo-mac-mini',
    model: 'kimi-k2.5', modelName: 'Kimi K2.5',
    status: 'working', context: 0.36, tool: null,
    task: taskRef(235, 'Coordinate iOS beta launch messaging', 0, 0),
  },
  {
    id: 'mkt-write', name: 'Elena', deptId: 'dept-mkt', deptName: 'Marketing',
    roleId: 'MKT-WRITE', roleTitle: 'Content writer',
    subId: 'sub-leo-claude', machineId: 'm-leo-air', machineHost: 'leo-macbook-air',
    model: 'claude-sonnet-4-6', modelName: 'Claude Sonnet 4.6',
    status: 'working', context: 0.43, tool: 'Edit',
    task: taskRef(236, 'Beta landing page copy and TestFlight invite email', 0, 0),
  },
  {
    id: 'mkt-seo', name: 'Jonah', deptId: 'dept-mkt', deptName: 'Marketing',
    roleId: 'MKT-SEO', roleTitle: 'SEO specialist',
    subId: 'sub-leo-kimi', machineId: 'm-leo-mini', machineHost: 'leo-mac-mini',
    model: 'kimi-k2.5', modelName: 'Kimi K2.5',
    status: 'working', context: 0.31, tool: 'Bash',
    task: taskRef(237, 'Care guide pages for 30 common houseplants', 0, 0),
  },
  {
    id: 'mkt-social', name: 'Zoe', deptId: 'dept-mkt', deptName: 'Marketing',
    roleId: 'MKT-SOCIAL', roleTitle: 'Social media',
    subId: 'sub-leo-google', machineId: 'm-leo-air', machineHost: 'leo-macbook-air',
    model: 'gemini-3-pro', modelName: 'Gemini 3 Pro',
    status: 'working', context: 0.27, tool: 'Edit',
    task: taskRef(238, 'Launch reel storyboard and waitlist threads', 0, 0),
  },

  /* Business development (2): head, analyst */
  {
    id: 'biz-head', name: 'grant', deptId: 'dept-biz', deptName: 'Business development',
    roleId: 'BIZ-HEAD', roleTitle: 'Head of business development', kind: 'head',
    subId: 'sub-maya-claude', machineId: 'm-maya-mbp', machineHost: 'maya-macbook-pro',
    model: 'claude-sonnet-4-6', modelName: 'Claude Sonnet 4.6',
    status: 'working', context: 0.26, tool: null,
    task: taskRef(240, 'Indie plant shop beta partner outreach', 0, 0),
  },
  {
    id: 'biz-analyst', name: 'Maya L.', deptId: 'dept-biz', deptName: 'Business development',
    roleId: 'BIZ-ANALYST', roleTitle: 'Business analyst',
    subId: 'sub-sam-codex', machineId: 'm-studio-server', machineHost: 'studio-server',
    model: 'gpt-5.3-codex', modelName: 'GPT-5.3 Codex',
    status: 'idle', context: 0.19,
  },
];

SPECS.find(s => s.id === 'biz-head')!.name = 'Grant';
SPECS.find(s => s.id === 'biz-analyst')!.name = 'Paula';

export const PLACEMENTS: AgentPlacement[] = SPECS.map(s => {
  const sub = subById(s.subId);
  const working = s.status === 'working';
  const employee: Employee = {
    id: s.id,
    name: s.name,
    roleId: s.roleId,
    teamId: s.teamId ?? null,
    title: L(s.roleTitle),
    kind: s.kind ?? 'worker',
    model: s.model,
    modelName: s.modelName,
    provider: sub.provider,
    effort: s.effort ?? null,
    state: working ? 'working' : 'sleeping',
    status: s.status,
    on: true,
    timer: s.timer ?? null,
    task: s.task ?? null,
    context: s.context ?? 0.3,
    program: working ? programOf(s.tool ?? null) : null,
    alarm: null,
    retry: null,
    failure: null,
  };
  return {
    employee,
    departmentId: s.deptId,
    departmentName: s.deptName,
    subscriptionId: s.subId,
    machineId: s.machineId,
    machineHost: s.machineHost,
    skills: [
      { id: 'hornhoof-tasks', title: 'Task workflow', description: 'Reads the task brief, commits on the task branch and hands work in.' },
      { id: 'git-clean', title: 'Clean git history', description: 'Keeps commits focused and verifies tests before submitting.' },
    ],
  };
});

function deptRoles(defs: [string, string, 'head' | 'member', number | null][]): DeptRole[] {
  return defs.map(([id, title, kind, gate]) => ({
    id,
    title: L(title),
    description: L(title),
    kind,
    gate,
  }));
}

function makeWorkLines(headId: string, employees: Employee[]): WorkLine[] {
  return employees
    .filter(e => e.id !== headId)
    .map(e => {
      const working = e.status === 'working';
      const returned = e.status === 'handed';
      return {
        upstreamAgentId: headId,
        downstreamAgentId: e.id,
        working,
        workEpoch: 4,
        returnedEpoch: returned ? 4 : null,
        returnedAt: returned ? isoMinutes(-2) : null,
      };
    });
}

function buildDept(
  id: string,
  templateKey: Department['templateKey'],
  roleCode: string,
  about: string,
  roles: DeptRole[],
  extra: Partial<Department> = {},
): Department {
  const employees = PLACEMENTS.filter(p => p.departmentId === id).map(p => p.employee);
  const head = employees.find(e => e.kind === 'head')!;
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
    roles,
    workLines: makeWorkLines(head.id, employees),
    current: head.task ? { id: head.task.id, number: head.task.number, title: head.task.title } : null,
    ...extra,
  };
}

export const MOONFERN_DEPARTMENTS: Department[] = [
  buildDept(
    'dept-ops',
    'operations',
    'OPS',
    'Keeps nodes, certificates, push delivery and release checks healthy.',
    deptRoles([
      ['OPS-HEAD', 'Head of operations', 'head', null],
      ['OPS-WATCH', 'Task watchdog', 'member', null],
      ['OPS-BUGS', 'Weak point collector', 'member', null],
      ['OPS-PROGRAM', 'Program operator', 'member', null],
      ['OPS-FIX', 'Reliability engineer', 'member', null],
    ]),
  ),
  buildDept(
    'dept-dev',
    'development',
    'DEV',
    'Builds the Moonfern iOS app, care schedule engine and species recognizer.',
    deptRoles([
      ['DEV-HEAD', 'Head of development', 'head', null],
      ['DEV-ARCH', 'Architect', 'member', null],
      ['DEV-ENG', 'Developer', 'member', null],
      ['DEV-PERF', 'Performance engineer', 'member', null],
      ['DEV-REV', 'Code reviewer', 'member', 1],
      ['DEV-SEC', 'Security engineer', 'member', 2],
      ['DEV-TEST', 'Test engineer', 'member', 3],
    ]),
    {
      people: [SAM_VIEW],
      reworkAt: isoMinutes(-2),
      teams: [
        {
          id: 'team-perf',
          name: 'Performance',
          about: 'Profiles cold start, scroll frame pacing and CoreML leaf model memory.',
          stage: 0,
          gate: false,
          turnkey: false,
        },
      ],
      repository: {
        url: 'https://github.com/moonfern-app/moonfern.git',
        branch: 'main',
        tokenLast4: '9c4a',
        author: { name: 'Moonfern Bot', email: 'bot@moonfern.app' },
      },
    },
  ),
  buildDept(
    'dept-dsn',
    'design',
    'DSN',
    'Plant cards, watering illustrations, design tokens and App Store visuals.',
    deptRoles([
      ['DSN-HEAD', 'Head of design', 'head', null],
      ['DSN-UI', 'Interface designer', 'member', null],
      ['DSN-SYS', 'Design systems', 'member', null],
    ]),
  ),
  buildDept(
    'dept-mkt',
    'marketing',
    'MKT',
    'Beta landing page, houseplant care guides and launch channels.',
    deptRoles([
      ['MKT-HEAD', 'Head of marketing', 'head', null],
      ['MKT-WRITE', 'Content writer', 'member', null],
      ['MKT-SEO', 'SEO specialist', 'member', null],
      ['MKT-SOCIAL', 'Social media', 'member', null],
    ]),
  ),
  buildDept(
    'dept-biz',
    'business_development',
    'BIZ',
    'Partnerships with neighborhood plant shops and botanical gardens.',
    deptRoles([
      ['BIZ-HEAD', 'Head of business development', 'head', null],
      ['BIZ-ANALYST', 'Business analyst', 'member', null],
    ]),
  ),
];

function toRunningAgent(p: AgentPlacement): RunningAgent {
  const e = p.employee;
  const sub = subById(p.subscriptionId);
  return {
    id: e.id,
    canOpen: true,
    name: e.name,
    busy: e.status === 'working',
    title: e.title,
    department: { id: p.departmentId, name: p.departmentName },
    provider: sub.provider,
    since: e.status === 'working' ? isoMinutes(-14) : null,
    task: e.task ? { number: e.task.number, title: e.task.title } : null,
    withCeo: false,
  };
}

const agentsBySub = new Map<string, RunningAgent[]>();
const agentsByMachine = new Map<string, RunningAgent[]>();
for (const p of PLACEMENTS) {
  const r = toRunningAgent(p);
  agentsBySub.set(p.subscriptionId, [...(agentsBySub.get(p.subscriptionId) ?? []), r]);
  agentsByMachine.set(p.machineId, [...(agentsByMachine.get(p.machineId) ?? []), r]);
}

export const MOONFERN_SUBSCRIPTIONS: SubView[] = BASE_SUBSCRIPTIONS.map(s => ({
  ...s,
  agents: agentsBySub.get(s.id) ?? [],
}));

export const MOONFERN_MACHINES: MachineView[] = attachRunningAgents(BASE_MACHINES, agentsByMachine);

const totalAgents = MOONFERN_DEPARTMENTS.reduce((sum, d) => sum + d.agents.total, 0);
const workingAgents = MOONFERN_DEPARTMENTS.reduce((sum, d) => sum + d.agents.working, 0);

export const MOONFERN_ORG: Org = {
  company: MOONFERN_COMPANY,
  orchestrator: {
    id: 'agent-orch',
    name: 'Orchestrator',
    model: 'claude-opus-4-6',
    effort: 'high',
    subscription: MOONFERN_SUBSCRIPTIONS[0]!,
    machine: { id: 'm-maya-mbp', hostname: 'maya-macbook-pro' },
    context: 0.34,
    program: null,
    alarm: null,
    retry: null,
    failure: null,
  },
  agents: { total: totalAgents, working: workingAgents },
  people: [MAYA_VIEW, LEO_VIEW],
  departments: MOONFERN_DEPARTMENTS,
  turn: {
    id: 'turn-6',
    number: 6,
    goal: 'Launch the iOS beta',
  },
  serverNow: BASE_ISO,
  workLines: MOONFERN_DEPARTMENTS.map(d => {
    const head = d.employees.find(e => e.kind === 'head')!;
    return {
      upstreamAgentId: 'agent-orch',
      downstreamAgentId: head.id,
      working: d.agents.working > 0,
      workEpoch: 6,
      returnedEpoch: null,
      returnedAt: null,
    };
  }),
};

const MODELS_BY_PROVIDER: Record<ProviderId, ModelOption[]> = {
  claude: [
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'high' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
  ],
  codex: [
    { id: 'gpt-5.4', name: 'GPT-5.4', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' },
  ],
  kimi: [{ id: 'kimi-k2.5', name: 'Kimi K2.5' }],
  glm: [{ id: 'glm-5', name: 'GLM-5' }],
  antigravity: [{ id: 'gemini-3-pro', name: 'Gemini 3 Pro', efforts: ['low', 'medium', 'high'], defaultEffort: 'high' }],
  anthropic_api: [],
  openai_api: [],
  openrouter: [],
  custom_api: [],
};

export function moonfernAgentCard(agentId: string): AgentCardView | null {
  if (agentId === 'orchestrator' || agentId === 'agent-orch') {
    const sub = MOONFERN_SUBSCRIPTIONS[0]!;
    return {
      id: 'agent-orch',
      canRemove: false,
      currentTask: null,
      kind: 'orchestrator',
      name: 'Orchestrator',
      role: null,
      department: null,
      product: null,
      team: null,
      teams: [],
      model: 'claude-opus-4-6',
      effort: 'high',
      subscription: sub,
      machine: { id: 'm-maya-mbp', hostname: 'maya-macbook-pro' },
      state: 'sleeping',
      program: null,
      alarm: null,
      retry: null,
      failure: null,
      skills: [],
      parts: [],
      raw: '',
      instructions: { length: 8420, max: 200_000 },
      runsOn: MOONFERN_SUBSCRIPTIONS.filter(s => s.place.kind === 'company').map(s => ({
        subscription: s,
        models: MODELS_BY_PROVIDER[s.provider],
      })),
      changes: [{ field: 'subscription', personName: 'Maya Chen', byOrchestrator: false, at: isoMinutes(-240) }],
      interrupted: [],
      canEdit: true,
      timer: null,
    };
  }
  const p = PLACEMENTS.find(x => x.employee.id === agentId);
  if (!p) return null;
  const e = p.employee;
  const sub = MOONFERN_SUBSCRIPTIONS.find(s => s.id === p.subscriptionId)!;
  const dept = MOONFERN_DEPARTMENTS.find(d => d.id === p.departmentId)!;
  const team = e.teamId ? (dept.teams.find(t => t.id === e.teamId) ?? null) : null;
  return {
    id: e.id,
    canRemove: false,
    currentTask: e.task ? { id: e.task.id, number: e.task.number, title: e.task.title } : null,
    kind: e.kind,
    name: e.name,
    role: e.roleId && e.title ? { id: e.roleId, title: e.title, description: e.title } : null,
    department: { id: p.departmentId, name: p.departmentName },
    product: null,
    team: team ? { id: team.id, name: team.name } : null,
    teams: dept.teams.map(t => ({ id: t.id, name: t.name })),
    model: e.model,
    effort: e.effort,
    subscription: sub,
    machine: { id: p.machineId, hostname: p.machineHost },
    state: e.state,
    program: e.program,
    alarm: null,
    retry: null,
    failure: null,
    skills: p.skills.map(sk => ({
      id: sk.id,
      title: L(sk.title),
      description: L(sk.description),
      on: true,
      locked: sk.id === 'hornhoof-tasks',
      overridden: false,
      templateChanged: false,
    })),
    parts: [
      { kind: 'header', id: null, title: null, text: `You are ${e.name}, ${e.title?.en ?? 'employee'} in ${p.departmentName} at Moonfern.`, overridden: false, templateChanged: false },
      { kind: 'base', id: e.roleId, title: e.title, text: 'Keep changes small, test every edge case and leave clear handoff notes.', overridden: false, templateChanged: false },
    ],
    raw: `You are ${e.name}, ${e.title?.en ?? 'employee'} in ${p.departmentName} at Moonfern.`,
    instructions: { length: 12_480, max: 200_000 },
    runsOn: MOONFERN_SUBSCRIPTIONS.filter(s => s.place.kind === 'company' || s.place.id === p.departmentId).map(s => ({
      subscription: s,
      models: MODELS_BY_PROVIDER[s.provider],
    })),
    changes: [
      { field: 'hired', personName: 'Maya Chen', byOrchestrator: true, at: isoMinutes(-720) },
      { field: 'model', personName: 'Sam Rivera', byOrchestrator: false, at: isoMinutes(-180) },
    ],
    interrupted: [],
    canEdit: true,
    timer: e.timer ? { minutes: e.timer, order: 'Check open Turn 6 tasks and nudge any quiet session.', forWork: true, lastAt: isoMinutes(-6) } : null,
  };
}
