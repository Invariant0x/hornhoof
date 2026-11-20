import type { OperatorError, OperatorRecoveryState } from '@hornhoof/protocol/program-operator';
import { and, eq, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { programOperatorCases } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';

type Case = typeof programOperatorCases.$inferSelect;

export function unavailableOperatorHold(row: Case): boolean {
  return row.recoveryHold && row.reason === 'assignment_unrecorded' && row.resolution?.outcome === 'operator_unavailable';
}

/* Only what the node sees right now counts. Manual release can also replace Hornhoof's own unsent words. */
export function recoveryScreenRefusal(state: OperatorRecoveryState | null, replaceHornhoofInput = false): OperatorError | null {
  if (!state) return 'node_unavailable';
  if (state.program === 'gone') return null;
  if (state.wait === 'protected') return 'protected_screen';
  if (state.wait) return 'input_not_proven';
  if (state.runningTool || state.retrying || state.busy) return 'program_busy';
  return state.input === 'empty' || (replaceHornhoofInput && state.input === 'hornhoof') ? null : 'input_not_proven';
}

export async function operatorRecoveryHolds(ctx: Ctx, agentId: string): Promise<boolean> {
  return recoveryHolds(ctx, eq(programOperatorCases.agentId, agentId));
}

export async function recoveryHolds(ctx: Ctx, scope: SQL): Promise<boolean> {
  const [held] = await ctx.db.select(idOnly(programOperatorCases)).from(programOperatorCases).where(and(scope, eq(programOperatorCases.recoveryHold, true))).limit(1);
  return Boolean(held);
}
