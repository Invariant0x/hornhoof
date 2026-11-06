import { effortFor, ORCHESTRATOR_EFFORT, ROLE_EFFORTS } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import type { agents } from '../../db/schema.js';
import { wakesOfTurn } from '../tasks/wake-state.js';

/* The level of a turn that needs less thought than the work did. */
const LIGHTER = 'medium';
const ORDER: readonly string[] = [...ROLE_EFFORTS, 'ultra'];
const rank = (level: string): number => ORDER.indexOf(level);

type TurnWake = { why: string; again?: boolean; mechanical?: boolean };

/* A look again at the fixes for one's own finding, merging what passed its gates, or fixes the server marked as mechanical
   from the verdicts that asked for them. Anything else may need all the thought the work had: a plan, a first look,
   security, or fixes nobody marked. A merge that fails is reported, and what comes after that is no merge wake. */
const needsLess = (wake: TurnWake | null): boolean => wake?.why === 'merge' || (wake?.why === 'review' && wake.again === true) || (wake?.why === 'changes' && wake.mechanical === true);

/* How hard a turn thinks, from its base and every wake that brought its words. A lighter turn takes medium, or the nearest
   level above it that the model takes, and never raises the base. A model with no known levels is claimed to take none. */
export function turnEffort(base: string | null, efforts: readonly string[], wakes: readonly (TurnWake | null)[]): string | null {
  if (!wakes.length || !wakes.every(needsLess)) return base;
  const lighter = ORDER.slice(rank(LIGHTER)).find(level => efforts.includes(level));
  if (!lighter || (base !== null && rank(base) <= rank(lighter))) return base;
  return lighter;
}

/* Read once, as the turn goes out: the program takes its level when it starts, so a turn that runs keeps the one it has. */
export async function effortOfTurn(ctx: Ctx, agent: Pick<typeof agents.$inferSelect, 'id' | 'kind' | 'roleKey' | 'effort'>, efforts: string[], turns: readonly { id: string }[]): Promise<string | null> {
  const role = agent.roleKey ? ctx.templates.roles.get(agent.roleKey) : undefined;
  const base = effortFor(agent.effort, efforts, agent.kind === 'orchestrator' ? ORCHESTRATOR_EFFORT : role?.effort);
  const wakes = await Promise.all(turns.map(turn => wakesOfTurn(ctx.db, agent.id, turn.id)));
  return turnEffort(base, efforts, wakes.flat());
}
