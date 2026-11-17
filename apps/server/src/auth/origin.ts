import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { ApiError } from '../errors.js';
import { linkOf } from '../modules/link/link.js';

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

function ordinaryRead(req: FastifyRequest): boolean {
  return READS.has(req.method) && req.headers.upgrade?.toLowerCase() !== 'websocket';
}

function fromRequestAddress(req: FastifyRequest, origin: string): boolean {
  const hosts = [req.headers.host, ...String(req.headers['x-forwarded-host'] ?? '').split(',')].map(h => h?.trim()).filter(Boolean);
  return URL.canParse(origin) && hosts.includes(new URL(origin).host);
}

async function fromKnownAddress(db: Db, req: FastifyRequest, origin: string): Promise<boolean> {
  if (fromRequestAddress(req, origin)) return true;
  const link = await linkOf(db);
  return Boolean(link && origin === new URL(link.url).origin);
}

/* A browser names the page each change and each socket comes from. One from a page of another site is refused, even
   with the person's cookie: that site cannot read the answer, but it could still stop an agent or type into a terminal.
   Hornhoof's own pages come from its public address, from its public link at hornhoof.org, or from the address the
   request was sent to, as a proxy passes it on; programs name no page and pass. */
export function fromOwnPages(config: Config, db: Db) {
  const own = new URL(config.publicUrl).origin;
  return async (req: FastifyRequest) => {
    const origin = req.headers.origin;
    if (origin === undefined || origin === own) return;
    if (ordinaryRead(req)) return;
    if (await fromKnownAddress(db, req, origin)) return;
    throw new ApiError(403, 'forbidden', 'This came from a page of another site, so Hornhoof did not do it.', 'cross_site');
  };
}
