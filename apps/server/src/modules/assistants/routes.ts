import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { accessOf, agentSpot } from '../../auth/access.js';
import { seesAgent, viewerOf, type AgentViewer } from '../../auth/agent-view.js';
import { requireAssistant, wholeCompany } from '../../auth/assistant.js';
import { actsAsCeo } from '../../auth/decisions.js';
import type { Person } from '../../auth/session.js';
import { agents, assistants, companies, departments, people } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import type { AgentRow } from '../agents/find.js';
import { agentRole, departmentParty } from '../events/parties.js';
import { personView } from '../people/views.js';
import { AnswerBody, answerRequest } from '../tasks/routes.js';
import { sendForOwner } from './messages.js';
import { waitingFor } from './requests.js';

const MessageBody = z.object({ agentId: z.uuid(), text: z.string().trim().min(1).max(20_000) }).strict();
/* An assistant reads its events after the last number it saw, and waits at most 50 seconds for a new one. */
export const LONGEST_WAIT_S = 50;
const EventsQuery = z.object({ after: z.coerce.number().int().min(0).default(0), wait: z.coerce.number().int().min(0).max(LONGEST_WAIT_S).default(0) }).strict();
const IdParams = z.object({ id: z.uuid() });

/* Whether the assistant may write to this agent: its owner may in the agent's window, and the orchestrator only for an owner
   who sees the whole company. */
function mayWrite(me: Person, viewer: AgentViewer, agent: AgentRow, spot: Awaited<ReturnType<typeof agentSpot>>): boolean {
  if (agent.kind === 'orchestrator' && !wholeCompany(me)) return false;
  return seesAgent(viewer, { subscriptionId: agent.subscriptionId, spot });
}

/* The agents of the company the assistant may write to now, in the order they were hired. */
async function writable(ctx: Ctx, me: Person): Promise<AgentRow[]> {
  const viewer = await viewerOf(ctx.db, me);
  const all = await ctx.db.select().from(agents).where(and(eq(agents.companyId, me.companyId), isNull(agents.removedAt))).orderBy(agents.createdAt);
  const open = await Promise.all(all.map(async a => mayWrite(me, viewer, a, await agentSpot(ctx.db, a))));
  return all.filter((_, i) => open[i]);
}

/* The agent a message is for: one of the company, which the assistant may write to. */
async function writableAgent(ctx: Ctx, me: Person, id: string): Promise<AgentRow> {
  const [agent] = await ctx.db.select().from(agents).where(and(eq(agents.id, id), eq(agents.companyId, me.companyId), isNull(agents.removedAt)));
  if (!agent) throw new ApiError(404, 'not_found', 'This employee does not exist.', 'agent_unknown');
  if (!mayWrite(me, await viewerOf(ctx.db, me), agent, await agentSpot(ctx.db, agent))) {
    throw new ApiError(403, 'forbidden', 'The person this assistant belongs to does not write to this agent, so neither does the assistant.', 'assistant_agent_refused');
  }
  return agent;
}

/* Who the assistant and its owner are, and what the owner is in the company, in plain fields. */
async function whoAmI(ctx: Ctx, me: Person) {
  const { db } = ctx;
  const [helper] = await db.select({ name: people.name, title: people.title, program: assistants.program }).from(people).innerJoin(assistants, eq(assistants.personId, people.id)).where(eq(people.id, me.assistant!.id));
  const [company] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, me.companyId));
  const view = await personView(db, me);
  const owns = [...((await accessOf(db, me)).owns ?? [])];
  const named = owns.length ? (await db.select().from(departments).where(eq(departments.companyId, me.companyId))).filter(d => owns.includes(d.id)) : [];
  return {
    assistant: { id: me.assistant!.id, name: helper!.name, title: helper!.title, program: helper!.program },
    owner: {
      id: me.id, name: me.name, title: me.title, ceo: me.isOwner, ceoDelegate: actsAsCeo(me) && !me.isOwner, wholeCompany: wholeCompany(me),
      departments: view.access.departments, teams: view.access.teams.map(t => ({ id: t.id, name: t.name, departmentId: t.departmentId })),
      responsibleFor: named.map(d => ({ id: d.id, name: departmentParty(d).name.en })),
      /* A program that serves several people binds the key to the one whose Telegram this is. */
      telegram: { username: view.telegram?.username ?? null, id: view.telegram?.id ?? null },
    },
    company: { name: company!.name },
  };
}

/* An agent as the assistant reads it: its kind, role and department in both languages. */
async function agentView(ctx: Ctx, agent: AgentRow, depts: Map<string, typeof departments.$inferSelect>) {
  const dept = agent.departmentId ? depts.get(agent.departmentId) : undefined;
  return { id: agent.id, name: agent.name, kind: agent.kind, role: agentRole(ctx, agent), department: dept ? departmentParty(dept) : null };
}

/* What a person's assistant does for them, with its key: reads who it is for and whom it may write to, writes to agents,
   reads what happened since, and answers what waits for its owner. Nothing here administers the company. */
export function assistantRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db } = ctx;

  app.get('/api/assistant/me', async req => whoAmI(ctx, await requireAssistant(req, db)));

  app.get('/api/assistant/agents', async req => {
    const me = await requireAssistant(req, db);
    const depts = new Map((await db.select().from(departments).where(eq(departments.companyId, me.companyId))).map(d => [d.id, d]));
    return { agents: await Promise.all((await writable(ctx, me)).map(a => agentView(ctx, a, depts))) };
  });

  app.post('/api/assistant/messages', async (req, reply) => {
    const me = await requireAssistant(req, db);
    const { agentId, text } = MessageBody.parse(req.body);
    const agent = await writableAgent(ctx, me, agentId);
    const id = await sendForOwner(ctx, me, agent, text);
    reply.code(202);
    return { message: { id, agentId: agent.id } };
  });

  /* A long poll: the events after a number at once, or the first that comes within the wait. */
  app.get('/api/assistant/events', async (req, reply) => {
    const me = await requireAssistant(req, db);
    const { after, wait } = EventsQuery.parse(req.query);
    const gone = new AbortController();
    reply.raw.once('close', () => gone.abort());
    const events = await ctx.assistants.read(me.assistant!.id, after, wait * 1000, gone.signal);
    return { events, next: events.at(-1)?.seq ?? after };
  });

  app.get('/api/assistant/requests', async req => ({ requests: await waitingFor(ctx, await requireAssistant(req, db)) }));

  /* The same answer the owner gives on their screen, recorded as given by the assistant for them. */
  app.post('/api/assistant/requests/:id/answer', async req => {
    const me = await requireAssistant(req, db);
    const { id } = IdParams.parse(req.params);
    return answerRequest(ctx, me, id, AnswerBody.parse(req.body));
  });
}
