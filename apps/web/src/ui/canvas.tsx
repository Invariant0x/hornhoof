import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { useT } from '../i18n';

/* A press that moves further than this drags the canvas instead of clicking. */
export const DRAG_PX = 4;
export const CANVAS_ZOOM_LIMITS = { min: .3, max: 2.5 };
export const CANVAS_NARROW = 760;
export const LEFT_PANEL_COVER = 432;

export function canvasSpace(width: number, left: number, right: number): { left: number; width: number } {
  return width <= CANVAS_NARROW ? { left: 0, width } : { left, width: width - left - right };
}

/* smooth: the change came from Fit and glides, flies into a department, or follows the bars of the shell as one comes or goes
   (shift, in the shell's time); drag and zoom follow the hand at once. */
export type View = { x: number; y: number; k: number; smooth: boolean | 'fly' | 'shift' };

/* Whether two views stand in the same place, to the half pixel. */
export const sameView = (a: Pick<View, 'x' | 'y' | 'k'>, b: Pick<View, 'x' | 'y' | 'k'>) =>
  Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.k - b.k) < 1e-4;

/* Where the room under the bars of the shell starts: least down from the top, or under the last bar while one stands lower
   (#1639). */
export const underShell = (least: number, shellTop: number | null) => Math.max(least, shellTop ?? 0);

const GLIDE = 'transform .8s cubic-bezier(.3,.7,.2,1)';
/* How the world goes to its view: at once while still, as for less motion, or when not asked to glide; in the shell's time
   after a bar of the shell came or went (#1635); flying into a department, as fly says; else with Fit's glide. */
export function worldTransition(smooth: View['smooth'], still: boolean, fly = GLIDE): string {
  if (still || !smooth) return 'none';
  if (smooth === 'shift') return 'transform var(--shell-shift) ease-out';
  return smooth === 'fly' ? fly : GLIDE;
}

/* The move of a fit from the view now to next: none where it already stands or glides there, so a second look as a resize is
   watched again keeps the move going; in the shell's time when a bar of the shell came or went since the last fit, as
   shellTop says (#1635); else Fit's glide. */
export function useFitMove(shellTop: number | null): (now: View, next: Omit<View, 'smooth'>) => View | null {
  const lastTop = useRef<number | null | undefined>(undefined);
  return useCallback((now: View, next: Omit<View, 'smooth'>) => {
    const shift = lastTop.current !== undefined && lastTop.current !== shellTop;
    lastTop.current = shellTop;
    return sameView(now, next) ? null : { ...next, smooth: shift ? 'shift' : true };
  }, [shellTop]);
}

/* A box from its top left to its bottom right corner. */
export type Box = { x0: number; y0: number; x1: number; y1: number };
/* What a canvas scrolls: its content, in the world's pixels, and the room of the canvas that what floats over it leaves free,
   in the canvas's own. */
export type Edges = { content: Box; room: Box };

/* How far floating bars and the sides of the screen keep a canvas's content from them. */
export const FLOAT_GAP = 8, SIDE_GAP = 16;

/* The room of a canvas that its floating bars leave free, in its own pixels: from the bars along its top to those along its
   bottom, FLOAT_GAP clear of each, and SIDE_GAP in from the sides of its space. A bar belongs to the half of the canvas its
   middle stands in. least: the room kept at the top, the bottom and each side whatever the bars are, as for the screen's own
   bar, which floats over the top of the canvas from outside it, and the room kept from the canvas's own top and bottom edges,
   FLOAT_GAP unless the canvas is already cut that far clear of its bars. */
export function freeRoom(canvas: HTMLElement, bars: Iterable<Element>, space: { left: number; width: number }, least: { top?: number; bottom?: number; side?: number; edge?: number } = {}): Box {
  const at = canvas.getBoundingClientRect(), h = canvas.clientHeight, side = least.side ?? SIDE_GAP, edge = least.edge ?? FLOAT_GAP;
  let y0 = Math.max(edge, least.top ?? 0), y1 = h - Math.max(edge, least.bottom ?? 0);
  for (const bar of bars) {
    const r = bar.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if ((r.top + r.bottom) / 2 - at.top < h / 2) y0 = Math.max(y0, r.bottom - at.top + FLOAT_GAP);
    else y1 = Math.min(y1, r.top - at.top - FLOAT_GAP);
  }
  return { x0: space.left + side, x1: space.left + space.width - side, y0, y1: Math.max(y0, y1) };
}

/* Where a view may stand along one side: content from c0 to c1 drawn at scale k in a room from r0 to r1. Content larger than
   the room scrolls until each of its edges meets the room's, no further; smaller content moves only inside the room. */
export function scrollRange(c0: number, c1: number, k: number, r0: number, r1: number): [number, number] {
  const start = r0 - c0 * k, end = r1 - c1 * k;
  return start <= end ? [start, end] : [end, start];
}

/* The view a drag or a zoom asks for, kept to the edges of its content: next as asked, as far as it stays in range. A view
   that already stood beyond an edge, as one put there by Fit or kept from an older visit may, may stay as far beyond it, never
   further, so the hand never makes it jump. */
export function keptToEdges(was: View, next: View, { content: c, room: r }: Edges): View {
  const side = (v: number, w: number, c0: number, c1: number, r0: number, r1: number) => {
    const [lo, hi] = scrollRange(c0, c1, next.k, r0, r1), [wasLo, wasHi] = scrollRange(c0, c1, was.k, r0, r1);
    return Math.min(Math.max(v, lo - Math.max(0, wasLo - w)), hi + Math.max(0, w - wasHi));
  };
  return { ...next, x: side(next.x, was.x, c.x0, c.x1, r.x0, r.x1), y: side(next.y, was.y, c.y0, c.y1, r.y0, r.y1) };
}

/* Dragging and zooming a world inside box. ready changes once box is on the page, so the wheel finds it. start: the view it
   opens at. touched tells whether the person has dragged or zoomed it since. edges: what the world scrolls, when it has edges
   the hand stops at; Fit and the code's own views are not stopped. */
export function usePanZoom(box: RefObject<HTMLDivElement | null>, ready: unknown, limits: { min: number; max: number }, start?: View, edges?: () => Edges | null) {
  const [view, setView] = useState<View>(start ?? { x: 0, y: 0, k: 1, smooth: false });
  const edgesOf = useRef(edges);
  useEffect(() => {
    edgesOf.current = edges;
  });
  const handTo = useCallback((was: View, next: View) => {
    const e = edgesOf.current?.();
    return e ? keptToEdges(was, next, e) : next;
  }, []);
  const drag = useRef<{ id: number; x: number; y: number; moved: number } | null>(null);
  const byHand = useRef(false);
  /* How far the last press moved, so the click that ends a drag opens nothing. */
  const lastMoved = useRef(0);
  const { min, max } = limits;

  const zoomAt = useCallback(
    (factor: number, px?: number, py?: number) => {
      const el = box.current;
      byHand.current = true;
      setView(v => {
        const k = Math.min(max, Math.max(min, v.k * factor));
        const cx = px ?? (el ? el.clientWidth / 2 : 0);
        const cy = py ?? (el ? el.clientHeight / 2 : 0);
        return handTo(v, { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k, smooth: false });
      });
    },
    [box, min, max, handTo],
  );

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [box, zoomAt, ready]);

  /* The canvas takes the pointer only once a press moves, so a press on a card still clicks it. */
  const handlers = {
    onPointerDown(e: ReactPointerEvent) {
      if (e.button !== 0) return;
      drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 };
    },
    onPointerMove(e: ReactPointerEvent) {
      const d = drag.current;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      const moved = d.moved + Math.abs(dx) + Math.abs(dy);
      if (d.moved <= DRAG_PX && moved > DRAG_PX) e.currentTarget.setPointerCapture?.(e.pointerId);
      drag.current = { ...d, x: e.clientX, y: e.clientY, moved };
      if (dx || dy) byHand.current = true;
      setView(v => handTo(v, { ...v, x: v.x + dx, y: v.y + dy, smooth: false }));
    },
    onPointerUp() {
      lastMoved.current = drag.current?.moved ?? 0;
      drag.current = null;
    },
    onPointerCancel() {
      lastMoved.current = drag.current?.moved ?? 0;
      drag.current = null;
    },
  };

  const dragged = useCallback(() => lastMoved.current > DRAG_PX, []);
  const touched = useCallback(() => byHand.current, []);
  return { view, setView, zoomAt, handlers, dragged, touched };
}

/* Zoom out, the scale, zoom in and Fit, bottom left. */
export function ZoomBar({ k, onZoom, onFit, step = 1.2 }: { step?: number; k: number; onZoom(factor: number): void; onFit(): void }) {
  const t = useT();
  return (
    <div className="zoom glass" onPointerDown={e => e.stopPropagation()}>
      <button className="zbtn" type="button" aria-label={t.map.zoomOut} onClick={() => onZoom(1 / step)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg>
      </button>
      <span className="zv">{Math.round(k * 100)}%</span>
      <button className="zbtn" type="button" aria-label={t.map.zoomIn} onClick={() => onZoom(step)}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      <button className="zbtn" type="button" aria-label={t.map.showAll} onClick={onFit}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
      </button>
    </div>
  );
}
