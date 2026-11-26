import { useEffect, useId, useRef, useSyncExternalStore } from 'react';
import { BOOT_STYLE, SERVICE_CLOSE } from '@hornhoof/protocol/service-lines';
import { useT } from '../i18n';
import { service, type ServiceMessage, type ServiceView } from '../service-state';
import { takeEscape } from './escape';
import { LogoMark } from './icons';

/* The one road of service messages (#2098, #2099), drawn as Design drew it (#2100): the window, the strip and the loader are
   one family. Each says the one current message, the Hornhoof logo and its one line, and for an update its progress bar;
   only where it stands differs. Nothing here asks the person to try again, and each goes by itself once the state ends.
   The words are English in every language, as the protocol keeps them. */

/* What the road shows now: nothing, or the one message and the one place it stands in. */
export const useServiceView = (): ServiceView => useSyncExternalStore(service.subscribe, service.snapshot);

/* How far the update has come, as a bar with no number on the screen: only a screen reader has it. Drawn only where the
   server says how far it is. */
function Progress({ message }: { message: ServiceMessage }) {
  const progress = message.update?.progress;
  if (progress === null || progress === undefined) return null;
  const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  return (
    <span className="svc-progress" role="progressbar" aria-label={message.line} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={message.line}>
      <i style={{ inlineSize: `${percent}%` }} />
    </span>
  );
}

/* The line of the message. A notice of the page's own is in the page's language; every other line is English. */
function Line({ message, id }: { message: ServiceMessage; id?: string }) {
  return <span className="svc-line" id={id} lang={message.kind === 'notice' ? undefined : 'en'}>{message.line}</span>;
}

/* The focus goes to the close button as the window comes, and back to where it was as it goes: what held it before the page
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

/* Escape closes the window, before anything under it takes the key; Tab stays on the close button, the one thing to press. */
function useWindowKeys(shown: boolean, close: { current: HTMLElement | null }): void {
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (takeEscape(e)) service.close();
      else if (e.key === 'Tab') {
        e.preventDefault();
        close.current?.focus({ preventScroll: true });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [shown, close]);
}

const CLOSE_MARK = (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true" focusable="false">
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

/* The state first appears here, in the middle of the page: the one window of the service, the same for every kind, on the
   shared scrim. The page under it is inert. The close button, Escape and a click outside it close it, and the state goes on
   as the strip. */
export function ServiceWindow() {
  const view = useServiceView();
  const shown = view?.place === 'window';
  const close = useRef<HTMLButtonElement>(null);
  const line = useId();
  useFocusReturn(shown, close);
  useWindowKeys(shown, close);
  if (view?.place !== 'window') return null;
  return (
    <div className="dialog-back svc-back" onPointerDown={e => e.target === e.currentTarget && service.close()}>
      <div className="dialog svc-window" role="dialog" aria-modal="true" aria-labelledby={line}>
        <button ref={close} className="btn ghost icon-btn window-close" type="button" aria-label={SERVICE_CLOSE} onClick={service.close}>{CLOSE_MARK}</button>
        <LogoMark className="svc-mark" />
        <Line message={view.message} id={line} />
        <Progress message={view.message} />
      </div>
    </div>
  );
}

/* Once the window is closed, the same state stays here: a thin plaque at the top of every screen, under the menu, out of the
   flow, so it never moves or shrinks what stands under it. It has no close and no button, takes no focus, and shows the
   state, and the update's progress, until the state ends. Where a page area shows the loader line in its own place, the line
   is said, and the strip is not drawn. */
export function ServiceStrip() {
  const view = useServiceView();
  if (view?.place !== 'strip' || view.loader) return null;
  return (
    <div className="svc-strip glass" role="status" aria-live="polite">
      <LogoMark className="svc-mark" />
      <Line message={view.message} />
      <Progress message={view.message} />
    </div>
  );
}

/* A notice of the road that stands while its reason does, and goes by itself once the reason ends or the screen is gone. */
export function useServiceNotice(id: string, on: boolean, line: string): void {
  useEffect(() => {
    if (!on) return;
    service.notify(id, line);
    return () => service.clear(id);
  }, [id, on, line]);
}

/* In the place of a page area that has nothing cached to show while a state stands: the logo, the ring and the same line, in
   place. No window of its own and nothing to press. live: false where a second area of the screen shows it too, so the
   screen has one status. */
export function ServiceLoader({ live = true, boot = false }: { live?: boolean; boot?: boolean }) {
  const view = useServiceView();
  const shown = view !== null;
  useEffect(() => (shown ? service.holdLoader() : undefined), [shown]);
  if (!view) return null;
  if (boot && view.message.kind === 'updating') return <BootScreen updating />;
  return (
    <section className="svc-loader" role={live ? 'status' : undefined} aria-live={live ? 'polite' : undefined} aria-busy="true">
      <LogoMark className="svc-mark" />
      <span className="svc-ring" aria-hidden="true" />
      <Line message={view.message} />
      <Progress message={view.message} />
    </section>
  );
}

export function BootScreen({ updating = false }: { updating?: boolean }) {
  const t = useT();
  const word = updating ? t.boot.updating : t.boot.loading;
  return (
    <>
      <style>{BOOT_STYLE}</style>
      <section className="boot-screen" role="status" aria-busy="true">
        <LogoMark className="boot-mark" />
        <p className="boot-line">
          <span className="boot-label">{word}…</span>
          <span className="boot-word" aria-hidden="true" data-word={word} />
          <span className="boot-dots" aria-hidden="true"><i /><i /><i /></span>
        </p>
      </section>
    </>
  );
}
