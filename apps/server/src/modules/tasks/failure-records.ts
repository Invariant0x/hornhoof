import type { Failure } from '@hornhoof/protocol';
import type { TurnRetry } from '@hornhoof/protocol/map';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { agents, jobs } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { STOPPED_ON_PURPOSE } from '../conversation/constants.js';
export const RETRY_MINUTES = [1, 2, 5, 10];
export type Job = typeof jobs.$inferSelect;
export type LastFailure = { kind: Failure['kind']; text: string; at: number; tail: string };
export type LastObsolete = { at: number };
export type FailureState = { retry: TurnRetry | null; failure: LastFailure | null; obsolete: LastObsolete | null };

type EndedRow = { id: string; agentId: string; status: Job['status']; error: string | null; failure: Failure | string | null; finishedAt: Date | string | null; createdAt: Date | string; tail: string };
type WaitingRow = { agentId: string; continueOf: string | null; notBefore: Date | string | null };
type ObsoleteRow = { agentId: string; finishedAt: Date | string | null; createdAt: Date | string };
type EndedJob = Pick<Job, 'id' | 'status' | 'error' | 'failure' | 'finishedAt' | 'createdAt' | 'tail'>;

const rowsOf = <T>(answer: unknown): T[] => (Array.isArray(answer) ? answer : (answer as { rows: T[] }).rows);
const uuidList = (ids: readonly string[]): string => `{${ids.join(',')}}`;
const asDate = (value: Date | string | null): Date | null => (value === null ? null : value instanceof Date ? value : new Date(value));
const asFailure = (value: Failure | string | null): Failure | null => (typeof value === 'string' ? (JSON.parse(value) as Failure) : value);

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

async function latestEndedJobs(ctx: Ctx, companyId: string, ids: readonly string[]): Promise<Map<string, EndedJob>> {
  const excluded = sql.join(NO_FAILURE.map(code => sql`${code}`), sql`, `);
  const rows = rowsOf<EndedRow>(await ctx.db.execute(sql`
    SELECT j.id, j.agent_id AS "agentId", j.status, j.error, j.failure, j.finished_at AS "finishedAt", j.created_at AS "createdAt", j.tail
    FROM unnest(${uuidList(ids)}::uuid[]) AS a(agent_id)
    CROSS JOIN LATERAL (
      SELECT id, agent_id, status, error, failure, finished_at, created_at, tail
      FROM jobs
      WHERE company_id = ${companyId}
        AND agent_id = a.agent_id
        AND kind = 'conversation'
        AND status IN ('done', 'failed')
        AND (error IS NULL OR error NOT IN (${excluded}))
      ORDER BY coalesce(finished_at, created_at) DESC, created_at DESC
      LIMIT 1
    ) j
  `));
  return new Map(rows.map(r => [r.agentId, { id: r.id, status: r.status, error: r.error, failure: asFailure(r.failure), finishedAt: asDate(r.finishedAt), createdAt: asDate(r.createdAt)!, tail: r.tail }]));
}

async function waitingRetryJobs(ctx: Ctx, companyId: string, ids: readonly string[]): Promise<WaitingRow[]> {
  return rowsOf<WaitingRow>(await ctx.db.execute(sql`
    SELECT j.agent_id AS "agentId", j.continue_of AS "continueOf", j.not_before AS "notBefore"
    FROM unnest(${uuidList(ids)}::uuid[]) AS a(agent_id)
    CROSS JOIN LATERAL (
      SELECT agent_id, continue_of, not_before
      FROM jobs
      WHERE company_id = ${companyId}
        AND agent_id = a.agent_id
        AND kind = 'conversation'
        AND status = 'queued'
        AND not_before IS NOT NULL
        AND continue_of IS NOT NULL
      ORDER BY created_at ASC
      LIMIT 1
    ) j
  `));
}

async function latestObsoleteJobs(ctx: Ctx, companyId: string, ids: readonly string[]): Promise<Map<string, number>> {
  const rows = rowsOf<ObsoleteRow>(await ctx.db.execute(sql`
    SELECT j.agent_id AS "agentId", j.finished_at AS "finishedAt", j.created_at AS "createdAt"
    FROM unnest(${uuidList(ids)}::uuid[]) AS a(agent_id)
    CROSS JOIN LATERAL (
      SELECT agent_id, finished_at, created_at
      FROM jobs
      WHERE company_id = ${companyId}
        AND agent_id = a.agent_id
        AND kind = 'conversation'
        AND status = 'obsolete'
      ORDER BY coalesce(finished_at, created_at) DESC, created_at DESC
      LIMIT 1
    ) j
  `));
  return new Map(rows.map(r => [r.agentId, +(asDate(r.finishedAt) ?? asDate(r.createdAt)!)]));
}

/* Read the company together with one indexed probe per agent; only waiting retries need their continuation history. */
export async function agentFailureStates(ctx: Ctx, companyId: string, agentIds: string[]): Promise<Map<string, FailureState>> {
  if (!agentIds.length) return new Map();
  const uniqueIds = [...new Set(agentIds)];
  const failures = await latestEndedJobs(ctx, companyId, uniqueIds);
  const waiting = await waitingRetryJobs(ctx, companyId, uniqueIds);
  const obsoletes = await latestObsoleteJobs(ctx, companyId, uniqueIds);
  const history = await retryHistory(ctx, companyId, waiting);
  const goesOn = await continuedTurns(ctx.db, companyId, [...failures.values()]);
  const retries = new Map(waiting.map(j => [j.agentId, j]));
  return new Map(await Promise.all(uniqueIds.map(async id => {
    const next = retries.get(id);
    const before = next?.continueOf ? history.get(next.continueOf) : undefined;
    const retry = before?.failure && passing(before.failure)
      ? { attempt: await passingAttempts(ctx, before, history), max: RETRY_MINUTES.length, at: Number(asDate(next!.notBefore)), kind: before.failure.kind } : null;
    const obsoleteAt = obsoletes.get(id);
    return [id, { retry, failure: failureShown(failures.get(id), goesOn), obsolete: obsoleteAt === undefined ? null : { at: obsoleteAt } }] as const;
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
const failureShown = (ended: EndedJob | undefined, continued: ReadonlySet<string>): LastFailure | null => (ended && turnFailed(ended, continued) ? lastFailureOf(ended) : null);

export function lastFailureOf(ended: EndedJob | undefined): LastFailure | null {
  if (ended?.status !== 'failed' || !ended.failure) return null;
  return { kind: ended.failure.kind, text: ended.failure.text, at: +(ended.finishedAt === null ? ended.createdAt : ended.finishedAt), tail: ended.tail };
}

/* The turns a waiting retry continues, a step at a time by their ids: a chain is a few turns long, and each step is one
   lookup by the primary key, where one recursive query scans the table. */
export async function retryHistory(ctx: Ctx, companyId: string, waiting: Pick<Job, 'continueOf'>[]): Promise<Map<string, Job>> {
  const history = new Map<string, Job>();
  let pending = [...new Set(waiting.flatMap(j => (j.continueOf ? [j.continueOf] : [])))];
  while (pending.length) {
    const rows = await ctx.db.select().from(jobs).where(and(eq(jobs.companyId, companyId), inArray(jobs.id, pending)));
    for (const row of rows) history.set(row.id, row);
    pending = [...new Set(rows.flatMap(row => (row.continueOf && !history.has(row.continueOf) ? [row.continueOf] : [])))];
  }
  return history;
}
