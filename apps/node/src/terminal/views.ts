import { execFile, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { NodeMessage, ServerMessage } from '@hornhoof/protocol';
import { StreamMask } from './mask.js';
import type { Tmux } from './tmux.js';
import { sendTerminalOutput, ViewHistory } from './view-stream.js';

/* People's windows on agents' tmux sessions: each view is a tmux client of its own, sized with the others of its session,
   with what the owner types going to the program through the host. */

type Msg<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

type Size = { cols: number; rows: number };
/* shown: the size its tmux client is to have; applied: the size it was last given; tty: that client's terminal, once
   found. */
type View = {
  child: ChildProcess;
  key: string;
  write: boolean;
  mask: StreamMask;
  decoder: StringDecoder;
  quiet: NodeJS.Timeout | null;
  shown: Size;
  applied: Size;
  tty: string | null;
  history: ViewHistory | null;
  out(text: string): void;
};

const sameSize = (a: Size, b: Size) => a.cols === b.cols && a.rows === b.rows;
/* Erases a window's screen below a session of so many rows, and puts the cursor back where it was. */
const eraseBelow = (rows: number) => `\u001b7\u001b[${rows + 1};1H\u001b[J\u001b8`;
/* Sets a terminal's size: stty names the terminal with -f on macOS and -F elsewhere. */
const stty = (tty: string, size: Size) =>
  new Promise<void>(resolve => execFile('stty', [process.platform === 'darwin' ? '-f' : '-F', tty, 'cols', String(size.cols), 'rows', String(size.rows)], () => resolve()));

const MAX_EARLY_KEYS = 256;
/* A browser opens a view again within seconds of a connection it lost, its retries reaching ten. Until then the agent still
   counts as watched, so its idle program is there for the view that comes back and is not started anew under the person. */
const VIEW_RETURN_MS = 30_000;

type ViewOptions = { tmux: Tmux; send(m: NodeMessage): void; secrets(): string[] };
/* What a view needs of the agent it shows: its session, and whether a program runs, sleeps or has a turn. */
export type ViewAgent = { name: string; hash: string | null; turn: unknown; up: boolean; asleep: boolean };
/* The host's side: the agent of a key, its session made when a view opens first, and the owner's keys taken in order. */
export type ViewHost = {
  openMs: number;
  agent(key: string): ViewAgent;
  ensureSession(key: string, starts: boolean): Promise<void>;
  typed(key: string, input: Msg<'term.input'>, write: (data: string) => void): void;
};

export class ViewSessions {
  private readonly views = new Map<string, View>();
  /* Views being opened, and those Hornhoof closed meanwhile. */
  private readonly viewsOpening = new Set<string>();
  /* What the owner types while their view opens: Hornhoof told them the terminal is there. */
  private readonly earlyKeys = new Map<string, Msg<'term.input'>[]>();
  private readonly viewsClosed = new Set<string>();
  /* The size each view's window asks for, from the moment Hornhoof opens it: a resize that comes while it still opens
     counts too, since Hornhoof says the view is ready as it asks for it. */
  private readonly wanted = new Map<string, { key: string; size: Size }>();
  /* When a view of each agent last went, and the views Hornhoof ended for good, which do not come back. */
  private readonly left = new Map<string, number>();
  private readonly forGood = new Set<string>();

  constructor(private readonly opts: ViewOptions, private readonly host: ViewHost) {}

  /* Someone has a window on this agent's session, is opening one, or lost one so lately that it comes back. */
  watched(key: string): boolean {
    return [...this.wanted.values()].some(view => view.key === key) || Date.now() - (this.left.get(key) ?? -Infinity) < VIEW_RETURN_MS;
  }

  private gone(termId: string, key: string): void {
    const ended = this.forGood.delete(termId);
    if (this.wanted.delete(termId) && !ended) this.left.set(key, Date.now());
  }

  /* Every view of an agent hears whether its program runs or sleeps. */
  program(key: string, running = true, asleep = false): void {
    for (const [termId, view] of this.views) if (view.key === key) this.opts.send({ type: 'term.program', termId, running, ...(asleep ? { asleep } : {}) });
  }

  /* Views belong to one connection to Hornhoof; after it came back, people open them again. */
  closeAll(): void {
    for (const view of this.views.values()) view.child.kill();
  }

  async open(m: Msg<'term.open'>): Promise<void> {
    this.expectKeys(m);
    try {
      await this.openView(m);
      this.earlyKeysGo(m.termId);
    } catch (err) {
      /* A view that did not open keeps no size, and takes no keys. */
      this.earlyKeys.delete(m.termId);
      await this.forget(m.termId, m.agentKey);
      throw err;
    }
  }

  /* The others may have got smaller for a view that is gone. */
  private forget(termId: string, key: string): Promise<void> {
    this.gone(termId, key);
    return this.fit(key);
  }




  private async openView(m: Msg<'term.open'>): Promise<void> {
    const a = this.host.agent(m.agentKey);
    this.viewsOpening.add(m.termId);
    this.wanted.set(m.termId, { key: m.agentKey, size: { cols: m.cols, rows: m.rows } });
    /* Someone who may type gets the program at once, to talk to it; watchers see it once it has a turn. */
    const starts = m.write && !a.turn && !(a.hash && (await this.opts.tmux.alive(a.name)));
    try {
      await this.host.ensureSession(m.agentKey, starts);
      /* The others get smaller first, if this window is: a client bigger than the session gets rows of dots. */
      await this.fit(m.agentKey);
    } finally {
      this.viewsOpening.delete(m.termId);
    }
    if (this.viewsClosed.delete(m.termId)) return this.forget(m.termId, m.agentKey);
    const shown = this.fitted(m.agentKey);
    const child = this.opts.tmux.attach(a.name, shown.cols, shown.rows, m.write);
    const values = this.opts.tmux.outputValues(a.name);
    const view: View = { child, key: m.agentKey, write: m.write, mask: new StreamMask(this.opts.secrets, () => values.forms()), decoder: new StringDecoder('utf8'), quiet: null, shown, applied: shown, tty: null, history: null, out: () => {} };
    this.views.set(m.termId, view);
    /* A program that sleeps shows what it printed, and says it sleeps, until a turn starts it; one who may type starts it.
       A watcher of an agent with no program sees the waiting screen; anyone else, a loader until the program is up. */
    if (a.asleep && !a.turn) this.opts.send({ type: 'term.program', termId: m.termId, running: false, asleep: true });
    else if (starts || a.turn || a.up) this.opts.send({ type: 'term.program', termId: m.termId, running: a.up && !starts });
    view.out = text => sendTerminalOutput(data => this.opts.send({ type: 'term.data', termId: m.termId, data }), text);
    child.on('exit', () => {
      view.history?.stop();
      if (view.quiet) clearTimeout(view.quiet);
      view.out(view.mask.end());
      this.views.delete(m.termId);
      this.gone(m.termId, m.agentKey);
      this.opts.send({ type: 'term.exit', termId: m.termId });
      void this.fit(m.agentKey);
    });
    await this.showHistory(m.termId, view, a.name);
    if (starts) this.opts.send({ type: 'agent.start', agentKey: m.agentKey });
    /* A resize that came while it opened, or a window smaller than the others', sizes every view of the session. */
    await this.fit(m.agentKey);
  }

  /* What the attached client writes meanwhile waits in its pipe, and follows the history in its order. */
  private async showHistory(termId: string, view: View, name: string): Promise<void> {
    const show = (text: string) => {
      view.out(view.mask.push(text));
      if (view.quiet) clearTimeout(view.quiet);
      view.quiet = setTimeout(() => view.out(view.mask.flush()), 60);
    };
    const open = () => this.views.get(termId) === view && !view.child.killed;
    /* A session gets the size of its views when one attaches, and what that leaves off its screen is history too. */
    const tty = await this.ttyOf(termId, view);
    if (tty) await this.clientSized(tty, view.shown);
    const history = new ViewHistory(this.opts.tmux, name, text => { if (open()) show(text); }, () => this.repaint(termId, view));
    view.history = history;
    await history.open();
    if (!open()) return;
    view.child.stdout?.on('data', (chunk: Buffer) => {
      /* The client draws, so it is there: a size that could not reach it before goes now. */
      if (!view.tty) void this.fit(view.key);
      const text = view.decoder.write(chunk);
      history.saw(text);
      show(text);
    });
  }

  private async repaint(termId: string, view: View): Promise<void> {
    const tty = await this.ttyOf(termId, view);
    if (tty) await this.opts.tmux.repaint(tty);
  }

  input(m: Msg<'term.input'>): void {
    const view = this.typingView(m.termId);
    if (view?.write) this.typed(view, m);
    else this.keepEarly(m);
  }

  /* Keys wait while what came before them still waits, for the order of what the owner typed. */
  private typingView(termId: string): View | undefined {
    return this.earlyKeys.has(termId) ? undefined : this.views.get(termId);
  }

  private keepEarly(m: Msg<'term.input'>): void {
    const early = this.earlyKeys.get(m.termId);
    if (early && early.length < MAX_EARLY_KEYS) early.push(m);
  }

  private expectKeys({ termId, write }: Msg<'term.open'>): void {
    if (write) this.earlyKeys.set(termId, []);
  }

  private earlyKeysGo(termId: string): void {
    const view = this.views.get(termId);
    const keys = this.earlyKeys.get(termId) ?? [];
    this.earlyKeys.delete(termId);
    if (view) for (const m of keys) this.typed(view, m);
  }



  async resize(m: Msg<'term.resize'>): Promise<void> {
    const wanted = this.wanted.get(m.termId);
    if (!wanted) return;
    const height = m.rows !== wanted.size.rows;
    wanted.size = { cols: m.cols, rows: m.rows };
    await this.fit(wanted.key);
    if (height) this.heightChanged(m.termId);
  }

  /* A terminal moved its own rows when its window changed height, also with the session's height as it was. */
  private heightChanged(termId: string): void {
    const view = this.views.get(termId);
    if (!view) return;
    this.eraseBelowSession(termId, view, view.shown);
    view.history?.resized();
  }

  /* One session runs one program at one size. People watching it in windows of different sizes are tmux clients of
     different sizes, and tmux fills what a bigger client has beyond the window with rows of dots. So every view of a
     session gets the size of the smallest window among them: all of it shows in each, and a bigger window keeps empty
     room below and to the right. */
  fitted(key: string): Size {
    const size = { cols: Infinity, rows: Infinity };
    for (const w of this.wanted.values()) {
      if (w.key !== key) continue;
      size.cols = Math.min(size.cols, w.size.cols);
      size.rows = Math.min(size.rows, w.size.rows);
    }
    return size;
  }

  private async fit(key: string): Promise<void> {
    const size = this.fitted(key);
    const changed = [...this.views].filter(([termId, view]) => view.key === key && this.wanted.has(termId) && !sameSize(view.shown, size));
    await Promise.all(changed.map(([termId, view]) => this.sizeView(termId, view, size)));
  }

  private async sizeView(termId: string, view: View, size: Size): Promise<void> {
    view.shown = size;
    const tty = await this.ttyOf(termId, view);
    /* Its client is not there yet, as on a machine short of memory: the size has not reached it, and goes once it draws. */
    if (!tty) {
      if (view.shown === size) view.shown = view.applied;
      return;
    }
    await this.applyNewest(tty, view);
    const last = view.shown;
    await this.clientSized(tty, last);
    if (view.shown === last) this.eraseBelowSession(termId, view, last);
  }

  /* Sizes on their way do not wait for each other. One that lands after a newer one would leave the terminal at the older
     size, so whichever ends last gives it the newest size again. */
  private async applyNewest(tty: string, view: View): Promise<void> {
    while (!sameSize(view.applied, view.shown)) {
      const size = view.shown;
      await stty(tty, size);
      view.applied = size;
    }
  }

  /* The terminal tells its client, which tells tmux; a session sized before then would still be sized for the old one. */
  private async clientSized(tty: string, size: Size): Promise<void> {
    for (const end = Date.now() + this.host.openMs; Date.now() < end; await new Promise(r => setTimeout(r, 20))) {
      const client = (await this.opts.tmux.clients()).find(c => c.tty === tty);
      if (!client || sameSize(client, size)) return;
    }
  }

  /* tmux redraws a client that got smaller only within its new size; what the window showed below stays unless erased. */
  private eraseBelowSession(termId: string, view: View, size: Size): void {
    const own = this.wanted.get(termId)?.size;
    if (own && size.rows < own.rows) view.out(eraseBelow(size.rows));
  }

  /* The terminal of a view's tmux client. A client attaches a moment after its view opens, so a size that comes before
     waits for it. */
  private async ttyOf(termId: string, view: View): Promise<string | null> {
    for (const end = Date.now() + this.host.openMs; !view.tty && this.views.get(termId) === view && Date.now() < end; await new Promise(r => setTimeout(r, 50))) {
      for (const client of await this.opts.tmux.clients()) if ((await parentOf(client.pid)) === view.child.pid) view.tty = client.tty;
    }
    return view.tty;
  }

  close(m: Msg<'term.close'>): void {
    const view = this.views.get(m.termId);
    if (m.final) this.forGood.add(m.termId);
    if (view) {
      view.child.kill();
      /* Its viewer process takes a while to end; the others get their size back at once. */
      void this.forget(m.termId, view.key);
    } else if (this.viewsOpening.has(m.termId)) this.viewsClosed.add(m.termId);
  }

  /* What the owner typed goes to the program through the host, which knows its turn and keeps the order of its input. */
  private typed(view: View, input: Msg<'term.input'>): void {
    this.host.typed(view.key, input, data => { view.child.stdin?.write(data); });
  }
}

/* The process that started a given one: from /proc on Linux, from ps elsewhere. */
export async function parentOf(pid: number): Promise<number | null> {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return new Promise(resolve => execFile('ps', ['-o', 'ppid=', '-p', String(pid)], (err, out) => resolve(err ? null : Number(out.trim()))));
  }
}
