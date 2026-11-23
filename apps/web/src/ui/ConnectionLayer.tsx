import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { connection, type Away, type Link } from '../connection';
import { useT } from '../i18n';

/* What the page knows of the server: nothing to say while it answers, why it does not once it does not. */
export const useLink = (): Link => useSyncExternalStore(connection.subscribe, connection.snapshot);

/* How long the server is missed before the layer says the wait is long: a lost connection, then an update. */
export const LONG_WAIT_MS: Record<Away, number> = { lost: 120_000, updating: 300_000 };

/* The page's clock to the second, for as long as the layer shows, so its countdown and its long-wait line follow it. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [running]);
  return now;
}

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

/* The layer over the page while the server cannot be reached or installs an update (#1938): what happened, that Hornhoof
   reconnects by itself, when it looks next (the ring turns only while it looks), a line once the wait is long, and one
   button to look at once. It is the book's dialog on its dimmed layer, so it takes every click, nothing under it moves, and
   the page under it is inert, so a key does not reach it either. Escape does not close it: the server is what ends it. */
export function ConnectionLayer() {
  const t = useT();
  const { away, trying, since, nextAt } = useLink();
  const shown = away !== null;
  const now = useNow(shown);
  const button = useRef<HTMLButtonElement>(null);
  useFocusReturn(shown, button);
  if (!away) return null;
  const words = t.connection[away];
  const long = since !== null && now - since >= LONG_WAIT_MS[away];
  const seconds = nextAt === null ? null : Math.max(0, Math.ceil((nextAt - now) / 1000));
  return (
    <div className="dialog-back conn-layer">
      <div className="dialog conn" role="alertdialog" aria-modal="true" aria-labelledby="conn-title" aria-describedby="conn-hint">
        <h2 id="conn-title" dir="auto">{words.title}</h2>
        <p id="conn-hint" className="muted" dir="auto">{words.hint}</p>
        {long && <p className="conn-long muted" dir="auto">{words.long}</p>}
        <div className="conn-foot">
          <p className="conn-try" role="status" aria-busy={trying}>
            {trying && <span className="spinner" aria-hidden="true" />}
            <span dir="auto">{trying || seconds === null ? t.connection.trying : t.connection.next(seconds)}</span>
          </p>
          <div className="entry-actions">
            <button ref={button} className="btn" type="button" onClick={() => connection.tryNow()}>{t.connection.tryNow}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
