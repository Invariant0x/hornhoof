import { randomUUID } from 'node:crypto';
import { TERM_CHUNK } from '@hornhoof/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agentFor } from '../agents/find.js';
import { liveSubscription } from '../conversation/queue.js';
import { identityOf, type NodeIdentity } from '../nodes/hub.js';
import { CLOSE } from './relay.js';

const cols = z.coerce.number().int().min(10).max(500);
const rows = z.coerce.number().int().min(4).max(200);
const Size = z.object({ cols: cols.catch(120), rows: rows.catch(36) });
const FromBrowser = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().min(1).max(TERM_CHUNK) }),
  z.object({ type: z.literal('resize'), cols, rows }),
]);

type Found = { personId: string; agentId: string; node: NodeIdentity | null };

/* An agent's live terminal for a person who reaches the agent: the screen of its session on the node, and the keys they
   type. Everyone who may write to an agent may type into it. */
export function terminalRoutes(app: FastifyInstance, ctx: Ctx): void {
  const found = new WeakMap<FastifyRequest, Found>();
  app.addHook('preClose', async () => ctx.terminals.stop());

  app.get(
    '/api/agents/:id/terminal',
    {
      websocket: true,
      preValidation: async req => {
        const { me, agent } = await agentFor(ctx, req);
        const sub = await liveSubscription(ctx, agent.id);
        found.set(req, { personId: me.id, agentId: agent.id, node: sub ? identityOf(sub) : null });
      },
    },
    (socket, req) => {
      const { personId, agentId, node } = found.get(req)!;
      const { cols, rows } = Size.parse(req.query ?? {});
      const termId = randomUUID();
      if (!node || !ctx.hub.hasTerminals(node)) return socket.close(...CLOSE.noTerminal);
      ctx.terminals.add(termId, { socket, node, agentId, personId });
      if (!ctx.hub.send(node, { type: 'term.open', termId, agentKey: agentId, cols, rows, write: true })) {
        ctx.terminals.remove(termId);
        return socket.close(...CLOSE.noTerminal);
      }
      socket.send(JSON.stringify({ type: 'ready', write: true }));

      socket.on('message', raw => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          return;
        }
        const msg = FromBrowser.safeParse(parsed);
        if (!msg.success) return;
        if (msg.data.type === 'input') {
          ctx.terminals.typing(agentId, personId);
          ctx.hub.send(node, { type: 'term.input', termId, data: msg.data.data });
        } else ctx.hub.send(node, { type: 'term.resize', termId, cols: msg.data.cols, rows: msg.data.rows });
      });
      /* Like the live stream, the view looks at the person again: one signed out or moved away stops watching. */
      const check = setInterval(() => void agentFor(ctx, req).catch(() => socket.close(...CLOSE.noAccess)), ctx.config.streamPingMs);
      socket.on('close', () => {
        clearInterval(check);
        if (ctx.terminals.remove(termId)) ctx.hub.send(node, { type: 'term.close', termId });
      });
    },
  );
}
