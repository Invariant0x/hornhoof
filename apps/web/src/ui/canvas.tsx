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

/* smooth: the change came from Fit and glides, or flies into a department; drag and zoom follow the hand at once. */
export type View = { x: number; y: number; k: number; smooth: boolean | 'fly' };

/* Dragging and zooming a world inside box. ready changes once box is on the page, so the wheel finds it. */
export function usePanZoom(box: RefObject<HTMLDivElement | null>, ready: unknown, limits: { min: number; max: number }) {
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1, smooth: false });
  const drag = useRef<{ id: number; x: number; y: number; moved: number } | null>(null);
  /* How far the last press moved, so the click that ends a drag opens nothing. */
  const lastMoved = useRef(0);
  const { min, max } = limits;

  const zoomAt = useCallback(
    (factor: number, px?: number, py?: number) => {
      const el = box.current;
      setView(v => {
        const k = Math.min(max, Math.max(min, v.k * factor));
        const cx = px ?? (el ? el.clientWidth / 2 : 0);
        const cy = py ?? (el ? el.clientHeight / 2 : 0);
        return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k, smooth: false };
      });
    },
    [box, min, max],
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
      setView(v => ({ ...v, x: v.x + dx, y: v.y + dy, smooth: false }));
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
  return { view, setView, zoomAt, handlers, dragged };
}

/* Zoom out, the scale, zoom in and Fit, bottom left as in the prototype. */
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
