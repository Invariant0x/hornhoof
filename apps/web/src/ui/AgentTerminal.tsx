import { Terminal, type ITerminalOptions, type ITheme } from '@xterm/xterm';
import { BindViewResponse, decodeViewChallenge, encodeViewSignature, isTestViewReady, TestTerminalClose, TestTerminalServerFrame, ViewProof, type BindViewRequest } from '@hornhoof/protocol';
import '@xterm/xterm/css/xterm.css';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { errorText, useT, type Messages } from '../i18n';
import { activeLook, subscribeSkins } from '../skins/store';
import { usePictureDrop } from './MessagePictures';
import { fitTerminal, measureGlyphsExactly, observeTerminalFit } from './terminal-fit';
import { isBracketedPaste, TerminalInput, type InputRefusal, type TerminalRights } from './terminal-input';
import { uploadTerminalPictures } from './terminal-pictures';
import { attachTerminalScroll, readingHistoryLine, restoreHistoryLine, restoreLiveTerminal, writeTerminalData } from './terminal-scroll';
import { isHidden } from './visibility';
import { WindowFoot, type WindowNote } from './WindowNotes';
import { disposeTerminal } from './xterm-release';

/* Dark terminal palette repeated on any page: Claude Code and Codex run their dark theme,
   which a light background would wash out. */
const ANSI = ['#14191e', '#b43c2a', '#00c200', '#c7c400', '#2744c7', '#c040be', '#00c5c7', '#c7c7c7', '#686868', '#dd7975', '#58e790', '#ece100', '#a7abf2', '#e17ee1', '#60fdff', '#ffffff'];
const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'] as const;
const ansiPalette = (list: readonly string[]): Partial<ITheme> =>
  Object.fromEntries(list.slice(0, 16).map((c, i) => [i < 8 ? NAMES[i]! : `bright${NAMES[i - 8]![0]!.toUpperCase()}${NAMES[i - 8]!.slice(1)}`, c]));
const THEME: ITheme = { ...ansiPalette(ANSI), background: '#15191f', foreground: '#dcdcdc', cursor: '#ffffff', cursorAccent: '#000000', selectionBackground: '#b3d7ff', selectionForeground: '#000000' };

/* Theme-specific dark terminal surface, ink and ANSI colours when the active theme declares them, else the default dark console. */
function terminalTheme(): ITheme {
  const custom = activeLook().terminal;
  if (!custom) return THEME;
  const overrides = Object.fromEntries(
    [
      ['background', custom.bg],
      ['foreground', custom.ink],
      ['cursor', custom.cursor],
      ['cursorAccent', custom.cursorAccent],
      ['selectionBackground', custom.selection],
      ['selectionForeground', custom.selectionInk],
    ].filter(([, value]) => value !== undefined),
  );
  return { ...THEME, ...(custom.ansi ? ansiPalette(custom.ansi) : {}), ...overrides };
}

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
/* Keys typed while the view has no connection wait for it, a bounded amount: after a minute they do not go to the program. */
const KEPT_KEYS = 256;
const KEPT_MS = 60_000;
const RETRY_MS = 500;
const RETRY_MAX_MS = 10_000;
const HISTORY_HEAD = '\x1b7\x1b[0m\x1b[1;2r';
const HISTORY_TAIL = '\x1b[r\x1b8';
/* How long a reconnected view holds a history-only prefix while waiting for the attached screen redraw. */
const RECONNECT_HOLD_MS = 100;
/* How a view ends: the node cannot show one, or the person may no longer reach the agent. */
const NO_TERMINAL = 4404;
const NO_ACCESS = 4403;

/* path: the view's address on the server, such as /api/agents/<id>/terminal; the terminal's size goes after it.
   watching: this person types elsewhere, so the terminal leaves the focus there as it opens. */
export type TestTerminalGoneReason = 'denied' | 'expired' | 'unavailable' | 'unknown';
type TestTerminalLease = {
  leaseId: string;
  expectedLeaseRevision: number;
  registrationId: string;
  expectedIdentityDigest: string;
};
export type TestTerminalSession = TestTerminalLease & {
  bindView(request: BindViewRequest): Promise<BindViewResponse>;
};
/* onNotes: who shows what the terminal has to say, under it and never over it; without one, the notes stand right under
   the terminal. */
type Props = { path: string; program: string; onGone(reason?: TestTerminalGoneReason): void; watching?: boolean; testSession?: TestTerminalSession; onNotes?(notes: WindowNote[]): void };

export async function createTestTerminalBrowserKey(lease: TestTerminalLease) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey);
  if (!publicKey.x || !publicKey.y) throw new Error('The browser public key is incomplete.');
  const request: BindViewRequest = {
    ...lease,
    operationId: crypto.randomUUID(),
    browserPublicKey: {
      algorithm: 'P-256/SHA-256',
      kty: 'EC',
      crv: 'P-256',
      x: publicKey.x,
      y: publicKey.y,
    },
  };
  return {
    request,
    sign(challenge: Uint8Array) {
      return crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new Uint8Array(challenge));
    },
  };
}

type Size = { cols: number; rows: number };
type Frame = { type: string; data?: string; write?: boolean; message?: boolean; running?: boolean; asleep?: boolean; reason?: InputRefusal };
type Send = (m: unknown) => void;
type SessionView = { shown: boolean; asleep: boolean; hasData: boolean };
type ReconnectHold = { waiting: boolean; chunks: string[]; timer: ReturnType<typeof setTimeout> | null };
/* What one view of the session learned so far. */
type View = { term: Terminal; send: Send; setUp(up: boolean, asleep?: boolean): void; asked: Size; told: boolean; unconfirmed: Size | null; session: SessionView; hold: ReconnectHold; ready(rights: TerminalRights): void; refused(reason: InputRefusal): void };

const newHold = (): ReconnectHold => ({ waiting: false, chunks: [], timer: null });

function clearHold(hold: ReconnectHold): void {
  if (hold.timer) clearTimeout(hold.timer);
  hold.timer = null;
  hold.waiting = false;
  hold.chunks = [];
}

/* History sent by ViewHistory.open starts with a two-row scroll region and ends before tmux draws the live screen. */
function isHistoryOnly(text: string): boolean {
  return text.startsWith(HISTORY_HEAD) && (!text.includes(HISTORY_TAIL) || text.endsWith(HISTORY_TAIL));
}

function applyProgram(session: SessionView, setUp: (up: boolean, asleep?: boolean) => void, running: boolean, asleep: boolean): void {
  if (running || asleep) {
    session.shown = true;
    session.asleep = asleep;
    setUp(true, asleep);
    return;
  }
  /* Keep existing screen visible across a live program restart; show the loader on first open or waking from sleep. */
  if (!session.shown || session.asleep) {
    session.asleep = false;
    setUp(false, false);
  }
}

/* A card that came or went while the view connected changed the terminal's size, and that resize was lost: sent before
   the socket opened, or after the server said ready but before the node held the view. The session's first screen comes
   from the view itself, so then the terminal tells its size once, if it is not the one the view was opened at. */
function confirmSize(term: Terminal, opened: Size | null, send: Send) {
  if (opened && (term.cols !== opened.cols || term.rows !== opened.rows)) send({ type: 'resize', cols: term.cols, rows: term.rows });
}

function readyCame(view: View, m: Frame): void {
  const control = Boolean(m.write);
  const rights = { control, message: m.message ?? control };
  view.ready(rights);
  view.told = false;
  if (view.session.hasData) {
    view.hold.waiting = true;
  } else {
    restoreLiveTerminal(view.term);
    view.term.reset();
  }
  view.term.options.disableStdin = !(rights.control || rights.message);
  view.unconfirmed = view.asked;
}

/* The session draws its whole screen for each new view. The server says separately who may control the program and who
   may write a message. A program starts on its first screen if the view says nothing about whether it is running. One that
   sleeps until its next turn shows what it printed, with no loader over it. */
function received(view: View, m: Frame) {
  if (m.type === 'ready') readyCame(view, m);
  if (m.type === 'refused' && m.reason) view.refused(m.reason);
  if (m.type === 'program') {
    view.told = true;
    applyProgram(view.session, view.setUp, Boolean(m.running), Boolean(m.asleep));
  }
  if (m.type === 'data' && m.data) screenCame(view, m.data);
}

type ClearScroll = { tail: string; reading: number | null; history: boolean };
const clearScroll = new WeakMap<Terminal, ClearScroll>();

function writeKeepingPlace(term: Terminal, data: string) {
  const state = clearScroll.get(term) ?? { tail: '', reading: null, history: false };
  clearScroll.set(term, state);
  const stream = state.tail + data;
  if (stream.includes('\x1b[3J') && state.reading === null) state.reading = term.buffer.active.viewportY;
  const intoHistory = stream.includes('\x1b[1;2r');
  state.tail = stream.slice(-2);
  if (state.reading === null) return writeTerminalData(term, data);
  if (intoHistory) state.history = true;
  if (!state.history) return writeTerminalData(term, data);
  const reading = state.reading;
  if (!intoHistory) {
    state.reading = null;
    state.history = false;
  }
  writeTerminalData(term, data, () => restoreHistoryLine(term, reading));
}

function flushReconnect(view: View): void {
  const combined = view.hold.chunks.join('');
  clearHold(view.hold);
  if (!combined) return;
  const reading = readingHistoryLine(view.term);
  restoreLiveTerminal(view.term);
  view.term.reset();
  if (reading === null) {
    clearScroll.delete(view.term);
    writeTerminalData(view.term, combined);
    return;
  }
  if (combined.endsWith(HISTORY_TAIL)) clearScroll.set(view.term, { tail: '', reading, history: true });
  else clearScroll.delete(view.term);
  writeTerminalData(view.term, combined, () => restoreHistoryLine(view.term, reading));
}

function screenCame(view: View, data: string) {
  view.session.hasData = true;
  if (!view.told) {
    view.session.shown = true;
    view.setUp(true);
  }
  if (view.hold.waiting) {
    view.hold.chunks.push(data);
    if (isHistoryOnly(view.hold.chunks.join(''))) {
      view.hold.timer ??= setTimeout(() => flushReconnect(view), RECONNECT_HOLD_MS);
    } else {
      flushReconnect(view);
    }
  } else {
    writeKeepingPlace(view.term, data);
  }
  /* Forgotten before the resize goes, since the screen it brings may come before send returns. */
  const opened = view.unconfirmed;
  view.unconfirmed = null;
  confirmSize(view.term, opened, view.send);
}

function socketUrl(path: string) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}${path}`;
}

function viewUrl(path: string, size: Size) {
  return `${socketUrl(path)}${path.includes('?') ? '&' : '?'}cols=${size.cols}&rows=${size.rows}`;
}

/* The node cannot show a view, or the person may no longer reach the agent: trying again changes nothing. */
const final = (code: number) => code === NO_TERMINAL || code === NO_ACCESS;

class KeptKeys {
  private kept: { keys: unknown; at: number }[] = [];

  constructor(private refused: () => void) {}

  keep(m: unknown) {
    if ((m as { type?: string }).type !== 'input') return;
    if (this.kept.length === KEPT_KEYS) return this.refused();
    this.kept.push({ keys: m, at: Date.now() });
  }

  go(send: Send) {
    const { kept } = this;
    this.kept = [];
    for (const { keys, at } of kept) if (Date.now() - at < KEPT_MS) send(keys);
  }
}

type LiveSocket = { socket: WebSocket | null; open: boolean; rights: TerminalRights };

function deliver(connection: LiveSocket, m: unknown, input: TerminalInput, refused: (reason: InputRefusal) => void) {
  if ((m as { type?: string }).type === 'input') {
    const data = String((m as { data?: unknown }).data ?? '');
    if (!connection.rights.control && isAutomaticReport(data)) return;
    const taken = input.take(data, connection.rights);
    if (taken.denied) return refused(taken.denied);
    m = { type: 'input', data: taken.data };
  }
  if (connection.open && connection.socket?.readyState === 1) connection.socket.send(JSON.stringify(m));
}

function sendOrKeep(connection: LiveSocket, m: unknown, kept: KeptKeys, deliverNow: Send) {
  if (connection.open && connection.socket?.readyState === 1) deliverNow(m);
  else kept.keep(m);
}

/* The view of the session over a socket, opened again after a machine went away for a moment, until it ends. */
function connectView(term: Terminal, path: string, setUp: (up: boolean, asleep?: boolean) => void, gone: () => void, overflow: () => void, refused: (reason: InputRefusal) => void, rightsChanged: (rights: TerminalRights) => void) {
  const connection: LiveSocket = { socket: null, open: false, rights: { control: true, message: true } };
  const session: SessionView = { shown: false, asleep: false, hasData: false };
  let activeHold: ReconnectHold | null = null;
  let ended = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let tries = 0;
  const kept = new KeptKeys(overflow);
  const input = new TerminalInput();
  const deliverNow: Send = m => deliver(connection, m, input, refused);
  const send: Send = m => sendOrKeep(connection, m, kept, deliverNow);
  const connect = () => {
    connection.open = false;
    const hold = newHold();
    activeHold = hold;
    const ready = (next: TerminalRights) => {
      connection.rights = next;
      connection.open = true;
      rightsChanged(next);
      tries = 0;
      kept.go(deliverNow);
    };
    const view: View = { term, send, setUp, asked: { cols: term.cols, rows: term.rows }, told: false, unconfirmed: null, session, hold, ready, refused };
    const ws = new WebSocket(viewUrl(path, view.asked));
    connection.socket = ws;
    ws.onmessage = e => {
      if (!ended && connection.socket === ws && ws.readyState === 1) received(view, JSON.parse(String(e.data)) as Frame);
    };
    ws.onclose = e => {
      clearHold(hold);
      if (ended || connection.socket !== ws) return;
      connection.open = false;
      rightsChanged({ control: false, message: false });
      if (!session.shown) setUp(false);
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
      if (activeHold) clearHold(activeHold);
      connection.socket?.close();
    },
  };
}

function testViewUrl(viewId: string) {
  return socketUrl(`/api/test-terminals/views/${viewId}/stream`);
}

function testCloseReason(close: { code: number; reason: string }): TestTerminalGoneReason | undefined {
  const parsed = TestTerminalClose.safeParse(close);
  if (!parsed.success) return 'unknown';
  return parsed.data.code === 1000 ? undefined : parsed.data.reason;
}

type TestBrowserKey = Awaited<ReturnType<typeof createTestTerminalBrowserKey>>;

class TestViewConnection {
  private socket: WebSocket | null = null;
  private ended = false;
  private failed = false;
  private finished = false;
  private proofSent = false;
  private admitted = false;
  private reason: TestTerminalGoneReason | undefined;
  private view: View;

  constructor(private session: TestTerminalSession, term: Terminal, private setUp: (up: boolean) => void, private gone: (reason?: TestTerminalGoneReason) => void) {
    this.view = { term, send: () => {}, setUp, asked: { cols: term.cols, rows: term.rows }, told: false, unconfirmed: null, session: { shown: false, asleep: false, hasData: false }, hold: newHold(), ready: () => {}, refused: () => {} };
  }

  start() {
    void this.bind();
  }

  end() {
    this.ended = true;
    this.socket?.close();
  }

  private async bind() {
    try {
      const key = await createTestTerminalBrowserKey(this.session);
      if (this.ended) return;
      const response = BindViewResponse.parse(await this.session.bindView(key.request));
      if (!this.ended) this.open(response, key);
    } catch {
      this.fail('unknown');
    }
  }

  private open(response: BindViewResponse, key: TestBrowserKey) {
    const ws = new WebSocket(testViewUrl(response.viewId));
    this.socket = ws;
    ws.onopen = () => void this.prove(response, key);
    ws.onmessage = event => this.receive(response, String(event.data));
    ws.onclose = event => this.closed(event);
  }

  private async prove(response: BindViewResponse, key: TestBrowserKey) {
    const ws = this.socket;
    if (!ws) return;
    try {
      const signature = encodeViewSignature(new Uint8Array(await key.sign(decodeViewChallenge(response.challenge))));
      if (this.ended || this.failed || this.socket !== ws) return;
      const proof = ViewProof.parse({ type: 'proof', viewId: response.viewId, nonceId: response.nonceId, signature });
      ws.send(JSON.stringify(proof));
      this.proofSent = true;
    } catch {
      this.fail('unknown');
    }
  }

  private receive(response: BindViewResponse, data: string) {
    if (this.ended || this.failed) return;
    if (!this.proofSent) return this.fail('denied');
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch {
      return this.fail(this.admitted ? 'unknown' : 'denied');
    }
    if (!this.admitted) return this.admit(response, frame);
    this.receiveAdmitted(frame);
  }

  private receiveAdmitted(frame: unknown) {
    const parsed = TestTerminalServerFrame.safeParse(frame);
    if (!parsed.success || parsed.data.type === 'ready') return this.fail('unknown');
    if (parsed.data.type === 'error') return this.fail(parsed.data.reason);
    received(this.view, { type: 'data', data: parsed.data.data });
  }

  private admit(response: BindViewResponse, frame: unknown) {
    if (this.admitted || !isTestViewReady(response, frame)) return this.fail('unknown');
    this.admitted = true;
    received(this.view, frame as Frame);
    this.view.term.options.disableStdin = true;
  }

  private fail(reason: TestTerminalGoneReason) {
    if (this.ended || this.failed) return;
    this.failed = true;
    this.reason = reason;
    if (this.socket) this.socket.close();
    else this.finish();
  }

  private closed(event: { code: number; reason: string }) {
    if (this.ended || this.finished) return;
    this.failed = true;
    this.reason ??= testCloseReason(event);
    this.finish();
  }

  private finish() {
    this.finished = true;
    this.setUp(false);
    this.gone(this.reason);
  }
}

function connectTestView(term: Terminal, session: TestTerminalSession, setUp: (up: boolean) => void, gone: (reason?: TestTerminalGoneReason) => void) {
  const connection = new TestViewConnection(session, term, setUp, gone);
  connection.start();
  return { send: () => {}, end: () => connection.end() };
}

/* Mouse reports are for selection and local history, never for the program. */
const SGR_MOUSE = /^\x1b\[<(\d+);\d+;\d+[Mm]$/;

function isMouseReport(data: string) {
  return SGR_MOUSE.test(data);
}

/* Focus and answers to the program's queries are not keys the person typed, and watchers never send them. */
const AUTOMATIC_REPORT = /^(?:\x1b\[[IO]|\x1b\[[>?][0-9;]*c|\x1b\[[0-9;]*R)$/;

function isAutomaticReport(data: string) {
  return isMouseReport(data) || AUTOMATIC_REPORT.test(data);
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

/* Ctrl+V outside Apple's systems, where it is how people paste: xterm would send it to the program as ^V, so it goes to the
   browser, which pastes into the terminal. On a Mac Cmd+V pastes, and Ctrl+V stays the program's key. */
function isPasteChord(e: KeyboardEvent) {
  const apple = /Mac|iPhone|iPad/.test(navigator.platform || '');
  return !apple && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey && (e.code === 'KeyV' || e.key.toLowerCase() === 'v');
}

function bindClipboard(term: Terminal) {
  term.onSelectionChange(() => {
    const text = selectedText(term);
    if (text) copyText(text);
  });
  term.attachCustomKeyEventHandler(e => {
    if (isPasteChord(e)) return false;
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
  pasteLabel: string;
};

/* What the clipboard holds goes to the program as if typed, where the person may type and the browser lets the page read it. */
function canPaste(term: Terminal | null) {
  return Boolean(term && !term.options.disableStdin && navigator.clipboard?.readText);
}

function pasteFromClipboard(term: Terminal | null) {
  void navigator.clipboard.readText().then(text => {
    if (text && term) term.paste(text);
  }).catch(() => {});
}

function CopyMenu({ menu, termRef, onClose, label, pasteLabel }: CopyMenuProps) {
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
      {canPaste(termRef.current) && (
        <button
          className="t-copy"
          type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={() => {
            pasteFromClipboard(termRef.current);
            onClose();
            termRef.current?.focus();
          }}
        >
          {pasteLabel}
        </button>
      )}
    </div>
  );
}

function shouldIgnoreInput(term: Terminal, data: string) {
  return Boolean(term.options.disableStdin) || isMouseReport(data);
}

/* What the person types goes in pieces the server takes, except a bracketed paste, whose markers stay around one frame. */
function forward(term: Terminal, send: Send) {
  term.onData(data => {
    if (shouldIgnoreInput(term, data)) return;
    if (isBracketedPaste(data)) return send({ type: 'input', data });
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
  requestAnimationFrame(() => setTimeout(() => disposeTerminal(term)));
}

const refusalText = (reason: InputRefusal, control: string, message: string) => reason === 'control' ? control : message;

type PictureResult = { current(run: number): boolean; send: Send; uploaded(): void; failed(failure: unknown): void };

function insertUploadedPictures(path: string, files: File[], run: number, result: PictureResult) {
  void uploadTerminalPictures(path, files).then(input => {
    if (!result.current(run)) return;
    result.send({ type: 'input', data: input });
    result.uploaded();
  }, failure => {
    if (!result.current(run)) return;
    result.failed(failure);
  });
}

type TerminalNoticesProps = {
  t: Messages;
  /* The program sleeps until its next turn: its name. */
  asleep: string | null;
  dropped: boolean;
  denied: InputRefusal | null;
  pictureFailure: unknown;
  pictureState: 'uploading' | 'uploaded' | null;
};

/* What the terminal has to say: that its program sleeps, that typed words or a file did not go, or how a file goes. */
function terminalNotes({ t, asleep, dropped, denied, pictureFailure, pictureState }: TerminalNoticesProps): WindowNote[] {
  const w = t.window.notes;
  const notes: (WindowNote | false)[] = [
    Boolean(asleep) && { id: 'asleep', word: w.asleep, text: t.window.asleep(asleep!), tone: 'quiet' },
    dropped && { id: 'dropped', word: w.notSent, text: t.window.inputDropped, tone: 'bad', alert: true },
    Boolean(denied) && { id: 'denied', word: w.notSent, text: refusalText(denied!, t.window.controlDenied, t.window.messageDenied), tone: 'bad', alert: true },
    pictureFailure !== null && { id: 'picture-failed', word: w.notSent, text: errorText(t, pictureFailure), tone: 'bad', alert: true },
    Boolean(pictureState) && { id: 'picture', word: w.file, text: pictureState === 'uploading' ? t.window.pictureUploading : t.window.pictureUploaded, tone: 'quiet' },
  ];
  return notes.filter(note => note !== false);
}

/* Hands the terminal's notes to whoever shows them, and takes them back when the terminal goes; with no one to take
   them, they stand in a foot of its own, under the terminal. */
function useNotesFoot(label: string, notes: WindowNote[], onNotes?: (notes: WindowNote[]) => void): ReactNode {
  const tell = useRef(onNotes);
  tell.current = onNotes;
  useEffect(() => tell.current?.(notes), [notes]);
  useEffect(() => () => tell.current?.([]), []);
  return onNotes ? null : <WindowFoot label={label} notes={notes} />;
}

/* A terminal opening has its own progress. The service road owns any outage message. */
function TerminalOpening({ program }: { program: string }) {
  const t = useT();
  return (
    <div className="t-load" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{t.window.opening(program)}</span>
    </div>
  );
}

/* A live agent terminal or a proof-only standalone test view, both using the same renderer and local history. */
export function AgentTerminal({ path, program, onGone, watching = false, testSession, onNotes }: Props) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sendPicture = useRef<Send>(() => {});
  const pictureRun = useRef(0);
  /* Until the view is open and the program is up, a loader hides what the session shows meanwhile. */
  const [up, setUp] = useState(false);
  const [asleep, setAsleep] = useState(false);
  const shows = useCallback((running: boolean, sleeps = false) => {
    setUp(running);
    setAsleep(sleeps);
  }, []);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dropped, setDropped] = useState(false);
  const [denied, setDenied] = useState<InputRefusal | null>(null);
  const [rights, setRights] = useState<TerminalRights>({ control: false, message: false });
  const [pictureState, setPictureState] = useState<'uploading' | 'uploaded' | null>(null);
  const [pictureFailure, setPictureFailure] = useState<unknown>(null);
  const gone = useRef(onGone);
  gone.current = onGone;
  const leavesFocus = useRef(watching);
  leavesFocus.current = watching;
  const addPictures = useCallback((files: File[]) => {
    const run = ++pictureRun.current;
    setDenied(null);
    setPictureFailure(null);
    setPictureState('uploading');
    insertUploadedPictures(path, files, run, {
      current: candidate => candidate === pictureRun.current,
      send: input => sendPicture.current(input),
      uploaded: () => setPictureState('uploaded'),
      failed: failure => {
        setPictureState(null);
        setPictureFailure(failure);
      },
    });
  }, [path]);
  const dragging = usePictureDrop(box, true, !testSession && rights.message, addPictures, true);

  useEffect(() => {
    setDropped(false);
    setDenied(null);
    setPictureState(null);
    setPictureFailure(null);
    const term = new Terminal({ ...OPTIONS, theme: terminalTheme() });
    const stopTheme = subscribeSkins(() => {
      term.options.theme = terminalTheme();
    });
    termRef.current = term;
    const container = box.current!;
    term.open(container);
    measureGlyphsExactly(term);
    keepSelecting(term);
    attachTerminalScroll(term);
    bindClipboard(term);
    fitTerminal(term, container);
    const view = testSession
      ? connectTestView(term, testSession, shows, reason => gone.current(reason))
      : connectView(term, path, shows, () => gone.current(), () => setDropped(true), setDenied, setRights);
    sendPicture.current = testSession ? () => {} : view.send;
    if (!testSession) forward(term, view.send);
    const unfit = keepFitted(term, container);
    if (!leavesFocus.current) term.focus();
    return () => {
      pictureRun.current++;
      sendPicture.current = () => {};
      termRef.current = null;
      view.end();
      stopTheme();
      unfit();
      disposeLater(term);
    };
  }, [path, testSession, shows]);

  const notes = useMemo(
    () => terminalNotes({ t, asleep: asleep ? program : null, dropped, denied, pictureFailure, pictureState }),
    [t, asleep, program, dropped, denied, pictureFailure, pictureState],
  );
  const foot = useNotesFoot(t.window.notes.label, notes, onNotes);

  return (
    <>
      <div className="t-term" onContextMenu={e => openMenu(e, termRef.current, setMenu)}>
        <div className="t-xterm" ref={box} />
        <CopyMenu menu={menu} termRef={termRef} onClose={() => setMenu(null)} label={t.common.copy} pasteLabel={t.common.paste} />
        {dragging && <div className="t-drop" role="status">{t.window.dropPictures}</div>}
        {!up && <TerminalOpening program={program} />}
      </div>
      {foot}
    </>
  );
}
