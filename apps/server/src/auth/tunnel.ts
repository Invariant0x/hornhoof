import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { isTunnelAddress, linkVisitor, socketAddress } from '../modules/tls/listener.js';

/* Whether the request came from the tunnel container's own address. */
const fromTunnel = (req: FastifyRequest, config: Config): Promise<boolean> => isTunnelAddress(socketAddress(req.socket), config);

/* A request through the TLS listener, or one the tunnel container passed on from https, as the relay's X-Forwarded-Proto
   says. Anyone can write that header, so it is believed only from the tunnel container. */
async function cameOverHttps(req: FastifyRequest, config: Config): Promise<boolean> {
  if (linkVisitor(req.socket) !== undefined) return true;
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim();
  return proto === 'https' && (await fromTunnel(req, config));
}

/* Whether the request is one of a visitor of the public link, the one the __Host- session cookie belongs to. */
export async function overLink(req: FastifyRequest, config: Config): Promise<boolean> {
  return cameOverHttps(req, config);
}

/* Who sent the request: through the TLS listener, the visitor it read, whatever the visitor's headers say; through the
   tunnel, the first address of X-Forwarded-For, where the relay puts the visitor in place of whatever the visitor wrote;
   otherwise the socket's own address. */
export async function clientAddress(req: FastifyRequest, config: Config): Promise<string> {
  const visitor = linkVisitor(req.socket);
  if (visitor !== undefined) return visitor;
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim();
  return forwarded && (await fromTunnel(req, config)) ? forwarded : socketAddress(req.socket);
}
