import { and, asc, desc, eq, gt, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { jobs, programOperatorCases } from '../../db/schema.js';
import { GONE_ALONG } from '../conversation/constants.js';

type Case = typeof programOperatorCases.$inferSelect;

/* What Hornhoof itself concludes, and says the same way each time. What an operator reports has its own words. */
const REPEATING = new Set(['operator_unavailable', 'operator_timeout']);
/* A failure long after the last one is news again, even though no turn worked in between. */
const RUN_MS = 24 * 60 * 60_000;

/* When the agent's last turn with words ended well. */
async function lastGoodTurn(ctx: Ctx, agentId: string): Promise<Date | null> {
  const [good] = await ctx.db.select({ at: jobs.finishedAt }).from(jobs)
    .where(and(eq(jobs.agentId, agentId), eq(jobs.kind, 'conversation'), eq(jobs.status, 'done'), ne(jobs.prompt, ''), isNotNull(jobs.finishedAt), or(isNull(jobs.result), ne(jobs.result, GONE_ALONG))))
    .orderBy(desc(jobs.finishedAt)).limit(1);
  return good?.at ?? null;
}

/* Cases escalated for this agent and reason since its last good turn. */
async function runScope(ctx: Ctx, row: Case, at: Date) {
  const since = await lastGoodTurn(ctx, row.agentId);
  const window = new Date(Math.max(+at - RUN_MS, +(since ?? 0)));
  return and(eq(programOperatorCases.agentId, row.agentId), eq(programOperatorCases.reason, row.reason), eq(programOperatorCases.status, 'escalated'), ne(programOperatorCases.id, row.id), gt(programOperatorCases.escalatedAt, window));
}

/* The case that opened this run with the same outcome: its one escalation speaks for this one. */
export async function firstOfRun(ctx: Ctx, row: Case): Promise<Case | null> {
  const outcome = row.resolution?.outcome, at = row.escalatedAt;
  if (!outcome || !at || !REPEATING.has(outcome)) return null;
  const earlier = or(lt(programOperatorCases.escalatedAt, at), and(eq(programOperatorCases.escalatedAt, at), lt(programOperatorCases.id, row.id)));
  const [first] = await ctx.db.select().from(programOperatorCases)
    .where(and(await runScope(ctx, row, at), earlier, sql`${programOperatorCases.resolution}->>'outcome' = ${outcome}`,
      outcome === 'operator_unavailable' ? eq(programOperatorCases.recoveryHold, false) : undefined))
    .orderBy(asc(programOperatorCases.escalatedAt), asc(programOperatorCases.id)).limit(1);
  return first ?? null;
}

/* What became of an operator that already tried these words in this run: asking it again would change nothing. */
export async function outcomeOfOperatorTry(ctx: Ctx, row: Case, now: Date): Promise<string | null> {
  if (row.reason !== 'assignment_unrecorded') return null;
  const [tried] = await ctx.db.select({ outcome: sql<string>`${programOperatorCases.resolution}->>'outcome'` }).from(programOperatorCases)
    .where(and(await runScope(ctx, row, now), isNotNull(programOperatorCases.operatorAgentId)))
    .orderBy(asc(programOperatorCases.escalatedAt)).limit(1);
  return tried && REPEATING.has(tried.outcome) ? tried.outcome : null;
}
