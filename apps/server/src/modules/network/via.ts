import type { FastifyRequest } from 'fastify';
import { fromTunnel } from '../../auth/tunnel.js';
import type { Config } from '../../config.js';
import { UUID } from '../../net/proxy.js';

/* Who a request of the network routes is from. Every door of front and the keeper drops this header when it comes in, so
   only the keeper itself writes it: for its own request, about the machine the app runs on, or with the id of the peer
   machine whose certificate the peer door saw. */
export const VIA = 'x-hornhoof-via';
export const OWN_VIA = 'keeper';
export type Asker = { own: true } | { own: false; machine: string };

/* The keeper passes every visitor's request on from its own address, so the address alone says nothing, and the header
   from any other address is somebody's own words: only both together name the asker. */
export async function askerOf(req: FastifyRequest, config: Config): Promise<Asker | null> {
  const said = String(req.headers[VIA] ?? '').toLowerCase();
  if (said !== OWN_VIA && !UUID.test(said)) return null;
  if (!(await fromTunnel(req, config))) return null;
  return said === OWN_VIA ? { own: true } : { own: false, machine: said };
}

/* The mark of a request a peer machine's keeper made itself. A worker's front door passes anybody's request to the server
   over its peer link, and the peer door names the worker on all of them; it writes this mark only on the ones the
   worker's keeper sent as its own, which no front door lets a visitor write. */
export const KEEPER_MARK = 'x-hornhoof-keeper';

/* Who asks the routes that are a keeper's alone: this machine's keeper, or a peer machine's keeper and nobody who came
   through that machine. */
export async function keeperAsker(req: FastifyRequest, config: Config): Promise<Asker | null> {
  const who = await askerOf(req, config);
  if (who && !who.own && req.headers[KEEPER_MARK] !== '1') return null;
  return who;
}
