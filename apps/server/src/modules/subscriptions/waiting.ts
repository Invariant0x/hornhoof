import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentSpot, type Spot } from '../../auth/access.js';
import { agentChanges, agents, companies, teams } from '../../db/schema.js';
import { idOnly, only } from '../../db/selections.js';
import { loggable } from '../../errors.js';
import { modelForTier, tierIn } from '../agents/role-model.js';
import { pump, pumpWaiting } from '../conversation/queue.js';
import { repinMoved } from '../tasks/echelons-repin.js';
import type { Tx } from '../tasks/state.js';
import { resumeAgent } from '../tasks/wake.js';
import { placeableForOrchestrator, placeableSubscriptions, runsTier, type Serving } from '../tools/staff.js';

/* Hornhoof's own doing: no person decided it and the orchestrator did not act for one. */
const HORNHOOF = { personId: null, byOrchestrator: false };

type Agent = typeof agents.$inferSelect;

/* Those whose last plan a person, or the orchestrator for one, took off by hand: they wait until someone gives them one.
   One hired with no plan, or one whose plan was removed, waits for any. */
async function keptOff(tx: Tx, ids: string[]): Promise<Set<string>> {
  const rows = await tx
    .select({ agentId: agentChanges.agentId, after: agentChanges.after, personId: agentChanges.personId, byOrchestrator: agentChanges.byOrchestrator })
    .from(agentChanges)
    .where(and(inArray(agentChanges.agentId, ids), eq(agentChanges.field, 'subscription')))
    .orderBy(desc(agentChanges.createdAt));
  const last = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!last.has(row.agentId)) last.set(row.agentId, row);
  return new Set([...last.values()].filter(change => change.after === null && (change.personId !== null || change.byOrchestrator)).map(change => change.agentId));
}

/* The first new plan that may serve the agent and runs its role's tier, with the model that tier asks for there. The
   orchestrator takes one that serves the whole company and keeps its model, as a move on his card does. */
async function planOf(ctx: Pick<Ctx, 'templates'>, tx: Tx, agent: Agent, fresh: ReadonlySet<string>, at: (spot: Spot) => Promise<Serving[]>): Promise<{ id: string; model: string } | null> {
  if (agent.kind === 'orchestrator') {
    const plan = (await placeableForOrchestrator({ db: tx }, agent.companyId)).find(p => fresh.has(p.id));
    return plan ? { id: plan.id, model: agent.model } : null;
  }
  const role = agent.roleKey ? ctx.templates.roles.get(agent.roleKey) : undefined;
  const [team] = agent.teamId ? await tx.select(only(teams, 'turnkey')).from(teams).where(eq(teams.id, agent.teamId)) : [];
  const tier = tierIn(role ?? { tier: 'standard' }, team);
  const plan = (await at(await agentSpot(tx, agent))).find(p => fresh.has(p.id) && runsTier(p.provider, tier));
  return plan ? { id: plan.id, model: modelForTier(tier, plan.provider, plan.models) ?? '' } : null;
}

/* Everyone of the company who waits for a plan takes one of these new ones by the rules of a hire, under the company's
   lock, so two servers place no one twice. One switched off takes no work, so it stays as it is, as the operator does.
   An assistant's own agent thinks only on the plan its owner picks. */
async function placeOn(ctx: Pick<Ctx, 'templates'>, tx: Tx, companyId: string, fresh: ReadonlySet<string>): Promise<Agent[]> {
  await tx.select(idOnly(companies)).from(companies).where(eq(companies.id, companyId)).for('update');
  const waiting = await tx.select().from(agents).where(and(eq(agents.companyId, companyId), ne(agents.kind, 'assistant'), isNull(agents.subscriptionId), isNull(agents.removedAt), isNull(agents.switchedOffAt)));
  if (!waiting.length) return [];
  const off = await keptOff(tx, waiting.map(a => a.id));
  /* Employees of one place share what may serve them. */
  const seen = new Map<string, Promise<Serving[]>>();
  const at = (spot: Spot) => {
    const key = `${spot.departmentId}/${spot.parentId ?? ''}/${spot.teamId ?? ''}`;
    if (!seen.has(key)) seen.set(key, placeableSubscriptions({ db: tx }, companyId, spot));
    return seen.get(key)!;
  };
  const placed: Agent[] = [];
  for (const agent of waiting.filter(a => !off.has(a.id))) {
    const plan = await planOf(ctx, tx, agent, fresh, at);
    if (!plan) continue;
    const [moved] = await tx
      .update(agents)
      .set({ subscriptionId: plan.id, model: plan.model, effort: null })
      .where(and(eq(agents.id, agent.id), isNull(agents.subscriptionId)))
      .returning({ id: agents.id });
    if (!moved) continue;
    await tx.insert(agentChanges).values({ companyId, agentId: agent.id, ...HORNHOOF, field: 'subscription', before: null, after: plan.id });
    placed.push(agent);
  }
  return placed;
}

/* A plan that came, or began to work, takes the employees and the orchestrator that wait for one, so a company starts
   working once its subscription is on. No one is asked. */
export async function placeWaiting(ctx: Ctx, companyId: string, planIds: readonly string[]): Promise<void> {
  if (!planIds.length) return;
  const placed = await ctx.db.transaction(tx => placeOn(ctx, tx, companyId, new Set(planIds)));
  if (!placed.length) return;
  ctx.bus.publish(companyId, { type: 'org' });
  /* Who sees an agent changes with the plan it runs on. */
  ctx.bus.accessChanged(companyId);
  await repinMoved(ctx, placed.map(agent => agent.id));
  /* Turns that waited for a plan can go now, with the tasks missed while there was none. */
  for (const agent of placed) {
    await resumeAgent(ctx, agent.id);
    await (agent.kind === 'orchestrator' ? pumpWaiting(ctx) : pump(ctx, agent.id));
  }
}

/* After a plan came: the people can still give it by hand, so a failure here does not fail what the person did. */
export async function tryPlaceWaiting(ctx: Ctx, companyId: string, planIds: readonly string[]): Promise<void> {
  await placeWaiting(ctx, companyId, planIds).catch((err: unknown) => ctx.log.error({ error: loggable(err) }, 'Placing the employees that wait for a subscription failed.'));
}
