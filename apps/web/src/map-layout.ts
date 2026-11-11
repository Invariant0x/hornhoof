import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Placed } from './map-arrange';

/* Where this person put blocks on the company map. The server keeps it for them alone, so it follows them to another device;
   when it gives nothing back, the map stands as it places itself. failed: the last change did not reach the server.
   version: counts the times the whole arrangement changed at once, from the server or put back, so Fit can show it again. */
export function useMapLayout() {
  const [placed, setPlaced] = useState<Placed>({});
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  /* What the person did before the server answered: their moves stand over what it keeps, and a reset over all of it. */
  const done = useRef<'moved' | 'reset' | null>(null);

  useEffect(() => {
    let live = true;
    api.get<{ blocks?: Placed } | null>('/api/map/layout').then(
      kept => {
        const blocks = kept?.blocks;
        if (!live || done.current === 'reset' || !blocks || typeof blocks !== 'object') return;
        setPlaced(p => ({ ...blocks, ...p }));
        setVersion(v => v + 1);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  const place = useCallback((key: string, at: { x: number; y: number }) => {
    done.current ??= 'moved';
    setPlaced(p => ({ ...p, [key]: at }));
    api.patch('/api/map/layout', { blocks: { [key]: at } }).then(() => setFailed(false), () => setFailed(true));
  }, []);

  const reset = useCallback(() => {
    done.current = 'reset';
    setPlaced({});
    setVersion(v => v + 1);
    api.del('/api/map/layout').then(() => setFailed(false), () => setFailed(true));
  }, []);

  return { placed, place, reset, failed, version };
}
