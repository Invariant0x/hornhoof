import { z } from 'zod';

const Id = z.uuid();
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Commit = z.string().regex(/^[a-f0-9]{40}$/);
const Milliseconds = z.number().int().nonnegative().max(2_147_483_647);
const Revision = z.number().int().positive();
const forbiddenRef = /[\x00-\x20\x7f~^:?*\[\\]|\.\.|@\{|\/\//;
const refPart = (part: string): boolean => !!part && !part.startsWith('.') && !part.endsWith('.lock');
const fullRef = (value: string): boolean => value.startsWith('refs/') && !forbiddenRef.test(value) && !value.endsWith('.') && value.split('/').every(refPart);
const Ref = z.string().max(1024).refine(fullRef, 'Expected one full literal Git ref.');
const SourceRef = z.union([Ref, z.literal('HEAD')]);

function configuredRefspec(value: string): boolean {
  const parts = (value.startsWith('+') ? value.slice(1) : value).split(':');
  if (parts.length !== 2) return false;
  const [source, destination] = parts as [string, string];
  const sourceStars = source.split('*').length - 1;
  const destinationStars = destination.split('*').length - 1;
  return sourceStars <= 1 && sourceStars === destinationStars && destination.startsWith('refs/remotes/')
    && Ref.safeParse(source.replace('*', 'x')).success && Ref.safeParse(destination.replace('*', 'x')).success;
}

/* A frozen fetch map, not argv. Runtime admission also verifies the Git version,
   effective endpoint, branch state and absence of inherited alias settings. */
export const ConfiguredRefspec = z.string().max(2050).refine(configuredRefspec, 'Expected one configured fetch refspec.');
export type ConfiguredRefspec = z.infer<typeof ConfiguredRefspec>;
const ConfiguredBranch = z.string().max(1024).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine(value => Ref.safeParse(`refs/heads/${value}`).success, 'Expected one branch name.');
const ConfiguredMerge = z.strictObject({ branch: ConfiguredBranch.nullable(), refs: z.array(SourceRef).max(16) })
  .refine(value => value.branch !== null || value.refs.length === 0, 'Detached HEAD has no branch merge refs.');

/* These are immutable selectors, not executable argv or a repository grant.
   The producer resolves repository and credential authority separately. */
export const ExternalGitIntent = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('git_push'), repositoryId: Id, sourceSha: Commit, destinationRef: Ref }),
  z.strictObject({ kind: z.literal('git_fetch'), repositoryId: Id, target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('commit'), commitSha: Commit }),
    z.strictObject({ kind: z.literal('refspec'), sourceRef: SourceRef, destinationRef: Ref.optional() }),
    z.strictObject({ kind: z.literal('configured'), refspecs: z.array(ConfiguredRefspec).min(1).max(16), merge: ConfiguredMerge }),
  ]) }),
  z.strictObject({ kind: z.literal('git_refs'), repositoryId: Id, selector: SourceRef }),
]);
export type ExternalGitIntent = z.infer<typeof ExternalGitIntent>;

/* Ending a model job does not end a committed test run. A registered server
   continuation is a literal service port, never serialized caller code. */
export const ExternalConsumer = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('agent_job'), jobId: Id, workspaceBinding: Digest }),
  z.strictObject({ kind: z.literal('test_part'), runId: Id, ordinal: Revision, attemptId: Id, commitSha: Commit }),
  z.strictObject({ kind: z.literal('server_read'), requestId: Id, registeredContinuation: z.literal('test_run_admission') }),
]);
export type ExternalConsumer = z.infer<typeof ExternalConsumer>;

/* Child stderr is bounded/masked by the real producer before transport. A
   schema or a marker printed by a command cannot authenticate that producer. */
export const ExternalGitOutcome = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('child'), exitCode: z.number().int().min(0).max(255).nullable(), signal: z.string().regex(/^SIG[A-Z0-9]{1,16}$/).nullable(), osCode: z.string().max(64).nullable(), stderr: z.string().max(8192), stderrTruncated: z.boolean() }),
  z.strictObject({ kind: z.literal('http'), status: z.number().int().min(100).max(599).nullable(), transportError: z.enum(['timeout', 'connection', 'dns', 'tls', 'aborted', 'unknown']).nullable(), rateLimit: z.enum(['exhausted', 'available', 'unknown']), retryAfterMs: Milliseconds.nullable() }),
]);
export type ExternalGitOutcome = z.infer<typeof ExternalGitOutcome>;

export const ExternalExecutionBudget = z.strictObject({
  originalTimeoutMs: Milliseconds.refine(value => value > 0),
  activeElapsedMs: Milliseconds,
  remainingMs: Milliseconds,
  deadlineAt: z.iso.datetime().nullable(),
}).refine(value => value.remainingMs === Math.max(0, value.originalTimeoutMs - value.activeElapsedMs), 'The remaining execution budget must not reset.');
export type ExternalExecutionBudget = z.infer<typeof ExternalExecutionBudget>;

/* Only preparation can be deferred. The receiving service still verifies the
   actual current node/link/attempt and its original budget before accepting. */
export const ExternalPreparationSettlement = z.strictObject({
  attemptId: Id, operationId: Id, generation: Revision,
  childSettled: z.literal(true), cleanupComplete: z.literal(true), cacheLockReleased: z.literal(true), commandStarted: z.literal(false),
  receiptDigest: Digest, budget: ExternalExecutionBudget,
});
export type ExternalPreparationSettlement = z.infer<typeof ExternalPreparationSettlement>;
