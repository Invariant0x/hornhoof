import { vi } from 'vitest';

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

export const ME = {
  person: { id: 'p1', companyId: 'c1', name: 'Ivan', email: 'ivan@acme.com', title: 'CEO', status: 'active', scopeKind: 'company', scopeId: null, isOwner: true },
  company: { id: 'c1', name: 'Acme' },
};

export const signedOut = { error: { code: 'unauthorized', message: 'Sign in to continue.' } };
