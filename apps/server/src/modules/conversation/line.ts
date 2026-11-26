import { inLane } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
/* One thing at a time per agent, so two pumps never send two turns. */
const subscriptionChains = new WeakMap<Ctx, Map<string, Promise<unknown>>>();

export function onSubscription<T>(ctx: Ctx, subscriptionId: string, fn: () => Promise<T>): Promise<T> {
  const lanes = subscriptionChains.get(ctx) ?? new Map<string, Promise<unknown>>();
  subscriptionChains.set(ctx, lanes);
  return inLane(lanes, subscriptionId, fn);
}

export const chains = new WeakMap<Ctx, Map<string, Promise<unknown>>>();

export function onAgent<T>(ctx: Ctx, agentId: string, fn: () => Promise<T>): Promise<T> {
  const mine = chains.get(ctx) ?? new Map<string, Promise<unknown>>();
  chains.set(ctx, mine);
  return inLane(mine, agentId, fn);
}
