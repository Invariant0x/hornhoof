import { useLayoutEffect, type RefObject } from 'react';

/* What this browser's scrollbar takes beside a box that scrolls, set on the box as --sb, so its stylesheet keeps the
   same 18 px of room at its end in every browser: a classic scrollbar fills part of that room, an overlay one none. The
   box's own borders are not the scrollbar's. Measured once, as the window opens. */
export function useScrollbarRoom(box: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const borders = (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
    element.style.setProperty('--sb', `${Math.max(0, element.offsetWidth - element.clientWidth - borders)}px`);
  }, [box]);
}
