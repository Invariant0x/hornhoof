import { useCallback, useEffect, useState } from 'react';

export type Route =
  | { kind: 'map' | 'subscriptions' | 'improvements' | 'versions' | 'profile' | 'settings' | 'about' | 'unavailable' }
  | { kind: 'tasks'; id?: string; personId?: string }
  | { kind: 'people' | 'machines'; id?: string }
  | { kind: 'department'; id: string }
  | { kind: 'invite'; token: string };

const PATHS = {
  map: '', tasks: 'tasks', people: 'people', department: 'departments', subscriptions: 'subscriptions',
  machines: 'machines', improvements: 'improvements', versions: 'versions', profile: 'profile',
  settings: 'settings', about: 'about', invite: 'invite', unavailable: 'not-found',
} as const;
const validId = (id: string): boolean => /^[A-Za-z0-9_-]+$/.test(id);
const unavailable = (): Route => ({ kind: 'unavailable' });

function cardRoute(kind: 'tasks' | 'people' | 'machines', id: string | undefined, query: string): Route {
  if (id) return { kind, id };
  if (kind !== 'tasks') return { kind };
  const personId = new URLSearchParams(query).get('person');
  return personId && validId(personId) ? { kind, personId } : { kind };
}

function fromParts(kind: Route['kind'], id: string | undefined, query: string): Route {
  if (kind === 'invite') return id ? { kind, token: id } : unavailable();
  if (kind === 'department') return id ? { kind, id } : unavailable();
  if (kind === 'people' || kind === 'machines' || kind === 'tasks') return cardRoute(kind, id, query);
  return id === undefined ? { kind } : unavailable();
}

export function parseRoute(path: string): Route {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return unavailable();
  try {
    const [pathname = '', query = ''] = path.split(/[?#]/);
    const parts = pathname.replace(/\/$/, '').slice(1).split('/').map(decodeURIComponent);
    if (parts.length > 2) return unavailable();
    if (parts[1] !== undefined && !validId(parts[1])) return unavailable();
    const kind = (Object.keys(PATHS) as Route['kind'][]).find(key => PATHS[key] === parts[0]);
    return kind ? fromParts(kind, parts[1], query) : unavailable();
  } catch {
    return unavailable();
  }
}

export function routePath(route: Route): string {
  const id = 'id' in route ? route.id : 'token' in route ? route.token : undefined;
  if (id !== undefined && !validId(id)) return '/not-found';
  const base = `/${PATHS[route.kind]}${id ? `/${id}` : ''}`;
  const person = route.kind === 'tasks' ? route.personId : undefined;
  return person && validId(person) ? `${base}?person=${person}` : base;
}

export function useRoute() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname + location.search));
  useEffect(() => {
    const pop = () => setRoute(parseRoute(location.pathname + location.search));
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  const navigate = useCallback((next: Route) => {
    const path = routePath(next);
    if (path !== location.pathname + location.search) history.pushState(null, '', path);
    setRoute(parseRoute(path));
  }, []);
  return { route, navigate };
}
