import type { FastifyRequest } from 'fastify';
import { fromTunnel } from '../../auth/tunnel.js';
import type { Config } from '../../config.js';

/* Who a request of the network routes is from. Every door of front and the keeper drops this header when it comes in, so
   only the keeper itself writes it: for its own request, about the machine the app runs on, or with the id of the peer
   machine whose certificate the peer door saw. */
export const VIA = 'x-hornhoof-via';
export const OWN_VIA = 'keeper';
export type Asker = { own: true } | { own: false; machine: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* The keeper passes every visitor's request on from its own address, so the address alone says nothing, and the header
   from any other address is somebody's own words: only both together name the asker. */
export async function askerOf(req: FastifyRequest, config: Config): Promise<Asker | null> {
  const said = String(req.headers[VIA] ?? '').toLowerCase();
  if (said !== OWN_VIA && !UUID.test(said)) return null;
  if (!(await fromTunnel(req, config))) return null;
  return said === OWN_VIA ? { own: true } : { own: false, machine: said };
}
