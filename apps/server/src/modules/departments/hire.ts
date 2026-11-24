import { languageOfText, SOURCE_LOCALE } from '@hornhoof/protocol';
import { pickNextWorldEraName, type WorldNameLanguage } from '@hornhoof/protocol/world';
import type { Ctx } from '../../app.js';
import { and, eq, isNull, ne } from 'drizzle-orm';
import { agentChanges, agents, companies, subscriptions, teams } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { modelOnPlan, tierIn } from '../agents/role-model.js';
import type { Tx } from '../tasks/state.js';
import type { Role } from '../templates/load.js';
import type { HireLine } from '../tools/staff.js';
import { defaultWorldPacks, worldPackForTheme } from '../world/packs/index.js';

export type Hired = { id: string; name: string; role: string; title: string };

/* Who a hire is by: a person, the orchestrator for one, or Hornhoof itself, which is neither. */
export type HiredBy = { personId: string | null; byOrchestrator: boolean; actingAgentId?: string | null };


/* True when a hire line carries a generated default role title (or numbered/parenthesized variant)
   rather than a custom manual name typed by a person. */
function isDefaultRoleName(name: string, role: Role): boolean {
  const clean = name.trim().toLowerCase();
  for (const title of Object.values(role.title).map(text => (text ?? '').trim().toLowerCase())) {
    if (!title) continue;
    if (clean === title) return true;
    if (clean.startsWith(`${title} (`)) return true;
    if (/^\s+\d+(\s+\(.*\))?$/.test(clean.slice(title.length)) && clean.startsWith(title)) return true;
  }
  return false;
}

/* Resolves an era name for newly hired agents when a company world pack is active and no manual name was given. */
async function resolveHireName(
  ctx: Pick<Ctx, 'templates'> & Partial<Pick<Ctx, 'worldPacks'>>,
  tx: Tx,
  companyId: string,
  role: Role,
  requestedName: string,
): Promise<string> {
  if (!isDefaultRoleName(requestedName, role)) return requestedName;
  const [company] = await tx.select({ theme: companies.theme }).from(companies).where(eq(companies.id, companyId));
  const pack = worldPackForTheme(ctx.worldPacks ?? defaultWorldPacks(), company?.theme);
  if (!pack) return requestedName;

  const existing = await tx
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), isNull(agents.removedAt), ne(agents.kind, 'assistant')));
  const existingNames = existing.map(row => row.name);
  const lang: WorldNameLanguage = languageOfText(requestedName) ?? languageOfText(existingNames.join(' ')) ?? SOURCE_LOCALE;
  return pickNextWorldEraName(pack, lang, existingNames, role.kind === 'head' ? 'head' : 'worker');
}

/* A hire that names no model runs the one its role's tier asks for on its plan, by name, and the strongest in a turnkey
   team: the stages of a task's route take only a model they know. With no plan yet it stays the program's default until it gets one. */
async function modelByRole(tx: Tx, tier: Parameters<typeof modelOnPlan>[0], subscriptionId: string | null): Promise<string> {
  const [plan] = subscriptionId ? await tx.select({ provider: subscriptions.provider, models: subscriptions.models }).from(subscriptions).where(eq(subscriptions.id, subscriptionId)) : [];
  return plan ? modelOnPlan(tier, plan) : '';
}

/* One employee joins a department, with its role's kind, template hashes and timer, and a record of who hired it. */
export async function hireEmployee(
  ctx: Pick<Ctx, 'templates'> & Partial<Pick<Ctx, 'worldPacks'>>,
  tx: Tx,
  place: { companyId: string; departmentId: string },
  asked: HireLine,
  by: HiredBy,
): Promise<Hired> {
  const role = ctx.templates.roles.get(asked.role)!;
  const [team] = asked.team ? await tx.select(only(teams, 'turnkey')).from(teams).where(eq(teams.id, asked.team)) : [];
  const name = await resolveHireName(ctx, tx, place.companyId, role, asked.name);
  const line = { ...asked, name, model: asked.model || await modelByRole(tx, tierIn(role, team), asked.subscription) };
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
  await tx.insert(agentChanges).values({ companyId: place.companyId, agentId: agent!.id, ...by, field: 'hired', before: null, after: line });
  return { id: agent!.id, name: line.name, role: role.id, title: role.title.en };
}
