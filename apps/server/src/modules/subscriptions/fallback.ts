import { modelsFor } from '@hornhoof/protocol';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agentSpot } from '../../auth/access.js';
import { agentChanges, agentEvents, agentFallbacks, agents, people, subscriptions, teams, type PlanFallback } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import { releaseLeftProgram } from '../agents/left-programs.js';
import { modelOnPlan, tierIn } from '../agents/role-model.js';
import { budgetUntil, enqueueTurn, insertTurn, limitUntil, orchestratorOf, planHeld, planWaitsFor, pump } from '../conversation/queue.js';
import { orchestratorServing, runsTier, servingSubscriptions } from '../tools/staff.js';

/* Hornhoof's own doing: no person decided it and the orchestrator did not act for one. */
const HORNHOOF = { personId: null, byOrchestrator: false };
/* How long after a plan's window starts over its employees come back, so its program sees the new limit first. */
const BACK_GRACE_MS = 5_000;
const LONGEST_TIMER_MS = 2 ** 31 - 1;

type Agent = typeof agents.$inferSelect;
type Plan = typeof subscriptions.$inferSelect;
type Fallback = typeof agentFallbacks.$inferSelect;
type Target = { plan: Plan; model: string | null };

/* Until when the plan holds this employee's turns back: at its limit, or a worker's past the share set for tasks. Heads and
   the orchestrator keep coordinating work above that share, so it holds none of theirs. */
export function heldUntil(plan: Pick<Plan, 'limits' | 'limitsUpdatedAt' | 'budget'>, kind: string): string | null {
  return limitUntil(plan.limits, plan.limitsUpdatedAt) ?? (kind === 'worker' ? budgetUntil(plan.limits, plan.budget, plan.limitsUpdatedAt) : null);
}

async function planOf(ctx: Ctx, id: string): Promise<Plan | null> {
  const [plan] = await ctx.db.select().from(subscriptions).where(and(eq(subscriptions.id, id), isNull(subscriptions.removedAt)));
  return plan ?? null;
}

/* The strength the employee's role asks for where it works; none for the orchestrator, which keeps its model. */
async function tierOf(ctx: Ctx, agent: Agent) {
  if (agent.kind === 'orchestrator') return null;
  const role = agent.roleKey ? ctx.templates.roles.get(agent.roleKey) : undefined;
  const [team] = agent.teamId ? await ctx.db.select({ turnkey: teams.turnkey }).from(teams).where(eq(teams.id, agent.teamId)) : [];
  return tierIn(role ?? { tier: 'standard' }, team);
}

/* The plans the employee may go on to from its own, in order: those named for that plan, else every personal plan of the
   company that may serve it, oldest first. An API key is paid by the token, so it takes them only where a person named it.
   Only plans that serve where it works and run its role's strength count. */
async function fallbacksOf(ctx: Ctx, agent: Agent, home: Plan): Promise<Target[]> {
  const serving = agent.kind === 'orchestrator' ? await orchestratorServing(ctx, agent.companyId) : await servingSubscriptions(ctx, agent.companyId, await agentSpot(ctx.db, agent));
  const tier = await tierOf(ctx, agent);
  const may = new Set(serving.filter(s => tier === null || runsTier(s.provider, tier)).map(s => s.id));
  const named: PlanFallback[] = home.fallbacks.length ? home.fallbacks : serving.filter(s => s.kind === 'personal').map(s => ({ subscription: s.id, model: null }));
  const out: Target[] = [];
  for (const entry of named) {
    if (entry.subscription === home.id || !may.has(entry.subscription)) continue;
    const plan = await planOf(ctx, entry.subscription);
    if (plan) out.push({ plan, model: entry.model });
  }
  return out;
}

/* A plan takes the employee's turns now: signed in, a machine of it there, and nothing of it holds them back. */
async function hasRoom(ctx: Ctx, agent: Agent, plan: Plan): Promise<boolean> {
  return plan.status === 'ready' && !heldUntil(plan, agent.kind) && (await planWaitsFor(ctx, agent, plan)) === null;
}

async function firstWithRoom(ctx: Ctx, agent: Agent, home: Plan, now: string | null): Promise<Target | null> {
  for (const target of await fallbacksOf(ctx, agent, home)) if (target.plan.id !== now && (await hasRoom(ctx, agent, target.plan))) return target;
  return null;
}

/* The model it runs there: the one named for that fallback, its own on a plan of its own plan's program, else the one its
   role asks for there. How hard it thinks goes back to the default on another program, which names its levels its own way. */
async function runsOn(ctx: Ctx, agent: Agent, home: Plan, back: { model: string; effort: string | null }, target: Target) {
  const models = modelsFor(target.plan.provider, target.plan.models);
  if (target.model && models.some(m => m.id === target.model)) return { model: target.model, effort: target.plan.provider === home.provider ? back.effort : null };
  if (target.plan.provider === home.provider) return back;
  const tier = await tierOf(ctx, agent);
  return { model: tier ? modelOnPlan(tier, target.plan) : back.model, effort: null };
}

/* One row per changed field of its card, as a person's change of it leaves, with Hornhoof as the one who changed it. */
function changesOf(agent: Agent, next: { subscriptionId: string; model: string; effort: string | null }) {
  return [
    { field: 'subscription' as const, before: agent.subscriptionId, after: next.subscriptionId },
    ...(next.model !== agent.model ? [{ field: 'model' as const, before: agent.model, after: next.model }] : []),
    ...(next.effort !== agent.effort ? [{ field: 'effort' as const, before: agent.effort, after: next.effort }] : []),
  ].map(change => ({ companyId: agent.companyId, agentId: agent.id, ...HORNHOOF, ...change }));
}

/* Moves the employee, if it is still where it was, and leaves its program on the plan it left for that plan's node to close. */
async function moveAgent(ctx: Ctx, agent: Agent, next: { subscriptionId: string; model: string; effort: string | null }, keep: (tx: Parameters<Parameters<Ctx['db']['transaction']>[0]>[0]) => Promise<unknown>): Promise<boolean> {
  const moved = await ctx.db.transaction(async tx => {
    const [row] = await tx.update(agents).set(next).where(and(eq(agents.id, agent.id), eq(agents.subscriptionId, agent.subscriptionId!))).returning({ id: agents.id });
    if (!row) return false;
    await keep(tx);
    await tx.insert(agentChanges).values(changesOf(agent, next));
    return true;
  });
  if (!moved) return false;
  await releaseLeftProgram(ctx, agent.id, agent.subscriptionId!);
  ctx.bus.publish(agent.companyId, { type: 'org' });
  /* Who sees an agent changes with the plan it runs on. */
  ctx.bus.accessChanged(agent.companyId);
  return true;
}

async function goOn(ctx: Ctx, agent: Agent, home: Plan, kept: Fallback | null, target: Target): Promise<boolean> {
  const back = kept ? { model: kept.homeModel, effort: kept.homeEffort } : { model: agent.model, effort: agent.effort };
  const next = { subscriptionId: target.plan.id, ...(await runsOn(ctx, agent, home, back, target)) };
  return moveAgent(ctx, agent, next, tx =>
    kept
      ? tx.update(agentFallbacks).set({ subscriptionId: target.plan.id }).where(eq(agentFallbacks.agentId, agent.id))
      : tx.insert(agentFallbacks).values({ agentId: agent.id, companyId: agent.companyId, homeSubscriptionId: home.id, homeModel: agent.model, homeEffort: agent.effort, subscriptionId: target.plan.id }),
  );
}

function goHome(ctx: Ctx, agent: Agent, kept: Fallback): Promise<boolean> {
  return moveAgent(ctx, agent, { subscriptionId: kept.homeSubscriptionId, model: kept.homeModel, effort: kept.homeEffort }, tx => tx.delete(agentFallbacks).where(eq(agentFallbacks.agentId, agent.id)));
}

/* Wakes the employee's line once its own plan's window starts over, so it comes back between turns even with no turn to go. */
const backTimers = new WeakMap<Ctx, Map<string, { at: string; timer: NodeJS.Timeout }>>();
function comeBackAt(ctx: Ctx, agentId: string, at: string): void {
  const timers = backTimers.get(ctx) ?? new Map<string, { at: string; timer: NodeJS.Timeout }>();
  backTimers.set(ctx, timers);
  if (timers.get(agentId)?.at === at) return;
  clearTimeout(timers.get(agentId)?.timer);
  const wait = Date.parse(at) - Date.now() + BACK_GRACE_MS;
  const timer = setTimeout(() => {
    timers.delete(agentId);
    if (wait > LONGEST_TIMER_MS) return comeBackAt(ctx, agentId, at);
    void pump(ctx, agentId).catch((err: unknown) => ctx.log.error({ error: loggable(err) }, 'An employee on a fallback plan could not come back.'));
  }, Math.min(Math.max(wait, 0), LONGEST_TIMER_MS));
  timer.unref();
  timers.set(agentId, { at, timer });
}

/* A provider gives the same reset with other milliseconds each time it is asked: the hold is the same one to the minute. */
const holdMinute = (until: string) => {
  const at = Date.parse(until);
  return Number.isNaN(at) ? until : new Date(Math.round(at / 60_000) * 60_000).toISOString();
};

/* Who on the plan its hold stops with no fallback that has room for them. */
async function stuckOn(ctx: Ctx, home: Plan): Promise<Agent[]> {
  const on = await ctx.db.select().from(agents).where(and(eq(agents.subscriptionId, home.id), isNull(agents.removedAt), isNull(agents.switchedOffAt), ne(agents.kind, 'assistant'))).orderBy(asc(agents.createdAt));
  const stuck: Agent[] = [];
  for (const agent of on) if ((await planHeld(ctx, agent, home)) && !(await firstWithRoom(ctx, agent, home, null))) stuck.push(agent);
  return stuck;
}

function noRoomText(home: Plan & { ownerName: string }, until: string, stuck: Agent[]): string {
  const why = limitUntil(home.limits, home.limitsUpdatedAt) ? 'is at its usage limit' : 'used the share set for tasks';
  return (
    `Hornhoof: the plan ${home.label} (${home.ownerName}) ${why} until ${until}, and no fallback plan has room for its employees, so their work waits: ${stuck.map(a => a.name).join(', ')}. ` +
    'Give the plan a fallback with room on the Subscriptions screen, connect another plan, or move them to another plan on their cards. They go back to their own plan once its window starts over.'
  );
}

/* The orchestrator can read it now: its own plan takes its turns. One held on a plan with no fallback hears nothing it could
   read only once the limit is over; the notice to Operations of a turn held that long stands for it. */
async function readsNow(ctx: Ctx, orchestrator: Agent): Promise<boolean> {
  const plan = orchestrator.subscriptionId ? await planOf(ctx, orchestrator.subscriptionId) : null;
  return Boolean(plan && !heldUntil(plan, orchestrator.kind));
}

/* The orchestrator hears once of a plan whose hold stops work that no fallback can take: once for each hold, by its reset. */
const told = new WeakMap<Ctx, Set<string>>();
async function tellNoRoom(ctx: Ctx, home: Plan, until: string, from: Agent): Promise<void> {
  const caseId = `plan-fallback:${home.id}:${holdMinute(until)}`;
  const seen = told.get(ctx) ?? new Set<string>();
  told.set(ctx, seen);
  if (seen.has(caseId)) return;
  const orchestrator = await orchestratorOf(ctx, home.companyId);
  if (!orchestrator || orchestrator.removedAt || !(await readsNow(ctx, orchestrator))) return;
  seen.add(caseId);
  const [before] = await ctx.db.select({ id: agentEvents.id }).from(agentEvents).where(sql`${agentEvents.data}->>'failureCase' = ${caseId}`).limit(1);
  const stuck = before ? [] : await stuckOn(ctx, home);
  if (!stuck.length) return;
  const [owner] = await ctx.db.select({ name: people.name }).from(people).where(eq(people.id, home.ownerPersonId));
  const text = noRoomText({ ...home, ownerName: owner?.name ?? '' }, until, stuck);
  const turn = { companyId: home.companyId, agentId: orchestrator.id, prompt: text, createdBy: null, message: { personId: null, text, failureCase: caseId, notification: { source: 'limit' as const, tasks: [], detail: { en: home.label, ru: home.label } } } };
  /* The orchestrator's own line goes on as it is: it takes the message once the turn it is in goes out. */
  await (orchestrator.id === from.id ? insertTurn(ctx, turn) : enqueueTurn(ctx, turn));
}

/* Between turns: an employee whose plan holds its turns back goes on to the first fallback with room for it, its tasks and
   its waiting turns with it, and comes back to its own plan, model and effort once that plan takes its turns again. A
   person who moved it by hand in between decided where it works, so it stays there. True when it moved. */
export async function fallbackMove(ctx: Ctx, agentId: string): Promise<boolean> {
  const [agent] = await ctx.db.select().from(agents).where(and(eq(agents.id, agentId), isNull(agents.removedAt)));
  if (!agent?.subscriptionId || agent.kind === 'assistant' || agent.switchedOffAt) return false;
  const [kept] = await ctx.db.select().from(agentFallbacks).where(eq(agentFallbacks.agentId, agentId));
  const home = await planOf(ctx, kept?.homeSubscriptionId ?? agent.subscriptionId);
  if (kept && (kept.subscriptionId !== agent.subscriptionId || !home)) {
    await ctx.db.delete(agentFallbacks).where(eq(agentFallbacks.agentId, agentId));
    return false;
  }
  if (!home) return false;
  const until = heldUntil(home, agent.kind);
  if (kept && !until) return (await hasRoom(ctx, agent, home)) && goHome(ctx, agent, kept);
  if (!until) return false;
  if (kept) comeBackAt(ctx, agentId, until);
  const now = kept ? await planOf(ctx, kept.subscriptionId) : null;
  if (now && (await hasRoom(ctx, agent, now))) return false;
  const target = await firstWithRoom(ctx, agent, home, now?.id ?? null);
  /* Only work the plan really holds back waits: a person's own message still goes past the share set for tasks. */
  if (!target) {
    if (await planHeld(ctx, agent, home)) await tellNoRoom(ctx, home, until, agent);
    return false;
  }
  const moved = await goOn(ctx, agent, home, kept ?? null, target);
  if (moved) comeBackAt(ctx, agentId, until);
  return moved;
}

/* A plan that came to its limit or its share for tasks: everyone on it goes on to a fallback at once, except whoever is in a
   turn now, who goes once that turn ends. */
export async function fallBackFrom(ctx: Ctx, planId: string): Promise<void> {
  const on = await ctx.db.select({ id: agents.id }).from(agents).where(and(eq(agents.subscriptionId, planId), isNull(agents.removedAt), ne(agents.kind, 'assistant'))).orderBy(asc(agents.createdAt));
  for (const { id } of on) await pump(ctx, id);
}

/* Each round of the reconciler: whoever is on a fallback while its own plan takes its turns again comes back between turns,
   also when the wake set for that was lost with a restart of the server. */
export async function settleFallbacks(ctx: Ctx): Promise<void> {
  const away = await ctx.db.select({ agentId: agentFallbacks.agentId, kind: agents.kind, home: subscriptions }).from(agentFallbacks)
    .innerJoin(agents, eq(agents.id, agentFallbacks.agentId)).innerJoin(subscriptions, eq(subscriptions.id, agentFallbacks.homeSubscriptionId));
  for (const { agentId, kind, home } of away) if (home.removedAt || !heldUntil(home, kind)) await pump(ctx, agentId);
}

/* The fallback an employee is on, for its card: its own plan and when that plan's hold ends, as far as it is known now. */
export async function fallbackOf(ctx: Ctx, agent: Pick<Agent, 'id' | 'kind' | 'subscriptionId'>): Promise<{ home: string; until: string | null } | null> {
  const [kept] = await ctx.db.select().from(agentFallbacks).where(eq(agentFallbacks.agentId, agent.id));
  if (!kept || kept.subscriptionId !== agent.subscriptionId) return null;
  const home = await planOf(ctx, kept.homeSubscriptionId);
  return home ? { home: home.id, until: heldUntil(home, agent.kind) } : null;
}

/* An employee a person moved by hand stays where they put it. */
export async function endFallback(ctx: Pick<Ctx, 'db'>, agentId: string): Promise<void> {
  await ctx.db.delete(agentFallbacks).where(eq(agentFallbacks.agentId, agentId));
}
