import type { Failure } from '@hornhoof/protocol';
import type { TurnRetry } from '@hornhoof/protocol/map';
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { STOPPED_ON_PURPOSE } from '../conversation/constants.js';
export const RETRY_MINUTES = [1, 2, 5, 10];
export type Job = typeof jobs.$inferSelect;
export type LastFailure = { kind: Failure['kind']; text: string; at: number; tail: string };
export type LastObsolete = { at: number };
export type FailureState = { retry: TurnRetry | null; failure: LastFailure | null; obsolete: LastObsolete | null };

export const passing = (f: Failure | null) => !!f && (['overloaded', 'network', 'cut', 'rate_limited', 'tools'].includes(f.kind) || (f.kind === 'unknown' && f.retryable));

/* Count only this continuation's unbroken chain, never an unrelated turn of the same agent. */
export async function passingAttempts(ctx: Ctx, job: Job, history?: ReadonlyMap<string, Job>, counted: (f: Failure | null) => boolean = passing): Promise<number> {
  let n = 0;
  let current: Job | undefined = job;
  while (current?.status === 'failed' && counted(current.failure)) {
    n++;
    if (!current.continueOf) break;
    if (history) current = history.get(current.continueOf);
    else [current] = await ctx.db.select().from(jobs).where(eq(jobs.id, current.continueOf));
  }
  return n;
}

export async function agentFailureState(ctx: Ctx, agentId: string): Promise<FailureState> {
  const [agent] = await ctx.db.select(only(agents, 'companyId')).from(agents).where(eq(agents.id, agentId));
  return agent ? (await agentFailureStates(ctx, agent.companyId, [agentId])).get(agentId)! : { retry: null, failure: null, obsolete: null };
}

/* Read the company together; only waiting retries need their continuation history. */
export async function agentFailureStates(ctx: Ctx, companyId: string, agentIds: string[]): Promise<Map<string, FailureState>> {
  if (!agentIds.length) return new Map();
  const scope = and(eq(jobs.companyId, companyId), inArray(jobs.agentId, agentIds), eq(jobs.kind, 'conversation'));
  const last = await ctx.db.selectDistinctOn([jobs.agentId]).from(jobs)
    .where(and(scope, inArray(jobs.status, ['done', 'failed']), or(isNull(jobs.error), notInArray(jobs.error, NO_FAILURE))))
    .orderBy(asc(jobs.agentId), desc(sql`coalesce(${jobs.finishedAt}, ${jobs.createdAt})`), desc(jobs.createdAt));
  const waiting = await ctx.db.selectDistinctOn([jobs.agentId]).from(jobs).where(and(scope, eq(jobs.status, 'queued'), isNotNull(jobs.notBefore), isNotNull(jobs.continueOf)))
    .orderBy(asc(jobs.agentId), asc(jobs.createdAt));
  const obsoleteTurns = await ctx.db.selectDistinctOn([jobs.agentId]).from(jobs)
    .where(and(scope, eq(jobs.status, 'obsolete'))).orderBy(asc(jobs.agentId), desc(sql`coalesce(${jobs.finishedAt}, ${jobs.createdAt})`), desc(jobs.createdAt));
  const history = await retryHistory(ctx, companyId, waiting);
  const goesOn = await continuedTurns(ctx.db, companyId, last);
  const failures = new Map(last.map(j => [j.agentId, j]));
  const retries = new Map(waiting.map(j => [j.agentId, j]));
  const obsoletes = new Map(obsoleteTurns.map(j => [j.agentId, j]));
  return new Map(await Promise.all(agentIds.map(async id => {
    const ended = failures.get(id);
    const next = retries.get(id);
    const obsolete = obsoletes.get(id);
    const before = next?.continueOf ? history.get(next.continueOf) : undefined;
    const retry = before?.failure && passing(before.failure)
      ? { attempt: await passingAttempts(ctx, before, history), max: RETRY_MINUTES.length, at: Number(next?.notBefore), kind: before.failure.kind } : null;
    const failure = failureShown(ended, goesOn);
    return [id, { retry, failure, obsolete: obsolete ? { at: +(obsolete.finishedAt === null ? obsolete.createdAt : obsolete.finishedAt) } : null }] as const;
  })));
}

/* A turn stopped on purpose, or one whose task moved on while it ran, so that a newer turn took its place: no failure. */
export const NO_FAILURE = [...STOPPED_ON_PURPOSE, 'stale'];
/* A failed turn that waits for the plan's owner to sign in or pass the first setup needs that person; any other failed turn
   with its continuation queued goes on by itself, as after an overloaded provider or a usage limit, and is no failure. */
const NEEDS_OWNER = new Set<Failure['kind']>(['auth', 'setup']);

/* The failed turns of those that ended whose continuation waits to go on, or runs. */
async function continuedTurns(db: Ctx['db'], companyId: string, ended: Pick<Job, 'id' | 'status'>[]): Promise<Set<string>> {
  const failed = ended.filter(j => j.status === 'failed').map(j => j.id);
  if (!failed.length) return new Set();
  const next = await db.select({ of: jobs.continueOf }).from(jobs)
    .where(and(eq(jobs.companyId, companyId), inArray(jobs.continueOf, failed), inArray(jobs.status, ['queued', 'running'])));
  return new Set(next.flatMap(j => (j.of ? [j.of] : [])));
}

/* A turn that ended failed in a way that needs a person or a head: not stopped on purpose, not replaced, and not one that goes
   on by itself. */
export const turnFailed = (job: Pick<Job, 'id' | 'status' | 'error' | 'failure'>, continued: ReadonlySet<string>): boolean =>
  job.status === 'failed' && !!job.failure && !NO_FAILURE.includes(job.error ?? '') && (!continued.has(job.id) || NEEDS_OWNER.has(job.failure.kind));

/* The failure an agent's card shows: its last ended turn's, when that turn failed in a way that needs someone. */
const failureShown = (ended: Job | undefined, continued: ReadonlySet<string>): LastFailure | null => (ended && turnFailed(ended, continued) ? lastFailureOf(ended) : null);

export function lastFailureOf(ended: Job | undefined): LastFailure | null {
  if (ended?.status !== 'failed' || !ended.failure) return null;
  return { kind: ended.failure.kind, text: ended.failure.text, at: +(ended.finishedAt === null ? ended.createdAt : ended.finishedAt), tail: ended.tail };
}

export async function retryHistory(ctx: Ctx, companyId: string, waiting: Job[]): Promise<Map<string, Job>> {
  const ids = waiting.flatMap(j => j.continueOf ? [j.continueOf] : []);
  if (!ids.length) return new Map();
  const history = await ctx.db.select().from(jobs).where(inArray(jobs.id, sql`(
    with recursive history as (
      select id, continue_of from jobs where company_id = ${companyId} and ${inArray(jobs.id, ids)}
      union
      select parent.id, parent.continue_of from jobs parent join history child on parent.id = child.continue_of where parent.company_id = ${companyId}
    ) select id from history
  )`));
  return new Map(history.map(j => [j.id, j]));
}
