import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useStream } from './live';
import type { Department, Org, PersonView } from './types';

/* What each employee does changes with its tasks and questions. */
const SETTLE_MS = 400;

/* An agent's context moves with every step it takes; only its bar changes. */
function withContext(org: Org, agentId: string, used: number): Org {
  const departments = org.departments.map(d => (d.employees.some(e => e.id === agentId) ? { ...d, employees: d.employees.map(e => (e.id === agentId ? { ...e, context: used } : e)) } : d));
  const orchestrator = org.orchestrator?.id === agentId ? { ...org.orchestrator, context: used } : org.orchestrator;
  return { ...org, orchestrator, departments };
}

/* A person on the map's top row, with the department they belong to when they reach only one. */
export type MapPerson = PersonView & { deputy?: boolean; home?: Department };

/* Everyone with a card on the map's top row, each once: the people next to the CEO, then the people of one department in
   the order of the departments. The server places them; the map only lines them up, so every card is reachable from the
   hub, and the decisions screen names whoever it shows. */
export function mapPeople(org: Org): MapPerson[] {
  const seen = new Set<string>();
  const all: MapPerson[] = [...org.people, ...org.departments.flatMap(d => d.people.map(p => ({ ...p, home: d })))];
  return all.filter(p => !seen.has(p.id) && !!seen.add(p.id));
}

/* The company as /api/org shows it, kept fresh from the live stream while enabled. */
export function useOrg(enabled = true): { org: Org | null; failure: unknown } {
  const [org, setOrg] = useState<Org | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const mounted = useRef(true);
  /* Answers can come back out of order; one older than the answer on screen is dropped. */
  const asked = useRef(0);
  const shown = useRef(0);

  const load = useCallback(() => {
    const n = ++asked.current;
    const fresh = () => {
      if (!mounted.current || n < shown.current) return false;
      shown.current = n;
      return true;
    };
    api.get<Org>('/api/org').then(
      data => {
        if (!fresh()) return;
        setOrg(data);
        setFailure(null);
      },
      err => fresh() && setFailure(err),
    );
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (enabled) load();
    return () => {
      mounted.current = false;
    };
  }, [enabled, load]);

  /* A tab that comes back from the background, or a computer from sleep, fetches the company again: the lines and the
     counts moved meanwhile. */
  useEffect(() => {
    if (!enabled) return;
    const back = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, [enabled, load]);

  /* Tasks and questions move often while agents work, so they fetch the company once things settle a little. */
  const soon = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (soon.current) clearTimeout(soon.current);
    },
    [],
  );

  useStream(m => {
    if (!enabled) return;
    if (m.type === 'task' || m.type === 'requests') {
      if (soon.current) clearTimeout(soon.current);
      soon.current = setTimeout(() => {
        soon.current = null;
        load();
      }, SETTLE_MS);
    }
    /* Who decides and what waits for the CEO change the counts on the people's cards. */
    if (m.type === 'org' || m.type === 'reconnected' || m.type === 'computer') load();
    if (m.type === 'context') setOrg(o => o && withContext(o, m.agentId, m.used));
    if (m.type === 'working') {
      setOrg(o => o && { ...o, agents: { ...o.agents, working: m.working } });
      /* Employees move between working and sleeping too, so the company is fetched again for their states. */
      load();
    }
  });

  return { org, failure };
}
