import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson, viaOrchestrator } from '../../auth/session.js';
import { machines, nodes, subscriptions } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { publicUrl } from '../link/link.js';
import { updateCommand } from '../nodes/command.js';
import { nodeIdentity, type NodeIdentity } from '../nodes/hub.js';
import { liveNode } from '../nodes/nodes.js';
import { cols, followFrames, keepLooking, rows } from '../terminals/look.js';
import { CLOSE } from '../terminals/relay.js';
import { CONNECT_ROUND_MS, connectionCleared, connectionRound } from './connecting.js';
import { LOGIN_KEY } from './credentials.js';

/* Plans that sign in in a terminal on one machine and are then sealed for the others. Kimi and GLM take a pasted key,
   and Antigravity signs in on each machine. */
const TERMINAL_SIGNIN = new Set(['claude', 'codex']);

const IdParams = z.object({ id: z.uuid() });
const SigninBody = z.object({ nodeId: z.uuid().optional(), fresh: z.boolean() });
const StopBody = z.object({ nodeId: z.uuid() });
const TerminalQuery = z.object({ nodeId: z.uuid(), cols: cols.catch(120), rows: rows.catch(36) });

const unknown = () => new ApiError(404, 'not_found', 'This subscription does not exist.', 'subscription_unknown');
const notOwner = () => new ApiError(403, 'forbidden', 'Only the owner of this plan signs it in.', 'not_owner');
const noNode = () => new ApiError(409, 'conflict', 'No machine of this plan is online. Turn one of them on and try again.', 'no_node_online');
/* Online, but from before machine keys or with no terminals: the node cannot run a sign-in Hornhoof can seal. The
   error names the machines, each with one node of the plan, and gives the command that updates their nodes, which
   holds no code. */
function unsupported(machines: string[], command: string) {
  const message = `The nodes on ${machines.join(', ')} are older than the sign-in from Hornhoof needs. To update them, run this in a terminal there, then try again: ${command}`;
  return new ApiError(409, 'conflict', message, 'signin_unsupported', { machines, command });
}

/* A plan's owner signs it in from Hornhoof: in a terminal on one of their machines that is online, which nobody else
   opens or watches, the CEO neither. The orchestrator may, for any plan: a fresh sign-in signs the program out first. */
export function signinRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, hub } = ctx;

  async function ownPlan(req: FastifyRequest) {
    const me = await requirePerson(req, db);
    const [sub] = await db.select().from(subscriptions).where(and(eq(subscriptions.id, IdParams.parse(req.params).id), isNull(subscriptions.removedAt)));
    if (!sub) throw unknown();
    if (!viaOrchestrator(me) && (me.via || sub.ownerPersonId !== me.id)) throw notOwner();
    return { me, sub };
  }

  /* The plan's live nodes that are online, oldest first, and of them the ones with a terminal and a key the new sign-in
     is sealed to. */
  async function onlineNodes(planId: string) {
    const rows = await db
      .select({ nodeId: nodes.id, hostname: machines.hostname, publicKey: nodes.publicKey })
      .from(nodes)
      .innerJoin(machines, eq(machines.id, nodes.machineId))
      .where(and(eq(nodes.subscriptionId, planId), liveNode))
      .orderBy(nodes.createdAt);
    const online = rows.filter(r => hub.isReady(nodeIdentity(r.nodeId)));
    return { online, able: online.filter(r => r.publicKey !== null && hub.hasTerminals(nodeIdentity(r.nodeId))) };
  }

  app.post('/api/subscriptions/:id/signin', async req => {
    const { sub } = await ownPlan(req);
    if (sub.kind !== 'personal' || !TERMINAL_SIGNIN.has(sub.provider))
      throw new ApiError(400, 'validation', 'This plan signs in with a pasted key or on its machine, not in a sign-in terminal.', 'wrong_kind');
    const { nodeId, fresh } = SigninBody.parse(req.body ?? {});
    const { online, able } = await onlineNodes(sub.id);
    const node = nodeId ? able.find(n => n.nodeId === nodeId) : able[0];
    const old = online.filter(n => !able.includes(n)).map(n => n.hostname);
    if (!node) throw old.length ? unsupported(old, updateCommand(await publicUrl(db, ctx.config))) : noNode();
    if (!hub.send(nodeIdentity(node.nodeId), { type: 'login.start', fresh })) throw noNode();
    /* A new sign-in starts a new connection: what the last one said goes. */
    connectionCleared(ctx, sub.id);
    return { nodeId: node.nodeId, hostname: node.hostname };
  });

  /* The owner stops a plan's connection: a sign-in still running on its machine stops, and the plan shows its state. */
  app.post('/api/subscriptions/:id/connecting/cancel', async (req, reply) => {
    const { sub } = await ownPlan(req);
    const gone = connectionCleared(ctx, sub.id);
    if (gone) hub.send(nodeIdentity(gone.nodeId), { type: 'login.stop' });
    return reply.code(204).send();
  });

  /* The owner tries a plan that signs in on its machine again: its node checks the sign-in there again and says each step,
     and the limit starts over with them. A plan that signs in from Hornhoof tries again with a new sign-in. */
  app.post('/api/subscriptions/:id/connecting/retry', async (req, reply) => {
    const { sub } = await ownPlan(req);
    if (sub.kind !== 'personal') throw new ApiError(400, 'validation', 'Only a plan connects on its machines.', 'wrong_kind');
    const gone = connectionCleared(ctx, sub.id);
    const { online } = await onlineNodes(sub.id);
    const asked = gone && online.some(n => n.nodeId === gone.nodeId) ? [gone.nodeId] : online.map(n => n.nodeId);
    if (!asked.length) throw noNode();
    for (const nodeId of asked) hub.send(nodeIdentity(nodeId), { type: 'login.check' });
    return reply.code(204).send();
  });

  /* A connection past its limit says so: the server looks once a second. */
  const round = setInterval(() => connectionRound(ctx), CONNECT_ROUND_MS);
  round.unref();
  app.addHook('onClose', async () => clearInterval(round));

  app.post('/api/subscriptions/:id/signin/stop', async (req, reply) => {
    const { sub } = await ownPlan(req);
    const { nodeId } = StopBody.parse(req.body ?? {});
    const [node] = await db.select(idOnly(nodes)).from(nodes).where(and(eq(nodes.id, nodeId), eq(nodes.subscriptionId, sub.id), liveNode));
    if (node) hub.send(nodeIdentity(node.id), { type: 'login.stop' });
    return reply.code(204).send();
  });

  const found = new WeakMap<FastifyRequest, { personId: string; companyId: string; node: NodeIdentity; cols: number; rows: number }>();
  app.get(
    '/api/subscriptions/:id/signin/terminal',
    {
      websocket: true,
      preValidation: async req => {
        const { me, sub } = await ownPlan(req);
        const q = TerminalQuery.parse(req.query ?? {});
        const [node] = await db.select(idOnly(nodes)).from(nodes).where(and(eq(nodes.id, q.nodeId), eq(nodes.subscriptionId, sub.id), liveNode));
        if (!node) throw noNode();
        found.set(req, { personId: me.id, companyId: me.companyId, node: nodeIdentity(node.id), cols: q.cols, rows: q.rows });
      },
    },
    (socket, req) => {
      const { personId, companyId, node, cols, rows } = found.get(req)!;
      const termId = randomUUID();
      if (!hub.isReady(node)) return socket.close(...CLOSE.nodeOffline);
      if (!hub.hasTerminals(node)) return socket.close(...CLOSE.noTerminal);
      ctx.terminals.add(termId, { socket, node, agentId: LOGIN_KEY, personId });
      if (!hub.send(node, { type: 'term.open', termId, agentKey: LOGIN_KEY, cols, rows, write: true })) {
        ctx.terminals.remove(termId);
        return socket.close(...CLOSE.nodeOffline);
      }
      socket.send(JSON.stringify({ type: 'ready', write: true }));
      /* A person who signed out or lost the plan stops seeing it, and their keys stop. */
      const mayGoOn = keepLooking(ctx, socket, { termId, node, companyId }, () => ownPlan(req).then(() => null));
      followFrames(ctx, socket, async data => {
        if (!(await mayGoOn())) return;
        if (data.type === 'input') hub.send(node, { type: 'term.input', termId, data: data.data });
        else hub.send(node, { type: 'term.resize', termId, cols: data.cols, rows: data.rows });
      });
    },
  );
}
