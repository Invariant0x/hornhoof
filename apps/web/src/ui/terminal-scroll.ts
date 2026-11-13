import type { Terminal } from '@xterm/xterm';

type ScrollBuffer = { hasScrollback: boolean; ybase: number; ydisp: number };
type Activation = { activeBuffer: ScrollBuffer; inactiveBuffer: ScrollBuffer };
type Buffers = { active: ScrollBuffer; normal: ScrollBuffer; alt: ScrollBuffer; _activeBuffer?: ScrollBuffer; _onBufferActivate?: { fire(event: Activation): void } };
type XtermCore = { buffers: Buffers; viewport?: WheelViewport };
type WheelViewport = { getLinesScrolled(event: WheelEvent): number };

const borrowed = new WeakMap<Buffers, ScrollBuffer>();

function buffersOf(term: Terminal): Buffers {
  return (term as unknown as { _core: XtermCore })._core.buffers;
}

function report(buffers: Buffers, activeBuffer: ScrollBuffer, inactiveBuffer: ScrollBuffer): void {
  buffers._onBufferActivate?.fire({ activeBuffer, inactiveBuffer });
}

function borrowNormal(buffers: Buffers): void {
  borrowed.set(buffers, buffers.active);
  Object.defineProperty(buffers, 'active', { configurable: true, get: () => buffers.normal });
  report(buffers, buffers.normal, buffers.alt);
}

/* The alt buffer has no scrollback. Borrow the normal one without activating it, which would clear the live screen. */
export function scrollTerminal(term: Terminal, amount: number): void {
  const buffers = buffersOf(term);
  if (!buffers.active.hasScrollback) {
    if (buffers.normal.ybase === 0) return;
    borrowNormal(buffers);
  }
  term.scrollLines(amount);
  if (buffers.active.hasScrollback && buffers.normal.ydisp < buffers.normal.ybase) {
    term.refresh(0, term.rows - 1);
    return;
  }
  restoreLiveTerminal(term);
}

/* New output always goes to the real active buffer, never to the history someone was reading. The live screen comes back
   at its bottom: xterm 5.5 lets an alternate screen keep lines above it when the terminal shrank before its first use, and
   output written there while someone read history leaves its view behind, since xterm counts that reader as scrolled up
   in every buffer. */
export function restoreLiveTerminal(term: Terminal): void {
  const buffers = buffersOf(term);
  const live = borrowed.get(buffers);
  if (!live) return;
  Reflect.deleteProperty(buffers, 'active');
  buffers._activeBuffer = live;
  live.ydisp = live.ybase;
  borrowed.delete(buffers);
  report(buffers, live, buffers.normal);
  term.refresh(0, term.rows - 1);
}

/* While someone reads alternate history, output grows it and the live screen in order, without moving the reader. */
export function writeTerminalData(term: Terminal, data: string, onWritten?: () => void): void {
  const buffers = buffersOf(term);
  if (!borrowed.has(buffers)) {
    term.write(data, onWritten);
    return;
  }
  term.write(data, () => {
    restoreLiveTerminal(term);
    term.write(data, () => {
      borrowNormal(buffers);
      term.refresh(0, term.rows - 1);
      onWritten?.();
    });
  });
}

function wheelLines(viewport: WheelViewport | undefined, event: WheelEvent): number {
  return viewport?.getLinesScrolled(event) ?? (event.deltaY < 0 ? -3 : 3);
}

/* Both xterm's mouse protocol and its alt-screen arrows are suppressed before they can become terminal data. */
export function attachTerminalScroll(term: Terminal): void {
  const viewport = (term as unknown as { _core: XtermCore })._core.viewport;
  term.attachCustomWheelEventHandler(event => {
    const amount = wheelLines(viewport, event);
    if (amount !== 0) scrollTerminal(term, amount);
    event.preventDefault();
    return false;
  });
}
