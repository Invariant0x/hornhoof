import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { programOperatorCases, START_REASONS, type CaseReason } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
export const NODE: CaseReason = 'node_cannot_work';

/* What each node last said of its work folder: why it cannot write there, while it says so. A node says it again in each
   hello, so a server that starts anew hears it again. */
export const workErrors = new WeakMap<Ctx['hub'], Map<string, string>>();
export function workErrorsOf(ctx: Ctx): Map<string, string> {
  const known = workErrors.get(ctx.hub) ?? new Map<string, string>();
  workErrors.set(ctx.hub, known);
  return known;
}

/* Whether a failed turn ended before its program started under a hold: its words go on with it, so nothing else decides. */
export async function keptBeforeStart(ctx: Ctx, jobId: string): Promise<boolean> {
  const [kept] = await ctx.db.select(idOnly(programOperatorCases)).from(programOperatorCases)
    .where(and(inArray(programOperatorCases.reason, [...START_REASONS]), sql`${programOperatorCases.evidence} @> ${JSON.stringify([{ evidenceKey: jobId }])}::jsonb`)).limit(1);
  return Boolean(kept);
}

/* The nodes of these that cannot write their work folder, as they say or as a hold keeps: no turn goes to them meanwhile. */
export async function nodesOnHold(ctx: Ctx, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await ctx.db.selectDistinct({ id: programOperatorCases.nodeId }).from(programOperatorCases)
    .where(and(inArray(programOperatorCases.nodeId, ids), eq(programOperatorCases.reason, NODE), eq(programOperatorCases.recoveryHold, true)));
  const said = workErrorsOf(ctx);
  return new Set([...rows.map(row => row.id), ...ids.filter(id => said.has(id))]);
}
