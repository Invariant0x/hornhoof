import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { agents, subscriptions, taskEvents, testParts, testRuns } from '../../db/schema.js';
import { repoAt } from '../departments/repository.js';
import type { CompareResult } from '../testruns/compare.js';
import type { Task, Tx } from './engine.js';

export const ReviewSha = z.string().regex(/^[a-f0-9]{40}$/);
export const reviewVendor = (provider: string): string => ({ anthropic_api: 'claude', openai_api: 'codex' })[provider] ?? provider;
const Counts = z.object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), other: z.number().int().nonnegative() });
const Run = z.object({ id: z.string().uuid(), number: z.number().int(), authorId: z.string().uuid(), commit: z.string().nullable(), command: z.string(), status: z.string(), parts: Counts, verified: z.boolean() });
export const ReviewSubmission = z.object({ baseCommit: ReviewSha }).strict();
const Source = z.object({ baseCommit: ReviewSha, commit: ReviewSha, paths: z.array(z.string()), changedLines: z.number().int().nonnegative() });
export const ReviewRecord = z.object({
  revision: z.string().uuid(), commit: ReviewSha.nullable(), branch: z.string().nullable(),
  authorId: z.string().uuid(), authorVendor: z.string().nullable(),
  status: z.enum(['pinned', 'degraded']), reason: z.string().nullable(),
  gateCounts: z.object({ passed: z.number().int().nonnegative(), returned: z.number().int().nonnegative() }),
  runs: z.array(Run),
  source: Source.nullable().default(null),
});
export type Review = z.infer<typeof ReviewRecord>;
type Reader = Pick<Ctx, 'db'> & Partial<Pick<Ctx, 'config' | 'readCommit' | 'readCompare'>>;

export const changedLines = (diff: string): number => diff.split('\n').filter(line => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line)).length;

export async function authorVendor(db: Ctx['db'] | Tx, authorId: string): Promise<string | null> {
  const [row] = await db.select({ provider: subscriptions.provider }).from(agents)
    .leftJoin(subscriptions, eq(subscriptions.id, agents.subscriptionId)).where(eq(agents.id, authorId));
  return row?.provider ? reviewVendor(row.provider) : null;
}

async function authorRuns(db: Ctx['db'] | Tx, task: Task, commit: string | null, branch?: string): Promise<Review['runs']> {
  const scope = branch ? and(eq(testRuns.branch, branch), inArray(testRuns.departmentId, [task.productId, task.departmentId].filter((id): id is string => id !== null))) : and(eq(testRuns.taskId, task.id), eq(testRuns.agentId, task.executorAgentId!));
  const runs = await db.select().from(testRuns).where(and(eq(testRuns.companyId, task.companyId), scope, eq(testRuns.kind, 'tests'))).orderBy(desc(testRuns.number));
  const parts = runs.length ? await db.select().from(testParts).where(inArray(testParts.runId, runs.map(run => run.id))) : [];
  return runs.map(run => {
    const own = parts.filter(part => part.runId === run.id);
    const passed = own.filter(part => part.status === 'passed').length;
    const failed = own.filter(part => part.status === 'failed').length;
    return {
      id: run.id, number: run.number, authorId: run.agentId, commit: run.commitSha, command: run.command, status: run.status,
      parts: { passed, failed, other: own.length - passed - failed },
      verified: commit !== null && run.commitSha === commit && run.status === 'passed' && own.length === run.parts && own.every(part => part.status === 'passed' && part.commit === commit && part.exitCode === 0 && !part.error),
    };
  });
}

export async function turnReviewContext(db: Tx, task: Task, head: string, branch: string, comparison: CompareResult): Promise<Review> {
  const commit = comparison.complete ? comparison.headSha : null;
  return {
    revision: randomUUID(), commit, branch, authorId: head, authorVendor: await authorVendor(db, head),
    status: commit ? 'pinned' : 'degraded', reason: commit ? null : 'comparison-unavailable',
    gateCounts: { passed: 0, returned: 0 }, runs: await authorRuns(db, task, commit, branch), source: null,
  };
}

/* Read a repository before opening a task transaction. Remote text never becomes an error or audit record. */
export async function captureReview(ctx: Reader, task: Task, input?: z.infer<typeof ReviewSubmission>): Promise<Review | null> {
  if (!ctx.config || !ctx.readCommit || !task.executorAgentId) return null;
  const found = await repoAt({ db: ctx.db, config: ctx.config }, [task.productId, task.departmentId]);
  if (!found) return null;
  let commit: string | null = null;
  let branch: string | null = null;
  try {
    const at = await ctx.readCommit(found.repo, { task: task.number }, 5_000);
    if ('commitSha' in at && ReviewSha.safeParse(at.commitSha).success) { commit = at.commitSha; branch = at.branch; }
  } catch { /* A submission still succeeds, explicitly degraded, if the repository is away. */ }
  const verdicts = await ctx.db.select({ data: taskEvents.data }).from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.kind, 'verdict')));
  let source: Review['source'] = null;
  if (commit && input && ctx.readCompare) {
    try {
      const compared = await ctx.readCompare(found.repo, { base: input.baseCommit, head: commit }, 10_000);
      if (compared.complete && compared.baseSha === input.baseCommit && compared.headSha === commit) source = { baseCommit: input.baseCommit, commit, paths: [...new Set(compared.paths)], changedLines: changedLines(compared.diff) };
    } catch { /* An incomplete source is a degraded review plan, never an invented inventory. */ }
  }
  return {
    revision: randomUUID(), commit, branch, authorId: task.executorAgentId, authorVendor: await authorVendor(ctx.db, task.executorAgentId),
    status: commit ? 'pinned' : 'degraded', reason: commit ? null : 'commit-unavailable',
    gateCounts: { passed: verdicts.filter(v => v.data.pass === true).length, returned: verdicts.filter(v => v.data.pass === false).length },
    runs: await authorRuns(ctx.db, task, commit),
    source,
  };
}

/* Event records, rather than a live branch lookup, define what a reviewer was assigned. */
export async function reviewContext(db: Ctx['db'] | Tx, taskId: string): Promise<Review | null> {
  const records = await db.select({ data: taskEvents.data }).from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), inArray(taskEvents.kind, ['submitted', 'created']))).orderBy(desc(taskEvents.id));
  for (const record of records) {
    const parsed = ReviewRecord.safeParse(record.data.review);
    if (parsed.success) return parsed.data;
  }
  return null;
}
