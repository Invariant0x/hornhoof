import { lookup } from 'node:dns/promises';
import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { socketAddress, UUID } from '../net/proxy.js';

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
export async function cameOverHttps(req: FastifyRequest, config: Config): Promise<boolean> {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]!.trim();
  return proto === 'https' && (await fromTunnel(req, config));
}

/* Whether the request is one of a visitor of the public link, the one the __Host- session cookie belongs to. */
export async function overLink(req: FastifyRequest, config: Config): Promise<boolean> {
  return cameOverHttps(req, config);
}

/* How an address that stands for a whole peer machine begins. */
export const PEER_ADDRESS = 'peer:';

/* Who sent the request: through the keeper, the first address of X-Forwarded-For, which the keeper writes whatever the
   visitor wrote; otherwise the socket's own address. What came through a peer machine counts as that one machine: the
   forwarded address there is the word of the machine's owner, who could change it with every try. The header that names
   the machine is read here and not through the network module, which reads this one. */
export async function clientAddress(req: FastifyRequest, config: Config): Promise<string> {
  const viaTunnel = await fromTunnel(req, config);
  const peer = String(req.headers['x-hornhoof-via'] ?? '').toLowerCase();
  if (viaTunnel && UUID.test(peer)) return `${PEER_ADDRESS}${peer}`;
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim();
  return forwarded && viaTunnel ? forwarded : socketAddress(req.raw);
}
