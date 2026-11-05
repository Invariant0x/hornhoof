import type { Terminal } from '@xterm/xterm';

type ScrollBuffer = { hasScrollback: boolean; ybase: number; ydisp: number };
type Activation = { activeBuffer: ScrollBuffer; inactiveBuffer: ScrollBuffer };
type Buffers = { active: ScrollBuffer; normal: ScrollBuffer; alt: ScrollBuffer; _onBufferActivate?: { fire(event: Activation): void } };
type XtermCore = { buffers: Buffers; viewport?: WheelViewport };
type WheelViewport = { getLinesScrolled(event: WheelEvent): number };

function buffersOf(term: Terminal): Buffers {
  return (term as unknown as { _core: XtermCore })._core.buffers;
}

function report(buffers: Buffers, activeBuffer: ScrollBuffer, inactiveBuffer: ScrollBuffer): void {
  buffers._onBufferActivate?.fire({ activeBuffer, inactiveBuffer });
}

/* The alt buffer has no scrollback. Borrow the normal one without activating it, which would clear the live screen. */
export function scrollTerminal(term: Terminal, amount: number): void {
  const buffers = buffersOf(term);
  if (!buffers.active.hasScrollback) {
    if (buffers.normal.ybase === 0) return;
    Object.defineProperty(buffers, 'active', { configurable: true, get: () => buffers.normal });
    report(buffers, buffers.normal, buffers.alt);
  }
  term.scrollLines(amount);
  if (buffers.active.hasScrollback && buffers.normal.ydisp < buffers.normal.ybase) {
    term.refresh(0, term.rows - 1);
    return;
  }
  restoreLiveTerminal(term);
}

/* New output always goes to the real active buffer, never to the history someone was reading. */
export function restoreLiveTerminal(term: Terminal): void {
  const buffers = buffersOf(term);
  if (!Object.getOwnPropertyDescriptor(buffers, 'active')?.get) return;
  Reflect.deleteProperty(buffers, 'active');
  report(buffers, buffers.alt, buffers.normal);
  term.refresh(0, term.rows - 1);
}

/* Both xterm's mouse protocol and its alt-screen arrows are suppressed before they can become terminal data. */
export function attachTerminalScroll(term: Terminal): void {
  const viewport = (term as unknown as { _core: XtermCore })._core.viewport;
  term.attachCustomWheelEventHandler(event => {
    const amount = viewport?.getLinesScrolled(event) ?? (event.deltaY < 0 ? -3 : 3);
    if (amount !== 0) scrollTerminal(term, amount);
    event.preventDefault();
    return false;
  });
}
