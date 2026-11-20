import { createContext, useContext, useLayoutEffect, useState, type RefObject } from 'react';
import { guardedResizeObserver } from '../guard';

/* The bars of the shell, each in its own row under the header: an update, the recovery file, a load that failed and a block
   that stopped. A stopped window floats on its own and is none of them. */
export const SHELL_BARS = ':scope > :is(.update-banner, .alert, .guard-stop:not(.float))';

/* On the map the canvas and an open department fill the window from its top, and the header and the bars of the shell float
   over them (#1639). What they show starts here, from the top of the page: under the last bar and the gap after it. While no
   bar stands it is null, and each keeps its own room under the header. */
export const ShellTop = createContext<number | null>(null);
export const useShellTop = (): number | null => useContext(ShellTop);

/* Where the room under the bars of the page starts, or null while none shows. */
export function shellTopOf(page: HTMLElement): number | null {
  const at = page.getBoundingClientRect().top;
  let end: number | null = null;
  for (const bar of page.querySelectorAll(SHELL_BARS)) {
    const r = bar.getBoundingClientRect();
    if (!r.height) continue;
    end = Math.max(end ?? 0, r.bottom - at + (parseFloat(getComputedStyle(bar).marginBlockEnd) || 0));
  }
  return end === null ? null : Math.ceil(end);
}

/* The shell's own measure of it: again as a bar comes, goes or grows with its words, and as the window changes size. */
export function useMeasuredShellTop(page: RefObject<HTMLElement | null>): number | null {
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = page.current;
    if (!el) return;
    const watched = new WeakSet<Element>();
    let sizes: ResizeObserver | null = null;
    const measure = () => {
      for (const bar of el.querySelectorAll(SHELL_BARS)) {
        if (watched.has(bar)) continue;
        watched.add(bar);
        sizes?.observe(bar);
      }
      const next = shellTopOf(el);
      setTop(was => (was === next ? was : next));
    };
    sizes = typeof ResizeObserver === 'undefined' ? null : guardedResizeObserver(measure, 'shell-bars');
    measure();
    sizes?.observe(el);
    const rows = typeof MutationObserver === 'undefined' ? null : new MutationObserver(measure);
    rows?.observe(el, { childList: true });
    return () => {
      rows?.disconnect();
      sizes?.disconnect();
    };
  }, [page]);
  return top;
}
