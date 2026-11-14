import net, { type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { spliceSockets } from './proxy.js';

const LOOPBACK = '127.0.0.1';

const ignore = (): void => {};

/* A loopback door in a worker's keeper that leads to the app of the company's leader: every connection it takes is
   carried, byte for byte, over a stream of the peer link. So the keeper's front door and the keeper's own requests reach
   the leader's app as they reach an app beside them, by plain HTTP to a local port. It listens only while there is a
   leader: a connection refused here is a target that is not up yet, which the front door holds its requests for. */
export class LeaderDoor {
  private server: net.Server | null = null;
  private at = 0;
  private readonly sockets = new Set<net.Socket>();
  private stopped = false;

  /* connect: a new stream to the leader's app, or a rejection while no leader is in reach. */
  constructor(private readonly opts: { connect: () => Promise<Duplex> }) {}

  /* Takes a free port and opens it. */
  async start(): Promise<number> {
    await this.open();
    return this.at;
  }

  /* The port the door listens at, or last did. */
  port(): number {
    return this.at;
  }

  /* Listens when it does not: at the port it had, so whoever knows the door finds it again, and at another free one when
     something took that port meanwhile. */
  async open(): Promise<void> {
    if (this.server || this.stopped) return;
    this.server = await this.listenAt(this.at).catch(() => this.listenAt(0));
    this.at = (this.server.address() as AddressInfo).port;
  }

  /* Takes no new connection and lets go of the ones it carries: they led to a machine that leads no more, and whoever
     held one comes again and finds the leader there is now. */
  async shut(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.shut();
  }

  private listenAt(port: number): Promise<net.Server> {
    const server = net.createServer(socket => void this.carry(socket));
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, LOOPBACK, () => {
        /* It stays on: after the start an error is one failed accept, and the next connection should still get through. */
        server.off('error', reject);
        server.on('error', ignore);
        resolve(server);
      });
    });
  }

  private async carry(socket: net.Socket): Promise<void> {
    socket.on('error', ignore);
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    const far = await this.opts.connect().catch(() => null);
    if (!far || socket.destroyed) {
      far?.destroy();
      socket.destroy();
      return;
    }
    spliceSockets(socket, far);
  }
}
