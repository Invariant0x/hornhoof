import { ProductCommitSha } from '@hornhoof/protocol';
import { z } from 'zod';

const Request = z.strictObject({
  batchId: z.uuid(), trialId: z.uuid(), turn: z.number().int().positive(), baseSha: ProductCommitSha, createdAt: z.iso.datetime(),
  heads: z.array(z.strictObject({ submissionId: z.uuid(), headSha: ProductCommitSha })).min(1)
    .refine(heads => new Set(heads.map(head => head.submissionId)).size === heads.length),
});
export type StagingPreparationRequest = z.infer<typeof Request>;
const Identity = z.strictObject({ name: z.string().min(1).max(200).regex(/^[^\u0000-\u001f<>]+$/), email: z.email() });
export interface StagingGitOptions { input?: string; env?: Record<string, string>; signal?: AbortSignal }
export interface StagingGitContext {
  git: (args: string[], options?: StagingGitOptions) => Promise<{ code: number | null; stdout: string }>;
  identity: { name: string; email: string }; signal: AbortSignal;
}
export type StagingPreparationResult = { status: 'prepared'; ref: string; commitSha: string; treeSha: string; members: string[] }
  | { status: 'conflict'; submissionId: string } | { status: 'unavailable' };

export interface StagingTrialPublicationRequest { batchId: string; trialId: string; turn: number; commitSha: string }
export type StagingTrialPublicationResult = { status: 'published'; ref: string; commitSha: string } | { status: 'conflict' | 'unavailable' };

/* Exact remote effect only; private operation/plan/inclusion authority belongs to the protected caller. */
export async function publishStagingTrial(request: StagingTrialPublicationRequest, context: StagingGitContext): Promise<StagingTrialPublicationResult> {
  void request; void context;
  return { status: 'unavailable' };
}

async function git(context: StagingGitContext, args: string[], options: StagingGitOptions = {}) {
  context.signal.throwIfAborted();
  const result = await context.git(args, { ...options, signal: context.signal });
  context.signal.throwIfAborted();
  return result;
}

function objectId(result: { code: number | null; stdout: string }): string | null {
  if (result.code !== 0) return null;
  const parsed = ProductCommitSha.safeParse(result.stdout.trim());
  return parsed.success ? parsed.data : null;
}

async function loadCommits(request: StagingPreparationRequest, context: StagingGitContext): Promise<boolean> {
  const commits = [...new Set([request.baseSha, ...request.heads.map(head => head.headSha)])];
  if ((await git(context, ['fetch', '--quiet', '--no-tags', 'origin', ...commits])).code !== 0) return false;
  for (const sha of commits) {
    const result = await git(context, ['cat-file', '-t', sha]);
    if (result.code !== 0 || result.stdout.trim() !== 'commit') return false;
  }
  return true;
}

async function commitTree(request: StagingPreparationRequest, context: StagingGitContext, tree: string, parents: string[]): Promise<string | null> {
  const { name, email } = context.identity;
  const env = { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
    GIT_AUTHOR_DATE: request.createdAt, GIT_COMMITTER_DATE: request.createdAt };
  const input = `Hornhoof staging batch ${request.batchId}\n\nTrial: ${request.trialId}\nSources: ${request.heads.map(head => `${head.submissionId}@${head.headSha}`).join(' ')}\n`;
  return objectId(await git(context, ['commit-tree', tree, ...parents.flatMap(parent => ['-p', parent])], { input, env }));
}

type MergedTree = { treeSha: string } | Extract<StagingPreparationResult, { status: 'conflict' | 'unavailable' }>;
async function mergeHeads(request: StagingPreparationRequest, context: StagingGitContext): Promise<MergedTree> {
  let current = request.baseSha;
  for (const head of request.heads) {
    const merged = await git(context, ['merge-tree', '--write-tree', current, head.headSha]);
    if (merged.code === 1) return { status: 'conflict', submissionId: head.submissionId };
    const tree = objectId(merged);
    if (!tree) return { status: 'unavailable' };
    const commit = await commitTree(request, context, tree, [current, head.headSha]);
    if (!commit) return { status: 'unavailable' };
    current = commit;
  }
  const treeSha = objectId(await git(context, ['rev-parse', `${current}^{tree}`]));
  return treeSha ? { treeSha } : { status: 'unavailable' };
}

/* The caller owns the private bare repository, sanitized Git configuration and authenticated executor. */
export async function prepareStagingCandidate(request: StagingPreparationRequest, context: StagingGitContext): Promise<StagingPreparationResult> {
  context.signal.throwIfAborted();
  const parsed = Request.safeParse(request);
  if (!parsed.success || !Identity.safeParse(context.identity).success) return { status: 'unavailable' };
  try {
    if (!await loadCommits(parsed.data, context)) return { status: 'unavailable' };
    const merged = await mergeHeads(parsed.data, context);
    if ('status' in merged) return merged;
    const commitSha = await commitTree(parsed.data, context, merged.treeSha, [parsed.data.baseSha]);
    if (!commitSha) return { status: 'unavailable' };
    return { status: 'prepared', ref: `turn-${parsed.data.turn}-staging-${parsed.data.batchId}-${parsed.data.trialId}`,
      commitSha, treeSha: merged.treeSha, members: parsed.data.heads.map(head => head.submissionId) };
  } catch {
    context.signal.throwIfAborted();
    return { status: 'unavailable' };
  }
}
