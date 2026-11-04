import { lookup } from 'node:dns/promises';
import net, { type AddressInfo } from 'node:net';
import { createSecureContext, TLSSocket } from 'node:tls';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import { readProxyV2, type ProxyHeader } from './proxy-header.js';
import { selfSigned } from './x509.js';

/* The tunnel container reaches it on the default network; compose does not publish it. */
export const LINK_TLS_PORT = 8443;

const STAND_IN_HOST = 'hornhoof.invalid';
const HEADER_MS = 5000;
const HANDSHAKE_MS = 10_000;
const CLOSE_GRACE_MS = 5000;

type WholeHeader = Extract<ProxyHeader, { state: 'done' }>;

/* Who each decrypted connection is for, kept beside the socket since Fastify only sees the socket. */
const visitors = new WeakMap<object, string>();

export function linkVisitor(socket: unknown): string | undefined {
  return visitors.get(socket as object);
}

export const socketAddress = (socket: { remoteAddress?: string }): string => (socket.remoteAddress ?? '').replace(/^::ffff:/, '');

/* Whether an address is the tunnel container's, looked up by its name each time, since the container gets a new address
   when it starts again. */
export async function isTunnelAddress(address: string, config: Config): Promise<boolean> {
  if (!config.tunnelHost) return false;
  try {
    return (await lookup(config.tunnelHost, { all: true })).some(a => a.address === address);
  } catch {
    return false;
  }
}

/* Anyone who reaches the port can write a header, so its source counts only from the tunnel container. */
async function visitorOf(raw: net.Socket, source: string | null, config: Config): Promise<string> {
  const address = socketAddress(raw);
  return source !== null && (await isTunnelAddress(address, config)) ? source : address;
}

/* Reads until the header is whole and leaves what came after it for TLS. Null when there will be no header: it was
   refused, it took too long, or the connection ended. */
function wholeHeader(raw: net.Socket): Promise<WholeHeader | null> {
  return new Promise(resolve => {
    let read = Buffer.alloc(0);
    const finish = (header: WholeHeader | null) => {
      clearTimeout(deadline);
      raw.off('data', onData);
      raw.off('close', onClose);
      resolve(header);
    };
    const onClose = () => finish(null);
    const onData = (chunk: Buffer) => {
      read = Buffer.concat([read, chunk]);
      const header = readProxyV2(read);
      if (header.state === 'more') return;
      if (header.state === 'bad') return finish(null);
      raw.pause();
      raw.unshift(read.subarray(header.length));
      finish(header);
    };
    const deadline = setTimeout(onClose, HEADER_MS);
    raw.on('data', onData);
    raw.once('close', onClose);
  });
}

/* The company's end of the link's TLS. The link's frpc opens each connection with a PROXY v2 header and then the visitor's
   TLS, which ends here; the decrypted connection goes to Fastify's own http server, so every route, hook and WebSocket
   works on it unchanged. */
export class LinkListener {
  private readonly server: net.Server;
  private readonly connections = new Set<net.Socket>();
  /* Replaced in listen before a connection can arrive, so a handshake always finds a certificate. */
  private context = createSecureContext();
  private uses = 0;

  constructor(private readonly opts: { app: FastifyInstance; config: Config; log: FastifyBaseLogger }) {
    this.server = net.createServer({ noDelay: true }, raw => this.accept(raw));
    this.server.on('error', err => opts.log.error({ err }, 'The link TLS listener failed.'));
  }

  async listen(port: number, host = '0.0.0.0'): Promise<number> {
    await this.use(null, null);
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    return (this.server.address() as AddressInfo).port;
  }

  /* For new connections. Making a stand-in takes a moment, so a later call may finish first, and the later call is the
     one that counts. */
  async use(host: string | null, cert: { certPem: string; keyPem: string } | null): Promise<void> {
    const use = ++this.uses;
    const served = cert ?? (await selfSigned(host ?? STAND_IN_HOST));
    if (use === this.uses) this.context = createSecureContext({ cert: served.certPem, key: served.keyPem });
  }

  /* The app's own close ends the event streams and WebSockets, so the grace is for what is left after that. */
  async close(graceMs = CLOSE_GRACE_MS): Promise<void> {
    const grace = setTimeout(() => this.connections.forEach(raw => raw.destroy()), graceMs);
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    clearTimeout(grace);
  }

  private accept(raw: net.Socket): void {
    this.connections.add(raw);
    raw.once('close', () => this.connections.delete(raw));
    raw.on('error', err => this.opts.log.debug({ err }, 'A link connection failed.'));
    this.open(raw).catch((err: unknown) => {
      this.opts.log.warn({ err }, 'A link connection could not be opened.');
      raw.destroy();
    });
  }

  private async open(raw: net.Socket): Promise<void> {
    const header = await wholeHeader(raw);
    if (!header) return void raw.destroy();
    const visitor = await visitorOf(raw, header.source, this.opts.config);
    if (!raw.destroyed) this.startTls(raw, visitor);
  }

  private startTls(raw: net.Socket, visitor: string): void {
    const secure = new TLSSocket(raw, { isServer: true, secureContext: this.context, ALPNProtocols: ['http/1.1'] });
    visitors.set(secure, visitor);
    const handshake = setTimeout(() => secure.destroy(), HANDSHAKE_MS);
    secure.once('close', () => clearTimeout(handshake));
    secure.on('error', err => this.opts.log.debug({ err }, 'A link connection failed in TLS.'));
    secure.once('secure', () => {
      clearTimeout(handshake);
      this.opts.app.server.emit('connection', secure);
    });
  }
}
