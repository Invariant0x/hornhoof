import type { ExternalGitOutcome } from '@hornhoof/protocol';

export type GitFailureDecision =
  | { readonly kind: 'success' }
  | { readonly kind: 'transient'; readonly family: 'transport' | 'temporary' | 'rate_limit' }
  | { readonly kind: 'permanent'; readonly reason: 'authorization' | 'non_fast_forward' | 'invalid_reference' | 'tls' | 'policy' }
  | { readonly kind: 'unknown' };

/* Classification is not producer authority, settlement or permission to replay. */
export function classifyGitOutcome(outcome: ExternalGitOutcome): GitFailureDecision {
  switch (outcome.kind) {
    case 'child': return { kind: 'unknown' };
    case 'http': return { kind: 'unknown' };
  }
}
