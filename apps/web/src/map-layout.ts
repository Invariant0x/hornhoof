import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Bends, Placed } from './map-arrange';
import type { Point } from './ui/wires';

/* Where this person put blocks on the company map, and the bends they put on its lines. The server keeps them for them alone,
   so they follow them to another device; when it gives nothing back, the map stands as it places itself. failed: the last
   change did not reach the server. version: counts the times the whole arrangement changed at once, from the server or put
   back, so Fit can show it again. */
export function useMapLayout() {
  const [placed, setPlaced] = useState<Placed>({});
  const [bends, setBends] = useState<Bends>({});
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  /* What the person did before the server answered: their moves stand over what it keeps, and a reset over all of it. */
  const done = useRef<'moved' | 'reset' | null>(null);
  /* The lines they bent before the server answered, which keep their bends as they left them. */
  const bent = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    api.get<{ blocks?: Placed; anchors?: Bends } | null>('/api/map/layout').then(
      kept => {
        if (!live || done.current === 'reset' || !kept || typeof kept !== 'object') return;
        const { blocks, anchors } = kept;
        if (blocks && typeof blocks === 'object') setPlaced(p => ({ ...blocks, ...p }));
        if (anchors && typeof anchors === 'object') setBends(b => ({ ...Object.fromEntries(Object.entries(anchors).filter(([line]) => !bent.current.has(line))), ...b }));
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

  /* A line's bends, all of them in order; none lets the line run its own way again. */
  const bend = useCallback((line: string, at: Point[]) => {
    done.current ??= 'moved';
    bent.current.add(line);
    setBends(b => {
      const next = { ...b };
      if (at.length) next[line] = at;
      else delete next[line];
      return next;
    });
    api.patch('/api/map/layout', { anchors: { [line]: at.length ? at : null } }).then(() => setFailed(false), () => setFailed(true));
  }, []);

  const reset = useCallback(() => {
    done.current = 'reset';
    setPlaced({});
    setBends({});
    setVersion(v => v + 1);
    api.del('/api/map/layout').then(() => setFailed(false), () => setFailed(true));
  }, []);

  return { placed, place, bends, bend, reset, failed, version };
}
