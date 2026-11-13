import { render, waitFor } from '@testing-library/react';
import type { Terminal } from '@xterm/xterm';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { AgentTerminal } from '../src/ui/AgentTerminal';
import {
  fitTerminal,
  fitTerminalDimensions,
  measureGlyphsExactly,
  measureTerminalFit,
  observeTerminalFit,
} from '../src/ui/terminal-fit';

/* Stand-in xterm Terminal with real _core layout fields so both legacy FitAddon and fitTerminal can measure it. */
const MeasuredTerminal = vi.hoisted(() => class MeasuredTerminalImpl {
  static all: MeasuredTerminalImpl[] = [];
  options: Record<string, unknown>;
  cols = 80;
  rows = 24;
  element: HTMLElement | undefined = document.createElement('div');
  viewport = document.createElement('div');
  scrollArea = document.createElement('div');
  buffer = { active: { viewportY: 0, baseY: 0, cursorY: 0, getLine: () => ({ isWrapped: false }) } };
  private onSize: ((s: { cols: number; rows: number }) => void)[] = [];
  clearCalls = 0;

  _core = {
    buffers: { active: { hasScrollback: false, ybase: 0, ydisp: 0 }, normal: { hasScrollback: false, ybase: 0, ydisp: 0 }, alt: { hasScrollback: false, ybase: 0, ydisp: 0 } },
    _selectionService: { shouldForceSelection: () => false, enable() {} },
    coreMouseService: { _protocols: {}, onProtocolChange: () => ({ dispose() {} }) },
    viewport: { scrollBarWidth: 15 },
    _coreBrowserService: { dpr: 1 },
    _charSizeService: { width: 7.201171875, height: 14 },
    _renderService: {
      /* At initial 80 cols, DomRenderer rounds 80 * 7.201171875 = 576.09 down to 576 -> 7.200 per cell. */
      dimensions: { css: { canvas: { width: 576, height: 336 }, cell: { width: 7.2, height: 14 } } },
      clear: () => {
        this.clearCalls++;
      },
    },
  };

  constructor(options: Record<string, unknown>) {
    this.options = options;
    this.element!.className = 'xterm';
    this.element!.style.padding = '6px 8px 4px 10px';
    this.viewport.className = 'xterm-viewport';
    this.scrollArea.className = 'xterm-scroll-area';
    this.viewport.appendChild(this.scrollArea);
    this.element!.appendChild(this.viewport);
    MeasuredTerminalImpl.all.push(this);
  }

  loadAddon(addon: { activate(term: unknown): void }) {
    addon.activate(this);
  }

  open(parent: HTMLElement) {
    if (this.element) parent.appendChild(this.element);
  }

  focus() {}
  reset() {}
  write() {}
  hasSelection() {
    return false;
  }
  getSelection() {
    return '';
  }
  onSelectionChange() {
    return { dispose() {} };
  }
  attachCustomKeyEventHandler() {}
  attachCustomWheelEventHandler() {}
  scrollLines() {}
  refresh() {}
  onData() {}
  onResize(fn: (s: { cols: number; rows: number }) => void) {
    this.onSize.push(fn);
  }
  scrollToBottom() {}
  scrollToLine() {}
  registerMarker() {
    return { line: 0, isDisposed: false, dispose() {} };
  }
  dispose() {}

  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    const cellW = this._core._charSizeService.width || this._core._renderService.dimensions.css.cell.width;
    const cellH = this._core._charSizeService.height || this._core._renderService.dimensions.css.cell.height;
    const width = Math.round(cols * cellW);
    const height = Math.round(rows * cellH);
    this._core._renderService.dimensions.css.canvas = { width, height };
    this._core._renderService.dimensions.css.cell = { width: width / cols, height: height / rows };
    for (const fn of this.onSize) fn({ cols, rows });
  }
});

vi.mock('@xterm/xterm', () => ({
  Terminal: MeasuredTerminal,
}));

class ObservedResize {
  static all: ObservedResize[] = [];
  targets: Element[] = [];
  constructor(private readonly fn: () => void) {
    ObservedResize.all.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  disconnect() {
    this.targets = [];
  }
  triggerFor(target: Element) {
    if (this.targets.includes(target)) this.fn();
  }
}

class CapturedSocket {
  static all: CapturedSocket[] = [];
  readyState = 1;
  sent: unknown[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(public readonly url: string) {
    CapturedSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
}

function setRect(el: HTMLElement, width: number, height: number) {
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  el.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}),
  });
}

beforeEach(() => {
  MeasuredTerminal.all = [];
  ObservedResize.all = [];
  CapturedSocket.all = [];
  vi.stubGlobal('ResizeObserver', ObservedResize);
  vi.stubGlobal('WebSocket', CapturedSocket);
});

describe('fitTerminalDimensions pure calculation', () => {
  const padding = { top: 6, right: 8, bottom: 4, left: 10 };

  it('computes exact visible columns on narrow (375px), regular (978px) and wide (1440px) windows with and without a scrollbar', () => {
    /* Narrow 375px mobile window:
       With 15px scrollbar: 375 - (10 + 8) - 15 = 342px; 342 / 7.201171875 = 47.49 -> 47 cols.
       Without scrollbar (scrollback = 0): 375 - 18 = 357px; 357 / 7.201171875 = 49.57 -> 49 cols. */
    expect(fitTerminalDimensions({
      containerWidth: 375, containerHeight: 500, padding, scrollbarWidth: 15, cellWidth: 7.201171875, cellHeight: 14,
    })).toEqual({ cols: 47, rows: 35 });
    expect(fitTerminalDimensions({
      containerWidth: 375, containerHeight: 500, padding, scrollbarWidth: 0, cellWidth: 7.201171875, cellHeight: 14,
    })).toEqual({ cols: 49, rows: 35 });

    /* Regular 978px desktop terminal window (980px .orch.term minus 2px border):
       With 15px scrollbar: 978 - 18 - 15 = 945px; 945 / 7.201171875 = 131.22 -> 131 cols.
       Without scrollbar: 978 - 18 = 960px; 960 / 7.201171875 = 133.31 -> 133 cols. */
    expect(fitTerminalDimensions({
      containerWidth: 978, containerHeight: 710, padding, scrollbarWidth: 15, cellWidth: 7.201171875, cellHeight: 14,
    })).toEqual({ cols: 131, rows: 50 });
    expect(fitTerminalDimensions({
      containerWidth: 978, containerHeight: 710, padding, scrollbarWidth: 0, cellWidth: 7.201171875, cellHeight: 14,
    })).toEqual({ cols: 133, rows: 50 });

    /* Wide 1440px fullscreen window:
       With 15px scrollbar: 1440 - 18 - 15 = 1407px; 1407 / 7.201171875 = 195.38 -> 195 cols.
       Without scrollbar: 1440 - 18 = 1422px; 1422 / 7.201171875 = 197.46 -> 197 cols. */
    expect(fitTerminalDimensions({
      containerWidth: 1440, containerHeight: 860, padding, scrollbarWidth: 15, cellWidth: 7.201171875, cellHeight: 14,
    })).toEqual({ cols: 195, rows: 60 });
    expect(fitTerminalDimensions({
      containerWidth: 1440, containerHeight: 860, padding, scrollbarWidth: 0, cellWidth: 7.201171875, cellHeight: 14,
    })).toEqual({ cols: 197, rows: 60 });
  });

  it('never overestimates columns when fractional glyph width or DomRenderer canvas rounding crosses available width', () => {
    /* Available width = 753 - 18 - 15 = 720px.
       At 7.201171875px per glyph, 100 cols take 720.12px (> 720px), so only 99 cols fully fit. */
    expect(fitTerminalDimensions({
      containerWidth: 753, containerHeight: 430, padding, scrollbarWidth: 15, cellWidth: 7.201171875, cellHeight: 14,
    })).toEqual({ cols: 99, rows: 30 });

    /* Available width = 576.6px (609.6 - 18 - 15).
       80 * 7.207 = 576.56 <= 576.6, but DomRenderer rounds css.canvas.width to Math.round(576.56) = 577 > 576.6. */
    expect(fitTerminalDimensions({
      containerWidth: 609.6, containerHeight: 430, padding, scrollbarWidth: 15, cellWidth: 7.207, cellHeight: 14,
    })).toEqual({ cols: 79, rows: 30 });

    /* Fractional CSS paddings (10.5 + 8.5 = 19px, not truncated to 18px by parseInt). */
    expect(fitTerminalDimensions({
      containerWidth: 373.8,
      containerHeight: 300,
      padding: { top: 6.5, right: 8.5, bottom: 4.5, left: 10.5 },
      scrollbarWidth: 15,
      cellWidth: 6.8,
      cellHeight: 14,
    })).toEqual({ cols: 49, rows: 20 });
  });

  it('clamps tiny positive boxes to 2x1, ignores negative insets and returns null for hidden or invalid boxes', () => {
    expect(fitTerminalDimensions({
      containerWidth: 20, containerHeight: 8, padding: { top: -2, right: 8, bottom: 4, left: 10 }, scrollbarWidth: -5, cellWidth: 7.2, cellHeight: 14,
    })).toEqual({ cols: 2, rows: 1 });
    expect(fitTerminalDimensions({
      containerWidth: 0, containerHeight: 500, padding, scrollbarWidth: 15, cellWidth: 7.2, cellHeight: 14,
    })).toBeNull();
    expect(fitTerminalDimensions({
      containerWidth: 500, containerHeight: 0, padding, scrollbarWidth: 15, cellWidth: 7.2, cellHeight: 14,
    })).toBeNull();
    expect(fitTerminalDimensions({
      containerWidth: 500, containerHeight: 500, padding, scrollbarWidth: 15, cellWidth: 0, cellHeight: 14,
    })).toBeNull();
    expect(fitTerminalDimensions({
      containerWidth: 500, containerHeight: 500, padding, scrollbarWidth: 15, cellWidth: 7.2, cellHeight: Number.NaN,
    })).toBeNull();
  });
});

describe('measureTerminalFit, fitTerminal and observeTerminalFit DOM helpers', () => {
  it('measures live scrollbar width, letterSpacing, fallback cell dimensions and missing elements safely', () => {
    const box = document.createElement('div');
    document.body.appendChild(box);
    setRect(box, 500, 300);

    const unmounted = new MeasuredTerminal({ scrollback: 5000, letterSpacing: 1 });
    unmounted.element = undefined;
    expect(measureTerminalFit(unmounted as unknown as Terminal, box)).toBeNull();
    expect(fitTerminal(unmounted as unknown as Terminal, box)).toBeNull();

    const term = new MeasuredTerminal({ scrollback: 5000, letterSpacing: 1 });
    term.open(box);
    /* Thin resting scrollbar (8px) reserves 15px minimum gutter; scrollback 0 reserves 0px. */
    setRect(term.viewport, 500, 300);
    setRect(term.scrollArea, 492, 900);
    expect(measureTerminalFit(term as unknown as Terminal, box)?.scrollbarWidth).toBe(15);

    term.options.scrollback = 0;
    expect(measureTerminalFit(term as unknown as Terminal, box)?.scrollbarWidth).toBe(0);

    /* Fallback when _charSizeService.width is 0, css.cell.height is 0, padding is unset or viewport is absent. */
    term.options.scrollback = 5000;
    term.element!.style.padding = '';
    term._core._charSizeService.width = 0;
    term._core._renderService.dimensions.css.cell.height = 0;
    term.viewport.remove();
    const fallback = measureTerminalFit(term as unknown as Terminal, box)!;
    expect(fallback.scrollbarWidth).toBe(15);
    expect(fallback.cellWidth).toBe(7.2);
    expect(fallback.cellHeight).toBe(14);

    /* No resize call when size already matches; safe no-op when ResizeObserver is unavailable. */
    const fitted = fitTerminal(term as unknown as Terminal, box)!;
    const clearsAfterFirst = term.clearCalls;
    expect(fitTerminal(term as unknown as Terminal, box)).toEqual(fitted);
    expect(term.clearCalls).toBe(clearsAfterFirst);

    vi.stubGlobal('ResizeObserver', undefined);
    const stop = observeTerminalFit(term as unknown as Terminal, box, () => {});
    expect(() => stop()).not.toThrow();
    box.remove();
  });
});

/* What a browser lays out for copies of one glyph: a fractional width in 1/64 px, and offsetWidth rounded to whole pixels. */
function layOutGlyph(glyph: number): HTMLSpanElement {
  const span = document.createElement('span');
  const width = () => Math.round((span.textContent ?? '').length * glyph * 64) / 64;
  Object.defineProperty(span, 'offsetWidth', { get: () => Math.round(width()) });
  span.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: width(), bottom: 14, width: width(), height: 14, toJSON: () => ({}) });
  return span;
}

/* Stand-in for the DOM renderer of xterm 5.5: a cache of glyph widths measured on its own elements, and the letter-spacing
   that fits the measured glyph to its cell, set again when the size of a character changes. */
class GlyphRenderer {
  spacing = 0;
  private widths = new Map<string, number>();
  _widthCache = {
    _measureElements: [layOutGlyph(7.201171875), layOutGlyph(7.25), layOutGlyph(7.201171875), layOutGlyph(7.25)],
    _measure: (c: string, variant: number) => {
      const element = this._widthCache._measureElements[variant]!;
      element.textContent = c.repeat(32);
      return element.offsetWidth / 32;
    },
  };

  constructor(public readonly cell: number) {}

  width(c: string, variant = 0): number {
    const key = `${c}${variant}`;
    if (!this.widths.has(key)) this.widths.set(key, this._widthCache._measure(c, variant));
    return this.widths.get(key)!;
  }

  handleCharSizeChanged() {
    this.widths.clear();
    this.spacing = this.cell - this.width('W');
  }
}

function termWith(renderer: unknown): Terminal {
  return { rows: 38, _core: { _renderService: { _renderer: { value: renderer } } } } as unknown as Terminal;
}

describe('measureGlyphsExactly', () => {
  it('fits Monaco 12px of 7.2012 px to a 7.1985 px cell, where a whole-pixel offsetWidth took it for 7.1875', () => {
    /* 131 columns on a 943 px screen, as the window of 1440 px lays them out. */
    const renderer = new GlyphRenderer(943 / 131);
    renderer.handleCharSizeChanged();
    expect(131 * (7.201171875 + renderer.spacing) - 943).toBeGreaterThan(1.7);

    measureGlyphsExactly(termWith(renderer));

    expect(renderer.spacing).toBeCloseTo(943 / 131 - 7.201171875, 4);
    expect(Math.abs(131 * (7.201171875 + renderer.spacing) - 943)).toBeLessThan(0.01);
    expect(renderer.width('W', 1)).toBeCloseTo(7.25, 4);
    expect(renderer._widthCache._measureElements[1]!.textContent).toBe('W'.repeat(32));
  });

  it('leaves a terminal whose renderer keeps no width cache as it is', () => {
    expect(() => measureGlyphsExactly(termWith(undefined))).not.toThrow();
    expect(() => measureGlyphsExactly(termWith({ handleCharSizeChanged() {} }))).not.toThrow();
    expect(() => measureGlyphsExactly({ rows: 24 } as unknown as Terminal)).not.toThrow();
  });
});

describe('AgentTerminal visible column sync with node resize', () => {
  it('opens the socket at exact visible columns and sends resize when container or scrollbar width changes', async () => {
    const { container } = render(
      createElement(
        LanguageProvider,
        null,
        createElement(AgentTerminal, { path: '/api/agents/b1/terminal', program: 'Codex', onGone: () => {} }),
      ),
    );

    const ws = await waitFor(() => {
      expect(CapturedSocket.all.length).toBe(1);
      return CapturedSocket.all[0]!;
    });
    const term = MeasuredTerminal.all[0]!;
    const box = container.querySelector<HTMLElement>('.t-xterm')!;

    /* Simulate real layout: 753px box, padding 10px left + 8px right, 15px scrollbar -> 720px available.
       With Monaco 7.201171875px, 100 cols need 720.12px (overflowing by 0.12px), so exact visible cols = 99. */
    setRect(box, 753, 430);
    setRect(term.viewport, 753, 430);
    setRect(term.scrollArea, 738, 1200);
    ws.onmessage?.({ data: JSON.stringify({ type: 'ready', write: true }) });

    for (const ro of ObservedResize.all) ro.triggerFor(box);
    expect(term.cols).toBe(99);
    expect(term.rows).toBe(30);
    expect(ws.sent).toEqual([{ type: 'resize', cols: 99, rows: 30 }]);

    /* Now scrollbar widens to 24px without box changing width: 753 - 18 - 24 = 711px -> 98 cols. */
    ws.sent.length = 0;
    setRect(term.scrollArea, 729, 1200);
    for (const ro of ObservedResize.all) ro.triggerFor(term.scrollArea);
    expect(term.cols).toBe(98);
    expect(ws.sent).toEqual([{ type: 'resize', cols: 98, rows: 30 }]);
  });
});
