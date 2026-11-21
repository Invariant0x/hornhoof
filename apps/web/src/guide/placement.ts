export type Rect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

export type ViewportBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type PlacementInput = {
  anchor: Rect;
  frame: Rect;
  viewport: ViewportBox;
  card: { width: number; height: number };
  dir: 'ltr' | 'rtl';
  safeTop: number;
  coachFocused: boolean;
};

export type PlacementResult = {
  mode: 'floating' | 'inline';
  hidden: boolean;
  side: 'end' | 'start' | 'inline';
  left: number;
  top: number;
};

const MOBILE_MAX = 760;
const NARROW_PANEL_MIN = 320;
const GUTTER = 12;
const MARGIN = 8;
const DESCRIBED_ID = 'guide-coach-text';

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, Math.max(low, high)));
}

function candidateLeft(frame: Rect, cardWidth: number, side: 'end' | 'start', dir: 'ltr' | 'rtl'): number {
  const onRight = (dir === 'ltr' && side === 'end') || (dir === 'rtl' && side === 'start');
  return onRight ? frame.right + GUTTER : frame.left - GUTTER - cardWidth;
}

function fitsHorizontally(left: number, cardWidth: number, viewport: ViewportBox): boolean {
  return left >= viewport.left + MARGIN && left + cardWidth <= viewport.left + viewport.width - MARGIN;
}

/* Computes floating inline-end -> inline-start -> inline fallback placement with RTL mirroring and safe bounds. */
export function computeCoachPlacement(input: PlacementInput): PlacementResult {
  const { anchor, frame, viewport, card, dir, safeTop, coachFocused } = input;
  const viewBottom = viewport.top + viewport.height;
  const isNarrowPanel = frame !== anchor && frame.width < NARROW_PANEL_MIN;
  const unmeasured = anchor.width === 0 && anchor.height === 0;

  if (viewport.width <= MOBILE_MAX || isNarrowPanel || unmeasured) {
    return { mode: 'inline', hidden: false, side: 'inline', left: 0, top: 0 };
  }

  const outOfView = anchor.bottom < safeTop || anchor.top > viewBottom - MARGIN;
  if (outOfView && !coachFocused) {
    return { mode: 'floating', hidden: true, side: 'end', left: 0, top: 0 };
  }

  if (card.height + MARGIN * 2 > viewBottom - safeTop) {
    return { mode: 'inline', hidden: false, side: 'inline', left: 0, top: 0 };
  }

  for (const side of ['end', 'start'] as const) {
    const left = candidateLeft(frame, card.width, side, dir);
    if (fitsHorizontally(left, card.width, viewport)) {
      const top = clamp(anchor.top, safeTop, viewBottom - card.height - MARGIN);
      return { mode: 'floating', hidden: false, side, left, top };
    }
  }

  return { mode: 'inline', hidden: false, side: 'inline', left: 0, top: 0 };
}

function escapeAttr(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
}

/* Finds the first visible matching data-guide-anchor element in priority order. */
export function findGuideAnchor(anchors: readonly string[]): HTMLElement | null {
  for (const id of anchors) {
    const nodes = document.querySelectorAll<HTMLElement>(`[data-guide-anchor="${escapeAttr(id)}"]`);
    for (const node of nodes) {
      if (!node.hidden && node.getAttribute('aria-hidden') !== 'true') return node;
    }
  }
  return null;
}

/* Finds the focusable / labelled real control inside or on an anchor element. */
export function focusTargetOf(anchor: HTMLElement): HTMLElement {
  if (anchor.matches('input, select, textarea, button, a, [tabindex]')) return anchor;
  return anchor.querySelector<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href]') ?? anchor;
}

function updateDescribedBy(el: HTMLElement, token: string, present: boolean): void {
  const tokens = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(id => id && id !== token);
  const next = present ? [...tokens, token] : tokens;
  if (next.length) el.setAttribute('aria-describedby', next.join(' '));
  else el.removeAttribute('aria-describedby');
}

/* Applies highlight and non-destructively merges guide-coach-text into aria-describedby; returns cleanup callback. */
export function attachAnchorDecoration(anchor: HTMLElement): () => void {
  const target = focusTargetOf(anchor);
  const visual = (anchor.matches('fieldset.choice') ? anchor.querySelector<HTMLElement>('label.on') : null) ?? anchor;
  visual.classList.add('guide-highlight');
  updateDescribedBy(target, DESCRIBED_ID, true);
  return () => {
    visual.classList.remove('guide-highlight');
    updateDescribedBy(target, DESCRIBED_ID, false);
  };
}

export function readSafeTop(): number {
  const shell = document.querySelector<HTMLElement>('.shell');
  const raw = shell ? getComputedStyle(shell).getPropertyValue('--shell-top') : '';
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed + MARGIN : MARGIN;
}

export function hasBlockingOverlay(): boolean {
  return Boolean(
    document.querySelector('dialog[open], [role="dialog"][aria-modal="true"], .dialog-back, .mv-back, .signin-panel, .xterm'),
  );
}
