import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITerminalOptions, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';

/* Ivan's iTerm2 profile in dark mode, which the terminal repeats on any page: Claude Code and Codex run their dark theme,
   which a light background would wash out. */
const ANSI = ['#14191e', '#b43c2a', '#00c200', '#c7c400', '#2744c7', '#c040be', '#00c5c7', '#c7c7c7', '#686868', '#dd7975', '#58e790', '#ece100', '#a7abf2', '#e17ee1', '#60fdff', '#ffffff'];
const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;
const COLORS = Object.fromEntries(ANSI.map((c, i) => [i < 8 ? NAMES[i]! : `bright${NAMES[i - 8]![0]!.toUpperCase()}${NAMES[i - 8]!.slice(1)}`, c]));
const THEME: ITheme = { ...COLORS, background: '#15191f', foreground: '#dcdcdc', cursor: '#ffffff', cursorAccent: '#000000', selectionBackground: '#b3d7ff', selectionForeground: '#000000' };

const OPTIONS: ITerminalOptions = {
  fontFamily: 'Monaco, Menlo, "DejaVu Sans Mono", monospace',
  fontSize: 12,
  lineHeight: 1,
  letterSpacing: 0,
  fontWeight: 'normal',
  fontWeightBold: 'bold',
  drawBoldTextInBrightColors: true,
  cursorStyle: 'block',
  cursorBlink: false,
  scrollback: 5000,
  theme: THEME,
};

/* What one frame of keys or a paste carries; the server takes up to 64 KB. */
const PIECE = 16_384;
const RETRY_MS = 500;
const RETRY_MAX_MS = 10_000;
/* How a view ends: the node cannot show one, or the person may no longer reach the agent. */
const NO_TERMINAL = 4404;
const NO_ACCESS = 4403;

type Props = { agentId: string; program: string; onGone(): void };
type Frame = { type: string; data?: string; write?: boolean; running?: boolean };
type Size = { cols: number; rows: number };

/* One view of an agent's session: its socket, how many times it tried again, and whether the node said if the program is up. */
type View = {
  agentId: string;
  term: Terminal;
  setUp(up: boolean): void;
  gone(): void;
  socket: WebSocket | null;
  ended: boolean;
  retry: ReturnType<typeof setTimeout> | null;
  tries: number;
  told: boolean;
};

function send(view: View, m: unknown) {
  if (view.socket?.readyState === 1) view.socket.send(JSON.stringify(m));
}

function connect(view: View) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const asked: Size = { cols: view.term.cols, rows: view.term.rows };
  const ws = new WebSocket(`${scheme}://${location.host}/api/agents/${view.agentId}/terminal?cols=${asked.cols}&rows=${asked.rows}`);
  view.socket = ws;
  ws.onmessage = e => receive(view, JSON.parse(String(e.data)) as Frame, asked);
  ws.onclose = e => closed(view, ws, e.code);
}

/* The session draws its whole screen for each new view. Only its subscription's owner types into it. The node says
   whether the program is up before it sends the screen; one that says nothing, as for a watcher of an agent that
   sleeps or a node from before, shows its screen as it comes. */
function receive(view: View, m: Frame, asked: Size) {
  if (m.type === 'ready') opened(view, m, asked);
  if (m.type === 'program') {
    view.told = true;
    view.setUp(Boolean(m.running));
  }
  if (m.type === 'data' && m.data) {
    if (!view.told) view.setUp(true);
    view.term.write(m.data);
  }
}

function opened(view: View, m: Frame, asked: Size) {
  const { term } = view;
  view.tries = 0;
  view.told = false;
  term.reset();
  term.options.disableStdin = !m.write;
  /* A card that came or went while the socket connected changed the size the address carried, and its resize was lost. */
  if (term.cols !== asked.cols || term.rows !== asked.rows) send(view, { type: 'resize', cols: term.cols, rows: term.rows });
}

function closed(view: View, ws: WebSocket, code: number) {
  if (view.ended || view.socket !== ws) return;
  view.setUp(false);
  if (code === NO_TERMINAL || code === NO_ACCESS) return view.gone();
  view.retry = setTimeout(() => connect(view), Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** view.tries++));
}

function typed(view: View, data: string) {
  if (view.term.options.disableStdin) return;
  for (let i = 0; i < data.length; i += PIECE) send(view, { type: 'input', data: data.slice(i, i + PIECE) });
}

/* A card below the terminal coming or going changes its height. Rows it gains come back from the history with the view
   left where it was, which hides the program's line to type in below the window, so the view goes back to the bottom. */
function followSize(box: HTMLElement, term: Terminal, fit: FitAddon): ResizeObserver | null {
  if (typeof ResizeObserver === 'undefined') return null;
  const observer = new ResizeObserver(() => {
    fit.fit();
    term.scrollToBottom();
  });
  observer.observe(box);
  return observer;
}

function end(view: View, resized: ResizeObserver | null) {
  view.ended = true;
  if (view.retry) clearTimeout(view.retry);
  view.socket?.close();
  resized?.disconnect();
  view.term.dispose();
}

/* An agent's live terminal: its session on the node, as it is, with the person's keys going back to it. */
export function AgentTerminal({ agentId, program, onGone }: Props) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  /* Until the view is open and the program is up, a loader hides what the session shows meanwhile. */
  const [up, setUp] = useState(false);
  const gone = useRef(onGone);
  gone.current = onGone;

  useEffect(() => {
    const term = new Terminal(OPTIONS);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current!);
    fit.fit();
    const view: View = { agentId, term, setUp, gone: () => gone.current(), socket: null, ended: false, retry: null, tries: 0, told: false };
    term.onData(data => typed(view, data));
    term.onResize(({ cols, rows }) => send(view, { type: 'resize', cols, rows }));
    const resized = followSize(box.current!, term, fit);
    connect(view);
    term.focus();
    return () => end(view, resized);
  }, [agentId]);

  return (
    <div className="t-term">
      <div className="t-xterm" ref={box} />
      {!up && (
        <div className="t-load" role="status">
          <span className="spinner" aria-hidden="true" />
          <span>{t.window.opening(program)}</span>
        </div>
      )}
    </div>
  );
}
