import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useStream } from './live';
import type { CompanyPauseView } from './types';

const EMPTY: CompanyPauseView = { paused: null, finishingTurns: 0 };

export type CompanyPauseState = {
  view: CompanyPauseView;
  busy: boolean;
  failure: unknown;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  toggle: () => Promise<void>;
};

/* Reads the company's pause state, updates finishing turns live from the working stream, and switches pause on or off. */
export function useCompanyPause(): CompanyPauseState {
  const [view, setView] = useState<CompanyPauseView>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const seq = useRef(0);
  const mounted = useRef(true);

  const load = useCallback(() => {
    const id = ++seq.current;
    /* An older server without /api/company/pause stays quiet instead of showing an error bar. */
    void api.get<CompanyPauseView>('/api/company/pause').then(
      next => {
        if (mounted.current && seq.current === id) setView(next);
      },
      () => undefined,
    );
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  useStream(m => {
    if (m.type === 'working') {
      setView(prev => (prev.finishingTurns === m.working ? prev : { ...prev, finishingTurns: m.working }));
    } else if (m.type === 'org' || m.type === 'reconnected') {
      load();
    }
  });

  const act = useCallback(async (path: '/api/company/pause' | '/api/company/resume') => {
    setBusy(true);
    setFailure(null);
    const id = ++seq.current;
    try {
      const next = await api.post<CompanyPauseView>(path);
      if (mounted.current && seq.current === id) setView(next);
    } catch (err) {
      if (mounted.current) setFailure(err);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, []);

  const pause = useCallback(() => act('/api/company/pause'), [act]);
  const resume = useCallback(() => act('/api/company/resume'), [act]);
  const toggle = useCallback(() => act(view.paused ? '/api/company/resume' : '/api/company/pause'), [act, view.paused]);

  return { view, busy, failure, pause, resume, toggle };
}
