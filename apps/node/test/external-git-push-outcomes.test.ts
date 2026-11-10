import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type GitRecordReply } from '../src/external-git.js';
import { eventually } from '../../../test-support/eventually.mjs';
import { calls, commit, FakePort, head, jobOf, KEY, OPERATION_LINE, planFor, realGit, remoteRef, runShim, serve, type Stand, stand } from './external-git-helpers.js';

describe('a refused push while the service recovers', () => {
  async function refusedOnce(s: Stand, extra: GitRecordReply[] = []) {
    planFor(s, { push: [{ do: 'refuse' }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'deferred', nextAttemptAt: '2026-11-06T08:00:00.000Z' }, ...extra];
    const served = await serve(s, port);
    const ran = runShim(['push', 'origin', 'task-1'], s.work, served.env);
    await eventually(() => port.recorded.length === 1 && ran.partial().stderr.includes('2026-11-06T08:00:00.000Z'));
    return { port, ran, ...served };
  }

  it('keeps the command waiting without showing the raw refusal', async () => {
    const s = stand();
    const { port, ran } = await refusedOnce(s);
    const shown = ran.partial().stderr;
    expect(shown).not.toContain('commit_refs_rules');
    expect(shown).not.toContain('remote rejected');
    expect(shown).toContain('nothing to investigate');
    expect(port.recorded[0]).toMatchObject({ settled: true, outcome: { kind: 'child', exitCode: 1, stderr: expect.stringContaining('commit_refs_rules') as string } });
    port.release();
    await ran;
  });

  it('finishes with the output of the attempt that worked', async () => {
    const s = stand();
    const { port, ran } = await refusedOnce(s);
    port.release();
    const ended = await ran;
    expect(ended.code).toBe(0);
    expect(ended.stderr).not.toContain('commit_refs_rules');
    expect(ended.stderr).toContain('-> task-1');
    expect(ended.stderr).toMatch(OPERATION_LINE);
    expect(remoteRef(s, 'refs/heads/task-1')).toBe(head(s));
    expect(port.registered).toHaveLength(1);
    expect(port.recorded.map(record => record.generation)).toEqual([1, 2]);
  });

  it('publishes the pinned commit when the local branch moved during the wait', async () => {
    const s = stand();
    const pinned = head(s);
    const { port, ran } = await refusedOnce(s);
    const later = commit(s.work, 'third');
    port.release();
    expect((await ran).code).toBe(0);
    expect(remoteRef(s, 'refs/heads/task-1')).toBe(pinned);
    expect(later).not.toBe(pinned);
    expect(head(s)).toBe(later);
  });

  it('looks the credential up again before each attempt', async () => {
    const s = stand();
    const { port, ran } = await refusedOnce(s);
    s.token = 'second-secret-token';
    port.release();
    await ran;
    expect(calls(s, 'push').map(call => call.token)).toEqual(['first-secret-token', 'second-secret-token']);
    expect(calls(s, 'push').every(call => call.nested === '1')).toBe(true);
  });

  it('uses the credential of a job bound again during the wait', async () => {
    const s = stand();
    const { port, ran, adapter } = await refusedOnce(s);
    adapter.bind(KEY, { ...jobOf(s), token: () => 'renewed-secret-token' });
    port.release();
    expect((await ran).code).toBe(0);
    expect(calls(s, 'push').map(call => call.token)).toEqual(['first-secret-token', 'renewed-secret-token']);
    expect(port.cancelled).toEqual([]);
  });

  it('stops without an attempt when the remote changed during the wait', async () => {
    const s = stand();
    const { port, ran } = await refusedOnce(s);
    realGit(s.work, 'remote', 'set-url', 'origin', `${s.url}.other`);
    port.release();
    const ended = await ran;
    expect(ended.code).toBe(128);
    expect(ended.stderr).toContain('the remote changed');
    expect(calls(s, 'push')).toHaveLength(1);
    expect(port.cancelled).toHaveLength(1);
  });

  it('stops without an attempt when the job ended during the wait', async () => {
    const s = stand();
    const { port, ran, adapter } = await refusedOnce(s);
    adapter.unbind(KEY);
    const ended = await ran;
    expect(ended.code).toBe(128);
    expect(ended.stderr).toContain('the turn ended');
    expect(calls(s, 'push')).toHaveLength(1);
    expect(port.cancelled).toEqual([{ operationId: port.registered[0]!.operationId, generation: 1 }]);
  });

  it('stops without an attempt when another job took the agent during the wait', async () => {
    const s = stand();
    const { port, ran, adapter } = await refusedOnce(s);
    adapter.bind(KEY, { ...jobOf(s), jobId: '20000000-0000-4000-8000-000000000009' });
    const ended = await ran;
    expect(ended.code).toBe(128);
    expect(calls(s, 'push')).toHaveLength(1);
    expect(port.cancelled).toHaveLength(1);
  });

  it('cancels the wait when the caller goes away and never pushes again', async () => {
    const s = stand();
    const { port, ran } = await refusedOnce(s);
    ran.signal('SIGTERM');
    await ran;
    await eventually(() => port.cancelled.length === 1);
    expect(calls(s, 'push')).toHaveLength(1);
  });

  it('says so when the server can no longer answer during a wait', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'refuse' }] });
    const port = new FakePort();
    port.readyFails = new Error('no link');
    port.replies = [{ accepted: true, state: 'deferred', nextAttemptAt: null }];
    const { env } = await serve(s, port);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(ran.code).toBe(128);
    expect(ran.stderr).toContain('stopped waiting');
    expect(calls(s, 'push')).toHaveLength(1);
    expect(port.cancelled).toHaveLength(1);
  });

  it('shows what Hornhoof ended it with when no attempt follows', async () => {
    const s = stand();
    const { port, ran } = await refusedOnce(s);
    port.release({ disposition: 'terminal', state: 'failed_permanent' });
    const ended = await ran;
    expect(ended.code).toBe(1);
    expect(ended.stderr).toContain('commit_refs_rules');
    expect(ended.stderr).toMatch(OPERATION_LINE);
    expect(calls(s, 'push')).toHaveLength(1);
  });

  it('keeps waiting through a grant to wait', async () => {
    const s = stand();
    const { port, ran } = await refusedOnce(s);
    port.release({ disposition: 'wait', nextAttemptAt: '2026-11-06T09:00:00.000Z' });
    await eventually(() => ran.partial().stderr.includes('2026-11-06T09:00:00.000Z'));
    port.release();
    expect((await ran).code).toBe(0);
    expect(calls(s, 'push')).toHaveLength(2);
  });
});

describe('a push with an unknown outcome', () => {
  it('reads the exact ref and does not push again when the remote already has the commit', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'accept_then_hang' }] });
    const port = new FakePort();
    const { env } = await serve(s, port);
    const sha = head(s);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(ran.code).toBe(0);
    expect(ran.stderr).not.toContain('hung up');
    expect(ran.stderr).toContain('already has');
    expect(ran.stderr).toMatch(OPERATION_LINE);
    expect(port.recorded[0]).toMatchObject({ observedHead: sha, outcome: { exitCode: 128 } });
    expect(calls(s, 'push')).toHaveLength(1);
    expect(calls(s, 'ls-remote').at(-1)!.argv).toEqual(['-C', s.work, 'ls-remote', 'origin', 'refs/heads/task-1']);
  });

  it('does not take another ref ending the same way for the target', async () => {
    const s = stand();
    realGit(s.work, 'push', '--quiet', 'origin', 'main:refs/tags/refs/heads/task-1');
    planFor(s, { push: [{ do: 'refuse' }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'outcome_unknown' }];
    const { env } = await serve(s, port);
    await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(port.recorded[0]!.observedHead).toBeNull();
  });

  it('says an absent target is absent and keeps the author error when nothing explains it', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'say', stderr: 'error: something unexpected\n', exit: 1 }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'outcome_unknown' }];
    const { env } = await serve(s, port);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(port.recorded[0]!.observedHead).toBeNull();
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('error: something unexpected');
    expect(ran.stderr).toMatch(/state=outcome_unknown$/m);
    expect(calls(s, 'push')).toHaveLength(1);
  });

  it('keeps waiting while the target cannot be read, then settles without a second push', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'accept_then_hang' }], 'ls-remote': [{ do: 'say', stderr: 'fatal: unable to access\n', exit: 128 }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'outcome_unknown' }, { accepted: true, state: 'satisfied' }];
    const { env } = await serve(s, port);
    const ran = runShim(['push', 'origin', 'task-1'], s.work, env);
    await eventually(() => port.recorded.length === 1 && ran.partial().stderr.includes('not known yet'));
    expect(port.recorded[0]!.observedHead).toBeUndefined();
    port.release();
    const ended = await ran;
    expect(ended.code).toBe(0);
    expect(calls(s, 'push')).toHaveLength(1);
    expect(port.recorded).toHaveLength(1);
  });

  it('reports the read as evidence of the current grant, never the old child as a new attempt', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'accept_then_hang' }], 'ls-remote': [{ do: 'say', stderr: 'fatal: unable to access\n', exit: 128 }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'outcome_unknown' }, { accepted: true, state: 'satisfied' }];
    const { env } = await serve(s, port);
    const sha = head(s);
    const ran = runShim(['push', 'origin', 'task-1'], s.work, env);
    await eventually(() => port.recorded.length === 1);
    await eventually(() => ran.partial().stderr.includes('not known yet'));
    port.release();
    await ran;
    const [first] = port.recorded, [read] = port.reconciled;
    expect(read).toEqual({
      operationId: first!.operationId, generation: 2, attemptId: '40000000-0000-4000-8000-000000000002', observedHead: sha,
      reconciles: { generation: 1, attemptId: first!.attemptId, receiptDigest: first!.receiptDigest },
      receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/) as string,
    });
    expect(read).not.toHaveProperty('outcome');
    expect(read).not.toHaveProperty('settled');
    expect(read!.receiptDigest).not.toBe(first!.receiptDigest);
  });

  it('never pushes again while the target stays unreadable', async () => {
    const s = stand();
    const unreadable = { do: 'say', stderr: 'fatal: unable to access\n', exit: 128 };
    planFor(s, { push: [{ do: 'refuse' }], 'ls-remote': [unreadable, unreadable] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'outcome_unknown' }, { accepted: true, state: 'outcome_unknown' }, { accepted: true, state: 'satisfied' }];
    const { env } = await serve(s, port);
    const ran = runShim(['push', 'origin', 'task-1'], s.work, env);
    await eventually(() => port.recorded.length === 1);
    port.release();
    await eventually(() => port.reconciled.length === 1);
    expect(port.reconciled[0]).not.toHaveProperty('observedHead');
    expect(calls(s, 'push')).toHaveLength(1);
    await eventually(() => ran.partial().stderr.match(/not known yet/g)?.length === 2);
    port.release();
    expect((await ran).code).toBe(0);
    expect(calls(s, 'push')).toHaveLength(2);
    expect(port.recorded.map(record => record.generation)).toEqual([1, 3]);
  });

  it('gives the first answer back when the read cannot be reported', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'refuse' }], 'ls-remote': [{ do: 'say', stderr: 'fatal: unable to access\n', exit: 128 }, { do: 'say', stderr: 'fatal: unable to access\n', exit: 128 }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'outcome_unknown' }];
    const { env } = await serve(s, port);
    const ran = runShim(['push', 'origin', 'task-1'], s.work, env);
    await eventually(() => port.recorded.length === 1);
    port.recordFails = new Error('no link');
    port.release();
    const ended = await ran;
    expect(ended.code).toBe(1);
    expect(ended.stderr).toContain('commit_refs_rules');
    expect(calls(s, 'push')).toHaveLength(1);
  });

  it('pushes again only after reading that the target still differs', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'refuse' }], 'ls-remote': [{ do: 'say', stderr: 'fatal: unable to access\n', exit: 128 }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'outcome_unknown' }, { accepted: true, state: 'satisfied' }];
    const { env } = await serve(s, port);
    const ran = runShim(['push', 'origin', 'task-1'], s.work, env);
    await eventually(() => port.recorded.length === 1);
    port.release();
    expect((await ran).code).toBe(0);
    expect(calls(s, 'push')).toHaveLength(2);
    expect(calls(s, 'ls-remote').length).toBeGreaterThanOrEqual(2);
    expect(remoteRef(s, 'refs/heads/task-1')).toBe(head(s));
    expect(port.reconciled).toEqual([]);
  });

  it('keeps the first answer when the node cannot record the result', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'say', stderr: 'error: something unexpected\n', exit: 1 }] });
    const port = new FakePort();
    port.recordFails = new Error('no link');
    const { env } = await serve(s, port);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('error: something unexpected');
    expect(calls(s, 'push')).toHaveLength(1);
  });

  it('gives the result of a stale generation back without another attempt', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'refuse' }] });
    const port = new FakePort();
    port.replies = [{ accepted: false, state: 'deferred', nextAttemptAt: null }];
    const { env } = await serve(s, port);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('commit_refs_rules');
    expect(calls(s, 'push')).toHaveLength(1);
  });

  it('leaves a settled unknown result to the author with its real exit code', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'say', stderr: 'error: strange\n', stdout: 'report\n', exit: 3 }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'outcome_unknown' }];
    const { env } = await serve(s, port);
    realGit(s.work, 'push', '--quiet', 'origin', 'main:refs/heads/task-1');
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(port.recorded[0]!.observedHead).toBe(remoteRef(s, 'refs/heads/task-1'));
    expect(ran).toMatchObject({ code: 3, stdout: 'report\n' });
    expect(ran.stderr).toContain('error: strange');
  });
});

describe('a permanent refusal', () => {
  it('reaches the author as real git said it, once', async () => {
    const s = stand();
    realGit(s.work, 'push', '--quiet', 'origin', 'task-1');
    const other = mkdtempSync(join(s.dir, 'other-'));
    realGit(other, 'clone', '--quiet', '--branch', 'task-1', s.url, '.');
    realGit(other, 'config', 'user.name', 'Test');
    realGit(other, 'config', 'user.email', 'test@example.test');
    commit(other, 'theirs');
    realGit(other, 'push', '--quiet', 'origin', 'task-1');
    realGit(s.work, 'fetch', '--quiet', 'origin', 'task-1');
    commit(s.work, 'mine');
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'failed_permanent' }];
    const { env } = await serve(s, port);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('rejected');
    expect(ran.stderr).toContain('non-fast-forward');
    expect(ran.stderr).toMatch(/state=failed_permanent$/m);
    expect(calls(s, 'push')).toHaveLength(1);
    expect(port.recorded[0]).toMatchObject({ outcome: { exitCode: 1 } });
  });
});
