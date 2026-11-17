import type { MachineDrain } from '@hornhoof/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { ApiError } from '../../errors.js';
import { identify } from '../nodes/socket.js';
import { namedServerNodes, type ServerNode } from './drain-work.js';
import { cancelNodeDrain, requestNodeDrain } from './node-drain.js';

/* nodes: on the whole server, the ones this is about, for an updater that replaces each by itself: the ones that run another
   image, or those it replaced. Names the server does not know, as a node of another server on this computer, count for
   nothing. */
const Scope = z.object({ scope: z.enum(['node', 'server']).default('node'), nodes: z.array(z.string().min(1).max(64)).max(64).optional() });
/* Well within the lease of a request, whatever the node waits for, so its card goes on saying so. */
const POLL_MS = 5000;

/* The node the key belongs to or, for the built-in node's key alone, those on the server's computer it names, or all. */
async function targets(ctx: Ctx, req: FastifyRequest): Promise<ServerNode[]> {
  const node = await identify(ctx, req);
  if (!node) throw new ApiError(401, 'unauthorized', 'Unknown node key.');
  const { scope, nodes } = Scope.parse(req.body ?? {});
  if (scope !== 'server') return [{ name: 'self', node }];
  if (node.kind !== 'builtin') throw new ApiError(403, 'forbidden', 'Only the built-in node may prepare a server update.');
  const all = await namedServerNodes(ctx);
  return nodes ? all.filter(n => nodes.includes(n.name)) : all;
}

/* The one that says most of why they wait: one still waiting, or else the first. */
const longestWait = (views: MachineDrain[]): MachineDrain | null => views.find(v => v.state === 'waiting') ?? views[0] ?? null;

const allFree = (views: MachineDrain[], free: string[]): boolean => views.length > 0 && free.length === views.length;

export function nodeUpdateRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.post('/api/nodes/update', async req => {
    const asked = await targets(ctx, req);
    const views = await Promise.all(asked.map(n => requestNodeDrain(ctx, n.node)));
    const free = asked.filter((_, i) => views[i]!.state === 'restarting').map(n => n.name);
    /* ready, for an updater from before free: all of them together. */
    return { ready: allFree(views, free), free, drain: longestWait(views), pollAfterMs: POLL_MS };
  });
  app.delete('/api/nodes/update', async (req, reply) => {
    for (const { node } of await targets(ctx, req)) cancelNodeDrain(ctx, node);
    return reply.code(204).send();
  });
}
