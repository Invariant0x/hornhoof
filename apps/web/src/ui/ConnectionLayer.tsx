import { useEffect, useRef, useSyncExternalStore } from 'react';
import { connection, type Away, type Link } from '../connection';
import { LogoMark } from './icons';

/* What the page knows of the server: nothing to say while it answers, why it does not once it does not. */
export const useLink = (): Link => useSyncExternalStore(connection.subscribe, connection.snapshot);

const LINE: Record<Away, string> = {
  lost: 'No connection',
  updating: 'Updating',
};

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

/* The layer over the page while the server cannot be reached or installs an update (#1938, #2049): only the Hornhoof logo and
   one English line, centred on a plain background. It covers the whole window while the page under it is inert and retries in
   the background until the server answers. */
export function ConnectionLayer() {
  const { away } = useLink();
  const shown = away !== null;
  const layer = useRef<HTMLDivElement>(null);
  useFocusReturn(shown, layer);
  if (!away) return null;
  return (
    <div ref={layer} className="conn-layer" role="alertdialog" aria-modal="true" aria-labelledby="conn-title" tabIndex={-1}>
      <div className="conn">
        <LogoMark className="conn-mark" />
        <p id="conn-title" lang="en">{LINE[away]}</p>
      </div>
    </div>
  );
}
