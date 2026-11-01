import { SubscriptionBudgetBody } from '@hornhoof/protocol';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { requirePerson } from '../../auth/session.js';
import { subscriptions } from '../../db/schema.js';
import { ApiError } from '../../errors.js';
import { subView, type IsOnline } from './views.js';

const BudgetParams = z.object({ id: z.uuid() });

async function setBudget(ctx: Ctx, online: IsOnline, req: FastifyRequest) {
  const me = await requirePerson(req, ctx.db);
  const body = SubscriptionBudgetBody.safeParse(req.body);
  const params = BudgetParams.safeParse(req.params);
  if (!body.success || !params.success) throw new ApiError(400, 'validation', 'Choose a whole percentage from 0 to 100 and a valid subscription.', 'budget_invalid');
  const scope = and(eq(subscriptions.id, params.data.id), eq(subscriptions.companyId, me.companyId), isNull(subscriptions.removedAt));
  await ctx.db.transaction(async tx => {
    const [sub] = await tx.select({ owner: subscriptions.ownerPersonId, budgetPercent: subscriptions.budgetPercent }).from(subscriptions).where(scope).for('update');
    if (!sub) throw new ApiError(404, 'not_found', 'This subscription does not exist.', 'subscription_unknown');
    if (sub.owner !== me.id && me.scopeKind !== 'company') throw new ApiError(403, 'forbidden', 'Only the owner of this subscription can do this.', 'not_owner');
    if (sub.budgetPercent !== body.data.budgetPercent) await tx.update(subscriptions).set(body.data).where(scope);
  });
  return { subscription: await subView(ctx.db, online, me.companyId, params.data.id) };
}

export function subscriptionBudgetRoutes(app: FastifyInstance, ctx: Ctx, online: IsOnline): void {
  app.patch('/api/subscriptions/:id/budget', req => setBudget(ctx, online, req));
}
