import { randomUUID } from 'node:crypto';
import { isTerminalReport, typesWords } from '@hornhoof/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agentHidden, requireAgentView } from '../../auth/agent-view.js';
import { namedAgent } from '../agents/find.js';
import { enterPressed } from '../conversation/decision-context.js';
import { windowNode } from '../conversation/placement.js';
import { identityOf, ownBuiltin, sameNode, type NodeIdentity } from '../nodes/hub.js';
import { mayTypeTo, programAccess } from './access.js';
import { readKeys } from './keys.js';
import { cols, followFrames, keepLooking, rows, type BrowserFrame } from './look.js';
import { CLOSE } from './relay.js';

const Size = z.object({ cols: cols.catch(120), rows: rows.catch(36) });

/* write: the person owns the subscription the agent runs on. A program's terminal runs commands on its owner's machine
   with the owner's sign-in, so only they steer it. message: the person writes to the agent, which here is everyone who sees
   the program: programFor opens this view only to them. */
type Found = { personId: string; companyId: string; agentId: string; node: NodeIdentity | null; write: boolean; message: boolean };
type Open = Found & { node: NodeIdentity; termId: string };

/* The agent a request names, for a person who sees the program its terminal shows. Nothing moves for anyone else. */
async function programFor(ctx: Ctx, req: FastifyRequest) {
  const { me, agent } = await namedAgent(ctx, req);
  const { plan, sees } = await programAccess(ctx, me, agent);
  if (!sees) throw agentHidden();
  return { me, agent, plan };
}

/* Why a view that is open ends now. An agent that moved to another subscription or machine runs on another node once its
   running turn is over, and the browser opens the view again there; so too when the person no longer types into what it
   shows, for the node to hear that. */
async function whyEnd(ctx: Ctx, req: FastifyRequest, { node, personId, write }: Open) {
  const { me, agent, plan } = await programFor(ctx, req);
  const at = plan && identityOf(plan, plan.nodeId, plan.builtinMachine, ownBuiltin(ctx.config));
  return !at || !sameNode(at, node) || (mayTypeTo(me, agent) && plan.ownerPersonId === personId) !== write ? CLOSE.nodeOffline : null;
}

/* Each frame goes on only while the view may. */
function onFrames(ctx: Ctx, socket: WebSocket, { termId, node, agentId, personId, write, message }: Open, mayGoOn: () => Promise<boolean>): void {
  let unread = '';
  followFrames(ctx, socket, async (data: BrowserFrame) => {
    if (!(await mayGoOn())) return;
    if (data.type === 'resize') return void ctx.hub.send(node, { type: 'term.resize', termId, cols: data.cols, rows: data.rows });
    if (!write && isTerminalReport(data.data)) return;
    const refused = ctx.terminals.inputLine(agentId).take(data.data, { control: write, message });
    if (refused) return socket.send(JSON.stringify({ type: 'refused', reason: refused }));
    /* A prompt goes in with Enter, in any of its forms; scrolling and clicks send keys too. Where the person's Enter
       counts is kept before the keys reach the program. */
    if (typesWords(data.data)) ctx.terminals.wrote(agentId, personId, node);
    const keys = readKeys(unread, data.data);
    unread = keys.rest;
    const pressedIn = keys.enter ? await enterPressed(ctx, agentId, personId, node) : null;
    ctx.hub.send(node, { type: 'term.input', termId, data: data.data, ...(pressedIn ? { pressedIn } : {}) });
  });
}

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
        const { me, agent } = await programFor(ctx, req);
        const at = await windowNode(ctx, agent.id);
        if (at) await requireAgentView(ctx.db, me, agent, at.planId);
        const message = mayTypeTo(me, agent);
        found.set(req, { personId: me.id, companyId: me.companyId, agentId: agent.id, node: at?.node ?? null, write: message && at?.ownerPersonId === me.id, message });
      },
    },
    (socket, req) => {
      const { personId, agentId, node, write, message } = found.get(req)!;
      const { cols, rows } = Size.parse(req.query ?? {});
      const termId = randomUUID();
      if (!node) return socket.close(...CLOSE.noTerminal);
      /* A node that is away comes back; the browser tries again. */
      if (!ctx.hub.isReady(node)) return socket.close(...CLOSE.nodeOffline);
      if (!ctx.hub.hasTerminals(node)) return socket.close(...CLOSE.noTerminal);
      ctx.terminals.add(termId, { socket, node, agentId, personId });
      /* The node takes keys from everyone who may send any: they were looked at here first. */
      if (!ctx.hub.send(node, { type: 'term.open', termId, agentKey: agentId, cols, rows, write: write || message })) {
        ctx.terminals.remove(termId);
        return socket.close(...CLOSE.nodeOffline);
      }
      socket.send(JSON.stringify({ type: 'ready', write, message }));
      const view = { ...found.get(req)!, node, termId };
      onFrames(ctx, socket, view, keepLooking(ctx, socket, view, () => whyEnd(ctx, req, view)));
    },
  );
}
