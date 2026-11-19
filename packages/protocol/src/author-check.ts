import { z } from 'zod';
import { ProductCommitSha, RepositoryPath, RepositoryScope } from './test-environment.js';

const Branch = z.string().min(1).max(255);
const AuthorRepo = z.strictObject({
  url: z.url().refine(value => {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }),
  token: z.string(),
});

export const AuthorCheckPin = z.strictObject({
  taskId: z.uuid(), agentId: z.uuid(), branch: Branch, baseCommit: ProductCommitSha, commit: ProductCommitSha,
  repoUrlHash: RepositoryScope.shape.repoUrlHash, paths: z.array(RepositoryPath).max(10_000),
});
export type AuthorCheckPin = z.infer<typeof AuthorCheckPin>;

export const AuthorCheckRun = z.strictObject({
  type: z.literal('author_check.run'), requestId: z.uuid(), pin: AuthorCheckPin, repo: AuthorRepo,
  repositoryScope: RepositoryScope, mainCommit: ProductCommitSha, verifyCherryPick: z.boolean(),
});
export type AuthorCheckRun = z.infer<typeof AuthorCheckRun>;

export const AuthorCheckDone = z.strictObject({
  type: z.literal('author_check.done'), requestId: z.uuid(), taskId: z.uuid(), commit: ProductCommitSha,
  crap: z.number().nonnegative().nullable(), cherryPick: ProductCommitSha.nullable(),
  n: z.number().int().positive().optional(),
});
export type AuthorCheckDone = z.infer<typeof AuthorCheckDone>;

export function docsOnly(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every(path => path.startsWith('docs/') && RepositoryPath.safeParse(path).success);
}
