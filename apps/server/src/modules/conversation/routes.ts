import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Text } from '../tasks/long-text.js';
import type { Ctx } from '../../app.js';
import { maskEvent, viewerOf } from '../../auth/agent-view.js';
import { companies, departments, jobs } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import type { Person } from '../../auth/session.js';
import { agentFor, type AgentRow } from '../agents/find.js';
import { answerDirectly } from '../tasks/engine.js';
import { wakeAll } from '../tasks/wake.js';
import { listEvents } from '../events/store.js';
import { isOperations } from '../operations/required.js';
import { ownPictures, pictureRoutes, PICTURES_PER_MESSAGE, withPictures, type MessagePicture } from './pictures.js';
import { answerBy, answerInTelegram, FIRST_TURN, FIRST_TURN_TEMPLATE, turnPrompt, type Standing } from './prompt.js';
import { terminalRights } from '../terminals/access.js';
import { agentState, insertTurn, onAgent, pump } from './queue.js';
import { cancelJob } from '../tasks/wake.js';
import { queueTaskMessage, TaskReference } from '../tasks/external-wait.js';

const EventsQuery = z.object({ after: z.coerce.number().int().min(0).default(0) });
const MessageBody = z
  .object({ text: Text.trim().default(''), task: TaskReference.optional(), pictures: z.array(z.uuid()).max(PICTURES_PER_MESSAGE).default([]) })
  .refine(m => m.text || m.pictures.length, 'Write something or add a picture.');

/* Where a person's message came from when not from the agent's window: the bot it came through, the chat its answer goes
   back to and the update it was. */
export type TelegramOrigin = { bot: string; chat: number; update: number };

function writtenBy(me: Person, text: string, pictures: MessagePicture[], telegram?: TelegramOrigin & { standing: Standing }) {
  if (me.via) return {
    actor: { agentId: me.via },
    turn: { prompt: `${turnPrompt({ name: 'Orchestrator', title: '' }, text)}\n\n${answerBy({ id: me.via, name: 'Orchestrator' })}`, createdBy: null, message: { personId: null, text, from: 'orchestrator' as const } },
  };
  if (telegram) {
    const { standing, ...origin } = telegram;
    return { actor: { personId: me.id }, turn: { prompt: `${turnPrompt(me, text)}\n\n${answerInTelegram(me, standing)}`, createdBy: me.id, message: { personId: me.id, text, channel: 'telegram' as const, telegram: origin } } };
  }
  return { actor: { personId: me.id }, turn: { prompt: turnPrompt(me, withPictures(text, pictures)), createdBy: me.id, message: { personId: me.id, text, ...(pictures.length ? { pictures } : {}) } } };
}

type Written = { text: string; task?: z.infer<typeof TaskReference>; pictures: string[]; telegram?: TelegramOrigin };

/* What the person is to this agent, said with words that came through Telegram, where no window shows who wrote. */
async function standingOf(ctx: Ctx, me: Person, agent: AgentRow): Promise<Standing> {
  const [department] = agent.departmentId ? await ctx.db.select({ owner: departments.ownerPersonId }).from(departments).where(eq(departments.id, agent.departmentId)) : [];
  return { owner: me.isOwner, delegate: me.isCeoDelegate, department: department ? department.owner === me.id : null };
}

/* A person's words to an agent, from its window or through its Telegram bot, under that person's own rights: whoever calls
   this has checked that they see the agent. Returns the turn the words went into. */
export async function writeToAgent(ctx: Ctx, me: Person, agent: AgentRow, input: Written): Promise<string> {
  if (me.via === agent.id) throw new ApiError(400, 'validation', 'This is your own conversation. Write to people in your answer.');
  const pictures = await ownPictures(ctx, me, agent.id, input.pictures);
  if (!(await agentState(ctx, agent.id)).ready) {
    throw agent.kind === 'orchestrator'
      ? new ApiError(409, 'conflict', 'The orchestrator cannot answer right now. See the window for what to do.', 'orchestrator_not_ready')
      : new ApiError(409, 'conflict', 'This employee cannot answer right now. See the window for what to do.', 'agent_not_ready');
  }
  /* Pictures alone read as their names wherever the words of a message show. */
  const words = input.text || pictures.map(p => p.name).join(', ');
  const { actor, turn } = writtenBy(me, words, pictures, input.telegram && { ...input.telegram, standing: await standingOf(ctx, me, agent) });
  const jobId = await queueTaskMessage(ctx, { companyId: me.companyId, agentId: agent.id, task: input.task, actor, text: words }, { companyId: me.companyId, agentId: agent.id, ...turn });
  ctx.bus.publish(me.companyId, {
    type: 'pulse',
    from: me.via ? { kind: 'orchestrator' } : { kind: 'person', id: me.id },
    to: agent.kind === 'orchestrator' ? { kind: 'orchestrator' } : { kind: 'department', id: agent.departmentId ?? '' },
  });
  /* Once the words are on their way, a person's words answer what the agent waits for from people; the orchestrator
     answers requests with its own tool. */
  if (!me.via) await wakeAll(ctx, await answerDirectly(ctx, me.id, agent.id, input.text));
  return jobId;
}

/* Every agent's window: its conversation, what it is doing, writing to it and stopping it. The orchestrator is for people
   who see the whole company; an employee for people who reach its department. */
export function conversationRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  pictureRoutes(app, ctx);

  app.get('/api/agents/:id/events', async req => {
    const { me, agent } = await agentFor(ctx, req);
    const { after } = EventsQuery.parse(req.query);
    const viewer = await viewerOf(db, me);
    const state = await agentState(ctx, agent.id);
    return { events: (await listEvents(db, agent.id, after)).map(e => maskEvent(viewer, e)), state: { ...state, ...(await terminalRights(ctx, me, agent, state.terminal)) } };
  });

  app.post('/api/agents/:id/messages', async (req, reply) => {
    const { me, agent } = await agentFor(ctx, req);
    const { text, task, pictures } = MessageBody.parse(req.body);
    const jobId = await writeToAgent(ctx, me, agent, { text, task, pictures });
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
      const depts = await db.select({ templateKey: departments.templateKey, parentId: departments.parentId }).from(departments).where(eq(departments.companyId, me.companyId));
      /* A company built by hand gets no greeting (its build already enqueued a turn); one from a template is greeted so he
         offers to staff it. The Operations every company starts with is no building. */
      if (depts.some(d => !isOperations(d)) && !company?.template) return false;
      const greeting = company?.template ? FIRST_TURN_TEMPLATE : FIRST_TURN;
      await insertTurn(ctx, { companyId: me.companyId, agentId: agent.id, prompt: greeting, createdBy: me.id, message: { personId: null, text: greeting, notification: { source: 'first_turn', tasks: [] } } });
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
