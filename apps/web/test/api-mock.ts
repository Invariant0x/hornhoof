import { vi } from 'vitest';
import type { AgentCardView, MachineView, Me, Org, PersonView, Roster, Serving, SubView } from '../src/types';

type Reply = [status: number, body?: unknown];
type Route = Reply | ((body: unknown) => Reply);

export type Call = { method: string; path: string; body: unknown };

/* Stubs fetch with routes keyed by "METHOD /path" and records every call. */
export function mockApi(routes: Record<string, Route>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const route = routes[`${method} ${path}`];
    const [status, data] = typeof route === 'function' ? route(body) : route ?? [404, { error: { code: 'not_found', message: 'Not found.' } }];
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
    subscription: { id: 's1', provider: 'anthropic_api', kind: 'api_key', label: 'Orchestrator', status: 'ready', online: false, last4: '9f3a', owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company', id: null, name: 'Whole company' }, machine: null, limits: null, isOrchestrator: true },
  },
  agents: { total: 1, working: 0 },
  people: PEOPLE.slice(0, 2),
  departments: [],
};

export const ORG_WITH_TEAMS: Org = {
  ...ORG,
  departments: [
    { id: 'd1', name: 'Marketing', templateKey: null, roleCode: 'CMO', about: '', agents: { total: 0, working: 0 }, products: [], teams: [{ id: 't1', name: 'Social', about: '', stage: 0, gate: false }, { id: 't2', name: 'Content', about: '', stage: 0, gate: false }], people: [], employees: [] },
    { id: 'd2', name: 'Development', templateKey: null, roleCode: 'CTO', about: '', agents: { total: 0, working: 0 }, products: [], teams: [], people: [], employees: [] },
  ],
};

const SUB_BASE = { kind: 'personal' as const, last4: null, owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company' as const, id: null, name: 'Whole company' }, limits: null, isOrchestrator: false };

export const MACHINE = { id: 'm1', hostname: 'ivan-mbp' };

export const SUBS: SubView[] = [
  {
    ...SUB_BASE, id: 's-claude', provider: 'claude', label: 'Claude', status: 'ready', online: true, machine: MACHINE,
    limits: { status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.42, resetsAt: '2026-10-29T18:00:00.000Z' }, { name: 'seven_day', utilization: 0.1, resetsAt: null }] },
  },
  { ...SUB_BASE, id: 's-codex', provider: 'codex', label: 'Codex', status: 'needs_login', online: true, machine: MACHINE },
  { ...SUB_BASE, id: 's-kimi', provider: 'kimi', label: 'Kimi', status: 'waiting_machine', online: false, machine: null },
  { ...SUB_BASE, id: 's-key', provider: 'anthropic_api', kind: 'api_key', label: 'Orchestrator', status: 'ready', online: true, last4: '9f3a', machine: null, isOrchestrator: true },
];

export const MACHINES: MachineView[] = [
  { id: 'm1', hostname: 'ivan-mbp', os: 'darwin', arch: 'arm64', owner: { id: 'p1', name: 'Ivan' }, online: true, lastSeenAt: null, subscriptions: 2 },
  { id: 'm2', hostname: 'build-box', os: 'linux', arch: 'x86_64', owner: { id: 'p2', name: 'Maria' }, online: false, lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(), subscriptions: 1 },
];

const OPUS = { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' };
const SONNET = { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' };
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
        { id: 'b0', name: 'Dana', roleId: 'DEV-HEAD', title: HEAD_TITLE, kind: 'head', model: '', modelName: null, provider: 'claude', state: 'working' },
        { id: 'b1', name: 'Bruno', roleId: 'DEV-BE', title: BE_TITLE, kind: 'worker', model: 'claude-sonnet-5-5', modelName: 'Claude Sonnet 5.5', provider: 'anthropic_api', state: 'sleeping' },
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
  subscription: TEAM_KEY,
  state: 'sleeping',
  skills: [
    { id: 'hh-report-to-head', title: about('Report to your head'), description: about('Tell the head what was done.'), on: true, locked: true, overridden: false, templateChanged: false },
    { id: 'dev-tdd', title: about('Test first'), description: about('A failing test before the code.'), on: true, locked: false, overridden: true, templateChanged: true },
    { id: 'dev-api-design', title: about('API design'), description: about('Plain, stable APIs.'), on: false, locked: false, overridden: false, templateChanged: false },
  ],
  parts: PARTS,
  raw: PARTS.map(p => p.text).join('\n\n'),
  runsOn: [
    { subscription: TEAM_KEY, models: [OPUS, SONNET] },
    { subscription: OLEG_CODEX, models: [SOL] },
  ],
  changes: [{ field: 'hired', personName: 'Ivan', at: '2026-10-30T08:00:00.000Z' }],
  canEdit: true,
};
