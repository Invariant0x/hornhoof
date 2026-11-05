import { Terminal, type ITerminalOptions, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useT } from '../i18n';
import { fitTerminal, observeTerminalFit } from './terminal-fit';
import { attachTerminalScroll, restoreLiveTerminal } from './terminal-scroll';
import { isHidden } from './visibility';

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
  macOptionClickForcesSelection: true,
  rightClickSelectsWord: false,
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

/* path: the view's address on the server, such as /api/agents/<id>/terminal; the terminal's size goes after it.
   watching: this person types elsewhere, so the terminal leaves the focus there as it opens. */
type Props = { path: string; program: string; onGone(): void; watching?: boolean };
type Size = { cols: number; rows: number };
type Frame = { type: string; data?: string; write?: boolean; running?: boolean };
type Send = (m: unknown) => void;
/* What one view of the session learned so far. */
type View = { term: Terminal; send: Send; setUp(up: boolean): void; asked: Size; told: boolean; unconfirmed: Size | null; ready(): void };

/* A card that came or went while the view connected changed the terminal's size, and that resize was lost: sent before
   the socket opened, or after the server said ready but before the node held the view. The session's first screen comes
   from the view itself, so then the terminal tells its size once, if it is not the one the view was opened at. */
function confirmSize(term: Terminal, opened: Size | null, send: Send) {
  if (opened && (term.cols !== opened.cols || term.rows !== opened.rows)) send({ type: 'resize', cols: term.cols, rows: term.rows });
}

/* The session draws its whole screen for each new view. Only its subscription's owner types into it. The node says
   whether the program is up before it sends the screen; one that says nothing, as for a watcher of an agent that sleeps
   or a node from before, shows its screen as it comes. */
function received(view: View, m: Frame) {
  if (m.type === 'ready') {
    view.ready();
    view.told = false;
    restoreLiveTerminal(view.term);
    view.term.reset();
    view.term.options.disableStdin = !m.write;
    view.unconfirmed = view.asked;
  }
  if (m.type === 'program') {
    view.told = true;
    view.setUp(Boolean(m.running));
  }
  if (m.type === 'data' && m.data) screenCame(view, m.data);
}

function screenCame(view: View, data: string) {
  if (!view.told) view.setUp(true);
  restoreLiveTerminal(view.term);
  view.term.write(data);
  /* Forgotten before the resize goes, since the screen it brings may come before send returns. */
  const opened = view.unconfirmed;
  view.unconfirmed = null;
  confirmSize(view.term, opened, view.send);
}

function viewUrl(path: string, size: Size) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}${path}${path.includes('?') ? '&' : '?'}cols=${size.cols}&rows=${size.rows}`;
}

/* The node cannot show a view, or the person may no longer reach the agent: trying again changes nothing. */
const final = (code: number) => code === NO_TERMINAL || code === NO_ACCESS;

/* The view of the session over a socket, opened again after a machine went away for a moment, until it ends. */
function connectView(term: Terminal, path: string, setUp: (up: boolean) => void, gone: () => void) {
  let socket: WebSocket | null = null;
  let ended = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let tries = 0;
  const send: Send = m => socket?.readyState === 1 && socket.send(JSON.stringify(m));
  const connect = () => {
    const view: View = { term, send, setUp, asked: { cols: term.cols, rows: term.rows }, told: false, unconfirmed: null, ready: () => (tries = 0) };
    const ws = new WebSocket(viewUrl(path, view.asked));
    socket = ws;
    ws.onmessage = e => received(view, JSON.parse(String(e.data)) as Frame);
    ws.onclose = e => {
      if (ended || socket !== ws) return;
      setUp(false);
      if (final(e.code)) return gone();
      retry = setTimeout(connect, Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** tries++));
    };
  };
  connect();
  return {
    send,
    end() {
      ended = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    },
  };
}

/* Mouse reports are for selection and local history, never for the program. */
const SGR_MOUSE = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;

function isMouseReport(data: string) {
  return SGR_MOUSE.test(data);
}

function copyByCommand(text: string) {
  if (typeof document.execCommand !== 'function') return;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
  } finally {
    area.remove();
  }
}

function copyText(text: string) {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => copyByCommand(text));
    return;
  }
  copyByCommand(text);
}

type XtermCore = {
  _selectionService: { shouldForceSelection: (e: MouseEvent) => boolean; enable(): void };
  coreMouseService: {
    _protocols: Record<string, { events: number }>;
    onProtocolChange: (fn: (events: number) => void) => { dispose(): void };
  };
};

/* Mouse drag selects text and the wheel scrolls in the browser, so no mouse protocol events go to the node. */
function keepSelecting(term: Terminal) {
  const { _selectionService: selection, coreMouseService: mouse } = (term as unknown as { _core: XtermCore })._core;
  for (const p of Object.values(mouse._protocols)) p.events = 0;
  selection.shouldForceSelection = () => true;
  const enable = () => {
    selection.enable();
    term.element!.classList.remove('enable-mouse-events');
  };
  enable();
  mouse.onProtocolChange(enable);
}

function isKeyC(e: KeyboardEvent) {
  return e.code === 'KeyC' || e.key.toLowerCase() === 'c';
}

function isCmdC(e: KeyboardEvent) {
  return e.metaKey && !e.ctrlKey && !e.shiftKey;
}

function isCtrlC(e: KeyboardEvent, hasSelection: boolean) {
  return e.ctrlKey && !e.metaKey && (e.shiftKey || hasSelection);
}

function isCopyChord(e: KeyboardEvent, hasSelection: boolean) {
  return isKeyC(e) && !e.altKey && (isCmdC(e) || isCtrlC(e, hasSelection));
}

function selectedText(term: Terminal | null) {
  return term?.hasSelection() ? term.getSelection() : '';
}

function bindCopy(term: Terminal) {
  term.onSelectionChange(() => {
    const text = selectedText(term);
    if (text) copyText(text);
  });
  term.attachCustomKeyEventHandler(e => {
    const text = selectedText(term);
    if (!isCopyChord(e, text.length > 0)) return true;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'keydown' && text) copyText(text);
    return false;
  });
}

type MenuState = { x: number; y: number; text: string };

function menuPlace(e: ReactMouseEvent<HTMLDivElement>, text: string): MenuState {
  const rect = e.currentTarget.getBoundingClientRect();
  const x = Math.max(8, Math.min(e.clientX - rect.left, Math.max(8, (rect.width || 240) - 120)));
  const y = Math.max(8, Math.min(e.clientY - rect.top, Math.max(8, (rect.height || 160) - 44)));
  return { x, y, text };
}

function openMenu(e: ReactMouseEvent<HTMLDivElement>, term: Terminal | null, setMenu: (m: MenuState) => void) {
  e.preventDefault();
  e.stopPropagation();
  setMenu(menuPlace(e, selectedText(term)));
}

const menuTakesEscape = (e: KeyboardEvent, term: Terminal | null): boolean => e.key === 'Escape' && !isHidden(term?.element);

function closeMenuOnKey(e: KeyboardEvent, term: Terminal | null, close: () => void) {
  if (!menuTakesEscape(e, term)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  close();
  term?.focus();
}

function closeMenuOnDown(e: MouseEvent, close: () => void) {
  if ((e.target as Element | null)?.closest('.t-menu')) return;
  close();
}

function useMenuDismiss(open: boolean, termRef: { current: Terminal | null }, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => closeMenuOnKey(e, termRef.current, close);
    const onDown = (e: MouseEvent) => closeMenuOnDown(e, close);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [open, termRef, close]);
}

type CopyMenuProps = {
  menu: MenuState | null;
  termRef: { current: Terminal | null };
  onClose(): void;
  label: string;
};

function CopyMenu({ menu, termRef, onClose, label }: CopyMenuProps) {
  useMenuDismiss(menu !== null, termRef, onClose);
  if (!menu) return null;
  return (
    <div className="t-menu glass" role="menu" style={{ left: menu.x, top: menu.y }}>
      <button
        className="t-copy"
        type="button"
        disabled={!menu.text}
        onMouseDown={e => e.preventDefault()}
        onClick={() => {
          copyText(selectedText(termRef.current) || menu.text);
          onClose();
          termRef.current?.focus();
        }}
      >
        {label}
      </button>
    </div>
  );
}

function shouldIgnoreInput(term: Terminal, data: string) {
  return Boolean(term.options.disableStdin) || isMouseReport(data);
}

/* What the person types goes to the session in pieces the server takes, and so does each new size of the terminal. */
function forward(term: Terminal, send: Send) {
  term.onData(data => {
    if (shouldIgnoreInput(term, data)) return;
    for (let i = 0; i < data.length; i += PIECE) send({ type: 'input', data: data.slice(i, i + PIECE) });
  });
  term.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }));
}

/* The page's own scroll of the view stands at its end. A taller box cuts that scroll for a view at the bottom before the
   terminal fits, and xterm follows the page up by the rows the box gained, so its buffer alone no longer tells. */
function pageAtBottom(scrolled: Element | null | undefined) {
  return !!scrolled && scrolled.scrollHeight > scrolled.clientHeight && scrolled.scrollTop + scrolled.clientHeight >= scrolled.scrollHeight - 1;
}

/* The line of the history the view starts at, held by a marker xterm moves with it as lines wrap again for a new width
   and drops when the history is trimmed, and how far into that line the view starts, in cells. */
function anchor(term: Terminal) {
  const buffer = term.buffer.active;
  let start = buffer.viewportY;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  return { marker: term.registerMarker(start - buffer.baseY - buffer.cursorY), cells: (buffer.viewportY - start) * term.cols };
}

/* Wider, the lines take fewer rows and the page's scroll area shrinks: the browser cuts its scroll, and xterm follows that
   scroll once it comes, after the terminal fit. So the view goes back to its line on the next frame as well. */
function scrollToAnchor(term: Terminal, { marker, cells }: ReturnType<typeof anchor>) {
  const back = () => marker && !marker.isDisposed && term.scrollToLine(marker.line + Math.floor(cells / term.cols));
  back();
  requestAnimationFrame(() => {
    back();
    marker?.dispose();
  });
}

/* A card below the terminal coming or going changes its height, and a narrower or wider window its width. Rows it gains
   come back from the history and lines wrap again, which moves the view and hides the program's line to type in below
   the window, so a view at the bottom stays there, and a view the person scrolled up into the history keeps its line. */
function fitKeepingPlace(term: Terminal, box: HTMLElement) {
  const { viewportY, baseY } = term.buffer.active;
  if (viewportY >= baseY || pageAtBottom(term.element?.querySelector('.xterm-viewport'))) {
    fitTerminal(term, box);
    return term.scrollToBottom();
  }
  const place = anchor(term);
  fitTerminal(term, box);
  scrollToAnchor(term, place);
}

function keepFitted(term: Terminal, box: HTMLElement) {
  return observeTerminalFit(term, box, () => fitKeepingPlace(term, box));
}

/* xterm syncs its scroll area on a timer once it opens and on the next frame after a reset, and does not cancel them on
   dispose; one that comes after it reads the renderer that is gone. So the terminal leaves the page at once and goes
   after both. */
function disposeLater(term: Terminal) {
  term.element?.remove();
  requestAnimationFrame(() => setTimeout(() => term.dispose()));
}

/* A live terminal: an agent's session on the node, or a plan's sign-in, as it is, with the person's keys going back to it. */
export function AgentTerminal({ path, program, onGone, watching = false }: Props) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  /* Until the view is open and the program is up, a loader hides what the session shows meanwhile. */
  const [up, setUp] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const gone = useRef(onGone);
  gone.current = onGone;
  const leavesFocus = useRef(watching);
  leavesFocus.current = watching;

  useEffect(() => {
    const term = new Terminal(OPTIONS);
    termRef.current = term;
    const container = box.current!;
    term.open(container);
    keepSelecting(term);
    attachTerminalScroll(term);
    bindCopy(term);
    fitTerminal(term, container);
    const view = connectView(term, path, setUp, () => gone.current());
    forward(term, view.send);
    const unfit = keepFitted(term, container);
    if (!leavesFocus.current) term.focus();
    return () => {
      termRef.current = null;
      view.end();
      unfit();
      disposeLater(term);
    };
  }, [path]);

  return (
    <div className="t-term" onContextMenu={e => openMenu(e, termRef.current, setMenu)}>
      <div className="t-xterm" ref={box} />
      <CopyMenu menu={menu} termRef={termRef} onClose={() => setMenu(null)} label={t.common.copy} />
      {!up && (
        <div className="t-load" role="status">
          <span className="spinner" aria-hidden="true" />
          <span>{t.window.opening(program)}</span>
        </div>
      )}
    </div>
  );
}
