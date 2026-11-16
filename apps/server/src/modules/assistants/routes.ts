import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf } from '../../auth/access.js';
import { canViewAgent, placeOf, seesAgent, viewerOf } from '../../auth/agent-view.js';
import { requireAssistant, wholeCompany } from '../../auth/assistant.js';
import { actsAsCeo } from '../../auth/decisions.js';
import type { Person } from '../../auth/session.js';
import { agents, assistants, companies, departments, people } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import type { AgentRow } from '../agents/find.js';
import { agentState } from '../conversation/queue.js';
import { agentRole, departmentParty } from '../events/parties.js';
import { personView } from '../people/views.js';
import { keepMessageFile, PICTURES_PER_MESSAGE } from '../conversation/pictures.js';
import { FILE_BYTES } from '../tasks/attachments.js';
import { AnswerBody, answerRequest } from '../tasks/routes.js';
import { fileFor } from './files.js';
import { sendForOwner } from './messages.js';
import { waitingFor } from './requests.js';
import { FILES_URL, inOwnersWords } from './words.js';

/* Words of one message. Nothing is cut: longer words are refused. */
export const Words = z.string().trim().min(1).max(50_000);
/* With no agent named, the words go to the assistant's own agent. text: the new words, which a message with files may
   leave out. freshText: the program's whole conversation, which the assistant's own agent reads in their place when its
   turn starts a new session. files: what the program sent this agent before, by the ids it got for them. */
export const MessageBody = z
  .object({ agentId: z.uuid().optional(), text: Words.optional(), freshText: z.string().trim().min(1).max(200_000).optional(), files: z.array(z.uuid()).max(PICTURES_PER_MESSAGE).default([]) })
  .strict()
  .refine(m => m.text || m.files.length, 'Write something or add a file.');
const FileQuery = z.object({ agentId: z.uuid().optional(), name: z.string().optional() }).strict();
/* A program may send each letter of both texts as an escape of six bytes. */
export const MESSAGE_BYTES = 2 * 1024 * 1024;
export const ASSISTANT_CONTRACT = 3;
/* An assistant reads its events after the last number it saw, and waits at most 50 seconds for a new one. */
export const LONGEST_WAIT_S = 50;
export const EventsQuery = z.object({ after: z.coerce.number().int().min(0).default(0), wait: z.coerce.number().int().min(0).max(LONGEST_WAIT_S).default(0) }).strict();
const IdParams = z.object({ id: z.uuid() });

/* The assistant writes to exactly the agents its owner writes to in the agent's window: the window's own check, with the
   owner's rights as they are now. The agents of the company it may write to, in the order they were hired. */
async function writable(ctx: Ctx, me: Person): Promise<AgentRow[]> {
  const viewer = await viewerOf(ctx.db, me);
  const all = await ctx.db.select().from(agents).where(and(eq(agents.companyId, me.companyId), isNull(agents.removedAt))).orderBy(agents.createdAt);
  const open = await Promise.all(all.map(async a => seesAgent(viewer, await placeOf(ctx.db, a))));
  return all.filter((_, i) => open[i]);
}

/* The agent a message is for: one of the company, which the assistant may write to. */
async function writableAgent(ctx: Ctx, me: Person, id: string): Promise<AgentRow> {
  const [agent] = await ctx.db.select().from(agents).where(and(eq(agents.id, id), eq(agents.companyId, me.companyId), isNull(agents.removedAt)));
  if (!agent) throw new ApiError(404, 'not_found', 'This employee does not exist.', 'agent_unknown');
  if (!(await canViewAgent(ctx.db, me, agent))) {
    throw new ApiError(403, 'forbidden', 'The person this assistant belongs to does not write to this agent, so neither does the assistant.', 'assistant_agent_refused');
  }
  return agent;
}

/* The agent the assistant writes or sends a file to: the one it names, or else its own. */
async function addressee(ctx: Ctx, me: Person, agentId: string | undefined, mine: string | null): Promise<AgentRow> {
  const id = agentId ?? mine;
  if (!id) throw new ApiError(409, 'conflict', "This assistant has no agent of its own yet: its owner picks a plan for it on the assistant's card in People.", 'agent_not_ready');
  return writableAgent(ctx, me, id);
}

/* The assistant's own agent, if its owner picked a plan for it once. */
export async function ownAgentOf(ctx: Pick<Ctx, 'db'>, assistantId: string): Promise<string | null> {
  const [row] = await ctx.db.select({ agentId: assistants.agentId }).from(assistants).where(eq(assistants.personId, assistantId));
  return row?.agentId ?? null;
}

/* Who the assistant and its owner are, and what the owner is in the company, in plain fields. The assistant's own agent,
   and whether it can answer now. */
export async function whoAmI(ctx: Ctx, me: Person) {
  const { db } = ctx;
  const [helper] = await db.select({ name: people.name, title: people.title, program: assistants.program, agentId: assistants.agentId }).from(people).innerJoin(assistants, eq(assistants.personId, people.id)).where(eq(people.id, me.assistant!.id));
  const [company] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, me.companyId));
  const view = await personView(db, me);
  const owns = [...((await accessOf(db, me)).owns ?? [])];
  const named = owns.length ? (await db.select().from(departments).where(eq(departments.companyId, me.companyId))).filter(d => owns.includes(d.id)) : [];
  return {
    assistant: { id: me.assistant!.id, name: helper!.name, title: helper!.title, program: helper!.program, agentId: helper!.agentId, agentReady: helper!.agentId ? (await agentState(ctx, helper!.agentId)).ready : false },
    owner: {
      id: me.id, name: me.name, title: me.title, ceo: me.isOwner, ceoDelegate: actsAsCeo(me) && !me.isOwner, wholeCompany: wholeCompany(me),
      departments: view.access.departments, teams: view.access.teams.map(t => ({ id: t.id, name: t.name, departmentId: t.departmentId })),
      responsibleFor: named.map(d => ({ id: d.id, name: departmentParty(d).name.en })),
      /* A program that serves several people binds the key to the one whose Telegram this is. */
      telegram: { username: view.telegram?.username ?? null, id: view.telegram?.id ?? null },
    },
    company: { name: company!.name },
    /* Contract 3 includes attachment downloads and reply origin. A server with no contract here keeps the first,
       which refuses a body with freshText. */
    contract: ASSISTANT_CONTRACT,
  };
}

/* An agent as the assistant reads it: its kind, role and department in both languages. */
async function agentView(ctx: Ctx, agent: AgentRow, depts: Map<string, typeof departments.$inferSelect>) {
  const dept = agent.departmentId ? depts.get(agent.departmentId) : undefined;
  return { id: agent.id, name: agent.name, kind: agent.kind, role: agentRole(ctx, agent), department: dept ? departmentParty(dept) : null };
}

/* The calls an assistant makes, the same through its routes and through its MCP tools: each checks what it is given and
   acts with the owner's rights as they are now. */

export async function agentsFor(ctx: Ctx, me: Person) {
  const depts = new Map((await ctx.db.select().from(departments).where(eq(departments.companyId, me.companyId))).map(d => [d.id, d]));
  return { agents: await Promise.all((await writable(ctx, me)).map(a => agentView(ctx, a, depts))) };
}

/* senderAgentId comes from the authenticated MCP job, never from the message body. */
export async function writeFor(ctx: Ctx, me: Person, body: unknown, senderAgentId?: string) {
  const { agentId, text = '', freshText, files } = MessageBody.parse(body);
  const mine = await ownAgentOf(ctx, me.assistant!.id);
  const agent = await addressee(ctx, me, agentId, mine);
  const id = await sendForOwner(ctx, me, agent, { text, fresh: agent.id === mine ? freshText : undefined, files, byOwnAgent: senderAgentId === mine });
  return { message: { id, agentId: agent.id } };
}

/* A file of any kind the assistant sends an agent, to name in its next message to it: kept as its owner's own, as a file
   the owner sends from the agent's window. */
export async function keepFor(ctx: Ctx, me: Person, query: unknown, body: unknown) {
  const { agentId, name } = FileQuery.parse(query);
  const agent = await addressee(ctx, me, agentId, await ownAgentOf(ctx, me.assistant!.id));
  const bytes = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  if (!bytes.length) throw new ApiError(400, 'validation', 'This file is empty.', 'file_empty');
  return { file: await keepMessageFile(ctx, me, agent.id, bytes, name ?? '') };
}

/* A long poll: the events after a number at once, or the first that comes within the wait, until the asker goes. */
export async function eventsFor(ctx: Ctx, me: Person, query: unknown, gone: AbortSignal) {
  const { after, wait } = EventsQuery.parse(query);
  const events = await ctx.assistants.read(me.assistant!.id, after, wait * 1000, gone);
  return { events, next: events.at(-1)?.seq ?? after };
}

export const requestsFor = async (ctx: Ctx, me: Person) => ({ requests: await waitingFor(ctx, me) });

/* The same answer the owner gives on their screen, recorded as given by the assistant for them. */
export function answerFor(ctx: Ctx, me: Person, params: unknown, body: unknown) {
  const { id } = IdParams.parse(params);
  return answerRequest(ctx, me, id, AnswerBody.parse(body));
}

/* What a person's assistant does for them, with its key: reads who it is for and whom it may write to, writes to agents
   and sends them files, reads what happened since, answers what waits for its owner, all with the owner's rights, and
   downloads the files its owner may. A refusal tells the owner why in their words. */
export function assistantRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  void app.register(async scope => {
    scope.setErrorHandler(inOwnersWords);

    scope.get('/api/assistant/me', async req => whoAmI(ctx, await requireAssistant(req, db)));

    scope.get('/api/assistant/agents', async req => agentsFor(ctx, await requireAssistant(req, db)));

    scope.post('/api/assistant/messages', { bodyLimit: MESSAGE_BYTES }, async (req, reply) => {
      const sent = await writeFor(ctx, await requireAssistant(req, db), req.body);
      reply.code(202);
      return sent;
    });

    /* A file comes as its raw bytes, whatever type the program gives it. */
    void scope.register(async files => {
      files.removeAllContentTypeParsers();
      files.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: FILE_BYTES }, (_req, body, done) => done(null, body));
      files.post(FILES_URL, { bodyLimit: FILE_BYTES }, async (req, reply) => {
        const kept = await keepFor(ctx, await requireAssistant(req, db), req.query, req.body);
        reply.code(201);
        return kept;
      });
    });

    scope.get('/api/assistant/events', async (req, reply) => {
      const me = await requireAssistant(req, db);
      const gone = new AbortController();
      reply.raw.once('close', () => gone.abort());
      return eventsFor(ctx, me, req.query, gone.signal);
    });

    scope.get('/api/assistant/requests', async req => requestsFor(ctx, await requireAssistant(req, db)));

    scope.post('/api/assistant/requests/:id/answer', async req => answerFor(ctx, await requireAssistant(req, db), req.params, req.body));

    scope.get('/api/assistant/attachments/:id', async (req, reply) => fileFor(ctx, await requireAssistant(req, db), req.params, reply));
  });
}
