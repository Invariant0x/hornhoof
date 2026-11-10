import { lookup } from 'node:dns/promises';
import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { socketAddress } from '../net/proxy.js';

/* Looked up by name each time, since a container gets a new address when it starts again. */
export async function isAddressOf(name: string | null | undefined, address: string): Promise<boolean> {
  if (!name) return false;
  try {
    return (await lookup(name, { all: true })).some(found => found.address === address);
  } catch {
    return false;
  }
}

/* Whether the request came from the keeper container's own address. */
export const fromTunnel = (req: FastifyRequest, config: Config): Promise<boolean> => isAddressOf(config.tunnelHost, socketAddress(req.raw));

/* A request the keeper passed on from the link, which only it marks as https. Anyone can write that header, so it is
   believed only from the keeper container. */
async function cameOverHttps(req: FastifyRequest, config: Config): Promise<boolean> {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim();
  return proto === 'https' && (await fromTunnel(req, config));
}

/* Whether the request is one of a visitor of the public link, the one the __Host- session cookie belongs to. */
export async function overLink(req: FastifyRequest, config: Config): Promise<boolean> {
  return cameOverHttps(req, config);
}

/* Who sent the request: through the keeper, the first address of X-Forwarded-For, which the keeper writes whatever the
   visitor wrote; otherwise the socket's own address. */
export async function clientAddress(req: FastifyRequest, config: Config): Promise<string> {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim();
  return forwarded && (await fromTunnel(req, config)) ? forwarded : socketAddress(req.raw);
}
