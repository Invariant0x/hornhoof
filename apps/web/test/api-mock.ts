import { vi } from 'vitest';
import type { Me, Org, PersonView } from '../src/types';

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
    subscription: { id: 's1', provider: 'anthropic_api', kind: 'api_key', label: 'Chief', status: 'active', last4: '9f3a', owner: { id: 'p1', name: 'Ivan' }, target: { kind: 'chief', id: null, name: 'Chief' } },
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
