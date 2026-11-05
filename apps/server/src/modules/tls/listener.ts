import type http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { createSecureContext, TLSSocket } from 'node:tls';
import type { FastifyBaseLogger } from 'fastify';
import { readProxyV2, type ProxyHeader } from './proxy-header.js';
import { selfSigned } from './x509.js';

/* Inside the keeper's container, where only the keeper's own frpc reaches it. */
export const LINK_TLS_PORT = 8443;

const LISTEN_HOST = '127.0.0.1';
const STAND_IN_HOST = 'hornhoof.invalid';
const HEADER_MS = 5000;
const HANDSHAKE_MS = 10_000;
const CLOSE_GRACE_MS = 5000;

type WholeHeader = Extract<ProxyHeader, { state: 'done' }>;
type ListenerOptions = { server: http.Server; log: FastifyBaseLogger | { warn(o: unknown, m?: string): void } };

/* Who each decrypted connection is for, kept beside the socket since the server it goes to only sees the socket. */
const visitors = new WeakMap<object, string>();

export function linkVisitor(socket: unknown): string | undefined {
  return visitors.get(socket as object);
}

/* A visitor who leaves in the middle is no news, but an error with no handler would end the process. */
const ignore = (): void => {};

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
   TLS, which ends here. The decrypted connection goes to the server it was given, so every request, stream and WebSocket
   works on it unchanged. Every header is believed: only that frpc reaches the address this listens on. */
export class LinkListener {
  private readonly server: net.Server;
  private readonly connections = new Set<net.Socket>();
  /* Replaced in listen before a connection can arrive, so a handshake always finds a certificate. */
  private context = createSecureContext();
  private uses = 0;

  constructor(private readonly opts: ListenerOptions) {
    this.server = net.createServer({ noDelay: true }, raw => this.accept(raw));
    this.server.on('error', err => opts.log.warn({ err }, 'The link TLS listener failed.'));
  }

  async listen(port: number, host = LISTEN_HOST): Promise<number> {
    await this.use(null, null);
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    /* That server has no port of its own, and Node times a connection's headers and finds its idle ones only on a server
       it has seen listen. Without this a visitor who never ends its headers would hold a connection for good. */
    this.opts.server.emit('listening');
    return (this.server.address() as AddressInfo).port;
  }

  /* For new connections. Making a stand-in takes a moment, so a later call may finish first, and the later call is the
     one that counts. */
  async use(host: string | null, cert: { certPem: string; keyPem: string } | null): Promise<void> {
    const use = ++this.uses;
    const served = cert ?? (await selfSigned(host ?? STAND_IN_HOST));
    if (use === this.uses) this.context = createSecureContext({ cert: served.certPem, key: served.keyPem });
  }

  /* An event stream or a WebSocket never ends by itself, so what is left after the grace is cut. */
  async close(graceMs = CLOSE_GRACE_MS): Promise<void> {
    const grace = setTimeout(() => this.connections.forEach(raw => raw.destroy()), graceMs);
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    clearTimeout(grace);
  }

  private accept(raw: net.Socket): void {
    this.connections.add(raw);
    raw.once('close', () => this.connections.delete(raw));
    raw.on('error', ignore);
    this.open(raw).catch((err: unknown) => {
      this.opts.log.warn({ err }, 'A link connection could not be opened.');
      raw.destroy();
    });
  }

  private async open(raw: net.Socket): Promise<void> {
    const header = await wholeHeader(raw);
    if (!header) return void raw.destroy();
    if (!raw.destroyed) this.startTls(raw, header.source);
  }

  private startTls(raw: net.Socket, visitor: string | null): void {
    const secure = new TLSSocket(raw, { isServer: true, secureContext: this.context, ALPNProtocols: ['http/1.1'] });
    if (visitor !== null) visitors.set(secure, visitor);
    const handshake = setTimeout(() => secure.destroy(), HANDSHAKE_MS);
    secure.once('close', () => clearTimeout(handshake));
    secure.on('error', ignore);
    secure.once('secure', () => {
      clearTimeout(handshake);
      this.opts.server.emit('connection', secure);
    });
  }
}
