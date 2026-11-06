import type { ExternalGitIntent, ExternalGitOutcome } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { classifyGitOutcome } from '../src/modules/failures/git.js';
import * as gitPolicy from '../src/modules/failures/git.js';

const child = (stderr: string, extra: Partial<Extract<ExternalGitOutcome, { kind: 'child' }>> = {}): ExternalGitOutcome =>
  ({ kind: 'child', exitCode: 1, signal: null, osCode: null, stderr, stderrTruncated: false, ...extra });
const http = (status: number | null, extra: Partial<Extract<ExternalGitOutcome, { kind: 'http' }>> = {}): ExternalGitOutcome =>
  ({ kind: 'http', status, transportError: null, rateLimit: 'unknown', retryAfterMs: null, ...extra });

describe('typed Git failure classification', () => {
  it.each([
    { name: 'an ordinary successful child', outcome: child('', { exitCode: 0 }), expected: { kind: 'success' } },
    { name: 'a successful moved notice', outcome: child('remote: This repository moved. Please use the new location.', { exitCode: 0 }), expected: { kind: 'success' } },
    { name: 'a successful read response', outcome: http(200), expected: { kind: 'success' } },
    { name: 'the paired receive-side temporary refusal', outcome: child('remote: fatal error in commit_refs_rules\n ! [remote rejected] task-559 -> task-559 (failure)'), expected: { kind: 'transient', family: 'temporary' } },
    { name: 'commit_refs_rules without a rejected result', outcome: child('remote: fatal error in commit_refs_rules'), expected: { kind: 'unknown' } },
    { name: 'a generic remote rejection', outcome: child('! [remote rejected] task-559 -> task-559 (remote rejected)'), expected: { kind: 'unknown' } },
    { name: 'an unexplained exit 1', outcome: child(''), expected: { kind: 'unknown' } },
    { name: 'a truncated partial temporary message', outcome: child('remote: fatal error in commit_refs_rules', { stderrTruncated: true }), expected: { kind: 'unknown' } },
    { name: 'a signalled child without a result', outcome: child('', { exitCode: null, signal: 'SIGTERM' }), expected: { kind: 'unknown' } },
    { name: 'an unresolved child result', outcome: child('', { exitCode: null }), expected: { kind: 'unknown' } },
    { name: 'a local missing binary', outcome: child('', { exitCode: null, osCode: 'ENOENT' }), expected: { kind: 'unknown' } },
    { name: 'failed authentication', outcome: child('fatal: Authentication failed'), expected: { kind: 'permanent', reason: 'authorization' } },
    { name: 'missing SSH rights', outcome: child('Permission denied (publickey).'), expected: { kind: 'permanent', reason: 'authorization' } },
    { name: 'missing interactive credentials', outcome: child("fatal: could not read Username for 'https://example.test': No such device or address"), expected: { kind: 'permanent', reason: 'authorization' } },
    { name: 'a non-fast-forward result', outcome: child('! [rejected] task-559 -> task-559 (non-fast-forward)'), expected: { kind: 'permanent', reason: 'non_fast_forward' } },
    { name: 'a protected branch refusal', outcome: child('remote: error: GH006: Protected branch update failed'), expected: { kind: 'permanent', reason: 'policy' } },
    { name: 'an explicit hook policy refusal', outcome: child('! [remote rejected] task-559 -> task-559 (pre-receive hook declined)'), expected: { kind: 'permanent', reason: 'policy' } },
    { name: 'an invalid refspec', outcome: child('fatal: invalid refspec'), expected: { kind: 'permanent', reason: 'invalid_reference' } },
    { name: 'a missing repository', outcome: child('fatal: repository not found'), expected: { kind: 'permanent', reason: 'invalid_reference' } },
    { name: 'certificate trust failure', outcome: child('fatal: SSL certificate problem: unable to get local issuer certificate'), expected: { kind: 'permanent', reason: 'tls' } },
    { name: 'a typed timeout', outcome: child('', { exitCode: null, osCode: 'ETIMEDOUT' }), expected: { kind: 'transient', family: 'transport' } },
    { name: 'a typed connection reset', outcome: child('', { exitCode: null, osCode: 'ECONNRESET' }), expected: { kind: 'transient', family: 'transport' } },
    { name: 'a typed unreachable network', outcome: child('', { exitCode: null, osCode: 'ENETUNREACH' }), expected: { kind: 'transient', family: 'transport' } },
    { name: 'a typed temporary DNS failure', outcome: child('', { exitCode: null, osCode: 'EAI_AGAIN' }), expected: { kind: 'transient', family: 'transport' } },
    { name: 'TLS evidence with a temporary-looking line', outcome: child('SSL certificate problem\nremote: fatal error in commit_refs_rules\n! [remote rejected]'), expected: { kind: 'permanent', reason: 'tls' } },
    { name: 'authorization evidence with a typed network error', outcome: child('Authentication failed', { osCode: 'ECONNRESET' }), expected: { kind: 'permanent', reason: 'authorization' } },
    { name: 'HTTP unauthorized', outcome: http(401), expected: { kind: 'permanent', reason: 'authorization' } },
    { name: 'HTTP forbidden with available quota', outcome: http(403, { rateLimit: 'available' }), expected: { kind: 'permanent', reason: 'authorization' } },
    { name: 'HTTP forbidden with exhausted quota', outcome: http(403, { rateLimit: 'exhausted' }), expected: { kind: 'transient', family: 'rate_limit' } },
    { name: 'HTTP forbidden without quota evidence', outcome: http(403), expected: { kind: 'unknown' } },
    { name: 'HTTP request timeout', outcome: http(408), expected: { kind: 'transient', family: 'transport' } },
    { name: 'HTTP rate limit', outcome: http(429, { retryAfterMs: 60000 }), expected: { kind: 'transient', family: 'rate_limit' } },
    { name: 'HTTP server failure', outcome: http(500), expected: { kind: 'transient', family: 'temporary' } },
    { name: 'HTTP service unavailable', outcome: http(503), expected: { kind: 'transient', family: 'temporary' } },
    { name: 'HTTP not found', outcome: http(404), expected: { kind: 'permanent', reason: 'invalid_reference' } },
    { name: 'HTTP bad request', outcome: http(400), expected: { kind: 'permanent', reason: 'invalid_reference' } },
    { name: 'an unhandled redirect', outcome: http(301), expected: { kind: 'unknown' } },
    { name: 'an absent HTTP response', outcome: http(null), expected: { kind: 'unknown' } },
    { name: 'a typed HTTP DNS failure', outcome: http(null, { transportError: 'dns' }), expected: { kind: 'transient', family: 'transport' } },
    { name: 'a typed HTTP connection failure', outcome: http(null, { transportError: 'connection' }), expected: { kind: 'transient', family: 'transport' } },
    { name: 'a typed HTTP timeout', outcome: http(null, { transportError: 'timeout' }), expected: { kind: 'transient', family: 'transport' } },
    { name: 'a typed HTTP TLS failure', outcome: http(null, { transportError: 'tls' }), expected: { kind: 'permanent', reason: 'tls' } },
    { name: 'TLS failure despite a server status', outcome: http(503, { transportError: 'tls' }), expected: { kind: 'permanent', reason: 'tls' } },
    { name: 'an aborted request', outcome: http(null, { transportError: 'aborted' }), expected: { kind: 'unknown' } },
    { name: 'an unknown transport failure', outcome: http(503, { transportError: 'unknown' }), expected: { kind: 'unknown' } },
  ])('classifies $name without granting execution', ({ outcome, expected }) => {
    expect(classifyGitOutcome(outcome)).toEqual(expected);
  });
});

describe('Git outcome state', () => {
  const state = (gitPolicy as unknown as { gitOutcomeState?: (intent: ExternalGitIntent, outcome: ExternalGitOutcome, settled: boolean, observedHead?: string | null) => string }).gitOutcomeState;
  const push: ExternalGitIntent = { kind: 'git_push', repositoryId: '00000000-0000-4000-8000-000000000001', sourceSha: 'a'.repeat(40), destinationRef: 'refs/heads/task-559' };
  const fetch: ExternalGitIntent = { kind: 'git_fetch', repositoryId: push.repositoryId, target: { kind: 'commit', commitSha: 'a'.repeat(40) } };
  const refs: ExternalGitIntent = { kind: 'git_refs', repositoryId: push.repositoryId, selector: 'refs/heads/task-559' };
  const temporary = child('remote: fatal error in commit_refs_rules\n! [remote rejected]');

  it.each([
    { name: 'a successful child still lacking cleanup settlement', intent: push, outcome: child('', { exitCode: 0 }), settled: false, head: undefined, expected: 'outcome_unknown' },
    { name: 'a matching ref still lacking settlement', intent: push, outcome: temporary, settled: false, head: 'a'.repeat(40), expected: 'outcome_unknown' },
    { name: 'a successful settled push', intent: push, outcome: child('', { exitCode: 0 }), settled: true, head: undefined, expected: 'satisfied' },
    { name: 'a settled write whose target could not be read', intent: push, outcome: temporary, settled: true, head: undefined, expected: 'outcome_unknown' },
    { name: 'an exact already-published target after a temporary refusal', intent: push, outcome: temporary, settled: true, head: 'a'.repeat(40), expected: 'satisfied' },
    { name: 'an exact target after an otherwise unclassified exit', intent: push, outcome: child('unrecognized result'), settled: true, head: 'a'.repeat(40), expected: 'satisfied' },
    { name: 'a different observed target after a settled temporary refusal', intent: push, outcome: temporary, settled: true, head: 'b'.repeat(40), expected: 'deferred' },
    { name: 'an absent target after a settled temporary refusal', intent: push, outcome: temporary, settled: true, head: null, expected: 'deferred' },
    { name: 'a different target without transient evidence', intent: push, outcome: child('unrecognized result'), settled: true, head: 'b'.repeat(40), expected: 'outcome_unknown' },
    { name: 'a permanent refusal despite an earlier matching observation', intent: push, outcome: child('Authentication failed'), settled: true, head: 'a'.repeat(40), expected: 'failed_permanent' },
    { name: 'a proven non-fast-forward refusal', intent: push, outcome: child('! [rejected] (non-fast-forward)'), settled: true, head: 'b'.repeat(40), expected: 'failed_permanent' },
    { name: 'a settled transient pinned fetch', intent: fetch, outcome: http(503), settled: true, head: undefined, expected: 'deferred' },
    { name: 'a settled successful refs read', intent: refs, outcome: http(200), settled: true, head: undefined, expected: 'satisfied' },
    { name: 'a settled transient refs read', intent: refs, outcome: http(429), settled: true, head: undefined, expected: 'deferred' },
    { name: 'an unclassified fetch without a grant from a matching-looking ref', intent: fetch, outcome: child('unknown'), settled: true, head: 'a'.repeat(40), expected: 'outcome_unknown' },
  ])('keeps $name in $expected', ({ intent, outcome, settled, head, expected }) => {
    expect(state?.(intent, outcome, settled, head)).toBe(expected);
  });
});
