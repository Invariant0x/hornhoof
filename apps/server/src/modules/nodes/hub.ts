import { parseNodeMessage, type NodeMessage, type ServerMessage } from '@hornhoof/protocol';
import type { WebSocket } from 'ws';

/* Who is on the other end of a socket: one personal subscription's node, or the built-in node that runs every API key. */
export type NodeIdentity = { kind: 'node'; subscriptionId: string } | { kind: 'builtin' };

export const BUILTIN: NodeIdentity = { kind: 'builtin' };

export const identityOf = (sub: { id: string; kind: 'personal' | 'api_key' }): NodeIdentity =>
  sub.kind === 'api_key' ? BUILTIN : { kind: 'node', subscriptionId: sub.id };

const keyOf = (id: NodeIdentity) => (id.kind === 'builtin' ? 'builtin' : id.subscriptionId);

/* A node that misses this many pings in a row is dropped. */
const MISSED_PINGS = 3;

type Entry = { socket: WebSocket; missed: number };

type HubOptions = {
  pingMs: number;
  onMessage(id: NodeIdentity, msg: NodeMessage): Promise<void>;
  onClose(id: NodeIdentity): Promise<void>;
  onError?(err: unknown): void;
};

/* Live sockets by identity. One socket per identity: a newer one replaces the older. */
export class NodeHub {
  private readonly sockets = new Map<string, Entry>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly opts: HubOptions) {
    this.timer = setInterval(() => this.sweep(), opts.pingMs);
    this.timer.unref();
  }

  attach(id: NodeIdentity, socket: WebSocket): void {
    const key = keyOf(id);
    this.sockets.get(key)?.socket.close(4000, 'Replaced by a newer connection.');
    const entry: Entry = { socket, missed: 0 };
    this.sockets.set(key, entry);
    const report = (err: unknown) => this.opts.onError?.(err);
    /* Messages run one after another, so job.started is stored before job.done. */
    let chain = Promise.resolve();
    socket.on('pong', () => {
      entry.missed = 0;
    });
    socket.on('message', data => {
      const msg = parseNodeMessage(String(data));
      if (msg) chain = chain.then(() => this.opts.onMessage(id, msg)).catch(report);
    });
    socket.on('close', () => {
      if (this.sockets.get(key) === entry) this.sockets.delete(key);
      chain = chain.then(() => this.opts.onClose(id)).catch(report);
    });
    socket.on('error', report);
  }

  isOnline(id: NodeIdentity): boolean {
    return this.sockets.get(keyOf(id))?.socket.readyState === 1;
  }

  send(id: NodeIdentity, msg: ServerMessage): boolean {
    const entry = this.sockets.get(keyOf(id));
    if (entry?.socket.readyState !== 1) return false;
    entry.socket.send(JSON.stringify(msg));
    return true;
  }

  /* 4001 tells the node it was disconnected in Hornhoof and should not reconnect with this key. */
  close(subscriptionId: string, code = 4001): void {
    this.sockets.get(subscriptionId)?.socket.close(code, 'Disconnected in Hornhoof.');
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
