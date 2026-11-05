import { z } from 'zod';

export const RepositoryPath = z.string().min(1).max(4096)
  .refine(path => !/^(?:\/|[a-z]:)|[\\\0]|(?:^|\/)\.\.(?:\/|$)/i.test(path), 'Use a path within the repository.');
const Argument = z.string().max(100_000).refine(value => !value.includes('\0'));

export const Command = z.strictObject({
  program: Argument.min(1),
  args: z.array(Argument).max(1000),
  cwd: RepositoryPath,
});
export type Command = z.infer<typeof Command>;

export const EnvironmentDigest = z.string().regex(/^[a-f0-9]{64}$/);
export const RepositoryScope = z.strictObject({
  companyId: z.uuid(),
  repositoryOwnerId: z.uuid(),
  repoUrlHash: EnvironmentDigest,
});
export type RepositoryScope = z.infer<typeof RepositoryScope>;
