import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Ctx } from '../../app.js';
import { hashToken } from '../../crypto/tokens.js';
import { subscriptions } from '../../db/schema.js';
import { BUILTIN, type NodeIdentity } from './hub.js';

/* Results can be long; anything bigger than this closes the socket. */
const MAX_FRAME = 4 * 1024 * 1024;

function sameKey(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/* The built-in node's key, or the key a node got at join. Removed subscriptions still match so they can be told to clean up. */
async function identify(ctx: Ctx, req: FastifyRequest): Promise<NodeIdentity | null> {
  const header = req.headers.authorization ?? '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!key) return null;
  if (ctx.config.nodeKey && sameKey(key, ctx.config.nodeKey)) return BUILTIN;
  const [sub] = await ctx.db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.nodeKeyHash, hashToken(key)));
  return sub ? { kind: 'node', subscriptionId: sub.id } : null;
}

export function nodeSocket(app: FastifyInstance, ctx: Ctx): void {
  const identities = new WeakMap<FastifyRequest, NodeIdentity>();
  app.get(
    '/api/nodes/socket',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        const id = await identify(ctx, req);
        if (!id) return reply.code(401).send({ error: { code: 'unauthorized', message: 'Unknown node key.' } });
        identities.set(req, id);
      },
    },
    (socket, req) => ctx.hub.attach(identities.get(req)!, socket),
  );
}

export const SOCKET_OPTIONS = { options: { maxPayload: MAX_FRAME } };
