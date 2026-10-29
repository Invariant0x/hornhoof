import { vi } from 'vitest';
import type { MachineView, Me, Org, PersonView, SubView } from '../src/types';

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
  person: { id: 'p1', companyId: 'c1', name: 'Ivan', email: 'ivan@acme.com', title: 'CEO', status: 'active', scopeKind: 'company', scopeId: null, isOwner: true },
  company: { id: 'c1', name: 'Acme' },
};

export const signedOut = { error: { code: 'unauthorized', message: 'Sign in to continue.' } };

export const PEOPLE: PersonView[] = [
  { id: 'p1', name: 'Ivan', email: 'ivan@acme.com', title: 'CEO', status: 'active', isOwner: true, scope: { kind: 'company', id: null, name: 'Whole company' } },
  { id: 'p2', name: 'Maria', email: 'maria@acme.com', title: 'Deputy CEO', status: 'active', isOwner: false, scope: { kind: 'company', id: null, name: 'Whole company' } },
  { id: 'p3', name: 'Sasha', email: 'sasha@acme.com', title: 'SMM', status: 'invited', isOwner: false, scope: { kind: 'team', id: 't1', name: 'Social' } },
];

export const ORG: Org = {
  company: { id: 'c1', name: 'Acme' },
  chief: {
    name: 'Chief',
    model: 'claude-opus-5-5',
    subscription: { id: 's1', provider: 'anthropic_api', kind: 'api_key', label: 'Chief', status: 'ready', online: false, last4: '9f3a', owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company', id: null, name: 'Whole company' }, machine: null, limits: null, isChief: true },
  },
  agents: { total: 1, working: 0 },
  people: PEOPLE.slice(0, 2),
  departments: [],
};

export const ORG_WITH_TEAMS: Org = {
  ...ORG,
  departments: [
    { id: 'd1', name: 'Marketing', roleCode: 'CMO', teams: [{ id: 't1', name: 'Social', about: '', stage: 0, gate: false }, { id: 't2', name: 'Content', about: '', stage: 0, gate: false }] },
    { id: 'd2', name: 'Development', roleCode: 'CTO', teams: [] },
  ],
};

const SUB_BASE = { kind: 'personal' as const, last4: null, owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'company' as const, id: null, name: 'Whole company' }, limits: null, isChief: false };

export const MACHINE = { id: 'm1', hostname: 'ivan-mbp' };

export const SUBS: SubView[] = [
  {
    ...SUB_BASE, id: 's-claude', provider: 'claude', label: 'Claude', status: 'ready', online: true, machine: MACHINE,
    limits: { status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.42, resetsAt: '2026-10-29T18:00:00.000Z' }, { name: 'seven_day', utilization: 0.1, resetsAt: null }] },
  },
  { ...SUB_BASE, id: 's-codex', provider: 'codex', label: 'Codex', status: 'needs_login', online: true, machine: MACHINE },
  { ...SUB_BASE, id: 's-kimi', provider: 'kimi', label: 'Kimi', status: 'waiting_machine', online: false, machine: null },
  { ...SUB_BASE, id: 's-key', provider: 'anthropic_api', kind: 'api_key', label: 'Chief', status: 'ready', online: true, last4: '9f3a', machine: null, isChief: true },
];

export const MACHINES: MachineView[] = [
  { id: 'm1', hostname: 'ivan-mbp', os: 'darwin', arch: 'arm64', owner: { id: 'p1', name: 'Ivan' }, online: true, lastSeenAt: null, subscriptions: 2 },
  { id: 'm2', hostname: 'build-box', os: 'linux', arch: 'x86_64', owner: { id: 'p2', name: 'Maria' }, online: false, lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(), subscriptions: 1 },
];
