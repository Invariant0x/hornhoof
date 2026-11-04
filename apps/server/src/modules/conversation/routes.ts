import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { companies, departments, jobs } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { agentFor } from '../agents/find.js';
import { answerDirectly } from '../tasks/engine.js';
import { wakeAll } from '../tasks/wake.js';
import { listEvents } from '../events/store.js';
import { FIRST_TURN, FIRST_TURN_TEMPLATE, turnPrompt } from './prompt.js';
import { agentState, insertTurn, onAgent, pump } from './queue.js';
import { cancelJob } from '../tasks/wake.js';
import { queueTaskMessage, TaskReference } from '../tasks/external-wait.js';

const EventsQuery = z.object({ after: z.coerce.number().int().min(0).default(0) });
const MessageBody = z.object({ text: z.string().trim().min(1).max(4000), task: TaskReference.optional() });

function writtenBy(me: Awaited<ReturnType<typeof agentFor>>['me'], text: string) {
  if (me.via) return {
    actor: { agentId: me.via },
    turn: { prompt: turnPrompt({ name: 'Orchestrator', title: '' }, text), createdBy: null, message: { personId: null, text, from: 'orchestrator' as const } },
  };
  return { actor: { personId: me.id }, turn: { prompt: turnPrompt(me, text), createdBy: me.id, message: { personId: me.id, text } } };
}

/* Every agent's window: its conversation, what it is doing, writing to it and stopping it. The orchestrator is for people
   who see the whole company; an employee for people who reach its department. */
export function conversationRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  app.get('/api/agents/:id/events', async req => {
    const { agent } = await agentFor(ctx, req);
    const { after } = EventsQuery.parse(req.query);
    return { events: await listEvents(db, agent.id, after), state: await agentState(ctx, agent.id) };
  });

  app.post('/api/agents/:id/messages', async (req, reply) => {
    const { me, agent } = await agentFor(ctx, req);
    const { text, task: ref } = MessageBody.parse(req.body);
    if (me.via === agent.id) throw new ApiError(400, 'validation', 'This is your own conversation. Write to people in your answer.');
    if (!(await agentState(ctx, agent.id)).ready) {
      throw agent.kind === 'orchestrator'
        ? new ApiError(409, 'conflict', 'The orchestrator cannot answer right now. See the window for what to do.', 'orchestrator_not_ready')
        : new ApiError(409, 'conflict', 'This employee cannot answer right now. See the window for what to do.', 'agent_not_ready');
    }
    const { actor, turn } = writtenBy(me, text);
    const jobId = await queueTaskMessage(ctx, { companyId: me.companyId, agentId: agent.id, task: ref, actor, text }, { companyId: me.companyId, agentId: agent.id, ...turn });
    ctx.bus.publish(me.companyId, {
      type: 'pulse',
      from: me.via ? { kind: 'orchestrator' } : { kind: 'person', id: me.id },
      to: agent.kind === 'orchestrator' ? { kind: 'orchestrator' } : { kind: 'department', id: agent.departmentId ?? '' },
    });
    /* Once the words are on their way, a person's words answer what the agent waits for from people; the orchestrator
       answers requests with its own tool. */
    if (!me.via) await wakeAll(ctx, await answerDirectly(ctx, me.id, agent.id, text));
    reply.code(202);
    return { jobId };
  });

  /* The orchestrator's greeting, once: on an empty company whose conversation never began. Employees wait to be written to. */
  app.post('/api/agents/:id/start', async req => {
    const { me, agent } = await agentFor(ctx, req);
    if (agent.kind !== 'orchestrator') return { started: false };
    const started = await onAgent(ctx, agent.id, async () => {
      if (!(await agentState(ctx, agent.id)).ready) return false;
      if ((await listEvents(db, agent.id, 0, 1)).length) return false;
      const [open] = await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.agentId, agent.id), eq(jobs.kind, 'conversation'), inArray(jobs.status, ['queued', 'running']))).limit(1);
      if (open) return false;
      const [company] = await db.select({ template: companies.template }).from(companies).where(eq(companies.id, me.companyId)).limit(1);
      const [dept] = await db.select({ id: departments.id }).from(departments).where(eq(departments.companyId, me.companyId)).limit(1);
      /* A company built by hand gets no greeting (its build already enqueued a turn); one from a template is greeted so he offers to staff it. */
      if (dept && !company?.template) return false;
      await insertTurn(ctx, { companyId: me.companyId, agentId: agent.id, prompt: company?.template ? FIRST_TURN_TEMPLATE : FIRST_TURN, createdBy: me.id, message: { personId: null, text: company?.template ? FIRST_TURN_TEMPLATE : FIRST_TURN, notification: { source: 'first_turn', tasks: [] } } });
      return true;
    });
    /* Outside the agent's line, which the pump waits on. */
    if (started) await pump(ctx, agent.id);
    return { started };
  });

  app.post('/api/agents/:id/stop', async (req, reply) => {
    const { agent } = await agentFor(ctx, req);
    const { runningJobId } = await agentState(ctx, agent.id);
    if (!runningJobId) throw new ApiError(409, 'conflict', 'Nothing is running.', 'nothing_running');
    await cancelJob(ctx, runningJobId);
    return reply.code(202).send();
  });
}
