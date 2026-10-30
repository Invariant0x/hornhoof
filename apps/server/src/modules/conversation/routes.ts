import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requireCompanyScope, requirePerson } from '../../auth/session.js';
import { departments, jobs } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { listEvents } from '../events/store.js';
import { FIRST_TURN, turnPrompt } from './prompt.js';
import { enqueueTurn, insertTurn, onAgent, orchestratorOf, orchestratorState, pump } from './queue.js';

const EventsQuery = z.object({ after: z.coerce.number().int().min(0).default(0) });
const MessageBody = z.object({ text: z.string().trim().min(1).max(4000) });

/* The orchestrator's window: his conversation, what he is doing, and writing to him. Only people who see the whole company use it. */
export function conversationRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  async function orchestrator(req: FastifyRequest) {
    const me = await requirePerson(req, db);
    requireCompanyScope(me);
    const agent = await orchestratorOf(ctx, me.companyId);
    if (!agent) throw new ApiError(404, 'not_found', 'This company has no orchestrator.');
    return { me, agent };
  }

  app.get('/api/agents/orchestrator/events', async req => {
    const { me, agent } = await orchestrator(req);
    const { after } = EventsQuery.parse(req.query);
    return { events: await listEvents(db, agent.id, after), state: await orchestratorState(ctx, me.companyId) };
  });

  app.post('/api/agents/orchestrator/messages', async (req, reply) => {
    const { me, agent } = await orchestrator(req);
    const { text } = MessageBody.parse(req.body);
    if (!(await orchestratorState(ctx, me.companyId)).ready) {
      throw new ApiError(409, 'conflict', 'The orchestrator cannot answer right now. See the window for what to do.', 'orchestrator_not_ready');
    }
    ctx.bus.publish(me.companyId, { type: 'pulse', from: { kind: 'person', id: me.id }, to: { kind: 'orchestrator' } });
    const jobId = await enqueueTurn(ctx, { companyId: me.companyId, agentId: agent.id, prompt: turnPrompt(me, text), createdBy: me.id, message: { personId: me.id, text } });
    reply.code(202);
    return { jobId };
  });

  /* His greeting, once: on an empty company whose conversation never began. */
  app.post('/api/agents/orchestrator/start', async req => {
    const { me, agent } = await orchestrator(req);
    const started = await onAgent(ctx, agent.id, async () => {
      if (!(await orchestratorState(ctx, me.companyId)).ready) return false;
      if ((await listEvents(db, agent.id, 0, 1)).length) return false;
      const [open] = await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.agentId, agent.id), eq(jobs.kind, 'conversation'), inArray(jobs.status, ['queued', 'running']))).limit(1);
      if (open) return false;
      const [dept] = await db.select({ id: departments.id }).from(departments).where(eq(departments.companyId, me.companyId)).limit(1);
      if (dept) return false;
      await insertTurn(ctx, { companyId: me.companyId, agentId: agent.id, prompt: FIRST_TURN, createdBy: me.id });
      return true;
    });
    /* Outside the agent's line, which the pump waits on. */
    if (started) await pump(ctx, agent.id);
    return { started };
  });
}
