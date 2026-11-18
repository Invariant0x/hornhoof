import { inLane } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
/* One thing at a time per agent, so two pumps never send two turns. */
export const chains = new WeakMap<Ctx, Map<string, Promise<unknown>>>();

export function onAgent<T>(ctx: Ctx, agentId: string, fn: () => Promise<T>): Promise<T> {
  const mine = chains.get(ctx) ?? new Map<string, Promise<unknown>>();
  chains.set(ctx, mine);
  return inLane(mine, agentId, fn);
}
