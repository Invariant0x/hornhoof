import { randomUUID } from 'node:crypto';
import { parseNodeMessage, type ConnectionEnd, type NodeLoad, type NodeMessage, type ProgramInfo } from '@hornhoof/protocol';
import { OperatorDeliveryMetadata, OperatorNodeMessage, type OperatorRecoveryState, type ProgramInputResult, type ProgramNodeMessage, type ProgramServerMessage, type ProgramView } from '@hornhoof/protocol/program-operator';
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

/* Who is on the other end of a socket: one node on a machine, or the built-in node of a machine that holds the company's
   data, which runs API keys' work. machine: that machine's network id. */
export type NodeIdentity = { kind: 'node'; nodeId: string; keyHash?: string } | { kind: 'builtin'; machine: string };

export const nodeIdentity = (nodeId: string): NodeIdentity => ({ kind: 'node', nodeId });

export const builtinOf = (machine: string): NodeIdentity => ({ kind: 'builtin', machine });

/* The one built-in node of an install that was not set up again since machines had ids runs under this. */
export const UNNAMED_BUILTIN = '0'.repeat(32);

/* The machine this app runs on, as its built-in node is named by it. */
export const ownMachine = (config: { machineId: string | null }): string => config.machineId ?? UNNAMED_BUILTIN;

/* The built-in node of the machine this app runs on. */
export const ownBuiltin = (config: { machineId: string | null }): NodeIdentity => builtinOf(ownMachine(config));

/* The node a job or an agent of this subscription runs on: a plan's is the one named; an API key's the built-in node of
   the machine named, or this app's own where none is named yet. */
export const identityOf = (sub: { kind: 'personal' | 'api_key' }, nodeId: string | null, builtinMachine: string | null, own: NodeIdentity): NodeIdentity | null =>
  sub.kind === 'api_key' ? (builtinMachine ? builtinOf(builtinMachine) : own) : nodeId ? nodeIdentity(nodeId) : null;

export const keyOf = (id: NodeIdentity) => (id.kind === 'builtin' ? `builtin:${id.machine}` : id.nodeId);

export const sameNode = (a: NodeIdentity, b: NodeIdentity) => keyOf(a) === keyOf(b);

/* The identity a key of keyOf stands for. The bare word of a build before, and of the updater, which knows the server's
   own built-in node by it, is this app's own. */
export const identityOfKey = (key: string, own: NodeIdentity): NodeIdentity => (key === 'builtin' ? own : key.startsWith('builtin:') ? builtinOf(key.slice('builtin:'.length)) : nodeIdentity(key));

/* A node that misses this many pings in a row is dropped. */
const MISSED_PINGS = 3;
/* Every live node reports its load every 20 s; one silent for three minutes is gone even if a relay answers pings. */
const NODE_SILENCE_MS = 3 * 60_000;

const REPLACED = 'Replaced by a newer connection.';
const NOT_TAKEN = 'Hornhoof could not take this now; send it again.';
/* Docker waits 10 s after its stop signal. What the sockets already sent gets half of that to finish. */
const STOP_GRACE_MS = 5000;
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
   socket is closing. ended: the end of the connection is on its way to the history. stream: the node's numbering of its
   messages, from the socket's first hello that names one. refused: a message of this socket could not be taken, so
   nothing that waits behind it runs, and the node sends it all again on its next socket. */
type Entry = { stream: string | null; refused: boolean; programOperatorV1?: boolean; link: string; chain: Promise<void>; ending: { cause: ConnectionEnd; at: Date; error: string | null } | null; ended: boolean; socket: WebSocket; keyHash: string | null; missed: number; heardAt: number; greeted: boolean; terminals: boolean; work: boolean; load: SaidLoad | null; skillFiles: boolean; noRuns: string | null; browserError: string | null; programs: ProgramInfo[] | null; build: string | null };

/* A node's load and when it said it. */
export type SaidLoad = NodeLoad & { at: number };

export type TerminalMessage = Extract<NodeMessage, { type: 'term.data' | 'term.exit' | 'term.program' }>;

const isTerminalFrame = (msg: ProgramNodeMessage): msg is TerminalMessage =>
  msg.type === 'term.data' || msg.type === 'term.exit' || msg.type === 'term.program';

/* What a node answers a program operator's request with. */
export const isOperatorReply = (msg: ProgramNodeMessage): msg is ProgramView | ProgramInputResult | OperatorRecoveryState =>
  msg.type === 'program.view' || msg.type === 'program.input_result' || msg.type === 'program.recovery_state';

/* A message before it may wait for this word, as a finished job waits for words typed into another agent's turn. A tool
   called with no turn running is taken at once too: it may run long, or wait for what the node says next. */
const isAwaitedFrame = (msg: ProgramNodeMessage) => msg.type === 'agent.said' || msg.type === 'tools.call' || isOperatorReply(msg);

const closeReason = (reason?: Buffer) => (reason?.length ? reason.toString() : null);

/* A message that carries its number in the node's stream. */
export type NumberedMessage = ProgramNodeMessage & { n: number };

const numberOf = (msg: ProgramNodeMessage): number | null => {
  const { n } = msg as { n?: unknown };
  return typeof n === 'number' ? n : null;
};

/* Provenance created by the server for the socket, never a field of its frames. */
export type NodeTransport = Readonly<{ linkId: string }>;

type HubOptions = {
  pingMs: number;
  silenceMs?: number;
  onMessage(id: NodeIdentity, msg: ProgramNodeMessage, transport: NodeTransport): Promise<void>;
  /* A message the node numbered, within the stream it named. True: it is applied, was applied before, or failed for
     good, so the node may forget it. False: it could not be taken now. Without this, numbered messages go to onMessage. */
  onNumbered?(id: NodeIdentity, stream: string, msg: NumberedMessage, transport: NodeTransport): Promise<boolean>;
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
  /* When this server process last received a connection or a valid frame from each node. */
  private readonly seen = new Map<string, number>();
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
    const entry: Entry = { stream: null, refused: false, link, chain: started, ending: null, ended: false, socket, keyHash, missed: 0, heardAt: at.getTime(), greeted: false, terminals: false, work: false, load: null, skillFiles: false, noRuns: null, browserError: null, programs: null, build: null };
    this.sockets.set(key, entry);
    this.away.delete(key);
    this.seen.set(key, at.getTime());
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
    if (this.leaving || this.sockets.get(key) !== entry) return chain;
    const msg = parseOperatorNodeMessage(raw);
    if (!msg) return chain;
    entry.heardAt = Date.now();
    entry.missed = 0;
    this.seen.set(key, entry.heardAt);
    this.capturePrograms(entry, msg);
    if (msg.type === 'hello') entry.stream ??= msg.stream ?? null;
    if (isTerminalFrame(msg)) {
      this.forwardTerminal(id, msg);
      return chain;
    }
    const current = () => this.sockets.get(key) === entry && !entry.refused;
    const deliver = () => (current() ? this.opts.onMessage(id, msg, { linkId: entry.link }) : Promise.resolve());
    const report = (err: unknown) => this.opts.onError?.(err);
    if (isAwaitedFrame(msg)) {
      void deliver().catch(report);
      return chain;
    }
    /* With the stream the socket had when the message came. */
    const { stream } = entry;
    const n = numberOf(msg);
    if (n === null || stream === null || !this.opts.onNumbered) return chain.then(deliver).catch(report);
    return chain.then(() => (current() ? this.takeNumbered(id, entry, stream, msg as NumberedMessage) : undefined)).catch(report);
  }

  /* The confirmation goes on the socket the message came on: a newer socket of the node has numbers of its own to hear of. */
  private async takeNumbered(id: NodeIdentity, entry: Entry, stream: string, msg: NumberedMessage): Promise<void> {
    if (await this.opts.onNumbered!(id, stream, msg, { linkId: entry.link })) {
      if (entry.socket.readyState === 1) entry.socket.send(JSON.stringify({ type: 'ack', upto: msg.n }));
      return;
    }
    entry.refused = true;
    entry.ending ??= { cause: 'not_taken', at: new Date(), error: null };
    entry.socket.close(1013, NOT_TAKEN);
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

  lastSeenAt(id: NodeIdentity): number | null {
    return this.seen.get(keyOf(id)) ?? null;
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

  /* A check group that is still alive keeps the machine out of new checks until cleanup succeeds. */
  checkErrorOf(id: NodeIdentity): string | null {
    const reason = this.openEntry(id)?.noRuns;
    return reason?.startsWith('Check group ') ? reason : null;
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

  /* The machines whose built-in node is connected and has said hello, in no order. */
  builtins(): string[] {
    return [...this.sockets.entries()].filter(([key, entry]) => key.startsWith('builtin:') && entry.socket.readyState === 1 && entry.greeted).map(([key]) => key.slice('builtin:'.length));
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

  /* True means queued on this socket; written reports its local write, not the node's receipt. */
  send(id: NodeIdentity, msg: ProgramServerMessage, written?: (error?: Error) => void): boolean {
    const entry = this.sockets.get(keyOf(id));
    if (entry?.socket.readyState !== 1) return false;
    entry.socket.send(JSON.stringify(msg), written);
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

  /* Takes no more messages, lets what the sockets already sent finish, so a restart cuts no handling in half, and then
     closes them. */
  async stop(): Promise<void> {
    this.stopping();
    clearInterval(this.timer);
    let giveUp!: NodeJS.Timeout;
    const grace = new Promise<void>(done => (giveUp = setTimeout(done, STOP_GRACE_MS)));
    await Promise.race([Promise.all([...this.sockets.values()].map(entry => entry.chain)), grace]);
    clearTimeout(giveUp);
    for (const { socket } of this.sockets.values()) socket.close(1001, 'Server is stopping.');
    this.sockets.clear();
  }

  private sweep(): void {
    const silenceMs = this.opts.silenceMs ?? NODE_SILENCE_MS;
    const now = Date.now();
    for (const entry of this.sockets.values()) {
      if (entry.missed >= MISSED_PINGS || now - entry.heardAt >= silenceMs) {
        entry.ending ??= { cause: 'missed_pongs', at: new Date(now), error: null };
        entry.socket.terminate();
        continue;
      }
      entry.missed++;
      entry.socket.ping();
    }
  }
}
