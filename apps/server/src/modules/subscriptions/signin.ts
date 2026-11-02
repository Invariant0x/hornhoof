import { randomUUID } from 'node:crypto';
import { TERM_CHUNK } from '@hornhoof/protocol';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson } from '../../auth/session.js';
import { machines, nodes, subscriptions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { nodeIdentity, type NodeIdentity } from '../nodes/hub.js';
import { liveNode } from '../nodes/nodes.js';
import { CLOSE } from '../terminals/relay.js';
import { LOGIN_KEY } from './credentials.js';

/* Plans that sign in in a terminal on one machine and are then sealed for the others. Kimi and GLM take a pasted key,
   and Antigravity signs in on each machine. */
const TERMINAL_SIGNIN = new Set(['claude', 'codex']);

const IdParams = z.object({ id: z.uuid() });
const SigninBody = z.object({ nodeId: z.uuid().optional(), fresh: z.boolean() });
const StopBody = z.object({ nodeId: z.uuid() });
const cols = z.coerce.number().int().min(10).max(500);
const rows = z.coerce.number().int().min(4).max(200);
const TerminalQuery = z.object({ nodeId: z.uuid(), cols: cols.catch(120), rows: rows.catch(36) });
const FromBrowser = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().min(1).max(TERM_CHUNK) }),
  z.object({ type: z.literal('resize'), cols, rows }),
]);

const unknown = () => new ApiError(404, 'not_found', 'This subscription does not exist.', 'subscription_unknown');
const notOwner = () => new ApiError(403, 'forbidden', 'Only the owner of this plan signs it in.', 'not_owner');
const noNode = () => new ApiError(409, 'conflict', 'No machine of this plan is online with a terminal. Start one of them and try again.', 'no_node_online');

/* A plan's owner signs it in from Hornhoof: in a terminal on one of their machines that is online, which nobody else
   opens or watches, the CEO neither. Never the orchestrator for them: a fresh sign-in signs the program out first. */
export function signinRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, hub } = ctx;

  async function ownPlan(req: FastifyRequest) {
    const me = await requirePerson(req, db);
    const [sub] = await db.select().from(subscriptions).where(and(eq(subscriptions.id, IdParams.parse(req.params).id), isNull(subscriptions.removedAt)));
    if (!sub) throw unknown();
    if (me.via || sub.ownerPersonId !== me.id) throw notOwner();
    return { me, sub };
  }

  /* The plan's live nodes that are online with a terminal, oldest first. */
  async function onlineNodes(planId: string) {
    const rows = await db
      .select({ nodeId: nodes.id, hostname: machines.hostname })
      .from(nodes)
      .innerJoin(machines, eq(machines.id, nodes.machineId))
      .where(and(eq(nodes.subscriptionId, planId), liveNode))
      .orderBy(nodes.createdAt);
    return rows.filter(r => hub.isReady(nodeIdentity(r.nodeId)) && hub.hasTerminals(nodeIdentity(r.nodeId)));
  }

  app.post('/api/subscriptions/:id/signin', async req => {
    const { sub } = await ownPlan(req);
    if (sub.kind !== 'personal' || !TERMINAL_SIGNIN.has(sub.provider))
      throw new ApiError(400, 'validation', 'This plan signs in with a pasted key or on its machine, not in a sign-in terminal.', 'wrong_kind');
    const { nodeId, fresh } = SigninBody.parse(req.body ?? {});
    const online = await onlineNodes(sub.id);
    const node = nodeId ? online.find(n => n.nodeId === nodeId) : online[0];
    if (!node || !hub.send(nodeIdentity(node.nodeId), { type: 'login.start', fresh })) throw noNode();
    return { nodeId: node.nodeId, hostname: node.hostname };
  });

  app.post('/api/subscriptions/:id/signin/stop', async (req, reply) => {
    const { sub } = await ownPlan(req);
    const { nodeId } = StopBody.parse(req.body ?? {});
    const [node] = await db.select({ id: nodes.id }).from(nodes).where(and(eq(nodes.id, nodeId), eq(nodes.subscriptionId, sub.id), liveNode));
    if (node) hub.send(nodeIdentity(node.id), { type: 'login.stop' });
    return reply.code(204).send();
  });

  const found = new WeakMap<FastifyRequest, { personId: string; node: NodeIdentity; cols: number; rows: number }>();
  app.get(
    '/api/subscriptions/:id/signin/terminal',
    {
      websocket: true,
      preValidation: async req => {
        const { me, sub } = await ownPlan(req);
        const q = TerminalQuery.parse(req.query ?? {});
        const [node] = await db.select({ id: nodes.id }).from(nodes).where(and(eq(nodes.id, q.nodeId), eq(nodes.subscriptionId, sub.id), liveNode));
        if (!node) throw noNode();
        found.set(req, { personId: me.id, node: nodeIdentity(node.id), cols: q.cols, rows: q.rows });
      },
    },
    (socket, req) => {
      const { personId, node, cols, rows } = found.get(req)!;
      const termId = randomUUID();
      if (!hub.isReady(node)) return socket.close(...CLOSE.nodeOffline);
      if (!hub.hasTerminals(node)) return socket.close(...CLOSE.noTerminal);
      ctx.terminals.add(termId, { socket, node, agentId: LOGIN_KEY, personId });
      if (!hub.send(node, { type: 'term.open', termId, agentKey: LOGIN_KEY, cols, rows, write: true })) {
        ctx.terminals.remove(termId);
        return socket.close(...CLOSE.nodeOffline);
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
        if (msg.data.type === 'input') hub.send(node, { type: 'term.input', termId, data: msg.data.data });
        else hub.send(node, { type: 'term.resize', termId, cols: msg.data.cols, rows: msg.data.rows });
      });
      /* A person who signed out stops seeing it. */
      const check = setInterval(() => void ownPlan(req).catch(() => socket.close(...CLOSE.noAccess)), ctx.config.streamPingMs);
      socket.on('close', () => {
        clearInterval(check);
        if (ctx.terminals.remove(termId)) hub.send(node, { type: 'term.close', termId });
      });
    },
  );
}
