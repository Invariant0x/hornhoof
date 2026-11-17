import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, assistants, departments, people, subscriptions } from '../db/schema.js';
import { idOnly } from '../db/selections.js';
import { ApiError } from '../errors.js';
import type { MessageEnvelope, MessageParty } from '../modules/events/parties.js';
import type { EventView } from '../modules/events/store.js';
import { accessOf, agentSpot, canReach, type Access, type Spot } from './access.js';
import { actsAsCeo } from './decisions.js';
import { type Person, viaOrchestrator } from './session.js';

/* The company is one, and everyone of it sees the whole of it: every department, every employee by name, role and state,
   and their work, on the map, on each department's screen and in its tasks (knowsAgentId). An assistant's own agent is
   apart from that: its owner alone knows of it. What follows is the other level, the agent's own: its window, card,
   conversation and terminal, and acting on it.

   Which agents a person opens. The CEO and the CEO's delegate open all of them, and so does a call from inside, whose rights
   its own tools set. The owner of a department sees every agent of it, its products and its sub-units, on whoever's plan:
   the owner of the company gave them that department to run as their own, and nobody runs people they cannot see. Two
   things stay with each plan's owner even there: typing into an agent's terminal, which works with that owner's sign-in on
   their machine, and the plan's secrets (keys, sign-ins, codes), which no view of an agent carries. Anyone else, and the
   owner outside their department, sees an agent only on a plan of their own in a place they reach: neither alone is
   enough. The orchestrator can inspect every assistant. Only its own person can talk to it.
   plans: the person's own live plans. agents: the employees that passes for now, empty for a full view. own: the agents of
   the person's own assistants. apart: every other assistant's agent of the company, which even a full view leaves out. */
export type AgentViewer = {
  full: boolean;
  personId: string;
  access: Access;
  plans: ReadonlySet<string>;
  agents: ReadonlySet<string>;
  own: ReadonlySet<string>;
  apart: ReadonlySet<string>;
};

/* Where the agent works and the plan it runs on. A terminal passes the plan its program really lives on. assistant: the
   agent's id, when it is an assistant's own. */
type AgentPlace = { subscriptionId: string | null; spot: Spot; assistant?: string };

/* Whether the place is in a department this person owns. */
export function ownsPlace(viewer: Pick<AgentViewer, 'access'>, spot: Spot): boolean {
  const department = spot.parentId ?? spot.departmentId;
  return department !== null && viewer.access.owns?.has(department) === true;
}

export function seesAgent(viewer: AgentViewer, agent: AgentPlace): boolean {
  if (agent.assistant) return viewer.own.has(agent.assistant);
  if (viewer.full || ownsPlace(viewer, agent.spot)) return true;
  return agent.subscriptionId !== null && viewer.plans.has(agent.subscriptionId) && canReach(viewer.access, agent.spot);
}

/* Whether a person knows of an agent named in the company's structure or work: its name, role, state and what it works
   on. Everyone does, but of another person's assistant's own agent. Its own conversation is seesAgentId's. */
export function knowsAgentId(viewer: Pick<AgentViewer, 'apart'>, id: string | null | undefined): boolean {
  return Boolean(id) && !viewer.apart.has(id!);
}

/* The same answer for an agent already named in a task, a message or a line; nobody sees one that is not named. */
export function seesAgentId(viewer: AgentViewer, id: string | null | undefined): boolean {
  if (id && viewer.apart.has(id)) return false;
  if (viewer.full) return true;
  return Boolean(id) && viewer.agents.has(id!);
}

/* Assistant agents this caller can see, and those kept in their own person's view. */
async function assistantAgentsOf(db: Db, me: Person): Promise<{ own: Set<string>; apart: Set<string> }> {
  const rows = await db
    .select({ id: agents.id, ownerId: people.assistantOf })
    .from(agents)
    .leftJoin(assistants, eq(assistants.agentId, agents.id))
    .leftJoin(people, eq(people.id, assistants.personId))
    .where(and(eq(agents.companyId, me.companyId), eq(agents.kind, 'assistant')));
  const mine = (row: { ownerId: string | null }) => viaOrchestrator(me) || (!me.via && row.ownerId === me.id);
  return { own: new Set(rows.filter(mine).map(r => r.id)), apart: new Set(rows.filter(r => !mine(r)).map(r => r.id)) };
}

export async function viewerOf(db: Db, me: Person): Promise<AgentViewer> {
  const access = await accessOf(db, me);
  const { own, apart } = await assistantAgentsOf(db, me);
  /* Only the orchestrator's call sees all; a head's call for a person sees what that person sees. */
  if (viaOrchestrator(me) || actsAsCeo(me)) return { full: true, personId: me.id, access, plans: new Set(), agents: own, own, apart };
  const plans = new Set(
    (await db.select(idOnly(subscriptions)).from(subscriptions).where(and(eq(subscriptions.companyId, me.companyId), eq(subscriptions.ownerPersonId, me.id), isNull(subscriptions.removedAt)))).map(p => p.id),
  );
  const onPlans = plans.size ? await db.select().from(agents).where(and(eq(agents.companyId, me.companyId), isNull(agents.removedAt), inArray(agents.subscriptionId, [...plans]))) : [];
  const seen = await Promise.all(onPlans.map(async a => (canReach(access, await agentSpot(db, a)) ? [a.id] : [])));
  /* Every agent of an owned department, of its products and of its sub-units, placed there or in a sub-unit itself. */
  const units = access.owns?.size ? [...access.owns, ...(await db.select(idOnly(departments)).from(departments).where(inArray(departments.parentId, [...access.owns]))).map(d => d.id)] : [];
  const owned = units.length ? await db.select(idOnly(agents)).from(agents).where(and(eq(agents.companyId, me.companyId), isNull(agents.removedAt), inArray(agents.departmentId, units))) : [];
  return { full: false, personId: me.id, access, plans, agents: new Set([...seen.flat(), ...owned.map(a => a.id), ...own]), own, apart };
}

type AgentRow = Pick<typeof agents.$inferSelect, 'id' | 'kind' | 'companyId' | 'subscriptionId' | 'departmentId' | 'productId' | 'teamId'>;

/* An agent's place as the rule reads it. */
export const placeOf = async (db: Db, agent: AgentRow, planId: string | null = agent.subscriptionId): Promise<AgentPlace> => ({
  subscriptionId: planId,
  spot: await agentSpot(db, agent),
  ...(agent.kind === 'assistant' ? { assistant: agent.id } : {}),
});

/* Whether this person sees this agent now. planId: the plan to judge by, when its program runs on another than its card's. */
export async function canViewAgent(db: Db, me: Person, agent: AgentRow, planId: string | null = agent.subscriptionId): Promise<boolean> {
  if (agent.companyId !== me.companyId) return false;
  return seesAgent(await viewerOf(db, me), await placeOf(db, agent, planId));
}

export const agentHidden = () => new ApiError(403, 'forbidden', 'This employee is not on a plan of yours in a department you have, nor in a department you own.', 'agent_hidden');

export async function requireAgentView(db: Db, me: Person, agent: AgentRow, planId: string | null = agent.subscriptionId): Promise<void> {
  if (!(await canViewAgent(db, me, agent, planId))) throw agentHidden();
}

/* The other end of a message when it is an agent this person does not see: that there is someone, and nothing of who. */
export function hiddenParty(party: MessageParty): MessageParty {
  return { kind: 'agent', id: null, name: 'Employee', role: null, department: null, ...(party.agentKind === 'orchestrator' ? { agentKind: party.agentKind } : {}) };
}

export function maskEnvelope(viewer: AgentViewer, message: MessageEnvelope): MessageEnvelope {
  if (viewer.full && !viewer.apart.size) return message;
  const shown = (party: MessageParty) => (party.kind === 'agent' && !seesAgentId(viewer, party.id) ? hiddenParty(party) : party);
  return { ...message, from: shown(message.from), to: shown(message.to), ...(message.senders ? { senders: message.senders.map(shown) } : {}) };
}

export function maskEvent(viewer: AgentViewer, event: EventView): EventView {
  return event.message ? { ...event, message: maskEnvelope(viewer, event.message) } : event;
}
