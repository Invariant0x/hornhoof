import { rmSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ExternalGitOutcome } from '@hornhoof/protocol';
import { parseGitMarker, type GitRegistration } from '../src/external-git.js';
import { eventually } from '../../../test-support/eventually.mjs';
import { answer, calls, FakePort, graceClock, hanging, head, jobOf, KEY, killed, planFor, realGit, runShim, serve, type Stand, stand } from './external-git-helpers.js';

describe('what stays unmanaged at the node', () => {
  const pushed = (s: Stand) => ({ kind: 'push', cwd: s.work, remote: 'origin', sourceSha: head(s), destinationRef: 'refs/heads/task-1', upstreamBranch: null, flags: [] });

  it('answers adapter_off while the wire is off and real git still works', async () => {
    const s = stand();
    const served = await serve(s, null);
    expect(await answer(served, pushed(s))).toEqual([{ type: 'unmanaged', reason: 'adapter_off' }]);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, served.env);
    expect(ran.code).toBe(0);
    expect(calls(s, 'push').map(call => call.nested)).toEqual([null]);
  });

  it('answers no_current_job between turns', async () => {
    const s = stand();
    const port = new FakePort();
    const served = await serve(s, port, false);
    expect(await answer(served, pushed(s))).toEqual([{ type: 'unmanaged', reason: 'no_current_job' }]);
    expect(port.registered).toEqual([]);
  });

  it('never runs git of an agent repository as root', async () => {
    const s = stand();
    const port = new FakePort();
    const served = await serve(s, port, false);
    served.adapter.bind(KEY, { ...jobOf(s), user: { uid: 0, gid: 0 } });
    expect(await answer(served, pushed(s))).toEqual([{ type: 'unmanaged', reason: 'no_agent_user' }]);
    expect(calls(s, 'remote')).toEqual([]);
    expect(port.registered).toEqual([]);
  });

  it('takes a user it cannot become as a remote it cannot read', async () => {
    const s = stand();
    const port = new FakePort();
    const served = await serve(s, port, false);
    const other = (process.getuid?.() ?? 1000) + 1;
    served.adapter.bind(KEY, { ...jobOf(s), user: { uid: other, gid: other } });
    expect(await answer(served, pushed(s))).toEqual([{ type: 'unmanaged', reason: 'foreign_endpoint' }]);
    expect(port.registered).toEqual([]);
  });

  it('answers foreign_endpoint for a remote outside the job repository', async () => {
    const s = stand();
    const port = new FakePort();
    const served = await serve(s, port);
    realGit(s.work, 'remote', 'add', 'other', `${s.url}.other`);
    expect(await answer(served, { ...pushed(s), remote: 'other' })).toEqual([{ type: 'unmanaged', reason: 'foreign_endpoint' }]);
    expect(port.registered).toEqual([]);
  });

  it('answers foreign_endpoint for a remote it cannot read', async () => {
    const s = stand();
    const port = new FakePort();
    const served = await serve(s, port);
    expect(await answer(served, { ...pushed(s), remote: 'nothing' })).toEqual([{ type: 'unmanaged', reason: 'foreign_endpoint' }]);
  });

  it('answers port_unavailable when the server cannot take the operation', async () => {
    const s = stand();
    const port = new FakePort();
    port.registerFails = new Error('unsupported producer');
    const served = await serve(s, port);
    expect(await answer(served, pushed(s))).toEqual([{ type: 'unmanaged', reason: 'port_unavailable' }]);
    expect(calls(s, 'push')).toEqual([]);
  });

  it.each<[string, (s: Stand) => unknown]>([
    ['text', () => 'not json'],
    ['a command line', s => ({ kind: 'push', cwd: s.work, argv: ['push', '--force'] })],
    ['extra fields', s => ({ ...pushed(s), env: { HH_GIT_PASSWORD: 'stolen' } })],
    ['a force flag', s => ({ ...pushed(s), flags: ['--force'] })],
    ['a source that is no commit', s => ({ ...pushed(s), sourceSha: 'main' })],
    ['a target outside branches', s => ({ ...pushed(s), destinationRef: 'refs/tags/v1' })],
    ['a remote that reads as an option', s => ({ ...pushed(s), remote: '--receive-pack=x' })],
    ['a relative folder', s => ({ ...pushed(s), cwd: 'work' })],
    ['a forced fetch', s => ({ kind: 'fetch', cwd: s.work, remote: 'origin', refspec: '+a:b', flags: [] })],
    ['a dynamic fetch', s => ({ kind: 'fetch', cwd: s.work, remote: 'origin', refspec: 'refs/heads/*:refs/x/*', flags: [] })],
  ])('turns %s down without running anything', async (_name, body) => {
    const s = stand();
    const port = new FakePort();
    const served = await serve(s, port);
    expect(await answer(served, body(s))).toEqual([{ type: 'unmanaged', reason: 'invalid_request' }]);
    expect(port.registered).toEqual([]);
    expect(calls(s, 'push')).toEqual([]);
  });

  it('turns an intent the protocol refuses down', async () => {
    const s = stand();
    const port = new FakePort();
    const served = await serve(s, port);
    expect(await answer(served, { ...pushed(s), destinationRef: 'refs/heads/a..b' })).toEqual([{ type: 'unmanaged', reason: 'invalid_request' }]);
    expect(port.registered).toEqual([]);
  });

  it('answers a closing terminal grant without any attempt', async () => {
    const s = stand();
    const port = new FakePort();
    port.registration = { disposition: 'terminal', state: 'satisfied', attemptId: null } as Partial<GitRegistration>;
    const served = await serve(s, port);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, served.env);
    expect(ran.code).toBe(0);
    expect(ran.stderr).toMatch(/state=satisfied$/m);
    expect(calls(s, 'push')).toEqual([]);
    port.registration = { disposition: 'terminal', state: 'cancelled', attemptId: null } as Partial<GitRegistration>;
    const stopped = await runShim(['push', 'origin', 'task-1'], s.work, served.env);
    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toContain('fatal: Hornhoof ended this git operation');
    expect(stopped.stderr).toMatch(/state=cancelled$/m);
  });
});

describe('the marker is only telemetry', () => {
  const operationId = '50000000-0000-4000-8000-000000000005';

  it('reads only a whole well formed line', () => {
    expect(parseGitMarker(`hornhoof-git: operation=${operationId} generation=2 state=satisfied`)).toEqual({ operationId, generation: 2, state: 'satisfied' });
    expect(parseGitMarker(`x hornhoof-git: operation=${operationId} generation=2 state=satisfied`)).toBeNull();
    expect(parseGitMarker(`hornhoof-git: operation=${operationId} generation=2 state=done`)).toBeNull();
    expect(parseGitMarker(`hornhoof-git: operation=nope generation=2 state=satisfied`)).toBeNull();
    expect(parseGitMarker(`hornhoof-git: operation=${operationId} generation=0 state=satisfied`)).toBeNull();
    expect(parseGitMarker(`hornhoof-git: operation=${operationId} generation=2 state=satisfied\nmore`)).toBeNull();
    expect(parseGitMarker(`hornhoof-git: operation=${operationId} generation=${'9'.repeat(400)} state=satisfied`)).toBeNull();
  });

  it('proves nothing when a command prints one', async () => {
    const s = stand();
    const forged = `hornhoof-git: operation=${operationId} generation=1 state=satisfied`;
    planFor(s, { push: [{ do: 'say', stderr: `${forged}\n`, stdout: `${forged}\n`, exit: 0 }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'failed_permanent' }];
    const { env, adapter } = await serve(s, port);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(ran.stdout).toContain(forged);
    expect(adapter.proves(KEY, parseGitMarker(forged)!)).toBe(false);
    expect(adapter.operations(KEY).map(known => known.operationId)).not.toContain(operationId);
    expect(port.recorded[0]!.operationId).not.toBe(operationId);
  });

  it('proves an operation only with the receipt of this agent', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'refuse' }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'failed_permanent' }];
    const { env, adapter } = await serve(s, port);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    const marker = parseGitMarker(ran.stderr.trim().split('\n').at(-1)!);
    expect(marker).toMatchObject({ generation: 1, state: 'failed_permanent' });
    expect(adapter.proves(KEY, marker!)).toBe(true);
    expect(adapter.proves('10000000-0000-4000-8000-00000000000f', marker!)).toBe(false);
    expect(adapter.proves(KEY, { ...marker!, state: 'satisfied' })).toBe(false);
    expect(adapter.proves(KEY, { ...marker!, generation: 2 })).toBe(false);
    expect(adapter.proves('10000000-0000-4000-8000-00000000000f', { ...marker!, operationId })).toBe(false);
  });

  it('forgets the receipts of an agent whose job ended and stays bounded', async () => {
    const s = stand();
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'failed_permanent' }];
    planFor(s, { push: [{ do: 'refuse' }] });
    const { env, adapter } = await serve(s, port);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    const marker = parseGitMarker(ran.stderr.trim().split('\n').at(-1)!)!;
    adapter.unbind(KEY);
    expect(adapter.proves(KEY, marker)).toBe(false);
  });

  it('keeps only the newest receipts of a long job', async () => {
    const s = stand();
    const port = new FakePort();
    const { env, adapter } = await serve(s, port, true, { keptReceipts: 2 });
    planFor(s, { push: Array.from({ length: 3 }, () => ({ do: 'say', stderr: 'error: strange\n', exit: 1 })) });
    port.replies = Array.from({ length: 3 }, () => ({ accepted: true, state: 'failed_permanent' }));
    const markers = [];
    for (let i = 0; i < 3; i++) markers.push(parseGitMarker((await runShim(['push', 'origin', 'task-1'], s.work, env)).stderr.trim().split('\n').at(-1)!)!);
    expect(adapter.proves(KEY, markers[0]!)).toBe(false);
    expect(adapter.proves(KEY, markers[2]!)).toBe(true);
  });

  it('shows an active wait only from what it owns', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'refuse' }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'deferred', nextAttemptAt: null }];
    const { env, adapter } = await serve(s, port);
    expect(adapter.operations(KEY)).toEqual([]);
    const ran = runShim(['push', 'origin', 'task-1'], s.work, env);
    await eventually(() => port.recorded.length === 1);
    await eventually(() => adapter.operations(KEY)[0]?.state === 'waiting');
    expect(adapter.operations(KEY)).toEqual([{ operationId: port.registered[0]!.operationId, state: 'waiting' }]);
    port.release();
    await ran;
    expect(adapter.operations(KEY)).toEqual([]);
  });
});

describe('the child the node owns', () => {
  it('hides the credential and bounds what it reports', async () => {
    const s = stand();
    const long = `${'e'.repeat(9000)} first-secret-token\nfatal: https://name:first-secret-token@example.test/x\n`;
    planFor(s, { push: [{ do: 'say', stderr: long, exit: 1 }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'failed_permanent' }];
    const { env } = await serve(s, port);
    await runShim(['push', 'origin', 'task-1'], s.work, env);
    const outcome = port.recorded[0]!.outcome as Extract<ExternalGitOutcome, { kind: 'child' }>;
    expect(ExternalGitOutcome.safeParse(outcome).success).toBe(true);
    expect(outcome.stderr).not.toContain('first-secret-token');
    expect(outcome.stderr.length).toBeLessThanOrEqual(8192);
    expect(outcome.stderrTruncated).toBe(true);
    expect(outcome.stderr).toContain('[hidden]');
  });

  it('holds output within its bound while keeping the end', async () => {
    const s = stand();
    const huge = `${'x'.repeat(2 * 1024 * 1024)}\nthe end\n`;
    planFor(s, { push: [{ do: 'say', stderr: huge, exit: 1 }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'failed_permanent' }];
    const { env } = await serve(s, port, true, { heldBytes: 64 * 1024 });
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(ran.stderr).toContain('the end');
    expect(ran.stderr).toContain('output shortened');
    expect(ran.stderr.length).toBeLessThan(256 * 1024);
  });

  it('stops its child when the caller goes away and reports it settled', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'hang' }] });
    const port = new FakePort();
    const { env } = await serve(s, port);
    const ran = runShim(['push', 'origin', 'task-1'], s.work, env);
    await eventually(() => calls(s, 'push').length === 1);
    ran.signal('SIGTERM');
    await ran;
    await eventually(() => port.recorded.length === 1);
    expect(port.recorded[0]).toMatchObject({ settled: true, outcome: { kind: 'child' } });
    await eventually(() => port.cancelled.length === 1);
  });

  it('kills a child that ignores the request to stop', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'ignore_term' }] });
    const port = new FakePort();
    graceClock();
    const signals = killed();
    const { env } = await serve(s, port, true, { stopGraceMs: 300 });
    const ran = runShim(['push', 'origin', 'task-1'], s.work, env);
    await eventually(() => hanging(s));
    ran.signal('SIGTERM');
    await ran;
    await eventually(() => signals().length === 1);
    await vi.advanceTimersByTimeAsync(299);
    expect(signals()).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals()).toEqual(['SIGTERM', 'SIGKILL']);
    await eventually(() => port.recorded.length === 1);
    expect(port.recorded[0]).toMatchObject({ settled: true, outcome: { exitCode: null, signal: 'SIGKILL' } });
  });

  it('calls a child that cannot be stopped unsettled, which admits no new writer', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'hang' }] });
    const port = new FakePort();
    graceClock();
    const signals: string[] = [];
    const { env } = await serve(s, port, true, { stopGraceMs: 20, kill: (_pid, signal) => { signals.push(signal); } });
    const ran = runShim(['push', 'origin', 'task-1'], s.work, env);
    await eventually(() => calls(s, 'push').length === 1);
    ran.signal('SIGTERM');
    await ran;
    await eventually(() => signals.length === 1);
    await vi.advanceTimersByTimeAsync(19);
    expect(signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    await vi.advanceTimersByTimeAsync(19);
    expect(port.recorded).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await eventually(() => port.recorded.length === 1);
    expect(port.recorded[0]!.settled).toBe(false);
    await eventually(() => port.cancelled.length === 1);
    expect(calls(s, 'push')).toHaveLength(1);
  });

  it('reports a child it could not start with its operating system code', async () => {
    const s = stand();
    const port = new FakePort();
    port.beforeRegister = () => rmSync(s.bin);
    port.replies = [{ accepted: true, state: 'failed_permanent' }];
    const { env } = await serve(s, port);
    const ran = await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(ran.code).toBe(127);
    expect(port.recorded[0]).toMatchObject({ settled: true, outcome: { kind: 'child', exitCode: null, signal: null, osCode: 'ENOENT' } });
  });

  it('does not wait for a stray process that keeps the pipes open, and does not call that settled', async () => {
    const s = stand();
    planFor(s, { push: [{ do: 'leave_process' }] });
    const port = new FakePort();
    port.replies = [{ accepted: true, state: 'outcome_unknown' }];
    graceClock();
    const { env } = await serve(s, port, true, { exitGraceMs: 50 });
    /* The stray process lives 30 s, past the runner's limit for the test: waiting for it would fail the test. */
    const running = runShim(['push', 'origin', 'task-1'], s.work, env);
    /* git ended: the node's grace for the pipes is its only timer that runs now. */
    await eventually(() => calls(s, 'push').length === 1 && vi.getTimerCount() === 1);
    await vi.advanceTimersByTimeAsync(49);
    expect(port.recorded).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const ran = await running;
    expect(ran.code).toBe(0);
    expect(ran.stderr).toContain('-> task-1');
    expect(ran.stderr).toMatch(/state=outcome_unknown$/m);
    expect(port.recorded[0]).toMatchObject({ settled: false, outcome: { exitCode: 0 } });
  });

  it('reads the target again only for a push', async () => {
    const s = stand();
    const port = new FakePort();
    const { env } = await serve(s, port);
    await runShim(['fetch', 'origin', 'main'], s.work, env);
    await runShim(['push', 'origin', 'task-1'], s.work, env);
    expect(calls(s, 'ls-remote')).toEqual([]);
  });
});
