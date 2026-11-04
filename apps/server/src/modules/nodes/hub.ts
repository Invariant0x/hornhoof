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
   it takes no part of any run. build: the node build its image is, none from a node built by hand or from before. */
type Entry = { socket: WebSocket; keyHash: string | null; missed: number; greeted: boolean; terminals: boolean; work: boolean; load: SaidLoad | null; skillFiles: boolean; noRuns: string | null; programs: ProgramInfo[] | null; build: string | null };

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
  onClose(id: NodeIdentity): Promise<void>;
  onError?(err: unknown): void;
};

/* Live sockets by identity. One socket per identity: a newer one replaces the older. */
export class NodeHub {
  private readonly sockets = new Map<string, Entry>();
  /* When each node that is away lost its socket, while it stays away. */
  private readonly away = new Map<string, number>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly opts: HubOptions) {
    this.timer = setInterval(() => this.sweep(), opts.pingMs);
    this.timer.unref();
  }

  attach(id: NodeIdentity, socket: WebSocket): void {
    const key = keyOf(id);
    this.sockets.get(key)?.socket.close(4000, 'Replaced by a newer connection.');
    const keyHash = id.kind === 'node' ? (id.keyHash ?? null) : null;
    const entry: Entry = { socket, keyHash, missed: 0, greeted: false, terminals: false, work: false, load: null, skillFiles: false, noRuns: null, programs: null, build: null };
    this.sockets.set(key, entry);
    this.away.delete(key);
    const report = (err: unknown) => this.opts.onError?.(err);
    /* Messages run one after another, so job.started is stored before job.done. */
    let chain = Promise.resolve();
    socket.on('pong', () => {
      entry.missed = 0;
    });
    socket.on('message', data => {
      chain = this.onFrame(id, key, entry, String(data), chain);
    });
    socket.on('close', () => {
      if (this.sockets.get(key) === entry) {
        this.sockets.delete(key);
        this.away.set(key, Date.now());
      }
      chain = chain.then(() => this.opts.onClose(id)).catch(report);
    });
    socket.on('error', report);
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
    const deliver = () => (this.sockets.get(key) === entry ? this.opts.onMessage(id, msg) : Promise.resolve());
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

  greet(id: NodeIdentity, terminals = false, skillFiles = false, work = false, noRuns: string | null = null, build: string | null = null): void {
    const entry = this.sockets.get(keyOf(id));
    if (!entry) return;
    entry.greeted = true;
    entry.terminals = terminals;
    entry.skillFiles = skillFiles;
    entry.work = work;
    entry.noRuns = noRuns;
    entry.build = build;
  }

  /* The node build a node that is ready said it is; none when it said none, as a node from before builds does. */
  buildOf(id: NodeIdentity): string | null {
    return this.sockets.get(keyOf(id))?.build ?? null;
  }

  /* Why a connected node takes no part of any run, as it said; none when it takes them. */
  noRunsOf(id: NodeIdentity): string | null {
    return this.sockets.get(keyOf(id))?.noRuns ?? null;
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
    const entry = this.sockets.get(keyOf(id));
    return entry?.socket.readyState === 1 ? entry.load : null;
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
    entry.socket.close(code, 'Disconnected in Hornhoof.');
  }

  stop(): void {
    clearInterval(this.timer);
    for (const { socket } of this.sockets.values()) socket.close(1001, 'Server is stopping.');
    this.sockets.clear();
  }

  private sweep(): void {
    for (const entry of this.sockets.values()) {
      if (entry.missed >= MISSED_PINGS) {
        entry.socket.terminate();
        continue;
      }
      entry.missed++;
      entry.socket.ping();
    }
  }
}
