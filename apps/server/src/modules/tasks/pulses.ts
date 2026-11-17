import { and, eq } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, people } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
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
    const [owner] = await ctx.db.select(idOnly(people)).from(people).where(and(eq(people.companyId, task.companyId), eq(people.isOwner, true)));
    return owner ? { kind: 'person', id: owner.id } : null;
  }
  return agentSpot(ctx, task.assigneeAgentId);
}

const same = (a: Endpoint, b: Endpoint) => a.kind === b.kind && (a.kind === 'orchestrator' || a.id === (b as { id: string }).id);

/* An employee as the end of a pulse inside its department. */
async function agentEnd(ctx: Live, id: string | null): Promise<Extract<Endpoint, { kind: 'agent' }> | null> {
  if (!id) return null;
  const [agent] = await ctx.db.select({ kind: agents.kind, departmentId: agents.departmentId }).from(agents).where(eq(agents.id, id));
  return agent && agent.kind !== 'orchestrator' && agent.departmentId ? { kind: 'agent', id, departmentId: agent.departmentId } : null;
}

/* The agent that has the task now, as holderSpot places it. */
const holderAgent = (task: Task) => (task.status === 'done' || task.status === 'blocked' ? task.createdByAgentId : task.status === 'cancelled' || task.status === 'waiting' ? null : task.assigneeAgentId);

/* A move shows on the map as a pulse from whoever made it to whoever has the task now. A move inside one department runs
   from agent to agent, for its card. A pulse that cannot be placed is left out: it never fails the move. */
export async function handOff(ctx: Live, actor: Actor, task: Task): Promise<void> {
  try {
    const [from, to] = await Promise.all([actorSpot(ctx, actor), holderSpot(ctx, task)]);
    if (!from || !to) return;
    if (!same(from, to)) return ctx.bus.publish(task.companyId, { type: 'pulse', from, to });
    const [a, b] = await Promise.all([agentEnd(ctx, actor.agentId ?? null), agentEnd(ctx, holderAgent(task))]);
    if (a && b && a.id !== b.id) ctx.bus.publish(task.companyId, { type: 'pulse', from: a, to: b });
  } catch {
    /* Only the picture is lost. */
  }
}
