import { randomUUID } from 'node:crypto';
import { parseNodeMessage, type ConnectionEnd, type NodeLoad, type NodeMessage, type ProgramInfo } from '@hornhoof/protocol';
import { OperatorDeliveryMetadata, OperatorNodeMessage, type OperatorKeyPrepared, type OperatorKeyResult, type OperatorRecoveryState, type OperatorScreen, type ProgramNodeMessage, type ProgramServerMessage } from '@hornhoof/protocol/program-operator';
import type { WebSocket } from 'ws';
import { z } from 'zod';

export function parseOperatorNodeMessage(raw: string): ProgramNodeMessage | null {
  try {
    const value: unknown = JSON.parse(raw);
    const operator = OperatorNodeMessage.safeParse(value);
    if (operator.success) return operator.data;
    const base = parseNodeMessage(raw);
    if (base?.type === 'hello') {
      const extension = z.object({ programOperatorV1: z.boolean().optional() }).safeParse(value);
      return extension.success ? { ...base, ...extension.data } : null;
    }
    if (base?.type !== 'agent.unheard') return base;
    const metadata = OperatorDeliveryMetadata.safeParse(value);
    return metadata.success ? { ...base, ...metadata.data } : null;
  } catch { return null; }
}

/* Who is on the other end of a socket: one node on a machine, or the built-in node that runs every API key. */
export type NodeIdentity = { kind: 'node'; nodeId: string; keyHash?: string } | { kind: 'builtin' };

export const BUILTIN: NodeIdentity = { kind: 'builtin' };

export const nodeIdentity = (nodeId: string): NodeIdentity => ({ kind: 'node', nodeId });

/* The node a job or an agent of this subscription runs on: an API key's is the built-in node, a plan's the one named. */
export const identityOf = (sub: { kind: 'personal' | 'api_key' }, nodeId: string | null): NodeIdentity | null =>
  sub.kind === 'api_key' ? BUILTIN : nodeId ? nodeIdentity(nodeId) : null;

export const keyOf = (id: NodeIdentity) => (id.kind === 'builtin' ? 'builtin' : id.nodeId);

export const sameNode = (a: NodeIdentity, b: NodeIdentity) => keyOf(a) === keyOf(b);

/* A node that misses this many pings in a row is dropped. */
const MISSED_PINGS = 3;

const REPLACED = 'Replaced by a newer connection.';
const DISCONNECTED = 'Disconnected in Hornhoof.';
/* What a close says when no close frame came: the socket was cut. */
const NO_CLOSE_FRAME = 1006;

/* How a socket of a node ended, for the history of its connections. */
export type LinkEnd = { link: string; at: Date; cause: ConnectionEnd; code: number | null; reason: string | null; error: string | null };

/* greeted: Hornhoof has handled the node's hello, so a job sent now cannot be mistaken for one lost in a restart.
   terminals: the node said it runs agents in sessions people can watch. work: it runs parts of any work, not only of
   test runs. load: how busy its machine was when it last said. skillFiles: it writes a turn's skills as files. noRuns: why
   it takes no part of any run. browserError: why Playwright's browser failed to start on the node. build: the node build its
   image is, none from a node built by hand or from before. link: this connection in the node's history. chain: what this
   socket has to do one after another, as job.started is stored before job.done. ending: what the server knows of why the
   socket is closing. ended: the end of the connection is on its way to the history. */
type Entry = { programOperatorV1?: boolean; link: string; chain: Promise<void>; ending: { cause: ConnectionEnd; at: Date; error: string | null } | null; ended: boolean; socket: WebSocket; keyHash: string | null; missed: number; greeted: boolean; terminals: boolean; work: boolean; load: SaidLoad | null; skillFiles: boolean; noRuns: string | null; browserError: string | null; programs: ProgramInfo[] | null; build: string | null };

/* A node's load and when it said it. */
export type SaidLoad = NodeLoad & { at: number };

export type TerminalMessage = Extract<NodeMessage, { type: 'term.data' | 'term.exit' | 'term.program' }>;

const isTerminalFrame = (msg: ProgramNodeMessage): msg is TerminalMessage =>
  msg.type === 'term.data' || msg.type === 'term.exit' || msg.type === 'term.program';

/* What a node answers a program operator's request with. */
export const isOperatorReply = (msg: ProgramNodeMessage): msg is OperatorScreen | OperatorKeyResult | OperatorKeyPrepared | OperatorRecoveryState =>
  msg.type === 'program.screen' || msg.type === 'program.key_result' || msg.type === 'program.key_prepared' || msg.type === 'program.recovery_state';

/* A message before it may wait for this word, as a finished job waits for words typed into another agent's turn. */
const isAwaitedFrame = (msg: ProgramNodeMessage) => msg.type === 'agent.said' || isOperatorReply(msg);

const closeReason = (reason?: Buffer) => (reason?.length ? reason.toString() : null);

/* Provenance created by the server for the socket, never a field of its frames. */
export type NodeTransport = Readonly<{ linkId: string }>;

type HubOptions = {
  pingMs: number;
  onMessage(id: NodeIdentity, msg: ProgramNodeMessage, transport: NodeTransport): Promise<void>;
  /* A screen goes straight to the people watching, without waiting behind the node's other messages. */
  onTerminal?(id: NodeIdentity, msg: TerminalMessage): void;
  onClose(id: NodeIdentity): Promise<void>;
  /* A connection's start and end, in the order of its socket's messages: the start before them, the end after them. */
  onConnected?(id: NodeIdentity, link: string, at: Date): Promise<void>;
  onDisconnected?(id: NodeIdentity, end: LinkEnd): Promise<void>;
  onError?(err: unknown): void;
};

/* Live sockets by identity. One socket per identity: a newer one replaces the older. */
export class NodeHub {
  private readonly sockets = new Map<string, Entry>();
  /* When each node that is away lost its socket, while it stays away. */
  private readonly away = new Map<string, number>();
  private readonly timer: NodeJS.Timeout;
  private leaving = false;

  constructor(private readonly opts: HubOptions) {
    this.timer = setInterval(() => this.sweep(), opts.pingMs);
    this.timer.unref();
  }

  attach(id: NodeIdentity, socket: WebSocket): void {
    const key = keyOf(id);
    const at = new Date();
    const old = this.sockets.get(key);
    if (old) {
      /* At once: a socket on a line that went dead answers this close only when it times out. */
      this.endLink(id, old, { at, cause: 'replaced', code: 4000, reason: REPLACED, error: null });
      old.socket.close(4000, REPLACED);
    }
    const keyHash = id.kind === 'node' ? (id.keyHash ?? null) : null;
    const report = (err: unknown) => this.opts.onError?.(err);
    const link = randomUUID();
    const started = this.opts.onConnected?.(id, link, at).catch(report) ?? Promise.resolve();
    const entry: Entry = { link, chain: started, ending: null, ended: false, socket, keyHash, missed: 0, greeted: false, terminals: false, work: false, load: null, skillFiles: false, noRuns: null, browserError: null, programs: null, build: null };
    this.sockets.set(key, entry);
    this.away.delete(key);
    socket.on('pong', () => {
      entry.missed = 0;
    });
    socket.on('message', data => {
      entry.chain = this.onFrame(id, key, entry, String(data), entry.chain);
    });
    socket.on('close', (code?: number, reason?: Buffer) => {
      if (this.sockets.get(key) === entry) {
        this.sockets.delete(key);
        this.away.set(key, Date.now());
      }
      this.endLink(id, entry, this.closed(entry, code ?? NO_CLOSE_FRAME, reason));
      entry.chain = entry.chain.then(() => this.opts.onClose(id)).catch(report);
    });
    socket.on('error', err => {
      entry.ending ??= { cause: 'socket_error', at: new Date(), error: err.message };
      report(err);
    });
  }

  /* How a socket that closed ended: what the server knows of it, else what its close says. */
  private closed(entry: Entry, code: number, reason?: Buffer): Omit<LinkEnd, 'link'> {
    const known = entry.ending;
    const said = code === NO_CLOSE_FRAME ? 'network' : 'node_closed';
    return { at: known?.at ?? new Date(), cause: this.leaving ? 'server_stopped' : (known?.cause ?? said), code, reason: closeReason(reason), error: known?.error ?? null };
  }

  private endLink(id: NodeIdentity, entry: Entry, end: Omit<LinkEnd, 'link'>): void {
    if (entry.ended) return;
    entry.ended = true;
    entry.chain = entry.chain.then(() => this.opts.onDisconnected?.(id, { link: entry.link, ...end })).catch(err => this.opts.onError?.(err));
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
    const msg = parseOperatorNodeMessage(raw);
    if (!msg) return chain;
    this.capturePrograms(entry, msg);
    if (isTerminalFrame(msg)) {
      this.forwardTerminal(id, msg);
      return chain;
    }
    const deliver = () => (this.sockets.get(key) === entry ? this.opts.onMessage(id, msg, { linkId: entry.link }) : Promise.resolve());
    const report = (err: unknown) => this.opts.onError?.(err);
    if (isAwaitedFrame(msg)) {
      void deliver().catch(report);
      return chain;
    }
    return chain.then(deliver).catch(report);
  }

  isOnline(id: NodeIdentity): boolean {
    return this.sockets.get(keyOf(id))?.socket.readyState === 1;
  }

  isCurrentLink(id: NodeIdentity, linkId: string): boolean {
    return this.openEntry(id)?.link === linkId;
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
    return !noRuns || noRuns.startsWith('browser_failed:') || noRuns.startsWith('Playwright browsers') ? error : null;
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
  private capturePrograms(entry: Entry, message: ProgramNodeMessage | null): void {
    if (message?.type !== 'hello' && message?.type !== 'status') return;
    entry.programs = message.programs ?? entry.programs;
    if (message.type === 'hello') entry.programOperatorV1 = message.programOperatorV1 === true;
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

  hasProgramOperator(id: NodeIdentity): boolean {
    return this.hasTerminals(id) && this.sockets.get(keyOf(id))?.programOperatorV1 === true;
  }

  send(id: NodeIdentity, msg: ProgramServerMessage): boolean {
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
    this.endLink(nodeIdentity(nodeId), entry, { at: new Date(), cause: 'disconnected', code, reason: DISCONNECTED, error: null });
    entry.socket.close(code, DISCONNECTED);
  }

  /* From now on every socket that closes ends with the server, whoever closes it first. */
  stopping(): void {
    this.leaving = true;
  }

  stop(): void {
    this.stopping();
    clearInterval(this.timer);
    for (const { socket } of this.sockets.values()) socket.close(1001, 'Server is stopping.');
    this.sockets.clear();
  }

  private sweep(): void {
    for (const entry of this.sockets.values()) {
      if (entry.missed >= MISSED_PINGS) {
        entry.ending ??= { cause: 'missed_pongs', at: new Date(), error: null };
        entry.socket.terminate();
        continue;
      }
      entry.missed++;
      entry.socket.ping();
    }
  }
}
