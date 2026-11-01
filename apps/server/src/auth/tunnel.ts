import { lookup } from 'node:dns/promises';
import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';

/* A request the tunnel container passed on from https, as the relay's X-Forwarded-Proto says. Anyone can write that
   header, so it is believed only from the tunnel container's own address, looked up by its name each time, since the
   container gets a new address when it starts again. */
export async function cameOverHttps(req: FastifyRequest, config: Config): Promise<boolean> {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim();
  if (!config.tunnelHost || proto !== 'https') return false;
  const from = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  try {
    return (await lookup(config.tunnelHost, { all: true })).some(a => a.address === from);
  } catch {
    return false;
  }
}
