import { randomUUID } from 'node:crypto';
import { TERM_CHUNK } from '@hornhoof/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agentFor } from '../agents/find.js';
import { typedInto } from '../conversation/decision-context.js';
import { programNode, windowNode } from '../conversation/queue.js';
import { sameNode, type NodeIdentity } from '../nodes/hub.js';
import { CLOSE } from './relay.js';

const cols = z.coerce.number().int().min(10).max(500);
const rows = z.coerce.number().int().min(4).max(200);
const Size = z.object({ cols: cols.catch(120), rows: rows.catch(36) });
const FromBrowser = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().min(1).max(TERM_CHUNK) }),
  z.object({ type: z.literal('resize'), cols, rows }),
]);

/* write: the person owns the subscription the agent runs on. A program's terminal runs commands on its owner's machine
   with the owner's sign-in, so everyone else watches and writes through Hornhoof. */
type Found = { personId: string; companyId: string; agentId: string; node: NodeIdentity | null; write: boolean };

/* An agent's live terminal for a person who reaches the agent: the screen of its session on the node, and the keys its
   subscription's owner types. */
export function terminalRoutes(app: FastifyInstance, ctx: Ctx): void {
  const found = new WeakMap<FastifyRequest, Found>();
  app.addHook('preClose', async () => ctx.terminals.stop());

  app.get(
    '/api/agents/:id/terminal',
    {
      websocket: true,
      preValidation: async req => {
        const { me, agent } = await agentFor(ctx, req);
        const at = await windowNode(ctx, agent.id);
        found.set(req, { personId: me.id, companyId: me.companyId, agentId: agent.id, node: at?.node ?? null, write: at?.ownerPersonId === me.id });
      },
    },
    (socket, req) => {
      const { personId, companyId, agentId, node, write } = found.get(req)!;
      const { cols, rows } = Size.parse(req.query ?? {});
      const termId = randomUUID();
      if (!node) return socket.close(...CLOSE.noTerminal);
      /* A node that is away comes back; the browser tries again. */
      if (!ctx.hub.isReady(node)) return socket.close(...CLOSE.nodeOffline);
      if (!ctx.hub.hasTerminals(node)) return socket.close(...CLOSE.noTerminal);
      ctx.terminals.add(termId, { socket, node, agentId, personId });
      if (!ctx.hub.send(node, { type: 'term.open', termId, agentKey: agentId, cols, rows, write })) {
        ctx.terminals.remove(termId);
        return socket.close(...CLOSE.nodeOffline);
      }
      socket.send(JSON.stringify({ type: 'ready', write }));

      /* Frames go on in the order they came, as one waits for the person's Enter to be kept. */
      let frames = Promise.resolve();
      const frame = async (data: z.infer<typeof FromBrowser>) => {
        if (data.type === 'resize') return void ctx.hub.send(node, { type: 'term.resize', termId, cols: data.cols, rows: data.rows });
        if (!write) return;
        /* A prompt goes in with Enter; scrolling and clicks send keys too. What the person sends with it is their word in
           the running turn from now on, kept before the keys reach it. */
        if (data.data.includes('\r')) {
          ctx.terminals.typing(agentId, personId, node);
          await typedInto(ctx, agentId, personId);
        }
        ctx.hub.send(node, { type: 'term.input', termId, data: data.data });
      };
      socket.on('message', raw => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(raw));
        } catch {
          return;
        }
        const msg = FromBrowser.safeParse(parsed);
        if (!msg.success) return;
        frames = frames.then(() => frame(msg.data)).catch(err => ctx.log.error({ error: String(err) }, 'Keys for a terminal could not go on.'));
      });
      /* Like the live stream, the view looks at the person again: one signed out or moved away stops watching. An agent
         that moved to another subscription or machine runs on another node once its running turn is over, and the browser
         opens the view again there. A change of anyone's access looks at once. */
      const look = async () => {
        try {
          await agentFor(ctx, req);
        } catch {
          return socket.close(...CLOSE.noAccess);
        }
        const at = await programNode(ctx, agentId).catch(() => undefined);
        if (at !== undefined && (!at || !sameNode(at.node, node))) socket.close(...CLOSE.nodeOffline);
      };
      const check = setInterval(look, ctx.config.streamPingMs);
      const stopLooking = ctx.bus.onAccessChange(companyId, () => void look());
      socket.on('close', () => {
        clearInterval(check);
        stopLooking();
        if (ctx.terminals.remove(termId)) ctx.hub.send(node, { type: 'term.close', termId });
      });
    },
  );
}
