import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, subscriptions } from '../../db/schema.js';
import type { Task } from './engine.js';
import { modelCapability, modelProvider, reviewEligibility, type CheckerIdentity } from './echelons-policy.js';

type Reader = Pick<Ctx, 'db'>;

export async function agentIdentity(db: Ctx['db'], companyId: string, agentId: string): Promise<CheckerIdentity | null> {
  const [row] = await db.select({ id: agents.id, subscriptionId: subscriptions.id, model: agents.model, provider: subscriptions.provider }).from(agents)
    .innerJoin(subscriptions, and(eq(subscriptions.id, agents.subscriptionId), eq(subscriptions.companyId, agents.companyId), isNull(subscriptions.removedAt)))
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  if (!row) return null;
  const capability = modelCapability(row.model);
  return capability === null ? null : { agentId: row.id, subscriptionId: row.subscriptionId, model: row.model, provider: modelProvider(row.provider), capability };
}

/* Selection never changes a subscription, model, employee or skill card. */
export async function checkerFor(ctx: Reader, task: Task, producer: CheckerIdentity, ability: string, named: string | null): Promise<CheckerIdentity | null> {
  const staff = await ctx.db.select().from(agents).where(and(eq(agents.companyId, task.companyId), eq(agents.departmentId, task.departmentId!), isNull(agents.removedAt), isNull(agents.switchedOffAt))).orderBy(asc(agents.createdAt));
  const eligible: CheckerIdentity[] = [];
  for (const agent of staff) {
    if ((named && agent.id !== named) || (agent.productId && agent.productId !== task.productId) || !agent.skills.includes(ability)) continue;
    const identity = await agentIdentity(ctx.db, task.companyId, agent.id);
    if (identity && !reviewEligibility(producer, identity)) eligible.push(identity);
  }
  return eligible.find(identity => identity.provider !== producer.provider) ?? eligible[0] ?? null;
}
