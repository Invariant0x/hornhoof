import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { Bends, Placed } from './map-arrange';
import type { Point } from './ui/wires';

/* What the server keeps, when it is an object at all. */
const objectOr = <T,>(kept: T): (T & object) | null => (kept && typeof kept === 'object' ? kept : null);

/* Where this person put blocks on the company map, and the bends they put on its lines. The server keeps them for them alone,
   so they follow them to another device; when it gives nothing back, the map stands as it places itself. failed: the last
   change did not reach the server. version: counts the times the whole arrangement changed at once, from the server or put
   back, so Fit can show it again. arrived: the server answered, with an arrangement, with none or with a failure, so the
   map can stand where the person put it from the first time it is drawn; load asks again. */
export function useMapLayout() {
  const [placed, setPlaced] = useState<Placed>({});
  const [bends, setBends] = useState<Bends>({});
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const [arrived, setArrived] = useState(false);
  /* What the person did before the server answered: their moves stand over what it keeps, and a reset over all of it. */
  const done = useRef<'moved' | 'reset' | null>(null);
  /* The lines they bent before the server answered, which keep their bends as they left them. */
  const bent = useRef(new Set<string>());

  const load = useCallback((live: () => boolean = () => true) => {
    api.get<{ blocks?: Placed; anchors?: Bends } | null>('/api/map/layout').then(
      answer => {
        if (!live()) return;
        setArrived(true);
        const kept = done.current === 'reset' ? null : objectOr(answer);
        if (!kept) return;
        const blocks = objectOr(kept.blocks), anchors = objectOr(kept.anchors);
        if (blocks) setPlaced(p => ({ ...blocks, ...p }));
        if (anchors) setBends(b => ({ ...Object.fromEntries(Object.entries(anchors).filter(([line]) => !bent.current.has(line))), ...b }));
        setVersion(v => v + 1);
      },
      () => live() && setArrived(true),
    );
  }, []);

  useEffect(() => {
    let live = true;
    load(() => live);
    return () => {
      live = false;
    };
  }, [load]);

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

  return { placed, place, bends, bend, reset, failed, version, arrived, load: () => load() };
}
