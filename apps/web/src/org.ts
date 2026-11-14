import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { listen, useStream, type LiveMessage } from './live';
import type { Department, Org, PersonView } from './types';
import type { AgentLive } from './ui/AgentState';

/* What each employee does changes with its tasks and questions. */
const SETTLE_MS = 400;

/* What makes the company fetch again at once: the map changed, the stream came back after a break, or the request for
   the computer changed, since who decides and what waits for the CEO change the counts on the people's cards. */
const FETCH_AT_ONCE: ReadonlySet<string> = new Set(['org', 'reconnected', 'computer']);

/* Stream counter ticks keep the roster snapshot they came from, so access checks do not storm on context bars. */
const rosterSnapshots = new WeakMap<Org, Org>();

export const rosterOf = (org: Org): Org => rosterSnapshots.get(org) ?? org;

function keepRoster(from: Org, next: Org): Org {
  rosterSnapshots.set(next, rosterOf(from));
  return next;
}

/* An agent's context moves with every step it takes; only its bar changes. */
function withContext(org: Org, agentId: string, used: number): Org {
  const current = agentIn(org, agentId);
  if (!current || current.context === used) return org;
  const departments = org.departments.map(d => (d.employees.some(e => e.id === agentId) ? { ...d, employees: d.employees.map(e => (e.id === agentId ? { ...e, context: used } : e)) } : d));
  const orchestrator = org.orchestrator?.id === agentId ? { ...org.orchestrator, context: used } : org.orchestrator;
  return keepRoster(org, { ...org, orchestrator, departments });
}

/* What an agent's program does and the server's alarm, as the map read them, with the server's clock then. The orchestrator
   goes by his window's name too. */
export function liveOf(org: Org | null, agentId: string): { live?: AgentLive; serverNow?: string } {
  const live = org ? agentIn(org, agentId) : undefined;
  return live ? { live, serverNow: org!.serverNow } : {};
}

function agentIn(org: Org, agentId: string): (AgentLive & { context: number | null }) | undefined {
  const orchestrator = org.orchestrator;
  if (orchestrator && (agentId === 'orchestrator' || agentId === orchestrator.id)) return orchestrator;
  return org.departments.flatMap(d => d.employees).find(e => e.id === agentId);
}

/* Whether the company says this person does not open this agent: everyone sees every employee and the orchestrator's state,
   and opens the employees of their own departments, and the orchestrator with the whole company. */
export function notOpened(org: Org, agentId: string): boolean {
  const orchestrator = org.orchestrator;
  if (orchestrator && (agentId === 'orchestrator' || agentId === orchestrator.id)) return orchestrator.opens === false;
  return org.departments.some(d => d.employees.some(e => e.id === agentId && e.opens === false));
}

/* A person with a card on the map, with the department they belong to when they reach only one. */
export type MapPerson = PersonView & { deputy?: boolean; departments?: string[]; home?: Department };

/* Everyone with a card on the map, each once: whole-company people and deputies first, then single-department people in
   department order, so the decisions screen names whoever a card opens. */
export function mapPeople(org: Org | null): MapPerson[] {
  if (!org) return [];
  const seen = new Set<string>();
  const all: MapPerson[] = [...org.people, ...org.departments.flatMap(d => d.people.map(p => ({ ...p, home: d })))];
  return all.filter(p => !seen.has(p.id) && !!seen.add(p.id));
}

function reachesDept(d: Department, p: Org['people'][number]): boolean {
  const hasId = (id: string) => d.id === id || d.products.some(pr => pr.id === id);
  return p.access.departments.some(a => hasId(a.id)) || p.access.teams.some(t => hasId(t.departmentId));
}

function deputyDepartments(org: Org, p: Org['people'][number]): string[] {
  return p.departments ?? org.departments.filter(d => reachesDept(d, p)).map(d => d.id);
}

/* Whole-company people who keep the top row above the hub. */
export function wholeCompanyPeople(org: Org | null): MapPerson[] {
  return org ? org.people.filter(p => !p.deputy) : [];
}

/* People placed beside or under the departments they look after, each once. */
export function departmentPeople(org: Org | null): (MapPerson & { departments: string[] })[] {
  if (!org) return [];
  const seen = new Set<string>();
  const single = org.departments.flatMap(d => d.people.map(p => ({ ...p, home: d, departments: [d.id] })));
  const multi = org.people.filter(p => p.deputy).map(p => ({ ...p, departments: deputyDepartments(org, p) }));
  return [...single, ...multi].filter(p => !seen.has(p.id) && !!seen.add(p.id));
}

/* A tab that comes back from the background, or a computer from sleep, fetches again: what it shows moved meanwhile. */
function useFetchOnReturn(enabled: boolean, load: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    const back = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [enabled, load]);
}

/* The company as the newest answer and the live stream since showed it, for every screen that shows it: a screen that
   opens again, or one that does not ask yet, shows it at once instead of an empty map while its own answer comes. */
let known: Org | null = null;
/* Each screen that shows the company hears every change to it; an answer also clears what went wrong asking for it. */
type Watch = (org: Org | null, answer: boolean) => void;
const watchers = new Set<Watch>();
/* Answers can come back out of order, to any screen; one older than the company shown is dropped. */
let asked = 0;
let shown = 0;
/* While any screen shows the company, what the stream says of it goes into the company itself, once. */
let unhear: (() => void) | null = null;

function share(org: Org | null, answer: boolean): void {
  known = org;
  for (const watch of [...watchers]) watch(org, answer);
}

function hear(m: LiveMessage): void {
  if (!known) return;
  if (m.type === 'context') {
    const next = withContext(known, m.agentId, m.used);
    if (next !== known) share(next, false);
  }
  if (m.type === 'working' && known.agents.working !== m.working) {
    share(keepRoster(known, { ...known, agents: { ...known.agents, working: m.working } }), false);
  }
}

function watchOrg(watch: Watch): () => void {
  watchers.add(watch);
  unhear ??= listen(hear);
  return () => {
    watchers.delete(watch);
    if (watchers.size || !unhear) return;
    unhear();
    unhear = null;
  };
}

/* The answer to request n. A cut-off answer is no company, and one older than the company shown is no news: the company on
   the screens stays until the next whole answer. */
function answered(n: number, data: Org | null | undefined): void {
  if (!data || n < shown) return;
  shown = n;
  share(data, true);
}

/* A person leaving the tab takes the company off every screen at once, with the answers still on their way for it. */
export function forgetOrg(): void {
  shown = ++asked;
  share(null, true);
}

/* The company as /api/org shows it, kept fresh from the live stream; a screen asks for it again only while enabled. */
export function useOrg(enabled = true): { org: Org | null; failure: unknown } {
  const [org, setOrg] = useState<Org | null>(() => known);
  const [failure, setFailure] = useState<unknown>(null);
  const mounted = useRef(true);

  useEffect(() => {
    const stop = watchOrg((next, answer) => {
      setOrg(next);
      if (answer) setFailure(null);
    });
    /* What came between the first drawing and now, a forgotten company too. */
    setOrg(known);
    return stop;
  }, []);

  /* A screen that went away meanwhile still leaves its answer for the screens after it. */
  const load = useCallback(() => {
    const n = ++asked;
    api.get<Org>('/api/org').then(
      data => answered(n, data),
      err => mounted.current && n >= shown && setFailure(err),
    );
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (enabled) load();
    return () => {
      mounted.current = false;
    };
  }, [enabled, load]);

  /* The lines and the counts moved while the tab was away. */
  useFetchOnReturn(enabled, load);

  /* Batch frequent task and question changes without letting a continuous stream postpone the refresh forever. */
  const soon = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (soon.current) clearTimeout(soon.current);
    },
    [],
  );

  useStream(m => {
    if (!enabled) return;
    if ((m.type === 'task' || m.type === 'requests') && !soon.current) {
      soon.current = setTimeout(() => {
        soon.current = null;
        load();
      }, SETTLE_MS);
    }
    /* Employees move between working and sleeping too, so the company is fetched again for their states. */
    if (FETCH_AT_ONCE.has(m.type) || m.type === 'working') load();
  });

  return { org, failure };
}
