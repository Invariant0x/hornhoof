import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { decodeViewChallenge, decodeViewSignature, encodeViewChallenge, type BindViewRequest, type BindViewResponse, type ViewProof } from '@hornhoof/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { AgentWindow } from '../src/screens/AgentWindow';
import * as testTerminal from '../src/ui/AgentTerminal';
import type { EventView, OrchestratorState } from '../src/types';
import { ME, mockApi, ORG } from './api-mock';
import { decl } from './css';

/* The terminal itself needs a real browser; these stand-ins keep what the window gives it and what it hands back. */
const terms = vi.hoisted(() => [] as FakeTerminal[]);
/* What the terminal and its fit did, in order. */
const moves = vi.hoisted(() => [] as string[]);
/* What xterm's own timers found when they came after the terminal was gone; xterm 5.5 throws there. */
const late = vi.hoisted(() => [] as string[]);
/* What a test makes the terminal's buffer do as it fits its box, as xterm rewraps long lines for a new width. */
const fitting = vi.hoisted(() => ({ then: null as null | (() => void) }));
type Marker = { line: number; isDisposed: boolean; dispose(): void };
type FakeTerminal = {
  options: Record<string, unknown>;
  written: string[];
  cols: number;
  rows: number;
  selection: string;
  buffer: { active: { viewportY: number; baseY: number; cursorY: number } };
  element: HTMLElement;
  wrapped: Set<number>;
  markers: Marker[];
  _core: {
    buffers: { active: { hasScrollback: boolean; ybase: number; ydisp: number }; normal: { hasScrollback: boolean; ybase: number; ydisp: number } };
    viewport: { getLinesScrolled(event: WheelEvent): number };
    _selectionService: { enabled: boolean; shouldForceSelection(e: MouseEvent): boolean; enable(): void; disable(): void };
    coreMouseService: { _protocols: Record<string, { events: number }>; fireProtocol(events: number): void };
  };
  type(data: string): void;
  write(data: string, onWritten?: () => void): void;
  wheel(deltaY: number): boolean;
  pressKey(init: KeyboardEventInit): KeyboardEvent;
  selectText(text: string): void;
  clearSelection(): void;
  resized(cols: number, rows: number): void;
  disposed: boolean;
  focused: number;
  pending: number;
};

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    written: string[] = [];
    cols = 100;
    rows = 30;
    selection = '';
    disposed = false;
    focused = 0;
    /* xterm's own timers set and not come yet. */
    pending = 0;
    /* The history above the screen, and the line the view starts at: at the bottom when they are equal. */
    /* Rows that go on the line above them, as xterm wraps a line longer than the terminal is wide. */
    wrapped = new Set<number>();
    markers: Marker[] = [];
    buffer = { active: { viewportY: 200, baseY: 200, cursorY: 29, getLine: (y: number) => ({ isWrapped: this.wrapped.has(y) }) } };
    /* Where xterm scrolls its view in the page; jsdom lays nothing out, so a test sets where it stands. */
    element = Object.assign(document.createElement('div'), { innerHTML: '<div class="xterm-viewport"></div>' });
    private onKeys: ((d: string) => void)[] = [];
    private onSize: ((s: { cols: number; rows: number }) => void)[] = [];
    private onSelect: (() => void)[] = [];
    private keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
    private wheelHandler: ((e: WheelEvent) => boolean) | null = null;
    private onProto: ((events: number) => void)[] = [];
    _core = {
      buffers: { active: { hasScrollback: true, ybase: 200, ydisp: 200 }, normal: { hasScrollback: true, ybase: 200, ydisp: 200 } },
      viewport: { getLinesScrolled: (event: WheelEvent) => event.deltaY },
      _selectionService: {
        enabled: true,
        shouldForceSelection: (e: MouseEvent) => e.shiftKey,
        enable: () => {
          this._core._selectionService.enabled = true;
          this.element.classList.remove('enable-mouse-events');
        },
        disable: () => {
          this._core._selectionService.enabled = false;
          this.element.classList.add('enable-mouse-events');
        },
      },
      coreMouseService: {
        _protocols: { NONE: { events: 0 }, X10: { events: 1 }, VT200: { events: 19 }, DRAG: { events: 23 }, ANY: { events: 31 } },
        onProtocolChange: (fn: (events: number) => void) => {
          this.onProto.push(fn);
          return { dispose() {} };
        },
        fireProtocol: (events: number) => {
          if (events) this._core._selectionService.disable();
          else this._core._selectionService.enable();
          for (const fn of this.onProto) fn(events);
        },
      },
    };
    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      terms.push(this as unknown as FakeTerminal);
    }
    loadAddon() {}
    /* xterm syncs its scroll area on a timer once it opens and on the next frame after a reset, and does not cancel them. */
    open(parent?: HTMLElement) {
      parent?.appendChild(this.element);
      this.pending++;
      setTimeout(() => this.synced('open'));
    }
    focus() {
      this.focused++;
    }
    hasSelection() {
      return this.selection.length > 0;
    }
    getSelection() {
      return this.selection;
    }
    clearSelection() {
      this.selection = '';
      for (const fn of this.onSelect) fn();
    }
    selectText(text: string) {
      this.selection = text;
      for (const fn of this.onSelect) fn();
    }
    onSelectionChange(fn: () => void) {
      this.onSelect.push(fn);
      return { dispose() {} };
    }
    attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean) {
      this.keyHandler = fn;
    }
    attachCustomWheelEventHandler(fn: (e: WheelEvent) => boolean) {
      this.wheelHandler = fn;
    }
    wheel(deltaY: number) {
      return this.wheelHandler?.(new WheelEvent('wheel', { deltaY })) ?? true;
    }
    scrollLines(amount: number) {
      this.buffer.active.viewportY = Math.max(0, Math.min(this.buffer.active.baseY, this.buffer.active.viewportY + amount));
    }
    refresh() {}
    pressKey(init: KeyboardEventInit) {
      const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      if (this.keyHandler && !this.keyHandler(event)) return event;
      if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && (event.key === 'c' || event.key === 'C' || event.code === 'KeyC')) {
        this.type('\x03');
      } else if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && (event.key === 'v' || event.key === 'V' || event.code === 'KeyV')) {
        /* As xterm does: Ctrl+V is the control key ^V, and the browser pastes nothing. */
        event.preventDefault();
        this.type('\x16');
      } else if (event.key === 'Escape') {
        this.type('\x1b');
      }
      return event;
    }
    scrollToBottom() {
      moves.push('scrollToBottom');
      this.buffer.active.viewportY = this.buffer.active.baseY;
    }
    /* xterm keeps a marker on its line as lines wrap again and the history is trimmed. */
    registerMarker(offset: number) {
      const marker: Marker = { line: this.buffer.active.baseY + this.buffer.active.cursorY + offset, isDisposed: false, dispose: () => (marker.isDisposed = true) };
      this.markers.push(marker);
      return marker;
    }
    scrollToLine(line: number) {
      moves.push(`scrollToLine ${line}`);
      this.buffer.active.viewportY = line;
    }
    reset() {
      this.written = [];
      this.pending++;
      requestAnimationFrame(() => this.synced('reset'));
    }
    private synced(after: string) {
      this.pending--;
      if (this.disposed) late.push(after);
    }
    write(data: string, onWritten?: () => void) {
      this.written.push(data);
      onWritten?.();
    }
    onData(fn: (d: string) => void) {
      this.onKeys.push(fn);
    }
    onResize(fn: (s: { cols: number; rows: number }) => void) {
      this.onSize.push(fn);
    }
    dispose() {
      this.disposed = true;
    }
    type(data: string) {
      for (const fn of this.onKeys) fn(data);
    }
    /* What xterm's paste hands on when the program asked for no bracketed paste. */
    paste(data: string) {
      this.type(data);
    }
    resized(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      for (const fn of this.onSize) fn({ cols, rows });
    }
    resize(cols: number, rows: number) {
      this.resized(cols, rows);
    }
  },
}));
vi.mock('../src/ui/terminal-fit', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/ui/terminal-fit')>();
  return {
    ...actual,
    fitTerminal(term: Parameters<typeof actual.fitTerminal>[0], box: HTMLElement) {
      moves.push('fit');
      fitting.then?.();
      return actual.fitTerminal(term, box);
    },
  };
});

/* The browser tells of a new size of the terminal's box; jsdom has no layout, so a test says when. */
class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  targets: Element[] = [];
  constructor(private fn: () => void) {
    FakeResizeObserver.all.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  disconnect() {}
  resized() {
    this.fn();
  }
}

const TEST_CURSOR = `ttc1.${'A'.repeat(43)}`;

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  /* What the server does. */
  connected() {
    this.readyState = 1;
    this.onopen?.();
  }
  ready(write: boolean, message: boolean) {
    this.onmessage?.({ data: JSON.stringify({ type: 'ready', write, message }) });
  }
  opened(write = true, message = write) {
    this.connected();
    this.ready(write, message);
  }
  refused(reason: 'control' | 'message') {
    this.onmessage?.({ data: JSON.stringify({ type: 'refused', reason }) });
  }
  screen(data: string) {
    this.onmessage?.({ data: JSON.stringify({ type: 'data', data }) });
  }
  testScreen(data: string) {
    this.onmessage?.({ data: JSON.stringify({ type: 'data', data, cursor: TEST_CURSOR }) });
  }
  testError(reason: 'denied' | 'expired' | 'unavailable' | 'unknown') {
    this.onmessage?.({ data: JSON.stringify({ type: 'error', reason }) });
  }
  program(running: boolean, asleep = false) {
    this.onmessage?.({ data: JSON.stringify({ type: 'program', running, ...(asleep ? { asleep } : {}) }) });
  }
  ended(code: number, reason: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const EVENTS = '/api/agents/orchestrator/events';
const READY: OrchestratorState = { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 };
const LOG: EventView[] = [{ seq: 1, kind: 'text', data: { kind: 'text', text: 'Hello from the log' }, jobId: 'j1', person: null, at: '2026-10-30T10:00:00Z' }];

function open(terminal = true, more: Partial<OrchestratorState> = {}, extra: Parameters<typeof mockApi>[0] = {}) {
  const calls = mockApi({
    [`GET ${EVENTS}?last=300`]: [200, { events: LOG, state: { ...READY, ...more, terminal } }],
    [`GET ${EVENTS}?after=1`]: [200, { events: [], state: { ...READY, ...more, terminal } }],
    'POST /api/agents/orchestrator/start': [200, { started: false }],
    'POST /api/agents/orchestrator/stop': [202],
    ...extra,
  });
  return { calls, ...view() };
}

function view() {
  return render(
    <LanguageProvider>
      <AgentWindow me={ME} org={ORG} agentId="orchestrator" onClose={() => {}} />
    </LanguageProvider>,
  );
}

const frame = () => new Promise(r => requestAnimationFrame(() => r(undefined)));
const answersTakenIn = () => new Promise<void>(resolve => setImmediate(resolve));

const socket = async () => {
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  return FakeSocket.all.at(-1)!;
};

/* A note of the window stands at its foot, under the terminal and never over it (#1115): its words, and the note that
   says them to a screen reader with the role it has. */
async function note(says: string | RegExp, role: 'status' | 'alert' = 'status') {
  const foot = await screen.findByRole('group', { name: 'Notes' });
  const words = await within(foot).findByText(says);
  expect(words.closest('.t-term')).toBeNull();
  expect(words.closest('.t-note')).toHaveAttribute('role', role);
  return words;
}

/* The view connects again after a pause of its own, 500 ms once a socket it had opened is lost; a fake clock lets that pause
   pass at once. lost: what closes the socket, and what the person does while the view is away. */
function reconnects(lost: () => void) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    lost();
    act(() => {
      vi.advanceTimersByTime(500);
    });
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  terms.length = 0;
  moves.length = 0;
  late.length = 0;
  fitting.then = null;
  FakeSocket.all = [];
  FakeResizeObserver.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  /* These are about the terminal, which a person reaches by choosing it over the chat. */
  localStorage.setItem('hh-agent-view', 'terminal');
});

describe("an agent's live terminal in its window", () => {
  it("shows the agent's terminal when its node has one, at the size of the window", async () => {
    open();
    const ws = await socket();
    expect(ws.url).toBe(`ws://${location.host}/api/agents/orchestrator/terminal?cols=100&rows=30`);
    ws.opened();
    ws.screen('\u001b[1m✻ Welcome to Claude Code\u001b[0m');
    expect(terms[0]!.written).toEqual(['\u001b[1m✻ Welcome to Claude Code\u001b[0m']);
    expect(screen.queryByText('Hello from the log')).not.toBeInTheDocument();
  });

  it('fills the whole phone screen with a terminal window, as with any other window', () => {
    /* The terminal window is wider than the others on a computer; on a phone it takes the full width like them. */
    expect(decl('.orch', 'width', '(max-width: 760px)')).toBe('auto');
    expect(decl('.orch.term', 'width', '(max-width: 760px)')).toBe('auto');
  });

  it('shows one big loader naming the program until it is up, over whatever the session shows meanwhile', async () => {
    const { container } = open();
    const ws = await socket();
    const terminal = within(container.querySelector<HTMLElement>('.t-term')!);
    expect(terminal.getByRole('status')).toHaveTextContent('Opening the Claude terminal…');
    ws.opened();
    ws.program(false);
    expect(terminal.getByRole('status')).toHaveTextContent('Opening the Claude terminal…');
    ws.program(true);
    await waitFor(() => expect(terminal.queryByRole('status')).not.toBeInTheDocument());
  });

  it('shows what a program that sleeps printed, and says it sleeps until the next task, with no loader over it', async () => {
    const { container } = open();
    const ws = await socket();
    const terminal = within(container.querySelector<HTMLElement>('.t-term')!);
    ws.opened();
    ws.program(false, true);
    await note("The Claude program sleeps until this agent's next task. Scroll up to see what it did.");
    expect(terminal.queryByRole('status')).not.toBeInTheDocument();
    /* A turn starts it: the loader shows until it is up. */
    ws.program(false);
    await waitFor(() => expect(terminal.getByRole('status')).toHaveTextContent('Opening the Claude terminal…'));
    await waitFor(() => expect(screen.queryByText(/sleeps until/)).not.toBeInTheDocument());
    ws.program(true);
    await waitFor(() => expect(terminal.queryByRole('status')).not.toBeInTheDocument());
  });

  it('uses the dark terminal palette on a light page too, since the programs inside run their dark theme', async () => {
    open();
    await socket();
    const o = terms[0]!.options as { fontFamily: string; fontSize: number; lineHeight: number; cursorStyle: string; cursorBlink: boolean; drawBoldTextInBrightColors: boolean; theme: Record<string, string> };
    expect(o.fontFamily.split(',')[0]).toBe('Monaco');
    expect(o).toMatchObject({ fontSize: 12, lineHeight: 1, cursorStyle: 'block', cursorBlink: false, drawBoldTextInBrightColors: true });
    expect(o.theme).toMatchObject({ background: '#15191f', foreground: '#dcdcdc', cursor: '#ffffff', black: '#14191e', red: '#b43c2a', brightCyan: '#60fdff' });
  });

  it('sends what the person types and the new size of the window', async () => {
    open();
    const ws = await socket();
    ws.opened();
    terms[0]!.type('ls\r');
    terms[0]!.resized(132, 40);
    expect(ws.sent).toEqual([
      { type: 'input', data: 'ls\r' },
      { type: 'resize', cols: 132, rows: 40 },
    ]);
  });

  it('lets a person who may only watch see the screen without typing into it', async () => {
    open();
    const ws = await socket();
    ws.opened(false);
    expect(terms[0]!.options.disableStdin).toBe(true);
    terms[0]!.type('ls\r');
    expect(ws.sent).toEqual([]);
  });

  it.each([false, true])('scrolls history locally without sending wheel input when write=%s', async write => {
    open();
    const ws = await socket();
    ws.opened(write);
    const term = terms[0]!;
    expect(term.wheel(-3)).toBe(false);
    expect(term.buffer.active.viewportY).toBe(197);
    expect(ws.sent).toEqual([]);
  });

  it.each([
    { saved: 120, after: 200, expected: 120 },
    { saved: 120, after: 80, expected: 80 },
    { saved: 200, after: 80, expected: 80 },
  ])('restores the reading place after 3J: $saved -> $after', async ({ saved, after, expected }) => {
    open();
    const ws = await socket();
    ws.opened();
    const term = terms[0]!;
    term.buffer.active.viewportY = saved;
    const write = term.write.bind(term);
    const written: (() => void)[] = [];
    term.write = (data, onWritten) => {
      write(data);
      if (data.includes('\x1b[3J') || data === '3J') {
        term.buffer.active.baseY = 0;
        term.buffer.active.viewportY = 0;
      }
      written.push(() => {
        if (data.includes('history')) term.buffer.active.baseY = after;
        onWritten?.();
      });
    };
    act(() => {
      ws.screen('\x1b[');
      ws.screen('3J');
      ws.screen('\x1b[1;2r history');
      ws.screen('repaint');
    });
    act(() => {
      for (const done of written) done();
    });
    expect(term.buffer.active.viewportY).toBe(expected);
    expect(term.wheel(-3)).toBe(false);
    expect(ws.sent).toEqual([]);
  });

  it('takes the focus for the person who types into it', async () => {
    open(true, { canType: true });
    await socket();
    expect(terms.at(-1)!.focused).toBe(1);
  });

  it('takes the focus for a person who writes to an agent on the plan of someone else, with no line under it', async () => {
    open(true, { canType: false });
    await socket();
    expect(terms.at(-1)!.focused).toBe(1);
    expect(screen.queryByRole('textbox', { name: 'Write to the orchestrator' })).not.toBeInTheDocument();
  });

  it('offers Stop above the terminal while the agent works', async () => {
    const user = userEvent.setup();
    const { calls } = open(true, { busy: true, runningJobId: 'j1' });
    await socket();
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(calls.some(c => c.method === 'POST' && c.path === '/api/agents/orchestrator/stop')).toBe(true);
  });

  it('cuts a long paste into pieces the server takes', async () => {
    open();
    const ws = await socket();
    ws.opened();
    terms[0]!.type('x'.repeat(40_000));
    const pieces = ws.sent as { type: string; data: string }[];
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every(p => p.type === 'input' && p.data.length <= 16_384)).toBe(true);
    expect(pieces.map(p => p.data).join('')).toHaveLength(40_000);
  });

  it('keeps automatic query answers for the subscription owner', async () => {
    open();
    const ws = await socket();
    ws.opened(true);
    terms[0]!.type('\x1b[I');
    terms[0]!.type('\x1b[>0;276;0c');
    expect(ws.sent).toEqual([
      { type: 'input', data: '\x1b[I' },
      { type: 'input', data: '\x1b[>0;276;0c' },
    ]);
  });

  it.each([false, true])('keeps one bracketed paste in one frame when write=%s', async write => {
    open();
    const ws = await socket();
    ws.opened(write, true);
    const data = `\x1b[200~${'x'.repeat(40_000)}\x1b[201~`;
    terms[0]!.type(data);
    expect(ws.sent).toEqual([{ type: 'input', data }]);
  });

  it('shows the chat with what was said, and the terminal again', async () => {
    const user = userEvent.setup();
    open();
    const ws = await socket();
    await user.click(screen.getByRole('button', { name: 'Chat' }));
    expect(await screen.findByText('Hello from the log')).toBeInTheDocument();
    expect(ws.readyState).toBe(3);
    await waitFor(() => expect(terms[0]!.disposed).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Terminal' }));
    await waitFor(() => expect(FakeSocket.all).toHaveLength(2));
  });

  it('says why when the node cannot show a terminal, with the chat one click away', async () => {
    const user = userEvent.setup();
    open();
    (await socket()).ended(4404, 'no_terminal');
    expect(await screen.findByRole('status', { name: 'Terminal' })).toHaveTextContent(/is asleep now\. It wakes up when someone writes to the agent/);
    await user.click(screen.getByRole('button', { name: 'Chat' }));
    expect(await screen.findByText('Hello from the log')).toBeInTheDocument();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('connects again when the machine went away for a moment, and starts the screen over', async () => {
    open();
    const first = await socket();
    first.opened();
    first.screen('old screen');
    reconnects(() => first.ended(4410, 'node_offline'));
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.opened();
    FakeSocket.all[1]!.screen('new screen');
    expect(terms[0]!.written).toEqual(['new screen']);
  });

  it('recovers from a transient socket drop without flashing the loader or clearing the screen before new output arrives', async () => {
    const { container } = open();
    const first = await socket();
    const terminal = within(container.querySelector<HTMLElement>('.t-term')!);
    act(() => {
      first.opened();
      first.program(true);
      first.screen('old screen');
    });
    expect(terminal.queryByRole('status')).not.toBeInTheDocument();
    reconnects(() => first.ended(4410, 'node_offline'));
    expect(FakeSocket.all).toHaveLength(2);
    expect(terminal.queryByRole('status')).not.toBeInTheDocument();
    expect(terms[0]!.written).toEqual(['old screen']);
    act(() => {
      FakeSocket.all[1]!.opened();
      FakeSocket.all[1]!.program(true);
    });
    expect(terminal.queryByRole('status')).not.toBeInTheDocument();
    expect(terms[0]!.written).toEqual(['old screen']);
    act(() => FakeSocket.all[1]!.screen('new screen'));
    expect(terms[0]!.written).toEqual(['new screen']);
    expect(terminal.queryByRole('status')).not.toBeInTheDocument();
  });

  it('buffers history and live screen together on reconnect and restores the scrolled-up reading line', async () => {
    open();
    const first = await socket();
    act(() => {
      first.opened();
      first.program(true);
      first.screen('old screen');
    });
    const term = terms[0]!;
    term.buffer.active.baseY = 200;
    term.buffer.active.viewportY = 50;
    const resets = vi.spyOn(term as unknown as { reset(): void }, 'reset').mockImplementation(() => {
      term.written = [];
      term.buffer.active.baseY = 0;
      term.buffer.active.viewportY = 0;
    });
    const origWrite = term.write.bind(term);
    term.write = (data, onWritten) => {
      origWrite(data);
      if (data.includes('\x1b[1;2r')) term.buffer.active.baseY = 200;
      onWritten?.();
    };
    reconnects(() => first.ended(4410, 'node_offline'));
    expect(FakeSocket.all).toHaveLength(2);
    const historyChunk = '\x1b7\x1b[0m\x1b[1;2r\x1b[1;1H\x1b[2K\x1b[2;1H\x1b[2K\x1b[1;1HLINE-0\x1b[0m\r\n\n\x1b[r\x1b8';
    act(() => {
      FakeSocket.all[1]!.opened();
      FakeSocket.all[1]!.program(true);
      FakeSocket.all[1]!.screen(historyChunk);
    });
    /* Still holding the history-only chunk until the live screen attach arrives, so the terminal never flashes empty. */
    expect(resets).not.toHaveBeenCalled();
    act(() => FakeSocket.all[1]!.screen('\x1b[H\x1b[2JNEW-43'));
    expect(resets).toHaveBeenCalledTimes(1);
    expect(term.written).toEqual([`${historyChunk}\x1b[H\x1b[2JNEW-43`]);
    expect(term.buffer.active.viewportY).toBe(50);
  });

  it('does not flash the opening loader over live output when a running program restarts', async () => {
    const { container } = open();
    const ws = await socket();
    const terminal = within(container.querySelector<HTMLElement>('.t-term')!);
    act(() => {
      ws.opened();
      ws.program(true);
      ws.screen('previous work');
    });
    expect(terminal.queryByRole('status')).not.toBeInTheDocument();
    act(() => ws.program(false));
    expect(terminal.queryByRole('status')).not.toBeInTheDocument();
    act(() => ws.program(true));
    expect(terminal.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps the terminal mounted when a background poll briefly reports terminal=false while the node reconnects', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    let first: FakeSocket | undefined;
    try {
      const { calls } = open(true, {}, {
        [`GET ${EVENTS}?after=1`]: [200, { events: [], state: { ...READY, terminal: false, reason: 'machine_offline', ready: false } }],
      });
      await act(answersTakenIn);
      await act(answersTakenIn);
      first = FakeSocket.all.at(-1);
      expect(first).toBeDefined();
      act(() => {
        first!.opened();
        first!.program(true);
        first!.screen('old screen');
      });
      const firstTerm = terms[0]!;
      await act(() => vi.advanceTimersByTimeAsync(15_000));
      await act(answersTakenIn);
      expect(calls.some(c => c.path === `${EVENTS}?after=1`)).toBe(true);
      expect(screen.getByText(/offline|не в сети/i)).toBeInTheDocument();
      expect(firstTerm.disposed).toBe(false);
      expect(terms).toHaveLength(1);
      expect(screen.queryByRole('status', { name: 'Terminal' })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
    /* A real final close still hands the window back to the unavailable screen. */
    act(() => first!.ended(4404, 'no_terminal'));
    expect(screen.getByRole('status', { name: 'Terminal' })).toBeInTheDocument();
  });

  it.each([
    ['busy', /went into the turn that was running/],
    ['unknown_words', /Hornhoof could not tell who wrote/],
  ] as const)('says at once in the window why a turn could not open: %s', async (turnRefused, says) => {
    open(true, { turnRefused });
    expect(await note(says)).toBeVisible();
  });

  it.each([
    [{ ready: false, reason: 'machine_offline' as const }, /offline|не в сети/i],
    [{ browserError: 'no chrome' }, /no chrome/],
    [{ limitUntil: '2026-11-05T15:00:00Z' }, /The plan is at its limit/],
    [{ budgetUntil: '2026-11-05T15:00:00Z' }, /The plan used the share set for tasks/],
    [{ limitUntil: '2026-11-05T15:00:00Z', budgetUntil: '2026-11-05T15:00:00Z' }, /The plan is at its limit/],
    [{ machineDrain: { state: 'waiting', since: '2026-11-05T15:00:00Z', turnsLeft: 1, partsLeft: 0 } as const }, /finishing its work before an update/],
  ])('says what keeps the agent from answering: %j', async (state, says) => {
    open(true, state);
    await note(says);
  });

  it('leaves the share of the plan out while the plan is at its limit', async () => {
    open(true, { limitUntil: '2026-11-05T15:00:00Z', budgetUntil: '2026-11-05T15:00:00Z' });
    await screen.findByText(/The plan is at its limit/);
    expect(screen.queryByText(/The plan used the share set for tasks/)).toBeNull();
  });

  it('says nothing of a refused turn while none was refused', async () => {
    open(true, { turnRefused: null });
    await socket();
    await waitFor(() => expect(screen.queryByText(/went into the turn that was running|Hornhoof could not tell who wrote/)).toBeNull());
  });

  it('keeps the refused turn in the log of what happened', async () => {
    const refused: EventView = { seq: 2, kind: 'turn_refused', data: { reason: 'unknown_words' }, jobId: null, person: null, at: '2026-10-30T10:00:01Z' };
    mockApi({
      [`GET ${EVENTS}?last=300`]: [200, { events: [...LOG, refused], state: { ...READY, terminal: false } }],
      [`GET ${EVENTS}?after=2`]: [200, { events: [], state: { ...READY, terminal: false } }],
      'POST /api/agents/orchestrator/start': [200, { started: false }],
    });
    localStorage.setItem('hh-agent-view', 'chat');
    view();
    expect(await screen.findByText(/Hornhoof could not tell who wrote/)).toBeInTheDocument();
  });

  it.each([
    ['who typed there last', { id: 'p1', name: 'Zed' }, /Zed typed in this terminal last/],
    ['that nobody knows who wrote them', null, /Hornhoof cannot tell who wrote them/],
  ] as const)('keeps words left in the input in the log of what happened, and says %s', async (_, person, says) => {
    const left: EventView = { seq: 2, kind: 'input_left', data: { text: 'a <b>draft</b>\nof two lines', ref: 'r1' }, jobId: null, person, at: '2026-10-30T10:00:01Z' };
    mockApi({
      [`GET ${EVENTS}?last=300`]: [200, { events: [...LOG, left], state: { ...READY, terminal: false } }],
      [`GET ${EVENTS}?after=2`]: [200, { events: [], state: { ...READY, terminal: false } }],
      'POST /api/agents/orchestrator/start': [200, { started: false }],
    });
    localStorage.setItem('hh-agent-view', 'chat');
    view();
    expect(await screen.findByText(/were left unsent in the program's input/)).toBeInTheDocument();
    expect(screen.getByText(says)).toBeInTheDocument();
    expect(screen.getByText(/a <b>draft<\/b>\s+of two lines/)).toBeInTheDocument();
  });

  it('keeps what the person types while the view connects again, and sends it in order once it is back', async () => {
    open();
    const first = await socket();
    first.opened();
    reconnects(() => {
      first.ended(4410, 'node_offline');
      terms[0]!.type('first question');
      terms[0]!.type('\r');
      terms[0]!.resized(90, 30);
    });
    expect(FakeSocket.all).toHaveLength(2);
    const again = FakeSocket.all[1]!;
    again.opened();
    expect(again.sent.filter(m => (m as { type: string }).type === 'input')).toEqual([
      { type: 'input', data: 'first question' },
      { type: 'input', data: '\r' },
    ]);
    expect(again.sent).not.toContainEqual({ type: 'resize', cols: 90, rows: 30 });
    terms[0]!.type('next');
    expect(again.sent.at(-1)).toEqual({ type: 'input', data: 'next' });
  });

  it('sends what it kept once, and nothing that had gone already, however often the view connects again', async () => {
    open();
    const first = await socket();
    first.opened();
    terms[0]!.type('went\r');
    reconnects(() => {
      first.ended(4410, 'node_offline');
      terms[0]!.type('kept\r');
    });
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.opened();
    expect(FakeSocket.all[1]!.sent).toEqual([{ type: 'input', data: 'kept\r' }]);
    reconnects(() => FakeSocket.all[1]!.ended(4410, 'node_offline'));
    expect(FakeSocket.all).toHaveLength(3);
    FakeSocket.all[2]!.opened();
    expect(FakeSocket.all[2]!.sent).toEqual([]);
  });

  it('keeps what the person types before the first connection is up', async () => {
    open();
    const ws = await socket();
    terms[0]!.type('hi\r');
    expect(ws.sent).toEqual([]);
    ws.opened();
    expect(ws.sent).toEqual([{ type: 'input', data: 'hi\r' }]);
  });

  it('sends none of it when the view comes back for someone who may only watch now', async () => {
    open();
    const first = await socket();
    first.opened();
    reconnects(() => {
      first.ended(4410, 'node_offline');
      terms[0]!.type('hi\r');
    });
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.opened(false);
    expect(FakeSocket.all[1]!.sent).toEqual([]);
  });

  it('sends none of it after a minute, when the person may have gone on, and keeps a bounded amount', async () => {
    open();
    const ws = await socket();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    terms[0]!.type('old\r');
    clock.mockReturnValue(now + 60_000);
    for (let i = 0; i < 300; i++) terms[0]!.type('k');
    await note('Too much text was typed before the terminal was ready. Wait until it is ready, then type again.', 'alert');
    ws.opened();
    clock.mockRestore();
    expect(ws.sent).toHaveLength(255);
    expect(ws.sent).not.toContainEqual({ type: 'input', data: 'old\r' });
  });

  it('shows the bottom of the screen, where the line to type in is, after a card below the terminal comes or goes', async () => {
    /* A taller terminal takes rows back from its history and stays scrolled up: the program's input line fell below the window. */
    open();
    (await socket()).opened();
    moves.length = 0;
    for (const ro of FakeResizeObserver.all) ro.resized();
    expect(moves).toEqual(['fit', 'scrollToBottom']);
  });

  it('keeps the place in the history that the person scrolled up to when the terminal changes its size', async () => {
    open();
    (await socket()).opened();
    terms[0]!.buffer.active.viewportY = 120;
    moves.length = 0;
    for (const ro of FakeResizeObserver.all) ro.resized();
    expect(moves).toEqual(['fit', 'scrollToLine 120']);
    expect(terms[0]!.buffer.active.viewportY).toBe(120);
    await frame();
    expect(terms[0]!.buffer.active.viewportY).toBe(120);
  });

  it('keeps the line of the history the person reads when the terminal gets narrower and long lines wrap again', async () => {
    /* The view starts on the second row of a line that wraps at 100 columns, and 100 more lines of the history wrap at 50. */
    open();
    (await socket()).opened();
    const term = terms[0]!;
    term.wrapped.add(121);
    term.buffer.active.viewportY = 121;
    fitting.then = () => {
      term.cols = 50;
      for (const m of term.markers) m.line += 100;
    };
    moves.length = 0;
    for (const ro of FakeResizeObserver.all) ro.resized();
    expect(moves).toEqual(['fit', 'scrollToLine 222']);
    await frame();
    expect(term.markers.every(m => m.isDisposed)).toBe(true);
  });

  it('puts the view back on its line after the browser cut the page scroll of a wider terminal and xterm followed it', async () => {
    /* Wider, the lines take fewer rows: the page's scroll area shrinks, the browser cuts its scroll to the end, and xterm
       moves the view to the bottom once that scroll comes, after the terminal fit. */
    open();
    (await socket()).opened();
    const term = terms[0]!;
    term.buffer.active.viewportY = 120;
    for (const ro of FakeResizeObserver.all) ro.resized();
    term.buffer.active.viewportY = term.buffer.active.baseY;
    await frame();
    expect(term.buffer.active.viewportY).toBe(120);
    expect(term.markers.every(m => m.isDisposed)).toBe(true);
  });

  it('leaves the view where xterm put it when the line the person read was trimmed from the history', async () => {
    open();
    (await socket()).opened();
    const term = terms[0]!;
    term.buffer.active.viewportY = 3;
    fitting.then = () => term.markers.forEach(m => m.dispose());
    moves.length = 0;
    for (const ro of FakeResizeObserver.all) ro.resized();
    expect(moves).toEqual(['fit']);
  });

  it('stays at the bottom when the browser moved the view up on its own as the terminal grew', async () => {
    /* A taller box cuts the page's scroll of a view at the bottom, and xterm follows it up by the rows it gained. */
    open();
    (await socket()).opened();
    terms[0]!.buffer.active.viewportY = 188;
    const scrolled = terms[0]!.element.firstElementChild!;
    Object.defineProperties(scrolled, { scrollTop: { value: 2792 }, clientHeight: { value: 440 }, scrollHeight: { value: 3232 } });
    moves.length = 0;
    for (const ro of FakeResizeObserver.all) ro.resized();
    expect(moves).toEqual(['fit', 'scrollToBottom']);
  });

  it('leaves nothing of the terminal working after its window closes, five times over', async () => {
    /* xterm's timers from opening and from a new screen come after the window closed at once, and found it gone. */
    const user = userEvent.setup();
    open();
    for (let i = 0; i < 5; i++) {
      (await socket()).opened();
      await user.click(screen.getByRole('button', { name: 'Chat' }));
      await user.click(screen.getByRole('button', { name: 'Terminal' }));
      await waitFor(() => expect(FakeSocket.all).toHaveLength(i + 2));
    }
    /* Each closed terminal is gone and every timer xterm set for it has come. */
    await waitFor(() => expect(terms.slice(0, 5).every(term => term.disposed && term.pending === 0)).toBe(true));
    expect(late).toEqual([]);
  });

  it("tells the session the terminal's size once its first screen comes, after a card changed it while connecting", async () => {
    /* A resize while the socket still connects goes nowhere. The server says ready before the node holds the view, so a
       resize at ready can be lost too; the first screen comes from the view itself. */
    open();
    const ws = await socket();
    terms[0]!.resized(100, 13);
    ws.opened();
    expect(ws.sent).toEqual([]);
    ws.screen('screen for 30 rows');
    expect(ws.sent).toEqual([{ type: 'resize', cols: 100, rows: 13 }]);
    ws.screen('screen for 13 rows');
    expect(ws.sent).toHaveLength(1);
  });

  it('tells its size once when the session answers the resize at once with a new screen', async () => {
    open();
    const ws = await socket();
    terms[0]!.resized(100, 13);
    ws.opened();
    const sent = ws.send.bind(ws);
    ws.send = (data: string) => {
      sent(data);
      if (ws.sent.length < 5) ws.screen('screen for 13 rows');
    };
    ws.screen('screen for 30 rows');
    expect(ws.sent).toEqual([{ type: 'resize', cols: 100, rows: 13 }]);
  });

  it('sends no size when a card came and went while connecting, and the terminal is back at the size it asked for', async () => {
    open();
    const ws = await socket();
    terms[0]!.resized(100, 13);
    terms[0]!.resized(100, 30);
    ws.opened();
    ws.screen('screen for 30 rows');
    expect(ws.sent).toEqual([]);
  });

  it('opens no terminal for an agent whose node shows none, and says why, with the chat one click away', async () => {
    open(false);
    expect(await screen.findByText(/is asleep now/)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Terminal' })).toHaveTextContent(/is asleep now/);
    expect(FakeSocket.all).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Chat' })).toBeInTheDocument();
  });

  it('copies selected text on selection, Cmd+C, Ctrl+Shift+C and Ctrl+C without sending ^C or Escape to the program, and keeps Ctrl+C without selection', async () => {
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn((text: string) => { copied.push(text); return Promise.resolve(); }) },
    });
    open();
    const ws = await socket();
    ws.opened();
    const term = terms[0]!;

    /* Selecting with the mouse copies at once and never sends keys to the session. */
    term.selectText('selected line');
    expect(copied).toEqual(['selected line']);
    expect(ws.sent).toEqual([]);

    /* Cmd+C, Ctrl+Shift+C and Ctrl+C with a selection copy the selection and send nothing to the program. */
    term.pressKey({ key: 'c', metaKey: true });
    term.pressKey({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true });
    term.pressKey({ key: 'c', code: 'KeyC', ctrlKey: true });
    expect(copied).toEqual(['selected line', 'selected line', 'selected line', 'selected line']);
    expect(ws.sent).toEqual([]);

    /* Without a selection, Cmd+C and Ctrl+Shift+C still send nothing, while Ctrl+C sends ^C as before. */
    term.clearSelection();
    term.pressKey({ key: 'c', code: 'KeyC', metaKey: true });
    term.pressKey({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true });
    expect(ws.sent).toEqual([]);
    term.pressKey({ key: 'c', code: 'KeyC', ctrlKey: true });
    expect(ws.sent).toEqual([{ type: 'input', data: '\x03' }]);
  });

  it('copies from the right-click menu in English and Russian without sending ^C or Escape, and keeps mouse drag for selection while wheel still scrolls', async () => {
    const user = userEvent.setup();
    const copied: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn((text: string) => { copied.push(text); return Promise.resolve(); }) },
    });
    const { calls } = open(true, { busy: true, runningJobId: 'j1' });
    const ws = await socket();
    ws.opened();
    const term = terms[0]!;

    /* Even when tmux or the program turns mouse tracking on, plain mouse drags select text while wheel stays local. */
    term._core.coreMouseService.fireProtocol(23);
    expect(term._core._selectionService.enabled).toBe(true);
    expect(term._core._selectionService.shouldForceSelection(new MouseEvent('mousedown'))).toBe(true);
    expect(term._core.coreMouseService._protocols.DRAG!.events).toBe(0);
    term.type('\x1b[<0;10;5M');
    term.type('\x1b[<32;12;5M');
    term.type('\x1b[<0;12;5m');
    term.type('\x1b[<64;10;5M');
    expect(ws.sent).toEqual([]);
    ws.sent.length = 0;

    /* Right-click opens Copy, clicking it copies the selection and closes the menu, and Escape on an open menu neither stops the agent nor sends Escape. */
    term.selectText('from right click');
    copied.length = 0;
    fireEvent.contextMenu(term.element);
    const copyBtn = screen.getByRole('button', { name: 'Copy' });
    await user.click(copyBtn);
    expect(copied).toEqual(['from right click']);
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();

    fireEvent.contextMenu(term.element);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    await user.keyboard('a');
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();
    expect(ws.sent).toEqual([]);
    expect(calls.some(c => c.method === 'POST' && c.path === '/api/agents/orchestrator/stop')).toBe(false);

    fireEvent.contextMenu(term.element);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();

    cleanup();
    terms.length = 0;
    FakeSocket.all = [];
    localStorage.setItem('hh-lang', 'ru');
    open();
    const wsRu = await socket();
    wsRu.opened();
    const termRu = terms[0]!;
    termRu.selectText('русский текст');
    copied.length = 0;
    fireEvent.contextMenu(termRu.element);
    await user.click(screen.getByRole('button', { name: 'Копировать' }));
    expect(copied).toEqual(['русский текст']);
    localStorage.removeItem('hh-lang');
  });

  it('pastes with Ctrl+V on Windows and Linux through the browser, and leaves Ctrl+V to the program on a Mac', async () => {
    const platform = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
    open();
    const ws = await socket();
    ws.opened();
    const term = terms[0]!;
    try {
      for (const os of ['Win32', 'Linux x86_64']) {
        Object.defineProperty(navigator, 'platform', { configurable: true, value: os });
        /* The browser pastes into xterm, which hands the text on as typed; no ^V reaches the program. */
        const event = term.pressKey({ key: 'v', code: 'KeyV', ctrlKey: true });
        expect(event.defaultPrevented).toBe(false);
        expect(ws.sent).toEqual([]);
      }
      Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
      term.pressKey({ key: 'v', code: 'KeyV', ctrlKey: true });
      expect(ws.sent).toEqual([{ type: 'input', data: '\x16' }]);
    } finally {
      delete (navigator as { platform?: string }).platform;
      if (platform) Object.defineProperty(Navigator.prototype, 'platform', platform);
    }
  });

  it('pastes from the right-click menu in English and Russian, what the clipboard holds going to the program as typed', async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.resolve()), readText: vi.fn(() => Promise.resolve('code#state')) },
    });
    open();
    const ws = await socket();
    ws.opened();
    const term = terms[0]!;
    fireEvent.contextMenu(term.element);
    await user.click(screen.getByRole('button', { name: 'Paste' }));
    await waitFor(() => expect(ws.sent).toEqual([{ type: 'input', data: 'code#state' }]));
    expect(screen.queryByRole('button', { name: 'Paste' })).not.toBeInTheDocument();

    cleanup();
    terms.length = 0;
    FakeSocket.all = [];
    localStorage.setItem('hh-lang', 'ru');
    try {
      open();
      const wsRu = await socket();
      wsRu.opened();
      fireEvent.contextMenu(terms[0]!.element);
      await user.click(screen.getByRole('button', { name: 'Вставить' }));
      await waitFor(() => expect(wsRu.sent).toEqual([{ type: 'input', data: 'code#state' }]));
    } finally {
      localStorage.removeItem('hh-lang');
    }
  });

  it('gives the terminal dark scrollbar scheme, right cushion and sends the exact visible column count in resize', async () => {
    expect(decl('.t-term', 'color-scheme')).toBe('dark');
    expect(decl('.t-term', 'min-width')).toBe('0');
    expect(decl('.t-xterm', 'width')).toBe('100%');
    expect(decl('.t-term .xterm', 'padding')).toBe('6px 8px 4px 10px');

    const { container } = open();
    const ws = await socket();
    ws.opened();
    const term = terms[0]!;
    const box = container.querySelector<HTMLElement>('.t-xterm')!;
    const viewport = term.element.querySelector<HTMLElement>('.xterm-viewport')!;
    const scrollArea = document.createElement('div');
    scrollArea.className = 'xterm-scroll-area';
    viewport.appendChild(scrollArea);
    term.element.style.padding = '6px 8px 4px 10px';
    Object.assign(term._core, {
      _charSizeService: { width: 7.201171875, height: 14 },
      _renderService: { dimensions: { css: { cell: { width: 7.2, height: 14 } } }, clear() {} },
    });

    /* Narrow 375px box with 15px scrollbar: 375 - (10 + 8) - 15 = 342px -> floor(342 / 7.201171875) = 47 visible cols. */
    box.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 375, bottom: 500, width: 375, height: 500, toJSON: () => ({}) });
    viewport.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 375, bottom: 500, width: 375, height: 500, toJSON: () => ({}) });
    scrollArea.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 360, bottom: 1200, width: 360, height: 1200, toJSON: () => ({}) });

    for (const ro of FakeResizeObserver.all) ro.resized();
    expect(term.cols).toBe(47);
    expect(ws.sent).toEqual([{ type: 'resize', cols: 47, rows: 35 }]);
  });

  it('sends fewer columns to the session when its own box gets narrower with no change of the browser window, and more when it widens back', async () => {
    /* A side panel or a card beside the terminal takes room from its box alone: the browser window keeps its size. */
    const { container } = open();
    const ws = await socket();
    ws.opened();
    const term = terms[0]!;
    const box = container.querySelector<HTMLElement>('.t-xterm')!;
    const viewport = term.element.querySelector<HTMLElement>('.xterm-viewport')!;
    const scrollArea = document.createElement('div');
    scrollArea.className = 'xterm-scroll-area';
    viewport.appendChild(scrollArea);
    term.element.style.padding = '6px 8px 4px 10px';
    Object.assign(term._core, {
      _charSizeService: { width: 7.201171875, height: 14 },
      _renderService: { dimensions: { css: { cell: { width: 7.2, height: 14 } } }, clear() {} },
    });
    const wide = (width: number) => {
      const rect = (w: number, h: number) => () => ({ x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) });
      box.getBoundingClientRect = rect(width, 500);
      viewport.getBoundingClientRect = rect(width, 500);
      scrollArea.getBoundingClientRect = rect(width - 15, 1200);
      /* Only what watches the terminal's own box hears of it. */
      for (const ro of FakeResizeObserver.all) if (ro.targets.includes(box)) ro.resized();
    };
    const windowResized = vi.fn();
    window.addEventListener('resize', windowResized);

    /* (1000 - 18 - 15) / 7.201171875 = 134 columns; (820 - 18 - 15) / 7.201171875 = 109. */
    wide(1000);
    wide(820);
    wide(1000);
    window.removeEventListener('resize', windowResized);
    expect(windowResized).not.toHaveBeenCalled();
    expect(ws.sent).toEqual([
      { type: 'resize', cols: 134, rows: 35 },
      { type: 'resize', cols: 109, rows: 35 },
      { type: 'resize', cols: 134, rows: 35 },
    ]);
  });

  it('lets a person write messages without control of the program, and silently drops automatic terminal reports', async () => {
    const { container } = open();
    const ws = await socket();
    act(() => ws.opened(false, true));
    const term = terms[0]!;
    expect(term.options.disableStdin).toBe(false);
    term.type('hello\r');
    expect(ws.sent).toEqual([{ type: 'input', data: 'hello\r' }]);
    term.type('/login');
    expect(ws.sent).toHaveLength(1);
    await note("Only the owner of this agent's subscription can control its program. Ask the owner, or write an ordinary message.", 'alert');
    term.type('!rm');
    term.type('\x03');
    term.type('\x1b[A');
    expect(ws.sent).toHaveLength(1);
    term.type('\x1b[<64;10;5M');
    term.type('\x1b[I');
    term.type('\x1b[>0;276;0c');
    expect(ws.sent).toHaveLength(1);
    /* One note says it, at the foot, however many keys were refused. */
    expect(within(screen.getByRole('group', { name: 'Notes' })).getAllByRole('alert')).toHaveLength(1);
    expect(within(container.querySelector<HTMLElement>('.t-term')!).queryAllByRole('alert')).toHaveLength(0);
  });

  it('shows a refusal the server sends when access changed', async () => {
    open();
    const ws = await socket();
    act(() => ws.opened(false, true));
    ws.refused('message');
    await note('You cannot write to this agent. Ask someone who has access to its department.', 'alert');
  });

  it('checks input kept during reconnect against the rights the new view grants', async () => {
    open();
    const first = await socket();
    first.opened();
    reconnects(() => {
      first.ended(4410, 'node_offline');
      terms[0]!.type('hello\r');
      terms[0]!.type('/login\r');
    });
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.opened(false, true);
    expect(FakeSocket.all[1]!.sent).toEqual([{ type: 'input', data: 'hello\r' }]);
    await note("Only the owner of this agent's subscription can control its program. Ask the owner, or write an ordinary message.", 'alert');
  });
});


const png = (name = 'screen.png') => new File([new Uint8Array(64)], name, { type: 'image/png' });
const dragged = (...files: File[]) => ({ dataTransfer: { types: ['Files'], files, dropEffect: 'none' } });
const copied = (files: File[]) => ({ clipboardData: { files, types: ['Files'], getData: () => '' } });
const pictureUploads = (calls: ReturnType<typeof mockApi>) => calls.filter(c => c.method === 'POST' && c.path.startsWith('/api/agents/orchestrator/pictures'));

describe('pictures directly in the live terminal', () => {
  it('pastes a picture, uploads it and inserts the prepared path without Enter', async () => {
    const { container, calls } = open(true, {}, {
      'POST /api/agents/orchestrator/pictures?name=screen.png': [201, { id: 'p1', name: 'screen.png', insert: "'/home/agent/screen.png' " }],
    });
    const ws = await socket();
    act(() => ws.opened(false, true));
    fireEvent.paste(container.querySelector<HTMLElement>('.t-xterm')!, copied([png()]));
    await waitFor(() => expect(pictureUploads(calls)).toHaveLength(1));
    await note('The file path is in the terminal. Press Enter to send it.');
    expect(ws.sent).toEqual([{ type: 'input', data: "'/home/agent/screen.png' " }]);
    expect(pictureUploads(calls)).toHaveLength(1);
  });

  it('drops a picture and uses the fetch instruction with an older server', async () => {
    const { container, calls } = open(true, {}, {
      'POST /api/agents/orchestrator/pictures?name=screen.png': [201, { id: 'p1', name: 'screen.png' }],
    });
    const ws = await socket();
    act(() => ws.opened(false, true));
    fireEvent.drop(container.querySelector<HTMLElement>('.t-xterm')!, dragged(png()));
    expect(await screen.findByText('The file path is in the terminal. Press Enter to send it.')).toBeInTheDocument();
    expect(ws.sent).toEqual([{ type: 'input', data: 'screen.png: hh-fetch message p1' }]);
    expect(pictureUploads(calls)).toHaveLength(1);
  });

  it('does not upload or insert a picture without message access', async () => {
    const { container, calls } = open(true, {}, {
      'POST /api/agents/orchestrator/pictures?name=screen.png': [201, { id: 'p1', name: 'screen.png' }],
    });
    const ws = await socket();
    ws.opened(false, false);
    const terminal = container.querySelector<HTMLElement>('.t-xterm')!;
    fireEvent.paste(terminal, copied([png()]));
    fireEvent.drop(terminal, dragged(png()));
    await Promise.resolve();
    await Promise.resolve();
    expect(pictureUploads(calls)).toEqual([]);
    expect(ws.sent).toEqual([]);
  });

  it('shows an upload refusal and inserts nothing', async () => {
    const { container } = open(true, {}, {
      'POST /api/agents/orchestrator/pictures?name=screen.png': [403, { error: { code: 'forbidden', message: 'No access.', reason: 'forbidden' } }],
    });
    const ws = await socket();
    act(() => ws.opened(false, true));
    fireEvent.drop(container.querySelector<HTMLElement>('.t-xterm')!, dragged(png()));
    await note('No access.', 'alert');
    expect(ws.sent).toEqual([]);
  });
});


describe('a test terminal browser key', () => {
  const lease = {
    leaseId: '7b1b70f3-f209-40f0-90b0-c06a52ca02a2',
    expectedLeaseRevision: 3,
    registrationId: 'eb21e51a-f597-47ae-bf74-317e529be02e',
    expectedIdentityDigest: 'a'.repeat(64),
  };

  it('publishes only the frozen public binding and signs the exact bytes the server supplied', async () => {
    const key = await testTerminal.createTestTerminalBrowserKey(lease);
    expect(key.request).toEqual({
      ...lease,
      operationId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      browserPublicKey: {
        algorithm: 'P-256/SHA-256',
        kty: 'EC',
        crv: 'P-256',
        x: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        y: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      },
    });

    const challenge = new TextEncoder().encode('exact server challenge bytes');
    const signature = await key.sign(challenge);
    const { kty, crv, x, y } = key.request.browserPublicKey;
    const publicKey = await crypto.subtle.importKey('jwk', { kty, crv, x, y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, challenge)).toBe(true);
    expect(signature.byteLength).toBe(64);
  });
});

describe('a standalone test terminal', () => {
  const lease = {
    leaseId: '7b1b70f3-f209-40f0-90b0-c06a52ca02a2',
    expectedLeaseRevision: 3,
    registrationId: 'eb21e51a-f597-47ae-bf74-317e529be02e',
    expectedIdentityDigest: 'a'.repeat(64),
  };
  const viewId = '0e4a50f7-40e2-45d8-9f45-c8b7ef8f3d84';
  const firstNonceId = '6f1db92c-83c4-4e9d-b84d-c12b3e528c6a';
  const secondNonceId = 'f280f8a7-5c64-48f2-b78b-f93ce76a7220';
  const response = (nonceId: string, nonce: number): BindViewResponse => ({
    viewId,
    nonceId,
    challenge: encodeViewChallenge(new Uint8Array(32).fill(nonce)),
    role: 'observer',
    rights: { control: false, message: false },
  });

  function openStandalone(bindView: (request: BindViewRequest) => Promise<BindViewResponse>, onGone = vi.fn()) {
    const calls = mockApi({});
    const rendered = render(
      <LanguageProvider>
        <testTerminal.AgentTerminal path="/api/not-a-test-terminal" program="Claude" onGone={onGone} testSession={{ ...lease, bindView }} />
      </LanguageProvider>,
    );
    return { calls, rendered };
  }

  async function prove(ws: FakeSocket) {
    act(() => ws.connected());
    await waitFor(() => expect(ws.sent).toHaveLength(1));
    return ws.sent[0] as ViewProof;
  }

  it('binds an in-memory key, signs the exact challenge and keeps an observer strictly local', async () => {
    const bindResponse = response(firstNonceId, 7);
    const bindView = vi.fn<(request: BindViewRequest) => Promise<BindViewResponse>>(async () => bindResponse);
    const { calls, rendered } = openStandalone(bindView);
    const ws = await socket();
    expect(bindView).toHaveBeenCalledTimes(1);
    expect(ws.url).toBe(`ws://${location.host}/api/test-terminals/views/${viewId}/stream`);
    expect(ws.url).not.toContain('?');

    const proof = await prove(ws);
    expect(proof).toEqual({ type: 'proof', viewId, nonceId: firstNonceId, signature: expect.stringMatching(/^[A-Za-z0-9_-]{86}$/) });
    const request = bindView.mock.calls[0]![0];
    const { kty, crv, x, y } = request.browserPublicKey;
    const publicKey = await crypto.subtle.importKey('jwk', { kty, crv, x, y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      new Uint8Array(decodeViewSignature(proof.signature)),
      new Uint8Array(decodeViewChallenge(bindResponse.challenge)),
    )).toBe(true);

    act(() => {
      ws.ready(false, false);
      ws.testScreen('masked output');
    });
    const term = terms[0]!;
    expect(term.written).toEqual(['masked output']);
    const terminal = rendered.container.querySelector<HTMLElement>('.t-xterm')!;
    fireEvent.paste(terminal, copied([png()]));
    fireEvent.drop(terminal, dragged(png()));
    act(() => {
      term.type('ls\r\x03\x1b[I\x1b[>0;276;0c');
      term.resized(132, 40);
    });
    expect(term.wheel(-3)).toBe(false);
    expect(term.buffer.active.viewportY).toBe(197);
    await Promise.resolve();
    await Promise.resolve();
    expect(ws.sent).toEqual([proof]);
    expect(calls).toEqual([]);
  });

  it('renders no server frame before an accepted proof', async () => {
    const bindView = vi.fn<(request: BindViewRequest) => Promise<BindViewResponse>>(async () => response(firstNonceId, 7));
    const gone = vi.fn();
    openStandalone(bindView, gone);
    const ws = await socket();
    act(() => {
      ws.ready(false, false);
      ws.testScreen('unauthenticated');
      ws.testError('denied');
    });
    expect(terms[0]!.written).toEqual([]);
    expect(ws.sent).toEqual([]);
    act(() => ws.connected());
    await Promise.resolve();
    await Promise.resolve();
    expect(ws.sent).toEqual([]);
    act(() => ws.ended(4403, 'denied'));
    expect(gone).toHaveBeenCalledWith('denied');
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('rejects contradictory ready rights before the renderer and still sends only proof', async () => {
    const bindView = vi.fn<(request: BindViewRequest) => Promise<BindViewResponse>>(async () => response(firstNonceId, 7));
    const gone = vi.fn();
    openStandalone(bindView, gone);
    const ws = await socket();
    const proof = await prove(ws);
    act(() => {
      ws.ready(true, true);
      ws.testScreen('not allowed');
      terms[0]!.type('ls\r');
      terms[0]!.resized(132, 40);
    });
    expect(terms[0]!.written).toEqual([]);
    expect(ws.sent).toEqual([proof]);
    act(() => ws.ended(4500, 'unknown'));
    expect(gone).toHaveBeenCalledWith('unknown');
  });

  it.each([
    { reason: 'expired', code: 4408 },
    { reason: 'unavailable', code: 4503 },
  ] as const)('returns a post-proof $reason terminal state to its owner', async ({ reason, code }) => {
    const bindView = vi.fn<(request: BindViewRequest) => Promise<BindViewResponse>>(async () => response(firstNonceId, 7));
    const gone = vi.fn();
    openStandalone(bindView, gone);
    const ws = await socket();
    await prove(ws);
    act(() => ws.ready(false, false));
    act(() => ws.testError(reason));
    act(() => ws.ended(code, reason));
    expect(gone).toHaveBeenCalledWith(reason);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('does not reconnect itself and uses a fresh key, nonce and proof on explicit remount', async () => {
    const responses = [response(firstNonceId, 7), response(secondNonceId, 8)];
    const requests: BindViewRequest[] = [];
    const bindView = vi.fn(async (request: BindViewRequest) => {
      requests.push(request);
      return responses[requests.length - 1]!;
    });
    const gone = vi.fn();
    const first = openStandalone(bindView, gone);
    const firstSocket = await socket();
    const firstProof = await prove(firstSocket);
    act(() => firstSocket.ready(false, false));
    act(() => terms[0]!.type('never replay this'));

    vi.useFakeTimers();
    try {
      act(() => {
        firstSocket.ended(1006, '');
        vi.advanceTimersByTime(11_000);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(gone).toHaveBeenCalledWith('unknown');
    expect(FakeSocket.all).toHaveLength(1);
    first.rendered.unmount();

    openStandalone(bindView, gone);
    await waitFor(() => expect(FakeSocket.all).toHaveLength(2));
    const secondSocket = FakeSocket.all[1]!;
    const secondProof = await prove(secondSocket);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.operationId).not.toBe(requests[0]!.operationId);
    expect(requests[1]!.browserPublicKey).not.toEqual(requests[0]!.browserPublicKey);
    expect(secondProof.nonceId).toBe(secondNonceId);
    expect(secondProof.signature).not.toBe(firstProof.signature);
    expect(secondSocket.url).toBe(`ws://${location.host}/api/test-terminals/views/${viewId}/stream`);
    expect(secondSocket.sent).toEqual([secondProof]);
  });
});
