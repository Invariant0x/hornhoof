import { PhoneBridgeAuthorization } from '@hornhoof/protocol';
import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { agents, companyPhones, jobs, machines, nodes, people, phoneSessions } from '../../db/schema.js';
import { hasCurrentKey } from '../nodes/nodes.js';
import { identify } from '../nodes/socket.js';
import { phoneCapable } from './rpc.js';
import { phoneDenied } from './store.js';

/* The host asks for every operation; values, trees and screenshots never enter this endpoint. */
export function phoneBridgeRoutes(app: FastifyInstance, ctx: Ctx): void {
  app.post('/api/nodes/phone-bridge/authorize', { bodyLimit: 4096 }, async (req, reply) => {
    const parsed = PhoneBridgeAuthorization.safeParse(req.body);
    if (!parsed.success) throw phoneDenied();
    const identity = await identify(ctx, req);
    if (identity?.kind !== 'node' || !await hasCurrentKey(ctx, identity) || !phoneCapable(ctx, identity)) throw phoneDenied();
    const [node] = await ctx.db.select({ id: nodes.id, companyId: nodes.companyId, machineId: nodes.machineId }).from(nodes).innerJoin(machines, and(eq(machines.id, nodes.machineId), eq(machines.companyId, nodes.companyId))).where(and(eq(nodes.id, identity.nodeId), isNotNull(nodes.keyHash), isNull(machines.revokedAt)));
    if (!node) throw phoneDenied();
    const input = parsed.data;
    if (input.scope === 'session') {
      const [held] = await ctx.db.select({ phone: companyPhones, session: phoneSessions, job: jobs, agent: agents, owner: people }).from(companyPhones)
        .innerJoin(phoneSessions, eq(phoneSessions.phoneId, companyPhones.id))
        .innerJoin(jobs, eq(jobs.id, phoneSessions.jobId))
        .innerJoin(agents, eq(agents.id, phoneSessions.agentId))
        .innerJoin(people, eq(people.id, companyPhones.personId))
        .where(and(eq(companyPhones.id, input.phoneId), eq(phoneSessions.id, input.sessionId)));
      if (!held || held.phone.companyId !== node.companyId || held.session.companyId !== node.companyId || held.phone.nodeId !== node.id || held.phone.machineId !== node.machineId || held.phone.transport !== 'usb' || held.phone.serial !== input.serial || held.phone.hardwareKey !== input.hardwareKey || held.phone.removedAt || !held.phone.lending || held.owner.status !== 'active' || held.phone.generation !== input.generation || held.session.generation !== input.generation || !['starting', 'active'].includes(held.session.status) || !held.session.leaseUntil || held.session.leaseUntil.getTime() <= ctx.clock() || held.job.status !== 'running' || held.job.error === 'cancelled' || held.agent.removedAt) throw phoneDenied();
    }
    return reply.header('cache-control', 'no-store').send({ allowed: true });
  });
}
