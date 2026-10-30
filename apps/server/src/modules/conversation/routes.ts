import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf, agentSpot, canReach } from '../../auth/access.js';
import { requireCompanyScope, requirePerson } from '../../auth/session.js';
import { agents, departments, jobs } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { listEvents } from '../events/store.js';
import { FIRST_TURN, turnPrompt } from './prompt.js';
import { agentState, cancelJob, enqueueTurn, insertTurn, onAgent, orchestratorOf, pump } from './queue.js';

const AgentParams = z.object({ id: z.union([z.literal('orchestrator'), z.uuid()]) });
const EventsQuery = z.object({ after: z.coerce.number().int().min(0).default(0) });
const MessageBody = z.object({ text: z.string().trim().min(1).max(4000) });

/* Every agent's window: its conversation, what it is doing, writing to it and stopping it. The orchestrator is for people
   who see the whole company; an employee for people who reach its department. */
export function conversationRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  async function agentFor(req: FastifyRequest) {
    const me = await requirePerson(req, db);
    const { id } = AgentParams.parse(req.params);
    const agent =
      id === 'orchestrator'
        ? await orchestratorOf(ctx, me.companyId)
        : (await db.select().from(agents).where(and(eq(agents.id, id), eq(agents.companyId, me.companyId), isNull(agents.removedAt))))[0];
    if (!agent) throw new ApiError(404, 'not_found', id === 'orchestrator' ? 'This company has no orchestrator.' : 'This employee does not exist.', 'agent_unknown');
    if (agent.kind === 'orchestrator') requireCompanyScope(me);
    else if (!canReach(await accessOf(db, me), await agentSpot(db, agent))) {
      throw new ApiError(403, 'forbidden', 'This employee works in a department you do not have.', 'not_your_department');
    }
    return { me, agent };
  }

  app.get('/api/agents/:id/events', async req => {
    const { agent } = await agentFor(req);
    const { after } = EventsQuery.parse(req.query);
    return { events: await listEvents(db, agent.id, after), state: await agentState(ctx, agent.id) };
  });

  app.post('/api/agents/:id/messages', async (req, reply) => {
    const { me, agent } = await agentFor(req);
    const { text } = MessageBody.parse(req.body);
    if (!(await agentState(ctx, agent.id)).ready) {
      throw agent.kind === 'orchestrator'
        ? new ApiError(409, 'conflict', 'The orchestrator cannot answer right now. See the window for what to do.', 'orchestrator_not_ready')
        : new ApiError(409, 'conflict', 'This employee cannot answer right now. See the window for what to do.', 'agent_not_ready');
    }
    ctx.bus.publish(me.companyId, {
      type: 'pulse',
      from: { kind: 'person', id: me.id },
      to: agent.kind === 'orchestrator' ? { kind: 'orchestrator' } : { kind: 'department', id: agent.departmentId ?? '' },
    });
    const jobId = await enqueueTurn(ctx, { companyId: me.companyId, agentId: agent.id, prompt: turnPrompt(me, text), createdBy: me.id, message: { personId: me.id, text } });
    reply.code(202);
    return { jobId };
  });

  /* The orchestrator's greeting, once: on an empty company whose conversation never began. Employees wait to be written to. */
  app.post('/api/agents/:id/start', async req => {
    const { me, agent } = await agentFor(req);
    if (agent.kind !== 'orchestrator') return { started: false };
    const started = await onAgent(ctx, agent.id, async () => {
      if (!(await agentState(ctx, agent.id)).ready) return false;
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

  app.post('/api/agents/:id/stop', async (req, reply) => {
    const { agent } = await agentFor(req);
    const { runningJobId } = await agentState(ctx, agent.id);
    if (!runningJobId) throw new ApiError(409, 'conflict', 'Nothing is running.', 'nothing_running');
    await cancelJob(ctx, runningJobId);
    return reply.code(202).send();
  });
}
