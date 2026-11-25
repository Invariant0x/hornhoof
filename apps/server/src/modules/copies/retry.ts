import type { Ctx } from '../../app.js';
import { ApiError } from '../../errors.js';
import { gaveUpOf } from './measured.js';

/* The machines whose copy the CEO asked for again by hand, after their keeper gave it up. The leader keeps the request
   in memory and tells the keeper in its next order, until the keeper says it is making a copy again: a leader that
   restarts first forgets it, and the CEO asks once more. */
const asked = new WeakMap<Ctx, Set<string>>();

const notGivenUp = () => new ApiError(409, 'conflict', "This machine's copy was not given up.", 'copy_not_given_up');

/* Asks for a new copy of a machine whose keeper said it gave its copy up. */
export function askCopyRetry(ctx: Ctx, machineId: string): void {
  if (!gaveUpOf(ctx, machineId)) throw notGivenUp();
  const known = asked.get(ctx) ?? new Set<string>();
  known.add(machineId);
  asked.set(ctx, known);
}

/* Whether the CEO asked for this machine's copy again and its keeper has not taken that up yet. */
export const copyRetryAsked = (ctx: Ctx, machineId: string): boolean => asked.get(ctx)?.has(machineId) === true;

/* The keeper's word that its copy is not given up any more, or that the machine has none. */
export function copyRetryTaken(ctx: Ctx, machineId: string): void {
  asked.get(ctx)?.delete(machineId);
}
