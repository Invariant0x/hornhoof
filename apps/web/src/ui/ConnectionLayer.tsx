import { useEffect, useRef, useSyncExternalStore } from 'react';
import { connection, type Away, type Link } from '../connection';
import { LogoMark } from './icons';

/* What the page knows of the server: nothing to say while it answers, why it does not once it does not. */
export const useLink = (): Link => useSyncExternalStore(connection.subscribe, connection.snapshot);

/* The one line of each state, in English whatever language the person chose (#2049): the server's own pages say the same. */
const LINE: Record<Away, string> = { lost: 'No connection', updating: 'Updating' };

/* The focus goes where the layer asks for it as it comes, and back to where it was as it goes: what held it before the page
   went inert is read as it moves, since the browser takes it away from what turns inert. */
function useFocusReturn(shown: boolean, entry: { current: HTMLElement | null }): void {
  const was = useRef<Element | null>(null);
  useEffect(() => {
    if (shown) return;
    const seen = (e: FocusEvent) => void (was.current = e.target as Element);
    document.addEventListener('focusin', seen);
    return () => document.removeEventListener('focusin', seen);
  }, [shown]);
  useEffect(() => {
    if (!shown) return;
    entry.current?.focus({ preventScroll: true });
    return () => {
      const back = was.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    };
  }, [shown, entry]);
}

/* The layer over the page while the server cannot be reached or installs an update (#1938, #2049): the sign of Hornhoof and
   one line under it, centred on the theme's plain background, and nothing else. It looks again by itself, with a growing wait,
   and goes once the server answers. It is a dialog of the page's own kind: it takes every click, nothing under it moves, and
   the page under it is inert, so a key does not reach it either. Escape does not close it: the server is what ends it. */
export function ConnectionLayer() {
  const { away } = useLink();
  const layer = useRef<HTMLDivElement>(null);
  useFocusReturn(away !== null, layer);
  if (!away) return null;
  return (
    <div ref={layer} className="conn-layer" role="alertdialog" aria-modal="true" aria-labelledby="conn-line" tabIndex={-1}>
      <LogoMark className="conn-mark" />
      <p id="conn-line" className="conn-line">{LINE[away]}</p>
    </div>
  );
}
