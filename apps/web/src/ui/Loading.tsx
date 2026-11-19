import { useEffect, useRef, useState } from 'react';
import { errorText, useT } from '../i18n';
import { Stalled, Waiting } from './Waiting';

/* The longest one load of a screen takes, all of its parts together, before the person hears it takes longer than usual.
   One limit for the whole load, not one per request; Try again starts it over. */
export const LOAD_LIMIT_MS = 20_000;

/* A part of a screen's data: undefined or null until its first answer; failure: why its last ask failed; load asks again. */
export type LoadPart = { data: unknown; failure: unknown; load(): unknown };

/* Where a screen's load is: its parts still coming, past the limit, failed with why, or all come. */
export type Load = { phase: 'loading' | 'late' | 'failed' | 'done'; failure: unknown; retry(): void };

const missingOf = (parts: LoadPart[]) => parts.filter(p => p.data === undefined || p.data === null);

/* One load of a screen from its parts. A failure from before the last Try again no longer counts: the part is asked again. */
export function useLoad(parts: LoadPart[], limitMs = LOAD_LIMIT_MS): Load {
  const [round, setRound] = useState(0);
  const [late, setLate] = useState(false);
  const before = useRef(new Set<unknown>());
  const missing = missingOf(parts);
  const failed = missing.find(p => p.failure && !before.current.has(p.failure));
  const loading = missing.length > 0 && !failed;
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => setLate(true), limitMs);
    return () => {
      clearTimeout(timer);
      setLate(false);
    };
  }, [loading, round, limitMs]);
  const retry = () => {
    for (const p of missing) {
      if (p.failure) before.current.add(p.failure);
      p.load();
    }
    setRound(r => r + 1);
  };
  if (failed) return { phase: 'failed', failure: failed.failure, retry };
  if (loading) return { phase: late ? 'late' : 'loading', failure: null, retry };
  return { phase: 'done', failure: null, retry };
}

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
