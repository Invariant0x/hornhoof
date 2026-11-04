import { parseNodeMessage, type NodeLoad, type NodeMessage, type ProgramInfo, type ServerMessage } from '@hornhoof/protocol';
import type { WebSocket } from 'ws';

/* Who is on the other end of a socket: one node on a machine, or the built-in node that runs every API key. */
export type NodeIdentity = { kind: 'node'; nodeId: string; keyHash?: string } | { kind: 'builtin' };

export const BUILTIN: NodeIdentity = { kind: 'builtin' };

export const nodeIdentity = (nodeId: string): NodeIdentity => ({ kind: 'node', nodeId });

/* The node a job or an agent of this subscription runs on: an API key's is the built-in node, a plan's the one named. */
export const identityOf = (sub: { kind: 'personal' | 'api_key' }, nodeId: string | null): NodeIdentity | null =>
  sub.kind === 'api_key' ? BUILTIN : nodeId ? nodeIdentity(nodeId) : null;

const keyOf = (id: NodeIdentity) => (id.kind === 'builtin' ? 'builtin' : id.nodeId);

export const sameNode = (a: NodeIdentity, b: NodeIdentity) => keyOf(a) === keyOf(b);

/* A node that misses this many pings in a row is dropped. */
const MISSED_PINGS = 3;

/* greeted: Hornhoof has handled the node's hello, so a job sent now cannot be mistaken for one lost in a restart.
   terminals: the node said it runs agents in sessions people can watch. work: it runs parts of any work, not only of
   test runs. load: how busy its machine was when it last said. skillFiles: it writes a turn's skills as files. noRuns: why
   it takes no part of any run. browserError: why Playwright's browser failed to start on the node. build: the node build its
   image is, none from a node built by hand or from before. */
type CloseEvent = {
  actor: 'server' | 'node' | 'network';
  cause: 'missed_pongs' | 'node_closed' | 'socket_error' | 'replaced' | 'server_close' | 'server_stop' | 'abnormal_close';
  closeCode: number | null;
  closeReason: string | null;
  error: string | null;
};

type Entry = {
  id: NodeIdentity;
  socket: WebSocket;
  keyHash: string | null;
  missed: number;
  greeted: boolean;
  terminals: boolean;
  work: boolean;
  load: SaidLoad | null;
  skillFiles: boolean;
  noRuns: string | null;
  browserError: string | null;
  programs: ProgramInfo[] | null;
  build: string | null;
  chain: Promise<void>;
  end: CloseEvent | null;
  ended: boolean;
};

/* A node's load and when it said it. */
export type SaidLoad = NodeLoad & { at: number };

export type TerminalMessage = Extract<NodeMessage, { type: 'term.data' | 'term.exit' | 'term.program' }>;

const isTerminalFrame = (msg: NodeMessage): msg is TerminalMessage =>
  msg.type === 'term.data' || msg.type === 'term.exit' || msg.type === 'term.program';

type HubOptions = {
  pingMs: number;
  onMessage(id: NodeIdentity, msg: NodeMessage): Promise<void>;
  /* A screen goes straight to the people watching, without waiting behind the node's other messages. */
  onTerminal?(id: NodeIdentity, msg: TerminalMessage): void;
  onEvent?(id: NodeIdentity, event: import('./history.js').NodeConnectionEvent): Promise<void> | void;
  onClose(id: NodeIdentity): Promise<void>;
  onError?(err: unknown): void;
};

/* Live sockets by identity. One socket per identity: a newer one replaces the older. */
export class NodeHub {
  private readonly sockets = new Map<string, Entry>();
  /* When each node that is away lost its socket, while it stays away. */
  private readonly away = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly opts: HubOptions) {
    this.timer = setInterval(() => this.sweep(), opts.pingMs);
    this.timer.unref();
  }

  private queue(entry: Entry, event: import('./history.js').NodeConnectionEvent): void {
    const key = keyOf(entry.id);
    const before = this.tails.get(key) ?? Promise.resolve();
    const messages = event.kind === 'disconnected' ? entry.chain : Promise.resolve();
    const next = Promise.all([before, messages]).then(() => this.opts.onEvent?.(entry.id, event)).catch(err => this.opts.onError?.(err));
    this.tails.set(key, next);
  }

  private finish(entry: Entry, end: CloseEvent): void {
    if (entry.ended) return;
    entry.ended = true;
    this.queue(entry, { kind: 'disconnected', at: new Date(), ...end });
  }

  attach(id: NodeIdentity, socket: WebSocket): void {
    const key = keyOf(id);
    const previous = this.sockets.get(key);
    if (previous) {
      this.finish(previous, { actor: 'server', cause: 'replaced', closeCode: 4000, closeReason: 'Replaced by a newer connection.', error: null });
      previous.socket.close(4000, 'Replaced by a newer connection.');
    }
    const keyHash = id.kind === 'node' ? (id.keyHash ?? null) : null;
    const entry: Entry = {
      id, socket, keyHash, missed: 0, greeted: false, terminals: false, work: false, load: null, skillFiles: false, noRuns: null,
      browserError: null, programs: null, build: null, chain: previous?.chain ?? Promise.resolve(), end: null, ended: false,
    };
    this.sockets.set(key, entry);
    this.away.delete(key);
    this.queue(entry, { kind: 'connected', at: new Date() });
    const report = (err: unknown) => this.opts.onError?.(err);
    socket.on('pong', () => {
      entry.missed = 0;
    });
    /* Messages run one after another, so job.started is stored before job.done. */
    socket.on('message', data => {
      entry.chain = this.onFrame(id, key, entry, String(data), entry.chain);
    });
    socket.on('close', (code: number, reason: Buffer) => {
      if (this.sockets.get(key) === entry) {
        this.sockets.delete(key);
        this.away.set(key, Date.now());
      }
      this.finish(entry, entry.end
        ? { ...entry.end, closeCode: code, closeReason: String(reason) }
        : { actor: code === 1000 || code === 1001 || code === 1005 ? 'node' : 'network', cause: code === 1000 || code === 1001 || code === 1005 ? 'node_closed' : 'abnormal_close', closeCode: code, closeReason: String(reason), error: null });
      entry.chain = entry.chain.then(() => this.opts.onClose(id)).catch(report);
    });
    socket.on('error', (err: unknown) => {
      entry.end ??= { actor: 'network', cause: 'socket_error', closeCode: null, closeReason: null, error: err instanceof Error ? err.message : String(err) };
      report(err);
    });
  }

  private forwardTerminal(id: NodeIdentity, msg: TerminalMessage): void {
    try {
      this.opts.onTerminal?.(id, msg);
    } catch (err) {
      this.opts.onError?.(err);
    }
  }

  private onFrame(id: NodeIdentity, key: string, entry: Entry, raw: string, chain: Promise<void>): Promise<void> {
    if (this.sockets.get(key) !== entry) return chain;
    const msg = parseNodeMessage(raw);
    if (!msg) return chain;
    this.capturePrograms(entry, msg);
    if (isTerminalFrame(msg)) {
      this.forwardTerminal(id, msg);
      return chain;
    }
    const deliver = () => {
      if (this.sockets.get(key) !== entry) return Promise.resolve();
      if (msg.type === 'node.reconnect') return (this.tails.get(key) ?? Promise.resolve()).then(() => this.opts.onMessage(id, msg));
      return this.opts.onMessage(id, msg);
    };
    const report = (err: unknown) => this.opts.onError?.(err);
    /* A message before it may wait for this word, as a finished job waits for words typed into another agent's turn. */
    if (msg.type === 'agent.said') {
      void deliver().catch(report);
      return chain;
    }
    return chain.then(deliver).catch(report);
  }

  isOnline(id: NodeIdentity): boolean {
    return this.sockets.get(keyOf(id))?.socket.readyState === 1;
  }

  /* Since when the node is away, none while it is online. One that went away before this Hornhoof started is away from
     the first time it is asked about. */
  awaySince(id: NodeIdentity): number | null {
    if (this.isOnline(id)) return null;
    const key = keyOf(id);
    if (!this.away.has(key)) this.away.set(key, Date.now());
    return this.away.get(key)!;
  }

  greet(
    id: NodeIdentity,
    terminals = false,
    skillFiles = false,
    work = false,
    noRuns: string | null = null,
    build: string | null = null,
    browserError: string | null = null,
  ): void {
    const entry = this.sockets.get(keyOf(id));
    if (!entry) return;
    entry.greeted = true;
    entry.terminals = terminals;
    entry.skillFiles = skillFiles;
    entry.work = work;
    entry.noRuns = noRuns;
    entry.browserError = browserError;
    entry.build = build;
  }

  /* Updates live readiness flags reported in a status message; returns true when a held reason cleared. */
  noteStatus(id: NodeIdentity, noRuns?: string | null, browserError?: string | null): boolean {
    const entry = this.sockets.get(keyOf(id));
    if (!entry) return false;
    const beforeBrowser = entry.browserError;
    const beforeRuns = this.noRunsOf(id);
    if (noRuns !== undefined) entry.noRuns = noRuns;
    if (browserError !== undefined) entry.browserError = browserError;
    return Boolean((beforeBrowser && !entry.browserError) || (beforeRuns && !this.noRunsOf(id)));
  }

  /* The node build a node that is ready said it is; none when it said none, as a node from before builds does. */
  buildOf(id: NodeIdentity): string | null {
    return this.sockets.get(keyOf(id))?.build ?? null;
  }

  private openEntry(id: NodeIdentity): Entry | null {
    const entry = this.sockets.get(keyOf(id));
    return entry?.socket.readyState === 1 ? entry : null;
  }

  /* Why Playwright's browser did not launch on a connected node, or null when it is ready. */
  browserErrorOf(id: NodeIdentity): string | null {
    return this.openEntry(id)?.browserError || null;
  }

  /* Why Playwright's browser alone holds this ready node back from runs, or null when it takes runs or has another blocker. */
  browserHoldOf(id: NodeIdentity): string | null {
    if (!this.isReady(id) || !this.loadOf(id)) return null;
    const error = this.browserErrorOf(id);
    if (!error) return null;
    const noRuns = this.sockets.get(keyOf(id))!.noRuns;
    return !noRuns || noRuns.startsWith('browser_failed:') || noRuns.startsWith('Playwright Chromium') ? error : null;
  }

  /* Why a connected node takes no part of any run, as it said; none when it takes them. */
  noRunsOf(id: NodeIdentity): string | null {
    const entry = this.sockets.get(keyOf(id));
    if (!entry) return null;
    if (entry.noRuns !== null) return entry.noRuns;
    return entry.browserError ? `browser_failed: ${entry.browserError}` : null;
  }

  /* Ready, and runs parts of any work. */
  runsWork(id: NodeIdentity): boolean {
    return this.isReady(id) && this.sockets.get(keyOf(id))!.work;
  }

  /* Kept only in memory and only while the node is connected: a figure from a node that is gone says nothing. */
  report(id: NodeIdentity, load: NodeLoad): void {
    const entry = this.sockets.get(keyOf(id));
    if (entry) entry.load = { ...load, at: Date.now() };
  }

  loadOf(id: NodeIdentity): SaidLoad | null {
    return this.openEntry(id)?.load || null;
  }

  /* Program metadata belongs to this socket, including before an asynchronous hello handler finishes. */
  private capturePrograms(entry: Entry, message: NodeMessage | null): void {
    if (message?.type !== 'hello' && message?.type !== 'status') return;
    entry.programs = message.programs ?? entry.programs;
  }

  programsOf(id: NodeIdentity): ProgramInfo[] | null {
    const entry = this.sockets.get(keyOf(id));
    return entry?.socket.readyState === 1 ? entry.programs?.map(program => ({ ...program })) ?? null : null;
  }

  updatePrograms(id: NodeIdentity): boolean {
    const entry = this.sockets.get(keyOf(id));
    if (!entry || !entry.greeted || entry.socket.readyState !== 1 || !entry.programs?.length) return false;
    if (entry.programs.some(program => program.updating)) return true;
    entry.programs = entry.programs.map(program => ({ ...program, updating: true, failed: false }));
    return this.send(id, { type: 'programs.update' });
  }

  /* Online and past its hello: ready for an agent's turn. */
  isReady(id: NodeIdentity): boolean {
    const entry = this.sockets.get(keyOf(id));
    return entry?.socket.readyState === 1 && entry.greeted;
  }

  /* Ready, and shows its agents' terminals. */
  hasTerminals(id: NodeIdentity): boolean {
    return this.isReady(id) && this.sockets.get(keyOf(id))!.terminals;
  }

  /* Said in its hello that it writes a turn's skills as files. */
  takesSkillFiles(id: NodeIdentity): boolean {
    return this.sockets.get(keyOf(id))?.skillFiles === true;
  }

  send(id: NodeIdentity, msg: ServerMessage): boolean {
    const entry = this.sockets.get(keyOf(id));
    if (entry?.socket.readyState !== 1) return false;
    entry.socket.send(JSON.stringify(msg));
    return true;
  }

  /* 4001 tells the node it was disconnected in Hornhoof and should not reconnect with this key. */
  close(nodeId: string, code = 4001, keyHash?: string): void {
    this.dropSocket(nodeId, code, keyHash);
  }

  private dropSocket(nodeId: string, code: number, keyHash?: string): void {
    const entry = this.sockets.get(nodeId);
    if (!entry || (keyHash && entry.keyHash !== keyHash)) return;
    this.sockets.delete(nodeId);
    this.away.set(nodeId, Date.now());
    this.finish(entry, { actor: 'server', cause: 'server_close', closeCode: code, closeReason: 'Disconnected in Hornhoof.', error: null });
    entry.socket.close(code, 'Disconnected in Hornhoof.');
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    const entries = [...this.sockets.values()];
    for (const entry of entries) {
      this.finish(entry, { actor: 'server', cause: 'server_stop', closeCode: 1001, closeReason: 'Server is stopping.', error: null });
      entry.socket.close(1001, 'Server is stopping.');
    }
    this.sockets.clear();
    await Promise.all(entries.map(entry => this.tails.get(keyOf(entry.id)) ?? entry.chain));
  }

  private sweep(): void {
    for (const entry of this.sockets.values()) {
      if (entry.missed >= MISSED_PINGS) {
        this.finish(entry, { actor: 'server', cause: 'missed_pongs', closeCode: 1006, closeReason: '', error: null });
        entry.socket.terminate();
        continue;
      }
      entry.missed++;
      entry.socket.ping();
    }
  }
}
