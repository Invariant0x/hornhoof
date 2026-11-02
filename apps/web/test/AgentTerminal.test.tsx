import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { AgentWindow } from '../src/screens/AgentWindow';
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
  buffer: { active: { viewportY: number; baseY: number; cursorY: number } };
  element: HTMLElement;
  wrapped: Set<number>;
  markers: Marker[];
  type(data: string): void;
  resized(cols: number, rows: number): void;
  disposed: boolean;
};

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    written: string[] = [];
    cols = 100;
    rows = 30;
    disposed = false;
    /* The history above the screen, and the line the view starts at: at the bottom when they are equal. */
    /* Rows that go on the line above them, as xterm wraps a line longer than the terminal is wide. */
    wrapped = new Set<number>();
    markers: Marker[] = [];
    buffer = { active: { viewportY: 200, baseY: 200, cursorY: 29, getLine: (y: number) => ({ isWrapped: this.wrapped.has(y) }) } };
    /* Where xterm scrolls its view in the page; jsdom lays nothing out, so a test sets where it stands. */
    element = Object.assign(document.createElement('div'), { innerHTML: '<div class="xterm-viewport"></div>' });
    private onKeys: ((d: string) => void)[] = [];
    private onSize: ((s: { cols: number; rows: number }) => void)[] = [];
    constructor(options: Record<string, unknown>) {
      this.options = options;
      terms.push(this as unknown as FakeTerminal);
    }
    loadAddon() {}
    /* xterm syncs its scroll area on a timer once it opens and on the next frame after a reset, and does not cancel them. */
    open() {
      setTimeout(() => this.synced('open'));
    }
    focus() {}
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
      requestAnimationFrame(() => this.synced('reset'));
    }
    private synced(after: string) {
      if (this.disposed) late.push(after);
    }
    write(data: string) {
      this.written.push(data);
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
    resized(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      for (const fn of this.onSize) fn({ cols, rows });
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {
      moves.push('fit');
      fitting.then?.();
    }
  },
}));

/* The browser tells of a new size of the terminal's box; jsdom has no layout, so a test says when. */
class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  constructor(private fn: () => void) {
    FakeResizeObserver.all.push(this);
  }
  observe() {}
  disconnect() {}
  resized() {
    this.fn();
  }
}

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
  opened(write = true) {
    this.readyState = 1;
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ type: 'ready', write }) });
  }
  screen(data: string) {
    this.onmessage?.({ data: JSON.stringify({ type: 'data', data }) });
  }
  program(running: boolean) {
    this.onmessage?.({ data: JSON.stringify({ type: 'program', running }) });
  }
  ended(code: number, reason: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const EVENTS = '/api/agents/orchestrator/events';
const READY: OrchestratorState = { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 };
const LOG: EventView[] = [{ seq: 1, kind: 'text', data: { kind: 'text', text: 'Hello from the log' }, jobId: 'j1', person: null, at: '2026-10-30T10:00:00Z' }];

function open(terminal = true, more: Partial<OrchestratorState> = {}) {
  const calls = mockApi({
    [`GET ${EVENTS}?after=0`]: [200, { events: LOG, state: { ...READY, ...more, terminal } }],
    [`GET ${EVENTS}?after=1`]: [200, { events: [], state: { ...READY, ...more, terminal } }],
    'POST /api/agents/orchestrator/start': [200, { started: false }],
    'POST /api/agents/orchestrator/stop': [202],
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

const socket = async () => {
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  return FakeSocket.all.at(-1)!;
};

beforeEach(() => {
  terms.length = 0;
  moves.length = 0;
  late.length = 0;
  fitting.then = null;
  FakeSocket.all = [];
  FakeResizeObserver.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
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
    open();
    const ws = await socket();
    expect(screen.getByRole('status')).toHaveTextContent('Opening the Claude terminal…');
    ws.opened();
    ws.program(false);
    expect(screen.getByRole('status')).toHaveTextContent('Opening the Claude terminal…');
    ws.program(true);
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it("looks like Ivan's iTerm2 in dark mode, on a light page too, since the programs inside run their dark theme", async () => {
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

  it('shows the log with what was said, and the terminal again', async () => {
    const user = userEvent.setup();
    open();
    const ws = await socket();
    await user.click(screen.getByRole('button', { name: 'Log' }));
    expect(await screen.findByText('Hello from the log')).toBeInTheDocument();
    expect(ws.readyState).toBe(3);
    await waitFor(() => expect(terms[0]!.disposed).toBe(true));
    await user.click(screen.getByRole('button', { name: 'Terminal' }));
    await waitFor(() => expect(FakeSocket.all).toHaveLength(2));
  });

  it('shows the log when the node cannot show a terminal', async () => {
    open();
    (await socket()).ended(4404, 'no_terminal');
    expect(await screen.findByText('Hello from the log')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Terminal' })).not.toBeInTheDocument();
  });

  it('connects again when the machine went away for a moment, and starts the screen over', async () => {
    open();
    const first = await socket();
    first.opened();
    first.screen('old screen');
    first.ended(4410, 'node_offline');
    await waitFor(() => expect(FakeSocket.all).toHaveLength(2), { timeout: 3000 });
    FakeSocket.all[1]!.opened();
    FakeSocket.all[1]!.screen('new screen');
    expect(terms[0]!.written).toEqual(['new screen']);
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
      await user.click(screen.getByRole('button', { name: 'Log' }));
      await user.click(screen.getByRole('button', { name: 'Terminal' }));
      await waitFor(() => expect(FakeSocket.all).toHaveLength(i + 2));
    }
    await waitFor(() => expect(terms.slice(0, 5).every(term => term.disposed)).toBe(true));
    await new Promise(r => setTimeout(r, 50));
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

  it('keeps the log for agents whose node shows no terminal', async () => {
    open(false);
    expect(await screen.findByText('Hello from the log')).toBeInTheDocument();
    expect(FakeSocket.all).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Log' })).not.toBeInTheDocument();
  });
});
