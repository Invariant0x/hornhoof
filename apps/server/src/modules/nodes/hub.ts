import { parseNodeMessage, type NodeLoad, type NodeMessage, type ProgramInfo, type ServerMessage } from '@hornhoof/protocol';
import type { WebSocket } from 'ws';

/* Who is on the other end of a socket: one node on a machine, or the built-in node that runs every API key. */
export type NodeIdentity = { kind: 'node'; nodeId: string } | { kind: 'builtin' };

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
   it takes no part of any run. */
type Entry = { socket: WebSocket; missed: number; greeted: boolean; terminals: boolean; work: boolean; load: SaidLoad | null; skillFiles: boolean; noRuns: string | null; programs: ProgramInfo[] | null };

/* A node's load and when it said it. */
export type SaidLoad = NodeLoad & { at: number };

export type TerminalMessage = Extract<NodeMessage, { type: 'term.data' | 'term.exit' | 'term.program' }>;

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
    const entry: Entry = { socket, missed: 0, greeted: false, terminals: false, work: false, load: null, skillFiles: false, noRuns: null, programs: null };
    this.sockets.set(key, entry);
    this.away.delete(key);
    const report = (err: unknown) => this.opts.onError?.(err);
    /* Messages run one after another, so job.started is stored before job.done. */
    let chain = Promise.resolve();
    socket.on('pong', () => {
      entry.missed = 0;
    });
    socket.on('message', data => {
      const msg = parseNodeMessage(String(data));
      this.capturePrograms(entry, msg);
      if (msg?.type === 'term.data' || msg?.type === 'term.exit' || msg?.type === 'term.program') {
        try {
          this.opts.onTerminal?.(id, msg);
        } catch (err) {
          report(err);
        }
        return;
      }
      /* A message before it may wait for this word, as a finished job waits for words typed into another agent's turn. */
      if (msg?.type === 'agent.said') return void this.opts.onMessage(id, msg).catch(report);
      if (msg) chain = chain.then(() => this.opts.onMessage(id, msg)).catch(report);
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

  greet(id: NodeIdentity, terminals = false, skillFiles = false, work = false, noRuns: string | null = null): void {
    const entry = this.sockets.get(keyOf(id));
    if (!entry) return;
    entry.greeted = true;
    entry.terminals = terminals;
    entry.skillFiles = skillFiles;
    entry.work = work;
    entry.noRuns = noRuns;
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
  close(nodeId: string, code = 4001): void {
    this.sockets.get(nodeId)?.socket.close(code, 'Disconnected in Hornhoof.');
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
