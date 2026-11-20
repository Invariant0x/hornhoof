import { useEffect, useRef, useState } from 'react';
import { errorText, useT } from '../i18n';
import { shownLoadFailure, useUpdateSaysIt } from './LoadFailure';
import { Stalled, Waiting } from './Waiting';

/* The longest one load of a screen takes, all of its parts together, before the person hears it takes longer than usual.
   One limit for the whole load, not one per request; Try again starts it over. */
export const LOAD_LIMIT_MS = 20_000;

/* A part of a screen's data: undefined or null until its first answer; failure: why its last ask failed; load asks again. */
export type LoadPart = { data: unknown; failure: unknown; load(): unknown };

/* Where a screen's load is: its parts still coming, past the limit, failed with why, or all come. */
export type Load = { phase: 'loading' | 'late' | 'failed' | 'done'; failure: unknown; retry(): void };

const missingOf = (parts: LoadPart[]) => parts.filter(p => p.data === undefined || p.data === null);

type Seen = { failed: unknown; loading: boolean; timed: boolean };

/* Where the parts that have not come are: the first failure to say, if any, then whether they are still coming, and whether
   the limit counts. A failure from before the last Try again no longer counts, as the part is asked again. A part that
   waits for Hornhoof's update, which the update panel already says, is still coming, and no limit counts while it waits. */
function seen(missing: LoadPart[], before: Set<unknown>, updateSaysIt: boolean): Seen {
  const failures = missing.map(p => shownLoadFailure(p.failure, updateSaysIt));
  const failed = failures.find(f => f && !before.has(f)) ?? null;
  const updating = missing.some((p, i) => p.failure && !failures[i]);
  const loading = missing.length > 0 && !failed;
  return { failed, loading, timed: loading && !updating };
}

/* One load of a screen from its parts. */
export function useLoad(parts: LoadPart[], limitMs = LOAD_LIMIT_MS): Load {
  const [round, setRound] = useState(0);
  const [late, setLate] = useState(false);
  const before = useRef(new Set<unknown>());
  const updateSaysIt = useUpdateSaysIt();
  const missing = missingOf(parts);
  const { failed, loading, timed } = seen(missing, before.current, updateSaysIt);
  useEffect(() => {
    if (!timed) return;
    const timer = setTimeout(() => setLate(true), limitMs);
    return () => {
      clearTimeout(timer);
      setLate(false);
    };
  }, [timed, round, limitMs]);
  const retry = () => {
    for (const p of missing) {
      if (p.failure) before.current.add(p.failure);
      p.load();
    }
    setRound(r => r + 1);
  };
  if (failed) return { phase: 'failed', failure: failed, retry };
  if (loading) return { phase: late ? 'late' : 'loading', failure: null, retry };
  return { phase: 'done', failure: null, retry };
}

/* A failure of a load said on top of the page: only once the data came. Before that, the load says it where the data would
   stand. */
export const onTop = (data: unknown, failure: unknown): unknown => (data === undefined || data === null ? null : failure);

/* Where a screen's data will stand while it comes: the shared indicator, then why it stalled with Try again, then nothing
   once it all came. */
export function LoadState({ load }: { load: Load }) {
  const t = useT();
  const retry = { text: t.app.tryAgain, run: load.retry };
  if (load.phase === 'loading') return <Waiting what={t.common.loading} />;
  if (load.phase === 'late') return <Stalled tone="late" reason={t.common.tooLong} next={t.common.stillComing} retry={retry} />;
  if (load.phase === 'failed') return <Stalled tone="failed" reason={errorText(t, load.failure)} retry={retry} />;
  return null;
}
