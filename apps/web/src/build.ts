import { useEffect, useState } from 'react';
import { api } from './api';
import { everyVisible } from './guard';
import { latestAnswers } from './live';

/* How often a page that is seen asks which build the server runs. */
export const BUILD_POLL_MS = 5 * 60_000;

/* The build the server names, or null for any answer that names none. */
function buildOf(answer: unknown): string | null {
  const build = (answer as { build?: unknown } | null)?.build;
  return typeof build === 'string' && build !== '' ? build : null;
}

/* Whether the server runs another build than this page came with, the first one it heard of. The server answers this to
   anyone, signed in or not. A look that fails says nothing, and the same build again is no news. */
export function useNewBuild(): boolean {
  const [newer, setNewer] = useState(false);
  useEffect(() => {
    let live = true;
    let mine: string | null = null;
    const ask = latestAnswers();
    const look = async () => {
      const fresh = ask();
      const build = await api.get<unknown>('/api/build').then(buildOf, () => null);
      if (!live || build === null || !fresh()) return;
      mine ??= build;
      setNewer(build !== mine);
    };
    void look();
    const stop = everyVisible(() => void look(), BUILD_POLL_MS);
    return () => {
      live = false;
      stop();
    };
  }, []);
  return newer;
}
