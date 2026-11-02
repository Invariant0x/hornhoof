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
type FakeTerminal = { options: Record<string, unknown>; written: string[]; cols: number; rows: number; type(data: string): void; resized(cols: number, rows: number): void; disposed: boolean };

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown>;
    written: string[] = [];
    cols = 100;
    rows = 30;
    disposed = false;
    private onKeys: ((d: string) => void)[] = [];
    private onSize: ((s: { cols: number; rows: number }) => void)[] = [];
    constructor(options: Record<string, unknown>) {
      this.options = options;
      terms.push(this as unknown as FakeTerminal);
    }
    loadAddon() {}
    open() {}
    focus() {}
    reset() {
      this.written = [];
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
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));

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

const socket = async () => {
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
  return FakeSocket.all.at(-1)!;
};

beforeEach(() => {
  terms.length = 0;
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
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
    expect(terms[0]!.disposed).toBe(true);
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

  it('keeps the log for agents whose node shows no terminal', async () => {
    open(false);
    expect(await screen.findByText('Hello from the log')).toBeInTheDocument();
    expect(FakeSocket.all).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Log' })).not.toBeInTheDocument();
  });
});
