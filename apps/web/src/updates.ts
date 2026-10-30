import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { UpdatesView } from './types';

/* A seam for tests: the page reloads once the server runs another build. */
export const page = { reload: () => window.location.reload() };

const POLL_MS = 5 * 60_000;
/* While an update waits or runs, and while the server restarts. */
const BUSY_POLL_MS = 2_000;

export type Updates = {
  view: UpdatesView | null;
  busy: boolean;
  check(): Promise<void>;
  update(version: string, whenIdle: boolean): Promise<void>;
  callOff(): Promise<void>;
};

/* What Hornhoof knows about newer builds and the updater, for people who see the whole company. */
export function useUpdates(enabled: boolean): Updates {
  const [view, setView] = useState<UpdatesView | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const boot = useRef<string | null>(null);

  const take = useCallback((next: UpdatesView) => {
    boot.current ??= next.current.commit;
    if (next.current.commit !== boot.current) return page.reload();
    setView(next);
  }, []);

  const load = useCallback(async () => {
    try {
      take(await api.get<UpdatesView>('/api/updates'));
    } catch {
      /* The server restarts during an update; the next poll asks again. */
    }
  }, [take]);

  const status = view?.updater.status;
  /* A sent request counts until the updater reports on it. */
  const answered = sent !== null && status?.id === sent && status.state !== 'running';
  const busy = (sent !== null && !answered) || status?.state === 'running' || Boolean(view?.updater.waiting);

  useEffect(() => {
    if (answered) setSent(null);
  }, [answered]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const timer = setInterval(() => void load(), busy ? BUSY_POLL_MS : POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, busy, load]);

  return {
    view,
    busy,
    check: async () => take(await api.post<UpdatesView>('/api/updates/check')),
    update: async (version, whenIdle) => {
      const { id } = await api.post<{ id: string }>('/api/updates', { version, whenIdle });
      if (!whenIdle) setSent(id);
      await load();
    },
    callOff: async () => {
      await api.del('/api/updates');
      await load();
    },
  };
}
