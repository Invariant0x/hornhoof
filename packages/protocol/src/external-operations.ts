import { z } from 'zod';

const Milliseconds = z.number().int().nonnegative().max(2_147_483_647);

/* Child stderr is bounded/masked by the real producer before transport. A
   schema or a marker printed by a command cannot authenticate that producer. */
export const ExternalGitOutcome = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('child'), exitCode: z.number().int().min(0).max(255).nullable(), signal: z.string().regex(/^SIG[A-Z0-9]{1,16}$/).nullable(), osCode: z.string().max(64).nullable(), stderr: z.string().max(8192), stderrTruncated: z.boolean() }),
  z.strictObject({ kind: z.literal('http'), status: z.number().int().min(100).max(599).nullable(), transportError: z.enum(['timeout', 'connection', 'dns', 'tls', 'aborted', 'unknown']).nullable(), rateLimit: z.enum(['exhausted', 'available', 'unknown']), retryAfterMs: Milliseconds.nullable() }),
]);
export type ExternalGitOutcome = z.infer<typeof ExternalGitOutcome>;
