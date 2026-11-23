import { useEffect, useRef, useSyncExternalStore } from 'react';
import { connection, type Link } from '../connection';
import { useT } from '../i18n';

/* What the page knows of the server: nothing to say while it answers, why it does not once it does not. */
export const useLink = (): Link => useSyncExternalStore(connection.subscribe, connection.snapshot);

/* The layer over the page while the server cannot be reached or installs an update (#1938): what happened, that Hornhoof keeps
   trying and comes back by itself, and one button to ask again at once. It lies over the page like a dialog, so nothing under
   it moves, and the page under it is inert, so a key does not reach it either. */
export function ConnectionLayer() {
  const t = useT();
  const { away, trying } = useLink();
  const shown = away !== null;
  const box = useRef<HTMLDivElement>(null);
  const was = useRef<Element | null>(null);
  /* The focus goes into the layer as it comes, and back to where it was as it goes. */
  useEffect(() => {
    if (!shown) return;
    was.current = document.activeElement;
    box.current?.focus({ preventScroll: true });
    return () => {
      const back = was.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus({ preventScroll: true });
    };
  }, [shown]);
  if (!away) return null;
  const words = t.connection[away];
  return (
    <div className="dialog-back conn-layer">
      <div ref={box} className="dialog conn" role="alertdialog" aria-modal="true" aria-label={words.title} aria-describedby="conn-hint" tabIndex={-1}>
        <h2 dir="auto">{words.title}</h2>
        <p id="conn-hint" className="muted" dir="auto">{words.hint}</p>
        <p className="conn-try" role="status" aria-busy={trying}>
          <span className="spinner" aria-hidden="true" />
          <span dir="auto">{t.connection.trying}</span>
        </p>
        <div className="entry-actions">
          <button className="btn" type="button" onClick={() => connection.tryNow()}>{t.connection.tryNow}</button>
        </div>
      </div>
    </div>
  );
}
