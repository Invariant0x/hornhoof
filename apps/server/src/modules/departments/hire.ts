import { MAX_INSTRUCTIONS } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import { eq } from 'drizzle-orm';
import { agentChanges, agents, subscriptions, teams } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { ApiError } from '../../errors.js';
import { placeOf, renderInstructions } from '../agents/instructions.js';
import { modelOnPlan, tierIn } from '../agents/role-model.js';
import type { Tx } from '../tasks/engine.js';
import type { HireLine } from '../tools/staff.js';

export type Hired = { id: string; name: string; role: string; title: string };

/* Who a hire is by: a person, the orchestrator for one, or Hornhoof itself, which is neither. */
export type HiredBy = { personId: string | null; byOrchestrator: boolean };

/* A hire that names no model runs the one its role's tier asks for on its plan, by name, and the strongest in a turnkey
   team: the stages of a task's route take only a model they know. With no plan yet it stays the program's default until it gets one. */
async function modelByRole(tx: Tx, tier: Parameters<typeof modelOnPlan>[0], subscriptionId: string | null): Promise<string> {
  const [plan] = subscriptionId ? await tx.select({ provider: subscriptions.provider, models: subscriptions.models }).from(subscriptions).where(eq(subscriptions.id, subscriptionId)) : [];
  return plan ? modelOnPlan(tier, plan) : '';
}

/* One employee joins a department, with its role's kind, template hashes and timer, and a record of who hired it. */
export async function hireEmployee(ctx: Pick<Ctx, 'templates'>, tx: Tx, place: { companyId: string; departmentId: string }, asked: HireLine, by: HiredBy): Promise<Hired> {
  const role = ctx.templates.roles.get(asked.role)!;
  const [team] = asked.team ? await tx.select(only(teams, 'turnkey')).from(teams).where(eq(teams.id, asked.team)) : [];
  const line = { ...asked, model: asked.model || await modelByRole(tx, tierIn(role, team), asked.subscription) };
  const hashes = Object.fromEntries([[role.id, role.hash], ...line.skills.map(id => [id, ctx.templates.skills.get(id)!.hash])]);
  const [agent] = await tx
    .insert(agents)
    .values({
      companyId: place.companyId,
      kind: role.kind === 'head' ? 'head' : 'worker',
      name: line.name,
      model: line.model,
      departmentId: place.departmentId,
      productId: line.product,
      teamId: line.team,
      subscriptionId: line.subscription,
      roleKey: role.id,
      skills: line.skills,
      templateHashes: hashes,
      /* A role that watches the company wakes on its timer from the hire on. */
      ...(role.timer ? { timerMinutes: role.timer.minutes, timerOrder: role.timer.order, timerForWork: role.timer.forWork, timerAt: new Date() } : {}),
      createdBy: by.personId,
    })
    .returning();
  /* A turn carries the instructions whole, so a hire whose skills make them too long would never run. A head's
     notebook has room of its own on top, as on the employee's card. */
  if (renderInstructions(ctx.templates, agent!, await placeOf(tx, agent!)).text.length > MAX_INSTRUCTIONS) {
    throw new ApiError(400, 'validation', `${line.name}'s instructions would be longer than ${MAX_INSTRUCTIONS} characters. Turn some skills off.`, 'instructions_too_long');
  }
  await tx.insert(agentChanges).values({ companyId: place.companyId, agentId: agent!.id, ...by, field: 'hired', before: null, after: line });
  return { id: agent!.id, name: line.name, role: role.id, title: role.title.en };
}
