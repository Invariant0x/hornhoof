import { modelsFor, type ModelOption, type ProviderId } from '@hornhoof/protocol';
import { modelCapability } from '../tasks/echelons-policy.js';
import type { Role } from '../templates/load.js';

type RoleTier = Role['tier'];

const WANTED: Readonly<Record<RoleTier, number>> = { top: 2, deep: 2, standard: 1, fast: 0 };
/* The strongest models cost the most to run, so only the top tier takes one while the plan runs another as strong. */
const COSTLIEST: ReadonlySet<string> = new Set(['fable', 'claude-fable-5-1']);

/* The model a role of this tier runs on a plan, by name: one of the tier's strength, else the nearest stronger, else the
   nearest weaker. None when the plan runs no model Hornhoof knows the strength of; the program's default is left then. */
export function modelForTier(tier: RoleTier, provider: string, models: readonly ModelOption[]): string | null {
  const known = models.flatMap(m => {
    const strength = modelCapability(m.id, provider);
    return strength === null ? [] : [{ id: m.id, strength }];
  });
  const stronger = known.filter(m => m.strength >= WANTED[tier]).sort((a, b) => a.strength - b.strength);
  const weaker = known.filter(m => m.strength < WANTED[tier]).sort((a, b) => b.strength - a.strength);
  const nearest = stronger[0] ?? weaker[0];
  if (!nearest) return null;
  const equal = known.filter(m => m.strength === nearest.strength);
  const costliest = (m: { id: string }) => COSTLIEST.has(m.id);
  return (equal.find(m => costliest(m) === (tier === 'top')) ?? equal[0]!).id;
}

/* The same on a plan as the database holds it, or the program's default when it names none. */
export const modelOnPlan = (tier: RoleTier, plan: { provider: ProviderId; models: ModelOption[] | null }): string =>
  modelForTier(tier, plan.provider, modelsFor(plan.provider, plan.models)) ?? '';

/* The strength an employee asks for where it works: its role's, and the strongest in a turnkey team, whose member does a
   task whole with nobody checking after. */
export const tierIn = (role: Pick<Role, 'tier'>, team: { turnkey: boolean } | null | undefined): RoleTier => (team?.turnkey ? 'top' : role.tier);
