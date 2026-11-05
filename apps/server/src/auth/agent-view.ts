import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents, subscriptions } from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { MessageEnvelope, MessageParty } from '../modules/events/parties.js';
import type { EventView } from '../modules/events/store.js';
import { accessOf, agentSpot, canReach, type Access, type Spot } from './access.js';
import { actsAsCeo } from './decisions.js';
import type { Person } from './session.js';

/* Which agents a person sees. The CEO and the CEO's delegate see all of them, and so does a call from inside, whose rights
   its own tools set. Anyone else, the owner of a department too, sees an agent only on a plan of their own in a place they
   reach: neither alone is enough. This is the one rule; every route that shows an agent or its work asks it here.
   plans: the person's own live plans. agents: the employees that passes for now, empty for a full view. */
export type AgentViewer = {
  full: boolean;
  personId: string;
  access: Access;
  plans: ReadonlySet<string>;
  agents: ReadonlySet<string>;
};

/* Where the agent works and the plan it runs on. A terminal passes the plan its program really lives on. */
export type AgentPlace = { subscriptionId: string | null; spot: Spot };

export function seesAgent(viewer: AgentViewer, agent: AgentPlace): boolean {
  if (viewer.full) return true;
  return agent.subscriptionId !== null && viewer.plans.has(agent.subscriptionId) && canReach(viewer.access, agent.spot);
}

/* The same answer for an agent already named in a task, a message or a line; nobody sees one that is not named. */
export function seesAgentId(viewer: AgentViewer, id: string | null | undefined): boolean {
  if (viewer.full) return true;
  return Boolean(id) && viewer.agents.has(id!);
}

export async function viewerOf(db: Db, me: Person): Promise<AgentViewer> {
  const access = await accessOf(db, me);
  if (me.via || actsAsCeo(me)) return { full: true, personId: me.id, access, plans: new Set(), agents: new Set() };
  const plans = new Set(
    (await db.select({ id: subscriptions.id }).from(subscriptions).where(and(eq(subscriptions.companyId, me.companyId), eq(subscriptions.ownerPersonId, me.id), isNull(subscriptions.removedAt)))).map(p => p.id),
  );
  const onPlans = plans.size ? await db.select().from(agents).where(and(eq(agents.companyId, me.companyId), isNull(agents.removedAt), inArray(agents.subscriptionId, [...plans]))) : [];
  const seen = await Promise.all(onPlans.map(async a => (canReach(access, await agentSpot(db, a)) ? [a.id] : [])));
  return { full: false, personId: me.id, access, plans, agents: new Set(seen.flat()) };
}

type AgentRow = Pick<typeof agents.$inferSelect, 'companyId' | 'subscriptionId' | 'departmentId' | 'productId' | 'teamId'>;

/* Whether this person sees this agent now. planId: the plan to judge by, when its program runs on another than its card's. */
export async function canViewAgent(db: Db, me: Person, agent: AgentRow, planId: string | null = agent.subscriptionId): Promise<boolean> {
  if (agent.companyId !== me.companyId) return false;
  return seesAgent(await viewerOf(db, me), { subscriptionId: planId, spot: await agentSpot(db, agent) });
}

export const agentHidden = () => new ApiError(403, 'forbidden', 'This employee is not on a plan of yours in a department you have.', 'agent_hidden');

export async function requireAgentView(db: Db, me: Person, agent: AgentRow, planId: string | null = agent.subscriptionId): Promise<void> {
  if (!(await canViewAgent(db, me, agent, planId))) throw agentHidden();
}

/* The other end of a message when it is an agent this person does not see: that there is someone, and nothing of who. */
export function hiddenParty(party: MessageParty): MessageParty {
  return { kind: 'agent', id: null, name: 'Employee', role: null, department: null, ...(party.agentKind === 'orchestrator' ? { agentKind: party.agentKind } : {}) };
}

export function maskEnvelope(viewer: AgentViewer, message: MessageEnvelope): MessageEnvelope {
  if (viewer.full) return message;
  const shown = (party: MessageParty) => (party.kind === 'agent' && !seesAgentId(viewer, party.id) ? hiddenParty(party) : party);
  return { ...message, from: shown(message.from), to: shown(message.to), ...(message.senders ? { senders: message.senders.map(shown) } : {}) };
}

export function maskEvent(viewer: AgentViewer, event: EventView): EventView {
  return event.message ? { ...event, message: maskEnvelope(viewer, event.message) } : event;
}
