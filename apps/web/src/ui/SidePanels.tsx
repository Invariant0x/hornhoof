import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { useT } from '../i18n';
import { takeEscape } from './escape';
import { guardedResizeObserver } from '../guard';
import { useScrollbarRoom } from './scrollbar-room';

/* The panels that slide out of an agent's window, all alike. They stand in a row left of the window, in the order they were
   opened, and the terminal never moves for them. A row the free space cannot hold reaches over the window as far as it must;
   theme.css reckons that place, under .side-panels. A panel closes with its button or Escape, the newest first, and the focus
   goes back to what opened it. A new panel is one line, framedPanel(id, label, icon, content), in the window's list. */
export type SidePanel = { id: string; render(close: () => void): ReactNode };
/* One the window's bar opens with its icon. */
export type WindowPanel = SidePanel & { label: string; icon: string; count?: { n: number; label: string } };

type Opened = { id: string; back: HTMLElement | null };

const TEXT_FIELD = 'textarea, input:not([type="checkbox"], [type="radio"])';

/* What someone is writing in a panel: Escape leaves the field first, so a slip of the hand does not throw the text away. */
function draftIn(row: HTMLElement | null, target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement) || !row?.contains(target) || !target.matches(TEXT_FIELD)) return null;
  return (target as HTMLInputElement | HTMLTextAreaElement).value ? target : null;
}

/* Focus in the window, or nowhere: nothing else on the page is the one Escape is for. */
function focusIn(box: HTMLElement | null): boolean {
  const at = document.activeElement;
  return !at || at === document.body || !!box?.contains(at);
}

function restorePanelFocus(back: HTMLElement | null | undefined, box: HTMLElement | null): void {
  (back?.isConnected ? back : box)?.focus();
}

function takePanelEscape(e: KeyboardEvent, row: HTMLElement | null, close: () => void): void {
  if (!takeEscape(e)) return;
  /* Neither the terminal nor the window may hear it: there Escape stops the agent's work. */
  e.stopPropagation();
  const draft = draftIn(row, e.target);
  if (draft) draft.blur();
  else close();
}

/* box: the window, for the focus and for Escape. active: false while the window is hidden, and Escape is none of its business. */
export function useSidePanels(panels: SidePanel[], box: RefObject<HTMLElement | null>, active: boolean) {
  const [opened, setOpened] = useState<Opened[]>([]);
  const row = useRef<HTMLDivElement>(null);
  const shown = opened.flatMap(o => panels.filter(p => p.id === o.id));
  const isOpen = (id: string) => shown.some(p => p.id === id);
  const close = useCallback(
    (id: string) => {
      const back = opened.find(o => o.id === id)?.back;
      setOpened(list => list.filter(o => o.id !== id));
      restorePanelFocus(back, box.current);
    },
    [opened, box],
  );
  /* Opens it, or brings it to the end of the row with the focus going back to this opener. */
  const open = (id: string, opener: HTMLElement | null) => setOpened(list => [...list.filter(o => o.id !== id), { id, back: opener }]);
  const toggle = (id: string, opener: HTMLElement | null) => {
    if (isOpen(id)) close(id);
    else open(id, opener);
  };
  const newest = shown.at(-1)?.id;

  useEffect(() => {
    if (!active || !newest) return;
    const take = (e: KeyboardEvent) => takePanelEscape(e, row.current, () => close(newest));
    const beforeTerminal = (e: KeyboardEvent) => {
      if (focusIn(box.current)) take(e);
    };
    /* Overlays elsewhere on the page have the focus, and take theirs first; what none took comes back here. */
    document.addEventListener('keydown', beforeTerminal, true);
    document.addEventListener('keydown', take);
    return () => {
      document.removeEventListener('keydown', beforeTerminal, true);
      document.removeEventListener('keydown', take);
    };
  }, [active, newest, close, box]);

  return { shown, isOpen, open, toggle, close, row };
}

/* The row reaches over what stands under it, or that has made way for it altogether. */
function liesOver(row: HTMLElement, under: HTMLElement): boolean {
  const { left, width } = under.getBoundingClientRect();
  return width === 0 || row.getBoundingClientRect().right > left;
}

/* Whether open panels keep the person from seeing what the window shows: only then is there something to go back to. theme.css
   reckons the place of the row, so this asks the page, whenever the row, the window or the screen changes size. */
export function usePanelsCover(row: RefObject<HTMLElement | null>, under: RefObject<HTMLElement | null>, open: boolean): boolean {
  const [covered, setCovered] = useState(false);
  useLayoutEffect(() => {
    const [panels, shown] = [row.current, under.current];
    if (!open || !panels || !shown) return;
    const measure = () => setCovered(liesOver(panels, shown));
    measure();
    window.addEventListener('resize', measure);
    const resized = typeof ResizeObserver === 'undefined' ? null : guardedResizeObserver(measure, 'side-panels');
    resized?.observe(panels);
    resized?.observe(shown);
    return () => {
      window.removeEventListener('resize', measure);
      resized?.disconnect();
    };
  }, [open, row, under]);
  return open && covered;
}

export function SidePanelRow({ stack, id }: { stack: ReturnType<typeof useSidePanels>; id: string }) {
  const count = stack.shown.length;
  const { row } = stack;
  /* Where they only fit one at a time, the newest is the one to see. */
  useLayoutEffect(() => {
    if (row.current) row.current.scrollLeft = row.current.scrollWidth;
  }, [count, row]);
  return (
    <div ref={row} id={id} className="side-panels" style={{ '--panels': count } as CSSProperties}>
      {stack.shown.map(panel => (
        <div key={panel.id} className="side-panel">
          {panel.render(() => stack.close(panel.id))}
        </div>
      ))}
    </div>
  );
}

/* A panel's frame: its name, the button that closes it, and a body that scrolls, which gives its words the same width in every
   browser. heading: what its bar says, when not its name. kind: a class that styles what this panel holds. */
export function PanelFrame({ label, heading = label, busy, kind, onClose, children }: { label?: string; heading?: string; busy?: boolean; kind?: string; onClose(): void; children: ReactNode }) {
  const t = useT();
  const body = useRef<HTMLDivElement>(null);
  useScrollbarRoom(body);
  return (
    <aside className={kind ? `acard ${kind}` : 'acard'} aria-label={label} aria-busy={busy}>
      <div className="t-bar">
        <span className="lights" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span>{heading}</span>
        <button type="button" aria-label={t.window.close} onClick={onClose}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div ref={body} className="ac-body">{children}</div>
    </aside>
  );
}

/* A panel that brings only its content. */
export const framedPanel = (id: string, label: string, icon: string, content: ReactNode): WindowPanel => ({
  id,
  label,
  icon,
  render: close => (
    <PanelFrame label={label} onClose={close}>
      {content}
    </PanelFrame>
  ),
});
