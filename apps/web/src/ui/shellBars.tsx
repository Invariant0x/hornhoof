import { createContext, useContext, useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { guardedResizeObserver } from '../guard';
import { FLOAT_GAP } from './canvas';
import { useT } from '../i18n';

/* The bars of the shell, each in its own row under the header: an update, the recovery file, a load that failed and a block
   that stopped. A stopped window floats on its own and is none of them. */
export const SHELL_BARS = ':scope > :is(.update-banner, .alert, .guard-stop:not(.float))';

/* On the map the canvas and an open department fill the window from its top, and the header and the bars of the shell float
   over them (#1639). What they show starts here, from the top of the page: FLOAT_GAP under the last bar on every screen,
   however far apart the bars stand (#1635). While no bar stands it is null, and each keeps its own room under the header. */
export const ShellTop = createContext<number | null>(null);
export const useShellTop = (): number | null => useContext(ShellTop);

/* Where the room under the bars of the page starts, or null while none shows. */
export function shellTopOf(page: HTMLElement): number | null {
  const at = page.getBoundingClientRect().top;
  let end: number | null = null;
  for (const bar of page.querySelectorAll(SHELL_BARS)) {
    const r = bar.getBoundingClientRect();
    if (!r.height) continue;
    end = Math.max(end ?? 0, r.bottom - at + FLOAT_GAP);
  }
  return end === null ? null : Math.ceil(end);
}

/* Where what the map and an open department show starts while no bar stands: FLOAT_GAP under the menu's blocks, 44 px tall
   and 12 px from the top (--under-menu). */
export const UNDER_MENU = 12 + 44 + FLOAT_GAP;

/* On a phone every bar after the first folds to one line with More, which opens it whole (#1635). More stays hidden on a wide
   screen and on the first bar: theme.css shows it where it folds the bar. className: the bar's, open once the person opened
   it. */
export function useBarFold(): { className: string; more: ReactNode } {
  const t = useT();
  const [open, setOpen] = useState(false);
  const more = open ? null : <button className="btn small ghost bar-more" type="button" hidden aria-expanded="false" onClick={() => setOpen(true)}>{t.shell.barMore}</button>;
  return { className: `update-banner glass${open ? ' open' : ''}`, more };
}

/* What watches a page, or nothing where the browser has no such watcher. */
type Watcher = { observe(target: Element, options?: object): void; disconnect(): void };
const UNWATCHED: Watcher = { observe: () => {}, disconnect: () => {} };
const sizesOf = (changed: () => void): Watcher => (typeof ResizeObserver === 'undefined' ? UNWATCHED : guardedResizeObserver(changed, 'shell-bars'));
const rowsOf = (changed: () => void): Watcher => (typeof MutationObserver === 'undefined' ? UNWATCHED : new MutationObserver(changed));

/* Calls changed now, and again as a bar of the page comes, goes or grows with its words, and as the page changes size;
   gives back what stops it. */
function watchShellBars(page: HTMLElement, changed: () => void): () => void {
  const watched = new WeakSet<Element>();
  const look = () => {
    for (const bar of page.querySelectorAll(SHELL_BARS)) {
      if (watched.has(bar)) continue;
      watched.add(bar);
      sizes.observe(bar);
    }
    changed();
  };
  const sizes = sizesOf(look), rows = rowsOf(look);
  look();
  sizes.observe(page);
  rows.observe(page, { childList: true });
  return () => {
    rows.disconnect();
    sizes.disconnect();
  };
}

/* The shell's own measure of it: again as a bar comes, goes or grows with its words, and as the window changes size. */
export function useMeasuredShellTop(page: RefObject<HTMLElement | null>): number | null {
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = page.current;
    if (!el) return;
    return watchShellBars(el, () => setTop(shellTopOf(el)));
  }, [page]);
  return top;
}
