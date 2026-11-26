import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from 'react';
import { BOOT_STYLE, SERVICE_CLOSE } from '@hornhoof/protocol/service-lines';
import { useT } from '../i18n';
import { service, type ServiceMessage, type ServiceView } from '../service-state';
import { takeEscape } from './escape';
import { LogoMark } from './icons';
import { VersionMark } from './VersionMark';

export const useServiceView = (): ServiceView => useSyncExternalStore(service.subscribe, service.snapshot);

type DepartmentFooter = { dock: HTMLDivElement | null; empty: HTMLParagraphElement | null };
const NO_FOOTER: DepartmentFooter = { dock: null, empty: null };
const ServiceFooter = createContext<Dispatch<SetStateAction<DepartmentFooter>>>(() => {});

export function useServiceStripFooter(ref: RefObject<HTMLDivElement | null>) {
  const register = useContext(ServiceFooter);
  const dock = useCallback((element: HTMLDivElement | null) => {
    ref.current = element;
    register(footer => ({ ...footer, dock: element }));
  }, [ref, register]);
  const empty = useCallback((element: HTMLParagraphElement | null) => {
    register(footer => ({ ...footer, empty: element }));
  }, [register]);
  return { dock, empty };
}

/* Keep the loaded app mounted so it can reconnect, poll the updater, and resume with its
   cached data. The startup screen is the only visible content while the update lasts. */
export function ServiceLayout({ starting = false, children }: { starting?: boolean; children: ReactNode }) {
  const view = useServiceView();
  const boot = starting || view?.place === 'boot';
  const [footer, setFooter] = useState(NO_FOOTER);
  return (
    <div className="app-layout">
      {!boot && <ServiceStrip footer={footer} />}
      <div className="app-screen" hidden={boot} inert={boot || view?.place === 'window'}>
        <ServiceFooter value={setFooter}>{children}</ServiceFooter>
      </div>
      {boot && <BootScreen message={view?.message} />}
      <VersionMark />
      {!boot && <ServiceWindow />}
    </div>
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
      </div>
    </div>
  );
}

/* Phones place the strip above the department's footer, whose controls and text can wrap. */
function useDockRoom({ dock, empty }: DepartmentFooter, shown: boolean): number {
  const [room, setRoom] = useState(0);
  useLayoutEffect(() => {
    if (!shown || !dock) return;
    const update = () => {
      const top = Math.min(dock.getBoundingClientRect().top, empty?.getBoundingClientRect().top ?? Infinity);
      setRoom(Math.max(0, window.innerHeight - top));
    };
    update();
    window.addEventListener('resize', update);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(dock);
    if (empty) observer?.observe(empty);
    if (dock.parentElement) observer?.observe(dock.parentElement);
    return () => {
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [dock, empty, shown]);
  return room;
}

/* Once dismissed, the current message stays in a strip out of the page flow. An area
   showing the loader already has the line in place, so the strip is hidden. */
export function ServiceStrip({ footer = NO_FOOTER }: { footer?: DepartmentFooter }) {
  const view = useServiceView();
  const room = useDockRoom(footer, view?.place === 'strip' && !view.loader);
  if (view?.place !== 'strip' || view.loader) return null;
  const style = footer.dock ? { '--svc-department-dock-room': `${room}px` } as CSSProperties : undefined;
  return (
    <div className="svc-strip glass" role="status" aria-live="polite" style={style}>
      <LogoMark className="svc-mark" />
      <Line message={view.message} />
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

/* A loaded page area with nothing cached uses the same loader inside its own room. */
export function ServiceLoader({ live = true }: { live?: boolean }) {
  const view = useServiceView();
  const message = view?.place === 'strip' ? view.message : undefined;
  const shown = message !== undefined;
  useLayoutEffect(() => (shown ? service.holdLoader() : undefined), [shown]);
  return message ? <BootScreen message={message} live={live} inline /> : null;
}

function BootScreen({ message, live = true, inline = false }: { message?: ServiceMessage; live?: boolean; inline?: boolean }) {
  const t = useT();
  const updating = message?.kind === 'updating';
  const word = message?.line ?? t.boot.loading;
  const label = updating || !message ? `${word}…` : word;
  return (
    <>
      <style>{BOOT_STYLE}</style>
      <section className={inline ? 'boot-screen svc-loader' : 'boot-screen'} role={live ? 'status' : undefined} aria-live={live ? 'polite' : undefined}>
        <LogoMark className="boot-mark" />
        <p className="boot-line" lang={message && message.kind !== 'notice' ? 'en' : undefined}>
          <span className="boot-label">{label}</span>
          <span className="boot-word" aria-hidden="true" data-word={word} />
          <span className="boot-dots" aria-hidden="true"><i /><i /><i /></span>
        </p>
      </section>
    </>
  );
}
