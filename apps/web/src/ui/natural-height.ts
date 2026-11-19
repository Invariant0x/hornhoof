import { useLayoutEffect, useState, type RefObject } from 'react';
import { guardedResizeObserver } from '../guard';

const px = (v: string) => parseFloat(v) || 0;

/* A box of a layout keeps its size until its words need more than a pixel beyond it, then takes what they need in whole
   pixels: words that fit keep every box where it always stood. */
export const grownTo = (base: number, need: number): number => (need > base + 1 ? Math.ceil(need) : base);

/* How tall each box needs to be for all it holds: its height is left to its content for a moment, read in the layout's own
   pixels so a zoom or any other transform changes nothing, and given back before anything is drawn. All boxes are let go
   at once and read after, so the page is laid out once however many there are. */
export function naturalHeights(boxes: HTMLElement[]): number[] {
  const set = boxes.map(box => box.style.height);
  for (const box of boxes) box.style.height = 'auto';
  const heights = boxes.map(box => {
    const style = getComputedStyle(box);
    const frame = style.boxSizing === 'border-box' ? 0 : px(style.paddingTop) + px(style.paddingBottom) + px(style.borderTopWidth) + px(style.borderBottomWidth);
    return px(style.height) + frame;
  });
  boxes.forEach((box, i) => {
    box.style.height = set[i]!;
  });
  return heights;
}

/* The height the box with the most words needs, to a tenth of a pixel, among the boxes the selector finds in the root; 0
   before it is measured or where nothing measures. It is measured again only when something it watches changes its size,
   as words, the language, the fonts and the skin do, and never for a drag, a zoom or a box's own new height. words: what
   the boxes say, so what comes or goes with new words is watched from then on. */
export function useNaturalHeight(root: RefObject<HTMLElement | null>, boxes: string, watch: string, words: string, block: string): number {
  const [most, setMost] = useState(0);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      /* A screen that is not drawn has nothing to measure, and keeps what it measured. */
      if (!el.getClientRects().length) return;
      const need = Math.round(Math.max(0, ...naturalHeights([...el.querySelectorAll<HTMLElement>(boxes)])) * 10) / 10;
      setMost(was => (was === need ? was : need));
    };
    const observer = guardedResizeObserver(measure, block);
    for (const part of el.querySelectorAll(watch)) observer.observe(part);
    return () => observer.disconnect();
  }, [root, boxes, watch, words, block]);
  return most;
}
