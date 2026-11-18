import type { Ctx } from '../../app.js';
import { canViewAgent } from '../../auth/agent-view.js';
import type { Person } from '../../auth/session.js';
import type { AgentRow } from '../agents/find.js';
import { programPlan } from '../conversation/placement.js';

/* A terminal shows a program, and a person gets it by the plan that program really lives on. The agent's card may say another:
   a new owner of the plan on the card gets nothing of a program that still runs on someone else's. */
export async function programAccess(ctx: Ctx, me: Person, agent: AgentRow) {
  const plan = await programPlan(ctx, agent.id);
  return { plan, sees: await canViewAgent(ctx.db, me, agent, plan?.id ?? agent.subscriptionId) };
}

export const mayTypeTo = (me: Person, agent: AgentRow): boolean => agent.kind !== 'assistant' || !me.via;

/* What a person's window of the agent can do with its terminal. */
export async function terminalRights(ctx: Ctx, me: Person, agent: AgentRow, terminal: boolean) {
  const { plan, sees } = await programAccess(ctx, me, agent);
  return { terminal: terminal && sees, canType: sees && mayTypeTo(me, agent) && plan?.ownerPersonId === me.id };
}
