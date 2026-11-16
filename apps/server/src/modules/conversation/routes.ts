import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { idOnly } from '../../db/selections.js';
import { Text } from '../tasks/long-text.js';
import type { Ctx } from '../../app.js';
import { accessOf } from '../../auth/access.js';
import { maskEvent, viewerOf } from '../../auth/agent-view.js';
import { agents, companies, departments, jobs } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import type { Person } from '../../auth/session.js';
import { agentFor, type AgentRow } from '../agents/find.js';
import { answerDirectly } from '../tasks/engine.js';
import { wakeAll } from '../tasks/wake.js';
import { lastEvents, listEvents } from '../events/store.js';
import { isOperations } from '../operations/required.js';
import { ownPictures, pictureRoutes, PICTURES_PER_MESSAGE, withPictures, type MessagePicture } from './pictures.js';
import { answerBy, answerForAssistant, answerInTelegram, FIRST_TURN, FIRST_TURN_STAFFED, FIRST_TURN_TEMPLATE, turnPrompt, whoIs, type Standing, type WrittenFrom } from './prompt.js';
import { terminalRights } from '../terminals/access.js';
import { agentState, insertTurn, onAgent, pump, reconnecting } from './queue.js';
import { refusedMessage } from './undelivered.js';
import { cancelJob } from '../tasks/wake.js';
import { queueTaskMessage, TaskReference } from '../tasks/external-wait.js';
import { STARTS_FIRST } from '../sources/requests.js';

/* after: what came since seq, a page at a time; last: only the newest so many, before seq when given. */
const EventsQuery = z.object({ after: z.coerce.number().int().min(0).default(0), last: z.coerce.number().int().min(1).max(500).optional(), before: z.coerce.number().int().min(1).optional() });
const MessageBody = z
  .object({ text: Text.trim().default(''), task: TaskReference.optional(), pictures: z.array(z.uuid()).max(PICTURES_PER_MESSAGE).default([]) })
  .refine(m => m.text || m.pictures.length, 'Write something or add a picture.');

/* Where a person's message came from when not from the agent's window: the bot it came through, the chat its answer goes
   back to and the update it was. */
export type TelegramOrigin = { bot: string; chat: number; update: number };
/* The message of the person's assistant this is, by the id the assistant was given for it. own: to the assistant's own
   agent, which thinks for it. fresh: what that agent reads instead when its turn starts a new session. */
export type AssistantOrigin = { message: string; own?: boolean; fresh?: string };

/* The words of the person's assistant, which the agent takes as the person's own and answers in its window for the
   assistant to read. The assistant's own agent takes them as they are: its rules say what they carry. Files come with
   both, with the commands that open them. */
function byAssistant(me: Person & { assistant: NonNullable<Person['assistant']> }, text: string, pictures: MessagePicture[], origin: AssistantOrigin, standing: Standing) {
  const assistant = { id: me.assistant.id, name: me.assistant.name, message: origin.message };
  const prompt = origin.own ? withPictures(text, pictures) : `${turnPrompt(me, withPictures(text, pictures))}\n\n${answerForAssistant(me, me.assistant, standing)}`;
  const fresh = origin.own && origin.fresh ? { fresh: withPictures(origin.fresh, pictures) } : {};
  return { actor: { personId: me.id }, turn: { prompt, createdBy: me.id, ...fresh, message: { personId: me.id, text, channel: 'assistant' as const, assistant, ...(pictures.length ? { pictures } : {}) } } };
}

/* from: the machine of the company the person sits at as they write in the window; none through Telegram or an assistant. */
type Origins = { telegram?: TelegramOrigin; assistant?: AssistantOrigin; standing?: Standing; from?: WrittenFrom };

function writtenBy(me: Person, text: string, pictures: MessagePicture[], { telegram, assistant, standing, from }: Origins = {}) {
  if (me.via) return {
    actor: { agentId: me.via },
    turn: { prompt: `${turnPrompt({ name: 'Orchestrator', title: '' }, text)}\n\n${answerBy({ id: me.via, name: 'Orchestrator' })}`, createdBy: null, message: { personId: null, text, from: 'orchestrator' as const } },
  };
  if (me.assistant && assistant && standing) return byAssistant({ ...me, assistant: me.assistant }, text, pictures, assistant, standing);
  if (telegram && standing) {
    return {
      actor: { personId: me.id },
      turn: { prompt: `${turnPrompt(me, withPictures(text, pictures))}\n\n${answerInTelegram(me, standing)}`, createdBy: me.id, message: { personId: me.id, text, channel: 'telegram' as const, telegram, ...(pictures.length ? { pictures } : {}) } },
    };
  }
  /* An employee is told what the person is to it, as its company tool does not show everyone who runs its department. */
  const who = standing && standing.department !== null ? `\n\n${whoIs(me, standing)}` : '';
  return { actor: { personId: me.id }, turn: { prompt: `${turnPrompt(me, withPictures(text, pictures), from)}${who}`, createdBy: me.id, message: { personId: me.id, text, ...(pictures.length ? { pictures } : {}) } } };
}

/* from: the machine of the company the person sits at as they write in the window; none through Telegram. */
type Written = { text: string; task?: z.infer<typeof TaskReference>; pictures: string[]; telegram?: TelegramOrigin; assistant?: AssistantOrigin; from?: WrittenFrom };

/* What the person is to this agent: the company's owner, the CEO's delegate, and whether they run its department, as
   everyone given it does. */
async function standingOf(ctx: Ctx, me: Person, agent: AgentRow): Promise<Standing> {
  const [department] = agent.departmentId ? await ctx.db.select({ id: departments.id, parentId: departments.parentId }).from(departments).where(eq(departments.id, agent.departmentId)) : [];
  const runs = department ? (await accessOf(ctx.db, me)).owns?.has(department.parentId ?? department.id) === true : null;
  return { owner: me.isOwner, delegate: me.isCeoDelegate, department: runs };
}

const NOT_READY = 'This employee cannot answer right now. See the window for what to do.';

/* An agent that cannot answer now is refused. The orchestrator's message to an employee whose machine is getting back on
   the line waits in line for it instead, and one refused is kept where failures reads it, with its code, the employee and
   the task. */
async function requireTakes(ctx: Ctx, me: Person, agent: AgentRow, task: Written['task']): Promise<void> {
  const state = await agentState(ctx, agent.id);
  if (state.ready) return;
  if (agent.kind === 'orchestrator') throw new ApiError(409, 'conflict', 'The orchestrator cannot answer right now. See the window for what to do.', 'orchestrator_not_ready');
  if (!me.via) throw new ApiError(409, 'conflict', NOT_READY, 'agent_not_ready');
  if (state.reason === 'machine_offline' && (await reconnecting(ctx, agent.id))) return;
  const refusal = new ApiError(409, 'conflict', NOT_READY, 'agent_not_ready', { undelivered: state.reason ?? 'cannot_run' });
  throw await refusedMessage(ctx, { companyId: me.companyId, agentId: me.via }, { recipient: agent.id, task }, refusal);
}

/* A person's words to an agent, from its window, through its Telegram bot or by the person's assistant, under that person's
   own rights: whoever calls this has checked that they may write to the agent. Returns the turn the words went into. */
export async function writeToAgent(ctx: Ctx, me: Person, agent: AgentRow, input: Written): Promise<string> {
  if (me.via === agent.id) throw new ApiError(400, 'validation', 'This is your own conversation. Write to people in your answer.');
  const pictures = await ownPictures(ctx, me, agent.id, input.pictures);
  await requireTakes(ctx, me, agent, input.task);
  /* Pictures alone read as their names wherever the words of a message show. */
  const words = input.text || pictures.map(p => p.name).join(', ');
  const standing = me.via ? undefined : await standingOf(ctx, me, agent);
  const { actor, turn } = writtenBy(me, words, pictures, { telegram: input.telegram, assistant: input.assistant, standing, from: input.from });
  const jobId = await queueTaskMessage(ctx, { companyId: me.companyId, agentId: agent.id, task: input.task, actor, text: words }, { companyId: me.companyId, agentId: agent.id, ...turn });
  ctx.bus.publish(me.companyId, {
    type: 'pulse',
    from: me.via ? { kind: 'orchestrator' } : { kind: 'person', id: me.id },
    to: agent.kind === 'orchestrator' ? { kind: 'orchestrator' } : { kind: 'department', id: agent.departmentId ?? '' },
  });
  /* Once the words are on their way, a person's words answer what the agent waits for from people; the orchestrator
     answers requests with its own tool. */
  if (!me.via) await wakeAll(ctx, await answerDirectly(ctx, me.id, agent.id, input.text, { assistant: me.assistant?.id }));
  return jobId;
}

/* Every agent's window: its conversation, what it is doing, writing to it and stopping it. The orchestrator is for people
   who see the whole company; an employee for people who reach its department. */
export function conversationRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  pictureRoutes(app, ctx);

  app.get('/api/agents/:id/events', async req => {
    const { me, agent } = await agentFor(ctx, req);
    const { after, last, before } = EventsQuery.parse(req.query);
    const viewer = await viewerOf(db, me);
    const state = await agentState(ctx, agent.id);
    const found = last === undefined ? await listEvents(db, agent.id, after) : await lastEvents(db, agent.id, last, before);
    return { events: found.map(e => maskEvent(viewer, e)), state: { ...state, ...(await terminalRights(ctx, me, agent, state.terminal)) } };
  });

  app.post('/api/agents/:id/messages', async (req, reply) => {
    const { me, agent } = await agentFor(ctx, req);
    const { text, task, pictures } = MessageBody.parse(req.body);
    /* The orchestrator is told which machine of the company a person writes from, when they sit at one. */
    const here = !me.via && agent.kind === 'orchestrator' ? await ctx.computer.here(req, me.companyId) : null;
    const from = here ? { machine: here.name, until: await ctx.computer.openUntil(here.id) } : undefined;
    const jobId = await writeToAgent(ctx, me, agent, { text, task, pictures, from });
    reply.code(202);
    return { jobId };
  });

  /* A template brings its people, so he says only a subscription is left; a company set up before it did, with a
     department nobody works in, is offered its staff. */
  async function templateGreeting(top: string[]): Promise<string> {
    const staffed = new Set((await db.select({ id: agents.departmentId }).from(agents).where(and(inArray(agents.departmentId, top), isNull(agents.removedAt)))).map(a => a.id));
    return top.every(id => staffed.has(id)) ? FIRST_TURN_STAFFED : FIRST_TURN_TEMPLATE;
  }

  /* The orchestrator's greeting, once: on an empty company whose conversation never began. Employees wait to be written to. */
  app.post('/api/agents/:id/start', async req => {
    const { me, agent } = await agentFor(ctx, req);
    if (agent.kind !== 'orchestrator') return { started: false };
    const started = await onAgent(ctx, agent.id, async () => {
      if (!(await agentState(ctx, agent.id)).ready) return false;
      if ((await listEvents(db, agent.id, 0, 1)).length) return false;
      const [open] = await db.select(idOnly(jobs)).from(jobs).where(and(eq(jobs.agentId, agent.id), eq(jobs.kind, 'conversation'), inArray(jobs.status, ['queued', 'running']))).limit(1);
      if (open) return false;
      const [company] = await db.select({ template: companies.template }).from(companies).where(eq(companies.id, me.companyId)).limit(1);
      const depts = await db.select({ id: departments.id, templateKey: departments.templateKey, parentId: departments.parentId }).from(departments).where(eq(departments.companyId, me.companyId));
      /* A company built by hand gets no greeting (its build already enqueued a turn); one from a template is greeted. The
         Operations every company starts with is no building. */
      if (depts.some(d => !isOperations(d)) && !company?.template) return false;
      const greeting = company?.template ? await templateGreeting(depts.filter(d => !d.parentId).map(d => d.id)) : FIRST_TURN;
      await insertTurn(ctx, { companyId: me.companyId, agentId: agent.id, prompt: greeting, createdBy: me.id, message: { personId: null, text: greeting, notification: { source: 'first_turn', tasks: [] } } });
      return true;
    });
    /* Outside the agent's line, which the pump waits on. */
    if (started) await pump(ctx, agent.id);
    return { started };
  });

  app.post('/api/agents/:id/stop', STARTS_FIRST, async (req, reply) => {
    const { agent } = await agentFor(ctx, req);
    const { runningJobId } = await agentState(ctx, agent.id);
    if (!runningJobId) throw new ApiError(409, 'conflict', 'Nothing is running.', 'nothing_running');
    await cancelJob(ctx, runningJobId);
    return reply.code(202).send();
  });
}
