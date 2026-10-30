import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITerminalOptions, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';

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

type Props = { agentId: string; onGone(): void };

/* An agent's live terminal: its session on the node, as it is, with the person's keys going back to it. */
export function AgentTerminal({ agentId, onGone }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const gone = useRef(onGone);
  gone.current = onGone;

  useEffect(() => {
    const term = new Terminal(OPTIONS);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current!);
    fit.fit();
    let socket: WebSocket | null = null;
    let ended = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let tries = 0;
    const send = (m: unknown) => socket?.readyState === 1 && socket.send(JSON.stringify(m));

    const connect = () => {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${scheme}://${location.host}/api/agents/${agentId}/terminal?cols=${term.cols}&rows=${term.rows}`);
      socket = ws;
      ws.onmessage = e => {
        const m = JSON.parse(String(e.data)) as { type: string; data?: string; write?: boolean };
        /* The session draws its whole screen for each new view. Only its subscription's owner types into it. */
        if (m.type === 'ready') {
          tries = 0;
          term.reset();
          term.options.disableStdin = !m.write;
        }
        if (m.type === 'data' && m.data) term.write(m.data);
      };
      ws.onclose = e => {
        if (ended || socket !== ws) return;
        if (e.code === NO_TERMINAL || e.code === NO_ACCESS) return gone.current();
        retry = setTimeout(connect, Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** tries++));
      };
    };

    term.onData(data => {
      if (term.options.disableStdin) return;
      for (let i = 0; i < data.length; i += PIECE) send({ type: 'input', data: data.slice(i, i + PIECE) });
    });
    term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => fit.fit());
    resized?.observe(box.current!);
    connect();
    term.focus();

    return () => {
      ended = true;
      if (retry) clearTimeout(retry);
      socket?.close();
      resized?.disconnect();
      term.dispose();
    };
  }, [agentId]);

  return <div className="t-term" ref={box} />;
}
