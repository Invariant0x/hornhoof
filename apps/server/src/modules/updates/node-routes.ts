import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { ApiError } from '../../errors.js';
import { identify } from '../nodes/socket.js';
import { cancelNodeDrain, requestNodeDrain, requestServerDrain } from './node-drain.js';

const Prepare = z.object({ scope: z.enum(['node', 'server']).default('node') });

export function nodeUpdateRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.post('/api/nodes/update', async req => {
    const node = await identify(ctx, req);
    if (!node) throw new ApiError(401, 'unauthorized', 'Unknown node key.');
    const { scope } = Prepare.parse(req.body ?? {});
    if (scope === 'server' && node.kind !== 'builtin') throw new ApiError(403, 'forbidden', 'Only the built-in node may prepare a server update.');
    const drain = scope === 'server' ? await requestServerDrain(ctx) : await requestNodeDrain(ctx, node);
    return { ready: drain.state === 'restarting', drain, pollAfterMs: drain.state === 'postponed' ? Math.max(1, Date.parse(drain.retryAt) - Date.now()) : 1000 };
  });
  app.delete('/api/nodes/update', async (req, reply) => {
    const node = await identify(ctx, req);
    if (!node) throw new ApiError(401, 'unauthorized', 'Unknown node key.');
    cancelNodeDrain(ctx, node);
    return reply.code(204).send();
  });
}
