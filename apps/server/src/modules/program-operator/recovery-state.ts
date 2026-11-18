import { and, eq, type SQL } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { programOperatorCases } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
export async function operatorRecoveryHolds(ctx: Ctx, agentId: string): Promise<boolean> {
  return recoveryHolds(ctx, eq(programOperatorCases.agentId, agentId));
}

export async function recoveryHolds(ctx: Ctx, scope: SQL): Promise<boolean> {
  const [held] = await ctx.db.select(idOnly(programOperatorCases)).from(programOperatorCases).where(and(scope, eq(programOperatorCases.recoveryHold, true))).limit(1);
  return Boolean(held);
}
