import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiFailure } from './api';
import type { UpdatesView } from './types';
import type { Version } from './ui/VersionMark';
import { answeredUpdate } from './update-state';
import { everyVisible } from './guard';
import { heardAgain, latestAnswers, useStream } from './live';

/* A seam for tests: the page reloads once the server runs another build. */
export const page = { reload: () => window.location.reload() };

const POLL_MS = 5 * 60_000;
/* While an update waits or runs, and while the server restarts. */
const BUSY_POLL_MS = 2_000;
/* While a node waits for an update: what it waits for changes only as turns end. */
const NODES_POLL_MS = 15_000;

export const updatesPollMs = (busy: boolean, waits: UpdatesView['nodeWaits']): number => {
  if (busy) return BUSY_POLL_MS;
  return waits?.length ? NODES_POLL_MS : POLL_MS;
};

/* An update asked for now that would stop this many turns, which waits for the person to say yes. */
export type UpdateCut = { version: string; turns: number };

export type Updates = {
  failure?: unknown;
  view: UpdatesView | null;
  busy: boolean;
  /* An update was asked for and the updater has not reported on it yet. */
  starting: boolean;
  target: Version | null;
  /* The server stopped answering while an update runs: it is restarting. */
  offline: boolean;
  /* The server answered that it is installing the update and takes no changes. */
  maintenance: boolean;
  /* An update is being asked for and the server has not answered yet. */
  asking: boolean;
  cut: UpdateCut | null;
  check(): Promise<void>;
  update(version: string, whenIdle: boolean): Promise<void>;
  callOff(): Promise<void>;
  confirmCut(): Promise<void>;
  dropCut(): void;
};

/* How many turns the server says an update now would stop, when that is why it refused. */
function turnsCut(err: unknown): number | null {
  if (!(err instanceof ApiFailure) || err.reason !== 'turns_would_stop') return null;
  const turns = err.details?.turns;
  return typeof turns === 'number' ? turns : null;
}

/* confirmTurns: how many turns the person agreed to stop; the server asks again if more would. The answer is the update
   that started, or how many turns stand in its way. */
async function askServer(version: string, whenIdle: boolean, confirmTurns?: number): Promise<{ id: string } | { turns: number }> {
  try {
    return await api.post<{ id: string }>('/api/updates', { version, whenIdle, ...(confirmTurns === undefined ? {} : { confirmTurns }) });
  } catch (err) {
    const turns = turnsCut(err);
    if (turns === null) throw err;
    return { turns };
  }
}

function requestedBuild(view: UpdatesView | null, tag: string): Version {
  const build = tag === 'latest' ? view?.latest : view?.versions.find(b => b.tag === tag);
  if (!build) return { version: tag };
  return { version: build.version || build.tag, commit: build.commit };
}

type Outage = 'none' | 'maintenance' | 'offline';

/* Why a poll failed: the server said it is in maintenance, or it is silent while an update runs, which is a restart. */
function outageOf(err: unknown, updating: boolean): Outage {
  if (err instanceof ApiFailure && err.reason === 'maintenance') return 'maintenance';
  return updating ? 'offline' : 'none';
}

/* What Hornhoof knows about newer builds and the updater, for people who see the whole company. */
export function useUpdates(enabled: boolean): Updates {
  const [failure, setFailure] = useState<unknown>(null);
  const [view, setView] = useState<UpdatesView | null>(null);
  const [sent, setSent] = useState<(Version & { id: string }) | null>(null);
  const [outage, setOutage] = useState<Outage>('none');
  const [asking, setAsking] = useState(false);
  const [cut, setCut] = useState<UpdateCut | null>(null);
  const boot = useRef<string | null>(null);
  const busyNow = useRef(false);
  const askingNow = useRef(false);
  const wasRunning = useRef(false);
  const hadOutage = useRef(false);
  const [askPoll] = useState(latestAnswers);

  const take = useCallback((next: UpdatesView) => {
    boot.current ??= next.current.commit;
    if (next.current.commit !== boot.current) return page.reload();
    const running = next.updater.status?.state === 'running';
    const recovered = hadOutage.current || (wasRunning.current && !running);
    wasRunning.current = running;
    hadOutage.current = false;
    setView(next);
    setOutage('none');
    if (recovered) heardAgain();
  }, []);

  const load = useCallback(async () => {
    const fresh = askPoll();
    try {
      const next = await api.get<UpdatesView>('/api/updates');
      if (!fresh()) return;
      take(next);
      setFailure(null);
    } catch (err) {
      if (!fresh()) return;
      setFailure(err);
      /* The server restarts during an update; the next poll asks again. */
      const next = outageOf(err, busyNow.current);
      hadOutage.current ||= next !== 'none';
      setOutage(next);
    }
  }, [askPoll, take]);

  const status = view?.updater.status;
  /* A sent request counts until the updater reports on it. */
  const answered = answeredUpdate(sent, status);
  const busy = (sent !== null && !answered) || status?.state === 'running' || Boolean(view?.updater.waiting);
  const starting = sent !== null && status?.id !== sent.id;
  busyNow.current = busy;
  const pollMs = updatesPollMs(busy || outage === 'maintenance', view?.nodeWaits);

  useEffect(() => {
    if (answered) setSent(null);
  }, [answered]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    return everyVisible(() => void load(), pollMs);
  }, [enabled, pollMs, load]);

  useStream(m => {
    if (enabled && m.type === 'updates') void load();
  });

  const dropCut = useCallback(() => setCut(null), []);

  const ask = async (version: string, whenIdle: boolean, confirmTurns?: number) => {
    /* A second click before the answer would ask the updater twice. */
    if (askingNow.current) return;
    askingNow.current = true;
    setAsking(true);
    try {
      const target = requestedBuild(view, version);
      const answer = await askServer(version, whenIdle, confirmTurns);
      if ('turns' in answer) return setCut({ version, turns: answer.turns });
      setCut(null);
      if (!whenIdle) setSent({ id: answer.id, ...target });
      await load();
    } finally {
      askingNow.current = false;
      setAsking(false);
    }
  };

  return {
    failure,
    view,
    busy,
    starting,
    target: sent,
    offline: outage === 'offline',
    maintenance: outage === 'maintenance',
    asking,
    cut,
    check: async () => {
      const fresh = askPoll();
      const next = await api.post<UpdatesView>('/api/updates/check');
      if (fresh()) take(next);
    },
    update: (version, whenIdle) => ask(version, whenIdle),
    callOff: async () => {
      await api.del('/api/updates');
      await load();
    },
    confirmCut: async () => {
      if (cut) await ask(cut.version, false, cut.turns);
    },
    dropCut,
  };
}
