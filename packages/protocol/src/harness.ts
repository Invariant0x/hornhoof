import { z } from 'zod';
import { EnvironmentDigest, EnvironmentProblem, ProductCommitSha, RepositoryScope } from './test-environment.js';

/* One built piece of a product's test harness. key: what it was built from, the program and the machine's architecture, so
   machines of another architecture build their own. version: the same on every architecture, while nothing it is built from
   changed. */
export const HarnessUnit = z.strictObject({
  fencing: z.literal(1).optional(),
  repositoryScope: RepositoryScope,
  key: EnvironmentDigest,
  version: EnvironmentDigest,
  unit: z.string().min(1).max(64),
  commitSha: ProductCommitSha,
  platform: z.string().min(1).max(64),
});
export type HarnessUnit = z.infer<typeof HarnessUnit>;

/* What Hornhoof says of a unit a machine lacks: take it, build it, wait for the machine building it, or it failed. local: it
   keeps nothing to share, so each machine builds for itself. */
export const HarnessClaim = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ready'), companyId: z.uuid(), attempt: z.uuid(), digest: EnvironmentDigest, size: z.number().int().nonnegative(), partBytes: z.number().int().positive() }),
  z.strictObject({ state: z.literal('build'), companyId: z.uuid(), attempt: z.uuid(), partBytes: z.number().int().positive() }),
  z.strictObject({ state: z.literal('wait'), afterMs: z.number().int().positive() }),
  z.strictObject({ state: z.literal('failed'), error: z.string().max(4000), afterMs: z.number().int().positive() }),
  z.strictObject({ state: z.literal('local') }),
]);
export type HarnessClaim = z.infer<typeof HarnessClaim>;

export const HarnessDone = z.strictObject({ digest: EnvironmentDigest, size: z.number().int().positive() });
export type HarnessDone = z.infer<typeof HarnessDone>;
export const HarnessFailed = z.strictObject({ error: z.string().max(4000).nullable() });

/* A machine's word on the harness of one commit: all its units are here, or why not. */
export const HarnessSynced = z.strictObject({
  type: z.literal('tests.harness.done'), requestId: z.uuid(), commitSha: ProductCommitSha,
  result: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('ready'), version: EnvironmentDigest, keys: z.array(EnvironmentDigest).max(1000) }),
    z.strictObject({ status: z.literal('error'), problem: EnvironmentProblem }),
  ]),
});
export type HarnessSynced = z.infer<typeof HarnessSynced>;
