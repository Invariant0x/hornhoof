import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { ApiError } from '../errors.js';
import { linkOf } from '../modules/link/link.js';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/* A browser names the page each change and each socket comes from. One from a page of another site is refused, even
   with the person's cookie: that site cannot read the answer, but it could still stop an agent or type into a terminal.
   Hornhoof's own pages come from its public address, from its public link at hornhoof.org, or from the address the
   request was sent to, as a proxy passes it on; programs name no page and pass. */
export function fromOwnPages(config: Config, db: Db) {
  const own = new URL(config.publicUrl).origin;
  return async (req: FastifyRequest) => {
    const origin = req.headers.origin;
    if (origin === undefined || origin === own) return;
    if (READS.has(req.method) && req.headers.upgrade?.toLowerCase() !== 'websocket') return;
    const hosts = [req.headers.host, ...String(req.headers['x-forwarded-host'] ?? '').split(',')].map(h => h?.trim()).filter(Boolean);
    if (URL.canParse(origin) && hosts.includes(new URL(origin).host)) return;
    const link = await linkOf(db);
    if (link && origin === new URL(link.url).origin) return;
    throw new ApiError(403, 'forbidden', 'This came from a page of another site, so Hornhoof did not do it.', 'cross_site');
  };
}
