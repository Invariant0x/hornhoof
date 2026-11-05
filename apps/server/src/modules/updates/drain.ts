import type { Ctx } from '../../app.js';
export { nodeDrain, nodeHeld, nodeHeldFrom, machineDrain } from './node-drain.js';

/* Companies whose update waits for their agents to finish: no new turn starts there meanwhile, so the turns that run
   end and the update can go in. The orchestrator still answers people. */
const held = new WeakMap<Ctx, Set<string>>();

export function holdTurns(ctx: Ctx, companyId: string, on: boolean): void {
  const companies = held.get(ctx) ?? new Set<string>();
  held.set(ctx, companies);
  if (on) companies.add(companyId);
  else companies.delete(companyId);
}

export const turnsHeld = (ctx: Ctx, companyId: string): boolean => held.get(ctx)?.has(companyId) ?? false;
