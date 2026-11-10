import net, { type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

const LOOPBACK = '127.0.0.1';

const ignore = (): void => {};

/* What is already written still goes out; then the socket closes whatever the other end does. */
function closeAfterFlush(socket: net.Socket): void {
  socket.end(() => socket.destroy());
}

/* A loopback door in a worker's keeper that leads to the app of the company's leader: every connection it takes is
   carried, byte for byte, over a stream of the peer link. So the keeper's front door and the keeper's own requests reach
   the leader's app as they reach an app beside them, by plain HTTP to a local port. It listens only while there is a
   leader: a connection refused here is a target that is not up yet, which the front door holds its requests for. */
export class LeaderDoor {
  private server: net.Server | null = null;
  private port = 0;
  private readonly sockets = new Set<net.Socket>();
  private stopped = false;

  /* connect: a new stream to the leader's app, or a rejection while no leader is in reach. */
  constructor(private readonly opts: { connect: () => Promise<Duplex> }) {}

  /* Takes a free port, which the door then keeps, and opens it. */
  async start(): Promise<number> {
    await this.open();
    return this.port;
  }

  /* Listens at its port when it does not. */
  async open(): Promise<void> {
    if (this.server || this.stopped) return;
    const server = net.createServer(socket => void this.carry(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, LOOPBACK, () => {
        /* It stays on: after the start an error is one failed accept, and the next connection should still get through. */
        server.off('error', reject);
        server.on('error', ignore);
        resolve();
      });
    });
    this.port = (server.address() as AddressInfo).port;
  }

  /* Takes no new connection. The ones it carries go on for as long as their streams do. */
  async shut(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const socket of this.sockets) socket.destroy();
    await this.shut();
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
    far.on('error', ignore);
    socket.pipe(far);
    far.pipe(socket);
    socket.once('close', () => far.destroy());
    far.once('close', () => closeAfterFlush(socket));
  }
}
