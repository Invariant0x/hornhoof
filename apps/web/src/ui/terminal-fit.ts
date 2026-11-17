import type { Terminal } from '@xterm/xterm';
import { guardedResizeObserver } from '../guard';

type EdgeBox = { top: number; right: number; bottom: number; left: number };

type TerminalFitInput = {
  containerWidth: number;
  containerHeight: number;
  padding: EdgeBox;
  scrollbarWidth: number;
  cellWidth: number;
  cellHeight: number;
};

type TerminalSize = { cols: number; rows: number };

const MIN_COLS = 2;
const MIN_ROWS = 1;
/* Reserves room for overlay or auto-expanding scrollbars that rest below 15px and widen when active. */
const MIN_SCROLLBAR_GUTTER = 15;
/* How many copies of a character xterm lays out to measure it. */
const MEASURED_COPIES = 32;

/* The DOM renderer's cache of glyph widths, from which it sets the letter-spacing that fits each character to its cell. */
type WidthCache = { _measureElements: HTMLElement[]; _measure(c: string, variant: number): number };

type DomRenderer = { _widthCache?: WidthCache; handleCharSizeChanged(): void };

type RenderService = {
  dimensions: { css: { cell: { width: number; height: number } } };
  clear(): void;
  _renderer?: { value?: DomRenderer };
};

type XtermFitCore = {
  _coreBrowserService?: { dpr: number };
  _charSizeService?: { width: number; height: number };
  _renderService?: RenderService;
};

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function clampInset(value: number): number {
  return positiveFinite(value) ? value : 0;
}

function fitAxis(available: number, cellSize: number, minimum: number): number {
  if (available <= 0) return minimum;
  const count = Math.max(minimum, Math.floor(available / cellSize));
  return count > minimum && Math.round(count * cellSize) > available ? count - 1 : count;
}

/* Pure calculation of fully visible terminal columns and rows, shared between screen layout and node resize. */
export function fitTerminalDimensions(input: TerminalFitInput): TerminalSize | null {
  const { containerWidth, containerHeight, padding, scrollbarWidth, cellWidth, cellHeight } = input;
  if (!positiveFinite(containerWidth) || !positiveFinite(containerHeight)) return null;
  if (!positiveFinite(cellWidth) || !positiveFinite(cellHeight)) return null;
  const availableWidth = containerWidth - clampInset(padding.left) - clampInset(padding.right) - clampInset(scrollbarWidth);
  const availableHeight = containerHeight - clampInset(padding.top) - clampInset(padding.bottom);
  return {
    cols: fitAxis(availableWidth, cellWidth, MIN_COLS),
    rows: fitAxis(availableHeight, cellHeight, MIN_ROWS),
  };
}

function pxValue(raw: string): number {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readPadding(element: HTMLElement): EdgeBox {
  const style = window.getComputedStyle(element);
  return {
    top: pxValue(style.paddingTop),
    right: pxValue(style.paddingRight),
    bottom: pxValue(style.paddingBottom),
    left: pxValue(style.paddingLeft),
  };
}

function liveScrollbarGutter(element: HTMLElement): number {
  const viewport = element.querySelector<HTMLElement>('.xterm-viewport');
  if (!viewport) return MIN_SCROLLBAR_GUTTER;
  const scrollArea = element.querySelector<HTMLElement>('.xterm-scroll-area');
  const rectGutter = scrollArea ? viewport.getBoundingClientRect().width - scrollArea.getBoundingClientRect().width : 0;
  const offsetGutter = viewport.offsetWidth - viewport.clientWidth;
  return Math.max(MIN_SCROLLBAR_GUTTER, Math.ceil(Math.max(0, rectGutter, offsetGutter)));
}

function readScrollbarWidth(term: Terminal, element: HTMLElement): number {
  return term.options.scrollback === 0 ? 0 : liveScrollbarGutter(element);
}

function coreOf(term: Terminal): XtermFitCore | undefined {
  return (term as unknown as { _core?: XtermFitCore })._core;
}

function cssCellSize(core: XtermFitCore | undefined): { width: number; height: number } {
  const render = core && core._renderService;
  return render ? render.dimensions.css.cell : { width: 0, height: 0 };
}

function letterSpacingRatio(term: Terminal, core: XtermFitCore | undefined): number {
  const raw = term.options.letterSpacing;
  const spacing = typeof raw === 'number' ? Math.round(raw) : 0;
  const browser = core && core._coreBrowserService;
  const dpr = browser && browser.dpr > 0 ? browser.dpr : 1;
  return spacing / dpr;
}

function readCellWidth(term: Terminal, core: XtermFitCore | undefined): number {
  const charSize = core && core._charSizeService;
  if (!charSize || charSize.width <= 0) return cssCellSize(core).width;
  return charSize.width + letterSpacingRatio(term, core);
}

function readCellHeight(core: XtermFitCore | undefined): number {
  const cssHeight = cssCellSize(core).height;
  if (cssHeight > 0) return cssHeight;
  const charSize = core && core._charSizeService;
  return charSize ? charSize.height : 0;
}

function boxExtent(box: HTMLElement): { width: number; height: number } {
  const rect = box.getBoundingClientRect();
  return { width: rect.width || box.clientWidth, height: rect.height || box.clientHeight };
}

export function measureTerminalFit(term: Terminal, box: HTMLElement): TerminalFitInput | null {
  if (!term.element) return null;
  const core = coreOf(term);
  const { width, height } = boxExtent(box);
  return {
    containerWidth: width,
    containerHeight: height,
    padding: readPadding(term.element),
    scrollbarWidth: readScrollbarWidth(term, term.element),
    cellWidth: readCellWidth(term, core),
    cellHeight: readCellHeight(core),
  };
}

function applyTerminalSize(term: Terminal, next: TerminalSize): void {
  if (term.cols === next.cols && term.rows === next.rows) return;
  const render = coreOf(term)?._renderService;
  if (render) render.clear();
  term.resize(next.cols, next.rows);
}

export function fitTerminal(term: Terminal, box: HTMLElement): TerminalSize | null {
  const measured = measureTerminalFit(term, box);
  const next = measured ? fitTerminalDimensions(measured) : null;
  if (next) applyTerminalSize(term, next);
  return next;
}

export function observeTerminalFit(term: Terminal, box: HTMLElement, onChange: () => void): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {};
  const observer = guardedResizeObserver(onChange, 'terminal');
  observer.observe(box);
  const scrollArea = term.element?.querySelector('.xterm-scroll-area');
  if (scrollArea) observer.observe(scrollArea);
  return () => observer.disconnect();
}

/* xterm 5.5 and 6.0 measure a glyph as the offsetWidth of 32 copies, a whole number of pixels: Monaco 12px of 7.2012 px
   counts as 7.1875, the letter-spacing that fits it to a 7.1985 px cell comes out 0.0137 px too wide, and 131 columns of
   text run 1.8 px past the screen, their last character cut and off the cursor and the selection. Measured by its
   fractional width, every character fills its own cell. Widths measured the old way are forgotten and the spacing of the
   rows is set again; xterm measures with the same function from then on, as the font or the pixel ratio changes. */
export function measureGlyphsExactly(term: Terminal): void {
  const renderer = coreOf(term)?._renderService?._renderer?.value;
  const cache = renderer?._widthCache;
  if (!renderer || !cache) return;
  cache._measure = fractionalMeasure(cache._measureElements);
  renderer.handleCharSizeChanged();
}

/* Copies of a character on the cache's element of its variant (regular, bold, italic, bold italic), by the width they
   lay out to. */
function fractionalMeasure(elements: HTMLElement[]) {
  return (c: string, variant: number): number => {
    const element = elements[variant]!;
    element.textContent = c.repeat(MEASURED_COPIES);
    return element.getBoundingClientRect().width / MEASURED_COPIES;
  };
}
