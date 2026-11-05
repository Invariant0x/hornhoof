import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { ApiError } from '../../errors.js';
import type { NodeIdentity } from '../nodes/hub.js';
import { identify } from '../nodes/socket.js';
import { serverNodes } from './drain-work.js';
import { requireProvenBuild } from './live-check.js';
import { cancelNodeDrain, requestNodeDrain } from './node-drain.js';

const Scope = z.object({ scope: z.enum(['node', 'server']).default('node') });
/* Well within the lease of a request, whatever the node waits for, so its card goes on saying so. */
const POLL_MS = 5000;

/* The node the key belongs to or, for the built-in node's key alone, all those on the server's computer. */
async function targets(ctx: Ctx, req: FastifyRequest): Promise<NodeIdentity[]> {
  const node = await identify(ctx, req);
  if (!node) throw new ApiError(401, 'unauthorized', 'Unknown node key.');
  const { scope } = Scope.parse(req.body ?? {});
  if (scope === 'server' && node.kind !== 'builtin') throw new ApiError(403, 'forbidden', 'Only the built-in node may prepare a server update.');
  return scope === 'server' ? serverNodes(ctx) : [node];
}

export function nodeUpdateRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.post('/api/nodes/update', async req => {
    const nodes = await targets(ctx, req);
    await requireProvenBuild(ctx);
    const views = await Promise.all(nodes.map(n => requestNodeDrain(ctx, n)));
    const drain = views.find(v => v.state === 'waiting') ?? views.find(v => v.state === 'postponed') ?? views[0]!;
    return { ready: views.every(v => v.state === 'restarting'), drain, pollAfterMs: POLL_MS };
  });
  app.delete('/api/nodes/update', async (req, reply) => {
    for (const node of await targets(ctx, req)) cancelNodeDrain(ctx, node);
    return reply.code(204).send();
  });
}
