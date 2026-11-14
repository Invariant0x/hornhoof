import { lookup } from 'node:dns/promises';
import net, { type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { OncePerMinute } from './peer-server.js';
import { spliceSockets } from './proxy.js';

export const DB_DOOR_PORT = 7432;
const REFRESH_MS = 60_000;
const ANY_ADDRESS = '0.0.0.0';
const FAILED = 'failed';

const ignore = (): void => {};
/* An IPv4 address a socket names the IPv6 way is the same address. */
const plain = (address: string): string => address.replace(/^::ffff:/, '');

/* The addresses the services of these names have on compose's network: the database and the app, the only ones that
   may use a door. A name that does not resolve adds none. */
export function composeAllowed(names: string[] = ['db', 'app']): () => Promise<string[]> {
  return async () => {
    const found = await Promise.all(names.map(name => lookup(name, { all: true }).then(all => all.map(one => one.address), () => [])));
    return found.flat();
  };
}

/* A door in the keeper that leads to the database of another machine: Postgres never sees the peer link, so every
   connection the door takes becomes one stream of it, carried byte for byte and never read. It takes connections only
   from the addresses it is told, read again each minute: a door opens the company's whole database to whoever knows the
   replica's password, so nothing else on the network may knock. */
export class DbDoor {
  private server: net.Server | null = null;
  private timer: NodeJS.Timeout | undefined;
  private allowed = new Set<string>();
  private readonly sockets = new Set<net.Socket>();
  private readonly lineGate = new OncePerMinute();

  constructor(
    private readonly opts: { connect: () => Promise<Duplex>; allowed: () => Promise<string[]>; log: (line: string) => void; host?: string; refreshMs?: number },
  ) {}

  /* Answers the port it listens at. */
  async listen(port: number): Promise<number> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.opts.refreshMs ?? REFRESH_MS);
    this.timer.unref();
    const server = net.createServer(socket => void this.carry(socket));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, this.opts.host ?? ANY_ADDRESS, () => {
        /* It stays on: after the start an error is one failed accept, and the next connection should still get through. */
        server.off('error', reject);
        server.on('error', ignore);
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  /* Stops listening and ends every connection it carries. */
  async close(): Promise<void> {
    clearInterval(this.timer);
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  }

  /* A read that fails keeps who was allowed before. */
  private async refresh(): Promise<void> {
    const allowed = await this.opts.allowed().catch(() => null);
    if (allowed) this.allowed = new Set(allowed.map(plain));
  }

  private async carry(socket: net.Socket): Promise<void> {
    socket.on('error', ignore);
    if (!this.allowed.has(plain(socket.remoteAddress ?? ''))) return void socket.destroy();
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    try {
      const far = await this.opts.connect();
      if (socket.destroyed) return void far.destroy();
      spliceSockets(socket, far);
    } catch (err) {
      socket.destroy();
      if (this.lineGate.allows(FAILED, Date.now())) this.opts.log(`A database connection could not be carried to the other machine: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
