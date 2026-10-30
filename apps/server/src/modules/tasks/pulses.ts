import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, people } from '../../db/schema.js';
import type { Endpoint } from '../events/bus.js';
import type { Actor, Task } from './engine.js';

type Live = Pick<Ctx, 'db' | 'bus'>;

/* Where an agent sits on the map: the hub for the orchestrator, else its department's card. */
async function agentSpot(ctx: Live, id: string | null): Promise<Endpoint | null> {
  if (!id) return null;
  const [agent] = await ctx.db.select({ kind: agents.kind, departmentId: agents.departmentId }).from(agents).where(eq(agents.id, id));
  if (!agent) return null;
  if (agent.kind === 'orchestrator') return { kind: 'orchestrator' };
  return agent.departmentId ? { kind: 'department', id: agent.departmentId } : null;
}

const actorSpot = (ctx: Live, a: Actor): Promise<Endpoint | null> => (a.personId ? Promise.resolve({ kind: 'person', id: a.personId }) : agentSpot(ctx, a.agentId ?? null));

/* Who has the task now: whoever gave it once it is done or blocked, the company's owner while it waits for people, else its assignee. */
async function holderSpot(ctx: Live, task: Task): Promise<Endpoint | null> {
  if (task.status === 'cancelled') return null;
  if (task.status === 'done' || task.status === 'blocked') {
    return task.createdByPersonId ? { kind: 'person', id: task.createdByPersonId } : agentSpot(ctx, task.createdByAgentId);
  }
  if (task.status === 'waiting') {
    const [owner] = await ctx.db.select({ id: people.id }).from(people).where(and(eq(people.companyId, task.companyId), eq(people.isOwner, true)));
    return owner ? { kind: 'person', id: owner.id } : null;
  }
  return agentSpot(ctx, task.assigneeAgentId);
}

const same = (a: Endpoint, b: Endpoint) => a.kind === b.kind && (a.kind === 'orchestrator' || a.id === (b as { id: string }).id);

/* A move shows on the map as a pulse from whoever made it to whoever has the task now. Moves inside one department show
   on its card instead, and a pulse that cannot be placed is left out: it never fails the move. */
export async function handOff(ctx: Live, actor: Actor, task: Task): Promise<void> {
  try {
    const [from, to] = await Promise.all([actorSpot(ctx, actor), holderSpot(ctx, task)]);
    if (from && to && !same(from, to)) ctx.bus.publish(task.companyId, { type: 'pulse', from, to });
  } catch {
    /* Only the picture is lost. */
  }
}
