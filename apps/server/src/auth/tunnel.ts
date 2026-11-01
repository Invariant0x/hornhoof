import { lookup } from 'node:dns/promises';
import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';

const socketAddress = (req: FastifyRequest) => (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');

/* Whether the request came from the tunnel container's own address, looked up by its name each time, since the
   container gets a new address when it starts again. */
async function fromTunnel(req: FastifyRequest, config: Config): Promise<boolean> {
  if (!config.tunnelHost) return false;
  const from = socketAddress(req);
  try {
    return (await lookup(config.tunnelHost, { all: true })).some(a => a.address === from);
  } catch {
    return false;
  }
}

/* A request the tunnel container passed on from https, as the relay's X-Forwarded-Proto says. Anyone can write that
   header, so it is believed only from the tunnel container. */
export async function cameOverHttps(req: FastifyRequest, config: Config): Promise<boolean> {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim();
  return proto === 'https' && (await fromTunnel(req, config));
}

/* Who sent the request: through the tunnel, the first address of X-Forwarded-For, where the relay puts the visitor in
   place of whatever the visitor wrote; otherwise the socket's own address. */
export async function clientAddress(req: FastifyRequest, config: Config): Promise<string> {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim();
  return forwarded && (await fromTunnel(req, config)) ? forwarded : socketAddress(req);
}
