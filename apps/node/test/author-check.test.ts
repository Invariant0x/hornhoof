import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { AuthorCheckPorts, AuthorCheckout } from '../src/author-check.js';
import { parseAuthorCheckOutput, runAuthorCheck } from '../src/author-check.js';
import { AuthorCheckExecutor, createAuthorCheckPorts, type AuthorCommand } from '../src/author-check-runtime.js';
import { CheckClient } from '../src/check-client.js';
import { setCheckClient } from '../src/check-queue.js';

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn() }));

const id = '11111111-1111-4111-8111-111111111111';
const request = { type: 'author_check.run' as const, requestId: id, jobId: id, agentId: id, taskId: id,
  repoUrl: 'https://github.com/acme/shop.git', branch: 'task-1', baseCommit: 'a'.repeat(40), commit: 'b'.repeat(40), paths: ['logic/totals.ts'] };
/* A sample of scripts/author-check/stages.mjs's existing structured output. No child program runs in these tests. */
const record = { version: 1, submissionCommit: request.commit, checkCommit: request.commit,
  scope: { kind: 'changed', paths: request.paths },
  stages: ['format', 'lint', 'types', 'tests', 'crapper', 'dryer'].map(name => ({ name, status: name === 'format' ? 'unavailable' : 'passed', exitCode: name === 'format' ? null : 0, partId: null })),
  numbers: { tests: { passed: 2, failed: 0, total: 2, skipped: 0 }, worstCrap: 2, dryerFlags: 0 } };
const output = (extra = {}) => `AUTHOR_CHECK ${JSON.stringify({ ...record, ...extra })}\n`;

function fake(overrides: Partial<AuthorCheckout> = {}) {
  const actions: string[] = [];
  const checkout = { repoUrl: request.repoUrl, commit: request.commit, baseCommit: request.baseCommit, clean: true, ...overrides };
  const ports: AuthorCheckPorts = {
    inspect: async place => { actions.push(place); return checkout; },
    execute: async () => { actions.push('execute'); return { exitCode: 0, output: output() }; },
    finish: async () => { actions.push('finish'); }, now: () => new Date('2026-11-17T00:00:00Z'),
  };
  return { ports, actions };
}

function recordedProcesses() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
  onTestFinished(() => { vi.useRealTimers(); vi.mocked(spawn).mockReset(); setCheckClient(null); });
  vi.mocked(spawn).mockImplementation((_program, args) => {
    const words = Array.isArray(args) ? args : [];
    const cwd = words[3], program = words[4], command = words.slice(5).join(' ');
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 555 });
    const text = program === process.execPath ? output() : command === 'rev-parse HEAD' ? request.commit
      : command === 'remote get-url origin' ? request.repoUrl : command === 'rev-parse --show-toplevel' ? cwd : '';
    queueMicrotask(() => { child.stdout.end(text); child.emit('close', 0, null); });
    return child as unknown as ReturnType<typeof spawn>;
  });
}

describe('author check execution owned by the node', () => {
  it('uses the process exit and fixed argument vector from recorded child output', async () => {
    recordedProcesses();
    const ports = createAuthorCheckPorts(request, { dir: '/work', home: '/home/agent', user: { uid: 20001, gid: 20001 } });
    expect(await runAuthorCheck(request, ports)).toMatchObject({ reason: null, crap: { kind: 'measured', max: 2 } });
    expect(vi.mocked(spawn).mock.calls.every(call => call[2]?.uid === 20001 && call[2]?.gid === 20001)).toBe(true);
  });

  it('never executes a candidate as root', async () => {
    recordedProcesses();
    const ports = createAuthorCheckPorts(request, { dir: '/work', home: '/root', user: { uid: 0, gid: 0 } });
    expect(await runAuthorCheck(request, ports)).toMatchObject({ reason: 'unavailable' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('accepts a server request once, through a real check lease, and emits its own completion', async () => {
    recordedProcesses();
    const client = new CheckClient(frame => {
      if (frame.type === 'check.acquire') queueMicrotask(() => client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 }));
      return true;
    });
    client.online(true); setCheckClient(client);
    let resolve!: (value: unknown) => void;
    const done = new Promise<unknown>(finish => { resolve = finish; });
    const executor = new AuthorCheckExecutor({ dir: '/work', builtin: null, credUser: { uid: 20001, gid: 20001 }, home: '/home/agent', emit: resolve });
    expect(executor.consume({ type: 'job.cancel', jobId: id })).toBe(false);
    expect(executor.consume(request)).toBe(true);
    expect(executor.consume(request)).toBe(true);
    expect(await done).toMatchObject({ type: 'author_check.done', reason: null, exitCode: 0 });
    executor.stop('other-job'); executor.stop();
  });

  it('cancels an author request queued for its job without starting a process', async () => {
    recordedProcesses();
    const client = new CheckClient(() => true);
    client.online(true); setCheckClient(client);
    let resolve!: (value: unknown) => void;
    const done = new Promise<unknown>(finish => { resolve = finish; });
    const executor = new AuthorCheckExecutor({ dir: '/work', builtin: null, credUser: { uid: 20001, gid: 20001 }, home: '/home/agent', emit: resolve });
    executor.consume(request); executor.stop(id);
    expect(await done).toMatchObject({ reason: 'unavailable', exitCode: null });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('executes the fixed script in a worktree at the assigned SHA with no author environment', async () => {
    const commands: { program: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
    const root = `/work/work/agents/${id}/shop`;
    const run: AuthorCommand = async (program, args, options) => {
      commands.push({ program, args, cwd: options.cwd, env: options.env });
      if (program === process.execPath) return { exitCode: 0, output: output() };
      const value = args.join(' ');
      const text = value === 'rev-parse HEAD' ? request.commit : value === 'remote get-url origin' ? request.repoUrl : value === 'rev-parse --show-toplevel' ? options.cwd : '';
      return { exitCode: 0, output: text };
    };
    const ports = createAuthorCheckPorts(request, { dir: '/work', home: '/home/agent', user: { uid: 20001, gid: 20001 } }, run);
    expect(await runAuthorCheck(request, ports)).toMatchObject({ reason: null });
    const script = commands.find(command => command.program === process.execPath)!;
    expect(script.args).toEqual(['scripts/author-check.mjs', '--sha', request.commit, '--base', request.baseCommit]);
    expect(script.cwd).not.toBe(root);
    expect(script.env.HOME).toBe('/home/agent');
    expect(commands.find(command => command.args[0] === 'worktree' && command.args[1] === 'add')?.args).toEqual(['worktree', 'add', '--detach', '--', script.cwd, request.commit]);
    expect(commands.find(command => command.args[1] === 'remove')?.args).toEqual(['worktree', 'remove', '--force', '--', script.cwd]);
  });

  it('records only the pinned result of its own execution and checks the finished checkout', async () => {
    const f = fake();
    expect(await runAuthorCheck(request, f.ports)).toMatchObject({ type: 'author_check.done', commit: request.commit, baseCommit: request.baseCommit, reason: null, exitCode: 0, crap: { kind: 'measured', max: 2 } });
    expect(f.actions).toEqual(['source', 'execute', 'checked', 'source', 'finish']);
  });

  it.each([
    [{ clean: false }, 'dirty_tree'], [{ commit: 'c'.repeat(40) }, 'sha_mismatch'],
    [{ baseCommit: null }, 'base_mismatch'], [{ repoUrl: 'https://github.com/elsewhere/shop.git' }, 'repository_mismatch'],
  ] as const)('refuses an unverified checkout %j before execution', async (snapshot, reason) => {
    const f = fake(snapshot);
    expect(await runAuthorCheck(request, f.ports)).toMatchObject({ reason, exitCode: null, crap: { kind: 'unknown' } });
    expect(f.actions).not.toContain('execute');
  });

  it('cannot turn an execution failure with green-looking JSON into a pass', async () => {
    const f = fake();
    f.ports.execute = async () => ({ exitCode: 1, output: output() });
    expect(await runAuthorCheck(request, f.ports)).toMatchObject({ exitCode: 1, reason: 'failed' });
  });

  it('refuses a source tree changed during the check and releases its worktree', async () => {
    const f = fake();
    f.ports.inspect = async place => ({ repoUrl: request.repoUrl, commit: request.commit, baseCommit: request.baseCommit, clean: place === 'source' ? !f.actions.includes('execute') : true });
    expect(await runAuthorCheck(request, f.ports)).toMatchObject({ reason: 'checkout_changed' });
    expect(f.actions).toContain('finish');
  });

  it.each(['not json', output({ checkCommit: 'c'.repeat(40) }), output({ scope: { kind: 'changed', paths: ['elsewhere.ts'] } }), `${output()}${output()}`])('refuses missing, forged or duplicated output', text => {
    expect(parseAuthorCheckOutput(text, request)).toBeNull();
  });

  it('keeps unknown CRAP distinct from a document with no functions', () => {
    const missing = { ...record.numbers, worstCrap: null };
    expect(parseAuthorCheckOutput(output({ numbers: missing }), request)).toEqual({ kind: 'unknown' });
    const docs = { ...request, paths: ['guide/install.md'] };
    expect(parseAuthorCheckOutput(output({ numbers: missing, scope: { kind: 'changed', paths: docs.paths } }), docs)).toEqual({ kind: 'no_functions' });
  });

  it('refuses a failed stage even when a document result claims exit zero', () => {
    const docs = { ...request, paths: ['guide/install.md'] };
    const stages = record.stages.map(stage => stage.name === 'tests' ? { ...stage, status: 'failed', exitCode: 1 } : stage);
    expect(parseAuthorCheckOutput(output({ stages, numbers: { ...record.numbers, worstCrap: null }, scope: { kind: 'changed', paths: docs.paths } }), docs)).toBeNull();
  });
});
