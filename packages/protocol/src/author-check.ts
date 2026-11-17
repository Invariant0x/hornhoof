import { z } from 'zod';

const Sha = z.string().regex(/^[a-f0-9]{40}$/);
const Path = z.string().min(1).max(500).refine(path => !/[\\\u0000-\u001f]/.test(path) && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'));
const Repo = z.url().refine(value => { const at = new URL(value); return at.protocol === 'https:' && !at.username && !at.password && !at.search && !at.hash; });

/* Only the server creates this command. Neither shell arguments nor author-supplied results cross this boundary. */
export const AuthorCheckRequest = z.strictObject({
  type: z.literal('author_check.run'), requestId: z.uuid(), jobId: z.uuid(), agentId: z.uuid(), taskId: z.uuid(),
  repoUrl: Repo, branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/), baseCommit: Sha, commit: Sha, paths: z.array(Path).max(30_000),
});
export type AuthorCheckRequest = z.infer<typeof AuthorCheckRequest>;

export const AuthorCheckCrap = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('measured'), max: z.number().nonnegative() }),
  z.strictObject({ kind: z.literal('no_functions') }),
  z.strictObject({ kind: z.literal('unknown') }),
]);
export type AuthorCheckCrap = z.infer<typeof AuthorCheckCrap>;

export const AuthorCheckDone = AuthorCheckRequest.omit({ type: true }).extend({
  type: z.literal('author_check.done'), exitCode: z.number().int().nullable(), crap: AuthorCheckCrap,
  startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(),
  reason: z.enum(['dirty_tree', 'sha_mismatch', 'base_mismatch', 'repository_mismatch', 'invalid_output', 'failed', 'checkout_changed', 'unavailable']).nullable(),
  n: z.number().int().positive().optional(),
});
export type AuthorCheckDone = z.infer<typeof AuthorCheckDone>;

/* Markdown in source or tests can affect executable behavior, and retains Review. */
export function authorCheckDocuments(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every(path => Path.safeParse(path).success && path.endsWith('.md')
    && !/^apps\/[^/]+\/src\//.test(path) && !/(^|\/)(?:test|tests|e2e|__tests__|spec|specs|testdata)\//.test(path) && !/\.(?:test|spec)\./.test(path));
}

export function sameAuthorCheck(a: AuthorCheckRequest, b: AuthorCheckRequest | AuthorCheckDone): boolean {
  const identity = (value: AuthorCheckRequest | AuthorCheckDone) => [value.requestId, value.jobId, value.agentId, value.taskId, value.repoUrl, value.branch, value.baseCommit, value.commit, value.paths];
  return JSON.stringify(identity(a)) === JSON.stringify(identity(b));
}
