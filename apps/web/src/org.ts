import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useStream } from './live';
import type { Org } from './types';

/* What each employee does changes with its tasks and questions. */
const SETTLE_MS = 400;

/* The company as /api/org shows it, kept fresh from the live stream while enabled. */
export function useOrg(enabled = true): { org: Org | null; failure: unknown } {
  const [org, setOrg] = useState<Org | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const mounted = useRef(true);

  const load = useCallback(() => {
    api.get<Org>('/api/org').then(
      data => {
        if (!mounted.current) return;
        setOrg(data);
        setFailure(null);
      },
      err => mounted.current && setFailure(err),
    );
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (enabled) load();
    return () => {
      mounted.current = false;
    };
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
    if (m.type === 'org' || m.type === 'reconnected') load();
    if (m.type === 'working') {
      setOrg(o => o && { ...o, agents: { ...o.agents, working: m.working } });
      /* Employees move between working and sleeping too, so the company is fetched again for their states. */
      load();
    }
  });

  return { org, failure };
}
