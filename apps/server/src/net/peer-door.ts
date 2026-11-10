import type http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { z } from 'zod';
import { VIA } from '../modules/network/via.js';
import type { Peer } from './peer-server.js';
import { firstForwarded, INVOCATION, passThrough, serve, startingAnswer, type Target } from './proxy.js';

const LOOPBACK = '127.0.0.1';
const NOBODY_REGISTERED = 'No peer is registered for this connection.';

/* A TCP connection, once it is up. */
export function openTcp(target: Target): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(target);
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
  });
}

/* What the app hears about a peer. The name comes from its certificate; passThrough has already dropped what it said. */
export function peerHeaders(req: http.IncomingMessage, peer: Peer): Record<string, string> {
  const invocation = z.uuid().safeParse(req.headers[INVOCATION]);
  return {
    'x-forwarded-for': firstForwarded(req) || peer.address,
    [VIA]: peer.machine,
    ...(invocation.success ? { [INVOCATION]: invocation.data } : {}),
  };
}

/* The loopback door between the peer link and the app, so that a peer's request reaches the app as any other HTTP request. */
export class PeerDoor {
  private readonly server: http.Server;
  private readonly open = new Map<number, { peer: Peer; socket: net.Socket }>();

  /* holdMs: for how long a peer's request is held while the app is away, as the keeper's other doors hold theirs. */
  constructor(opts: { app: Target; holdMs?: number }) {
    this.server = serve(
      passThrough({ target: opts.app, headers: req => this.headersFor(req), unreachable: startingAnswer, holdMs: opts.holdMs }),
    );
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      /* It stays on: after the start an error is one failed accept, and the next peer should still get through. */
      this.server.on('error', reject);
      this.server.listen(0, LOOPBACK, resolve);
    });
  }

  async connect(peer: Peer): Promise<Duplex> {
    const { port } = this.server.address() as AddressInfo;
    const socket = await openTcp({ host: LOOPBACK, port });
    this.register(socket, peer);
    return socket;
  }

  stop(): Promise<void> {
    for (const { socket } of this.open.values()) socket.destroy();
    this.server.closeAllConnections();
    return new Promise(resolve => this.server.close(() => resolve()));
  }

  private register(socket: net.Socket, peer: Peer): void {
    const port = socket.localPort!;
    this.open.set(port, { peer, socket });
    socket.once('close', () => this.open.delete(port));
  }

  /* Asked at the first request and not when the connection comes: the server may hear of a connection before connect()
     does, but no byte goes out before connect() has registered it. */
  private headersFor(req: http.IncomingMessage): Record<string, string> {
    const known = this.open.get(req.socket.remotePort!);
    if (known) return peerHeaders(req, known.peer);
    req.socket.destroy();
    throw new Error(NOBODY_REGISTERED);
  }
}
