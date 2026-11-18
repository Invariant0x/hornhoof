import { useCallback, useEffect, useState } from 'react';
import { TRACKER_VIEWS, type TrackerView } from './tracker';

/* The parts of the Settings window that have an address of their own, /settings/<group>: Profile, then the groups after
   Appearance & language, which opens at /settings. */
export const SETTINGS_GROUPS = ['profile', 'integrations', 'passwords', 'company'] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

/* Where the tracker stands: what waits for the person, the work going on now, or turns and releases instead of their own
   tasks, or all the company's goals and tasks; a department, its pipeline, a goal, the task the graph grows from and a
   person who answers for the work; and the view. personId: whose screen is looked at. A card is a task's, or with card a
   goal's. */
export const TRACKER_SHOWS = ['waits', 'working', 'failures', 'turns', 'company'] as const;
export type TrackerShow = (typeof TRACKER_SHOWS)[number];
export type TrackerPlace = { show?: TrackerShow; department?: string; product?: string; pipeline?: string; goal?: string; root?: string; responsible?: string; personId?: string; view?: TrackerView };
export type TasksRoute = { kind: 'tasks'; id?: string; card?: 'goal' } & TrackerPlace;

export type Route =
  | { kind: 'map' | 'subscriptions' | 'improvements' | 'inbox' | 'versions' | 'about' | 'unavailable' }
  | { kind: 'settings'; group?: SettingsGroup }
  | TasksRoute
  | { kind: 'people' | 'machines'; id?: string }
  | { kind: 'department'; id: string }
  | { kind: 'invite'; token: string };

const PATHS = {
  map: '', tasks: 'tasks', people: 'people', department: 'departments', subscriptions: 'subscriptions',
  machines: 'machines', improvements: 'improvements', inbox: 'inbox', versions: 'versions',
  settings: 'settings', about: 'about', invite: 'invite', unavailable: 'not-found',
} as const;
const validId = (id: string): boolean => /^[A-Za-z0-9_-]+$/.test(id);
const unavailable = (): Route => ({ kind: 'unavailable' });

/* The query of the tracker, in the order an address writes it; each id the same safe kind as a path's. */
const PLACE_KEYS = [['show', 'show'], ['department', 'department'], ['product', 'product'], ['pipeline', 'pipeline'], ['goal', 'goal'], ['root', 'root'], ['responsible', 'responsible'], ['personId', 'person'], ['view', 'view']] as const;
/* Where the tracker is, without the card that sits on top of it. */
export function placeOf(route: TasksRoute): TrackerPlace {
  const place: TrackerPlace = {};
  for (const [key] of PLACE_KEYS) if (route[key]) Object.assign(place, { [key]: route[key] });
  return place;
}

const placeValue = (key: (typeof PLACE_KEYS)[number][0], value: string | null | undefined): string | undefined => {
  if (!value) return undefined;
  if (key === 'show') return TRACKER_SHOWS.find(s => s === value);
  if (key === 'view') return TRACKER_VIEWS.find(v => v === value);
  return validId(value) ? value : undefined;
};

function tasksRoute(id: string | undefined, query: string): TasksRoute {
  const params = new URLSearchParams(query);
  if (id) return params.get('card') === 'goal' ? { kind: 'tasks', id, card: 'goal' } : { kind: 'tasks', id };
  const route: TasksRoute = { kind: 'tasks' };
  for (const [key, name] of PLACE_KEYS) {
    const value = placeValue(key, params.get(name));
    if (value) Object.assign(route, { [key]: value });
  }
  return route;
}

function cardRoute(kind: 'tasks' | 'people' | 'machines', id: string | undefined, query: string): Route {
  if (kind === 'tasks') return tasksRoute(id, query);
  return id ? { kind, id } : { kind };
}

function settingsRoute(group: string | undefined): Route {
  if (group === undefined) return { kind: 'settings' };
  const known = SETTINGS_GROUPS.find(name => name === group);
  return known ? { kind: 'settings', group: known } : unavailable();
}

function fromParts(kind: Route['kind'], id: string | undefined, query: string): Route {
  if (kind === 'invite') return id ? { kind, token: id } : unavailable();
  if (kind === 'settings') return settingsRoute(id);
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
  const id = 'id' in route ? route.id : 'token' in route ? route.token : 'group' in route ? route.group : undefined;
  if (id !== undefined && !validId(id)) return '/not-found';
  const base = `/${PATHS[route.kind]}${id ? `/${id}` : ''}`;
  if (route.kind !== 'tasks') return base;
  if (route.id) return route.card === 'goal' ? `${base}?card=goal` : base;
  const query = PLACE_KEYS.flatMap(([key, name]) => {
    const value = placeValue(key, route[key]);
    return value ? [`${name}=${value}`] : [];
  });
  return query.length ? `${base}?${query.join('&')}` : base;
}

function backgroundsOf(state: unknown): Route[] {
  if (!state || typeof state !== 'object' || !('hhBackground' in state) || typeof state.hhBackground !== 'string') return [];
  const rest = 'hhUnderlays' in state && Array.isArray(state.hhUnderlays) ? state.hhUnderlays.filter((path): path is string => typeof path === 'string') : [];
  return [state.hhBackground, ...rest].map(path => {
    const route = parseRoute(path);
    return route.kind === 'unavailable' ? { kind: 'map' } as const : route;
  });
}

function currentEntry() {
  const route = parseRoute(location.pathname + location.search);
  const stored = backgroundsOf(history.state);
  const backgrounds: Route[] = stored.length ? stored : [{ kind: route.kind === 'tasks' ? 'tasks' : 'map' }];
  return { route, backgrounds };
}

function pushRoute(next: Route, backgrounds: Route[]) {
  const path = routePath(next);
  const paths = backgrounds.map(routePath);
  if (path !== location.pathname + location.search) history.pushState(paths.length ? { hhBackground: paths[0], hhUnderlays: paths.slice(1) } : null, '', path);
}

export function useRoute() {
  const [entry, setEntry] = useState(currentEntry);
  useEffect(() => {
    const pop = () => setEntry(currentEntry());
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  const navigate = useCallback((next: Route, background?: Route) => {
    const rest = background && routePath(background) === routePath(parseRoute(location.pathname + location.search)) ? backgroundsOf(history.state) : [];
    pushRoute(next, background ? [background, ...rest] : []);
    setEntry(currentEntry());
  }, []);
  /* Another section of the same window: its address takes the place of the current one and keeps what lies under it. */
  const switchOverlay = useCallback((next: Route) => {
    history.replaceState(history.state, '', routePath(next));
    setEntry(currentEntry());
  }, []);
  const closeOverlay = useCallback(() => {
    const { backgrounds } = currentEntry();
    pushRoute(backgrounds[0]!, backgrounds.slice(1));
    setEntry(currentEntry());
  }, []);
  return { ...entry, navigate, switchOverlay, closeOverlay };
}
