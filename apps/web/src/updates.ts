import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { UpdatesView } from './types';
import type { Version } from './ui/VersionMark';

/* A seam for tests: the page reloads once the server runs another build. */
export const page = { reload: () => window.location.reload() };

const POLL_MS = 5 * 60_000;
/* While an update waits or runs, and while the server restarts. */
const BUSY_POLL_MS = 2_000;

export type Updates = {
  view: UpdatesView | null;
  busy: boolean;
  /* An update was asked for and the updater has not reported on it yet. */
  starting: boolean;
  target: Version | null;
  /* The server stopped answering while an update runs: it is restarting. */
  offline: boolean;
  /* An update is being asked for and the server has not answered yet. */
  asking: boolean;
  check(): Promise<void>;
  update(version: string, whenIdle: boolean): Promise<void>;
  callOff(): Promise<void>;
};

function requestedBuild(view: UpdatesView | null, tag: string): Version {
  const build = tag === 'latest' ? view?.latest : view?.versions.find(b => b.tag === tag);
  if (!build) return { version: tag };
  return { version: build.version || build.tag, commit: build.commit };
}

/* What Hornhoof knows about newer builds and the updater, for people who see the whole company. */
export function useUpdates(enabled: boolean): Updates {
  const [view, setView] = useState<UpdatesView | null>(null);
  const [sent, setSent] = useState<(Version & { id: string }) | null>(null);
  const [offline, setOffline] = useState(false);
  const [asking, setAsking] = useState(false);
  const boot = useRef<string | null>(null);
  const busyNow = useRef(false);
  const askingNow = useRef(false);

  const take = useCallback((next: UpdatesView) => {
    boot.current ??= next.current.commit;
    if (next.current.commit !== boot.current) return page.reload();
    setView(next);
  }, []);

  const load = useCallback(async () => {
    try {
      take(await api.get<UpdatesView>('/api/updates'));
      setOffline(false);
    } catch {
      /* The server restarts during an update; the next poll asks again. */
      if (busyNow.current) setOffline(true);
    }
  }, [take]);

  const status = view?.updater.status;
  /* A sent request counts until the updater reports on it. */
  const answered = sent !== null && status?.id === sent.id && status.state !== 'running';
  const busy = (sent !== null && !answered) || status?.state === 'running' || Boolean(view?.updater.waiting);
  const starting = sent !== null && status?.id !== sent.id;
  busyNow.current = busy;

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
    starting,
    target: sent,
    offline,
    asking,
    check: async () => take(await api.post<UpdatesView>('/api/updates/check')),
    update: async (version, whenIdle) => {
      /* A second click before the answer would ask the updater twice. */
      if (askingNow.current) return;
      askingNow.current = true;
      setAsking(true);
      try {
        const target = requestedBuild(view, version);
        const { id } = await api.post<{ id: string }>('/api/updates', { version, whenIdle });
        if (!whenIdle) setSent({ id, ...target });
        await load();
      } finally {
        askingNow.current = false;
        setAsking(false);
      }
    },
    callOff: async () => {
      await api.del('/api/updates');
      await load();
    },
  };
}
