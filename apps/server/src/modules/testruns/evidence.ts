import type { Ctx } from '../../app.js';
import type { testRuns } from '../../db/schema.js';
import { targetOf } from './runs.js';

type Run = typeof testRuns.$inferSelect;

export type Freshness = 'current' | 'stale' | 'unknown';
export type Evidence = { commitSha: string | null; head: string | null; freshness: Freshness; why: string | null };

/* A run proves something about the commit it pinned and no other: its proof stands while what is under review is at that
   very commit, and a new one makes it stale. Without either commit nobody can tell. */
export function freshnessOf(commitSha: string | null, head: string | null): Freshness {
  if (!commitSha || !head) return 'unknown';
  return commitSha === head ? 'current' : 'stale';
}

const unknown = (commitSha: string | null, why: string): Evidence => ({ commitSha, head: null, freshness: 'unknown', why });

/* Whether a run still proves its branch, asked of the repository now. It says why it cannot tell rather than throw, as a
   task should still show when the repository is away. */
export async function evidenceOf(ctx: Ctx, run: Pick<Run, 'kind' | 'branch' | 'commitSha' | 'departmentId'>): Promise<Evidence> {
  const { branch, commitSha } = run;
  if (!branch || !commitSha) return unknown(commitSha, 'This run pinned no commit.');
  const repo = (await targetOf(ctx, run))?.repo;
  if (!repo) return unknown(commitSha, 'Its repository is no longer set.');
  const at = await ctx.readCommit(repo, { branch });
  if ('problem' in at) return unknown(commitSha, at.problem);
  const freshness = freshnessOf(commitSha, at.commitSha);
  return { commitSha, head: at.commitSha, freshness, why: freshness === 'stale' ? `The branch is at ${at.commitSha} now, not at the ${commitSha} this run checked.` : null };
}
