import type { ExternalGitOutcome } from '@hornhoof/protocol';

export type GitFailureDecision =
  | { readonly kind: 'success' }
  | { readonly kind: 'transient'; readonly family: 'transport' | 'temporary' | 'rate_limit' }
  | { readonly kind: 'permanent'; readonly reason: 'authorization' | 'non_fast_forward' | 'invalid_reference' | 'tls' | 'policy' }
  | { readonly kind: 'unknown' };

type ChildOutcome = Extract<ExternalGitOutcome, { kind: 'child' }>;
type HttpOutcome = Extract<ExternalGitOutcome, { kind: 'http' }>;
type PermanentReason = Extract<GitFailureDecision, { kind: 'permanent' }>['reason'];

const PERMANENT: ReadonlyArray<readonly [PermanentReason, RegExp]> = [
  ['tls', /SSL certificate problem|server certificate verification failed|certificate verify failed|unable to get local issuer certificate/i],
  ['authorization', /Authentication failed|Permission denied|could not read Username/i],
  ['policy', /GH006|protected branch|pre-receive hook declined/i],
  ['non_fast_forward', /non-fast-forward/i],
  ['invalid_reference', /invalid refspec|repository not found|does not appear to be a git repository/i],
];
const NETWORK_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH', 'EAI_AGAIN']);

const childSucceeded = (outcome: ChildOutcome): boolean => outcome.exitCode === 0 && outcome.signal === null && outcome.osCode === null;
const temporaryRefusal = (stderr: string): boolean => /remote:.*fatal error in commit_refs_rules/i.test(stderr) && /\[remote rejected\]/i.test(stderr);

function classifyChild(outcome: ChildOutcome): GitFailureDecision {
  if (childSucceeded(outcome)) return { kind: 'success' };
  if (outcome.signal !== null) return { kind: 'unknown' };
  const permanent = PERMANENT.find(([, pattern]) => pattern.test(outcome.stderr));
  if (permanent) return { kind: 'permanent', reason: permanent[0] };
  if (NETWORK_CODES.has(outcome.osCode ?? '')) return { kind: 'transient', family: 'transport' };
  if (outcome.stderrTruncated) return { kind: 'unknown' };
  return temporaryRefusal(outcome.stderr) ? { kind: 'transient', family: 'temporary' } : { kind: 'unknown' };
}

function transportDecision(error: HttpOutcome['transportError']): GitFailureDecision | null {
  if (error === null) return null;
  if (error === 'tls') return { kind: 'permanent', reason: 'tls' };
  return ['timeout', 'connection', 'dns'].includes(error) ? { kind: 'transient', family: 'transport' } : { kind: 'unknown' };
}

function forbiddenDecision(quota: HttpOutcome['rateLimit']): GitFailureDecision {
  if (quota === 'exhausted') return { kind: 'transient', family: 'rate_limit' };
  return quota === 'available' ? { kind: 'permanent', reason: 'authorization' } : { kind: 'unknown' };
}

const HTTP_STATUS: Partial<Record<number, GitFailureDecision>> = {
  400: { kind: 'permanent', reason: 'invalid_reference' },
  401: { kind: 'permanent', reason: 'authorization' },
  404: { kind: 'permanent', reason: 'invalid_reference' },
  408: { kind: 'transient', family: 'transport' },
  429: { kind: 'transient', family: 'rate_limit' },
};

function classifyHttp(outcome: HttpOutcome): GitFailureDecision {
  const transport = transportDecision(outcome.transportError);
  if (transport) return transport;
  if (outcome.status === null) return { kind: 'unknown' };
  if (outcome.status === 403) return forbiddenDecision(outcome.rateLimit);
  if (outcome.status >= 200 && outcome.status < 300) return { kind: 'success' };
  if (outcome.status >= 500 && outcome.status < 600) return { kind: 'transient', family: 'temporary' };
  return { ...(HTTP_STATUS[outcome.status] ?? { kind: 'unknown' }) };
}

/* Only authenticated producer captures enter this classifier. Its decision is
   not authority, child settlement or permission to repeat an ambiguous write. */
export function classifyGitOutcome(outcome: ExternalGitOutcome): GitFailureDecision {
  return outcome.kind === 'child' ? classifyChild(outcome) : classifyHttp(outcome);
}
