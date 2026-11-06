import * as protocol from '../src/index.js';
import type { z } from 'zod';
import { describe, expect, it } from 'vitest';

const ID = '00000000-0000-4000-8000-000000000001';
const SHA = 'a'.repeat(40);
const HASH = 'b'.repeat(64);
const push = { kind: 'git_push', repositoryId: ID, sourceSha: SHA, destinationRef: 'refs/heads/task-558' };
const fetch = { kind: 'git_fetch', repositoryId: ID, target: { kind: 'refspec', sourceRef: 'refs/heads/turn-8', destinationRef: 'refs/remotes/origin/turn-8' } };
const consumer = { kind: 'test_part', runId: ID, ordinal: 1, attemptId: ID, commitSha: SHA };

/* Namespace lookup lets the initial RED report a missing public contract as an
   assertion, rather than failing the test loader on a nonexistent export. */
function accepts(name: string, input: unknown): boolean {
  const schema = Reflect.get(protocol, name) as z.ZodType | undefined;
  expect(schema, `Missing public ${name}`).toBeDefined();
  return schema!.safeParse(input).success;
}

describe('external operation intents', () => {
  it.each([
    push,
    fetch,
    { kind: 'git_fetch', repositoryId: ID, target: { kind: 'commit', commitSha: SHA } },
    { kind: 'git_refs', repositoryId: ID, selector: 'HEAD' },
    { kind: 'git_refs', repositoryId: ID, selector: 'refs/heads/turn-8' },
  ])('keeps one exact Git intent %#', input => {
    expect(accepts('ExternalGitIntent', input)).toBe(true);
  });

  it.each([
    { ...push, sourceSha: 'a'.repeat(64) },
    { ...push, sourceSha: 'main' },
    { ...push, force: true },
    { ...push, token: 'not-a-credential' },
    { ...push, argv: ['push', '--all'] },
    { ...push, destinationRef: 'main' },
    { ...push, destinationRef: 'refs/heads/../main' },
    { ...push, destinationRef: 'refs/heads/a:refs/heads/b' },
    { ...push, destinationRef: 'refs/heads/a.lock' },
    { ...fetch, target: { ...fetch.target, sourceRef: 'refs/heads/*' } },
    { ...fetch, target: { kind: 'commit', commitSha: SHA, sourceRef: 'main' } },
    { kind: 'git_refs', repositoryId: ID, selector: '--upload-pack=other' },
  ])('refuses changed, ambiguous or authority-bearing intent %#', input => {
    expect(accepts('ExternalGitIntent', input)).toBe(false);
  });
});

describe('configured fetch snapshots', () => {
  const literal = 'refs/heads/main:refs/remotes/origin/main';
  const glob = '+refs/heads/*:refs/remotes/origin/*';
  const target = { kind: 'configured', refspecs: [glob], merge: { branch: 'turn-8', refs: ['refs/heads/turn-8'] } };
  const intent = (value: unknown) => ({ kind: 'git_fetch', repositoryId: ID, target: value });

  it.each([
    target,
    { ...target, refspecs: [literal], merge: { branch: null, refs: [] } },
    { ...target, merge: { branch: 'feature/one', refs: [] } },
    { ...target, merge: { branch: 'feature/one', refs: ['HEAD', 'refs/heads/main'] } },
    { ...target, refspecs: Array.from({ length: 16 }, () => literal), merge: { branch: 'main', refs: Array.from({ length: 16 }, () => 'refs/heads/main') } },
    { ...target, refspecs: [`+refs/${'a'.repeat(1019)}:refs/remotes/${'b'.repeat(1011)}`] },
  ])('accepts the bounded immutable configured target %#', value => {
    expect(accepts('ExternalGitIntent', intent(value))).toBe(true);
  });

  it('preserves refspec and merge order, duplicates and the leading plus', () => {
    const value = intent({ ...target, refspecs: [literal, glob, literal], merge: { branch: 'main', refs: ['refs/heads/next', 'refs/heads/main', 'refs/heads/next'] } });
    expect(protocol.ExternalGitIntent.parse(value)).toEqual(value);
  });

  it.each([
    '', '^refs/heads/private', 'refs/heads/main', ':refs/remotes/origin/main',
    'HEAD:refs/remotes/origin/main', 'main:refs/remotes/origin/main',
    'refs/heads/main:', 'refs/heads/main:refs/heads/main',
    'refs/heads/main:refs/remotes/origin/main:other',
    '++refs/heads/*:refs/remotes/origin/*',
    'refs/heads/*:refs/remotes/origin/main', 'refs/heads/main:refs/remotes/origin/*',
    'refs/heads/**:refs/remotes/origin/**',
    'refs/heads/../main:refs/remotes/origin/main',
    'refs/heads/.hidden:refs/remotes/origin/main',
    'refs/heads/a.lock:refs/remotes/origin/main',
    'refs/heads/main:refs/remotes/origin/a.lock',
    'refs/heads/main:refs/remotes/origin/main/',
    'refs/heads/a b:refs/remotes/origin/main',
    'refs/heads/a\nb:refs/remotes/origin/main',
    `refs/${'a'.repeat(1020)}:refs/remotes/origin/main`,
    `refs/heads/main:refs/remotes/${'b'.repeat(1012)}`,
  ])('refuses a malformed or overlong configured refspec %#', refspec => {
    expect(accepts('ExternalGitIntent', intent({ ...target, refspecs: [refspec] }))).toBe(false);
  });

  it.each([
    { ...target, refspecs: [] },
    { ...target, refspecs: Array.from({ length: 17 }, () => literal) },
    { ...target, refspecs: [3] },
    { ...target, merge: undefined },
    { ...target, merge: { branch: null, refs: ['refs/heads/main'] } },
    { ...target, merge: { branch: 'main', refs: Array.from({ length: 17 }, () => 'refs/heads/main') } },
    { ...target, merge: { branch: 'main', refs: ['main'] } },
    { ...target, merge: { branch: 'main', refs: ['refs/heads/*'] } },
    { ...target, merge: { branch: 'main', refs: [], remote: 'origin' } },
    { ...target, observedHead: SHA },
    { ...target, url: 'https://example.test/repo.git' },
    { ...target, argv: ['fetch', '--all'] },
  ])('refuses incomplete, ambiguous or authority-bearing configured targets %#', value => {
    expect(accepts('ExternalGitIntent', intent(value))).toBe(false);
  });

  it.each(['', '-main', 'a=b', 'a b', 'a..b', 'a.lock', '.hidden', 'main/', 'a//b', 'a@{b', 'main\nother', 'a'.repeat(1014)])('refuses an unsafe configured branch %#', branch => {
    expect(accepts('ExternalGitIntent', intent({ ...target, merge: { branch, refs: [] } }))).toBe(false);
  });
});

describe('external consumer lifetime', () => {
  it.each([
    consumer,
    { kind: 'agent_job', jobId: ID, workspaceBinding: HASH },
    { kind: 'server_read', requestId: ID, registeredContinuation: 'test_run_admission' },
  ])('describes a single registered consumer %# without granting it authority', input => {
    expect(accepts('ExternalConsumer', input)).toBe(true);
  });

  it.each([
    { ...consumer, ordinal: 0 },
    { ...consumer, commitSha: 'turn-8' },
    { ...consumer, nodeToken: 'not-a-credential' },
    { kind: 'agent_job', jobId: ID },
    { kind: 'server_read', requestId: ID, registeredContinuation: 'eval(code)' },
  ])('refuses incomplete or caller-invented consumer binding %#', input => {
    expect(accepts('ExternalConsumer', input)).toBe(false);
  });
});

describe('external outcomes and settlement', () => {
  const child = { kind: 'child', exitCode: 1, signal: null, osCode: null, stderr: 'remote: temporary refusal', stderrTruncated: false };
  const http = { kind: 'http', status: 403, transportError: null, rateLimit: 'unknown', retryAfterMs: null };
  const budget = { originalTimeoutMs: 60000, activeElapsedMs: 12000, remainingMs: 48000, deadlineAt: '2026-11-06T05:00:00.000Z' };
  const settlement = { attemptId: ID, operationId: ID, generation: 1, childSettled: true, cleanupComplete: true, cacheLockReleased: true, commandStarted: false, receiptDigest: HASH, budget };

  it.each([child, http, { ...http, status: null, transportError: 'timeout' }])('preserves typed producer evidence %#', input => {
    expect(accepts('ExternalGitOutcome', input)).toBe(true);
  });

  it.each([
    { ...child, exitCode: -1 },
    { ...child, stderr: 'x'.repeat(8193) },
    { ...child, trusted: true },
    { ...http, headers: { authorization: 'not-a-credential' } },
    { ...http, status: 999 },
  ])('refuses unbounded or authority-bearing result %#', input => {
    expect(accepts('ExternalGitOutcome', input)).toBe(false);
  });

  it('accepts a fully settled preparation and its original execution budget', () => {
    expect(accepts('ExternalPreparationSettlement', settlement)).toBe(true);
  });

  it.each([
    { ...settlement, childSettled: false },
    { ...settlement, cleanupComplete: false },
    { ...settlement, cacheLockReleased: false },
    { ...settlement, commandStarted: true },
    { ...settlement, budget: { ...budget, remainingMs: 60000 } },
    { ...settlement, budget: { ...budget, activeElapsedMs: -1 } },
    { ...settlement, budget: { ...budget, deadlineAt: 'tomorrow' } },
  ])('does not confuse a fence, a running command or a fresh timeout with settlement %#', input => {
    expect(accepts('ExternalPreparationSettlement', input)).toBe(false);
  });
});
