import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useStream } from './live';
import type { Org } from './types';

/* The company as /api/org shows it, kept fresh from the live stream while enabled. */
export function useOrg(enabled = true): { org: Org | null; failure: unknown } {
  const [org, setOrg] = useState<Org | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const mounted = useRef(true);

  const load = useCallback(() => {
    api.get<Org>('/api/org').then(
      data => mounted.current && setOrg(data),
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

  useStream(m => {
    if (!enabled) return;
    if (m.type === 'org' || m.type === 'reconnected') load();
    if (m.type === 'working') setOrg(o => o && { ...o, agents: { ...o.agents, working: m.working } });
  });

  return { org, failure };
}
