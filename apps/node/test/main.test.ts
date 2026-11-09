import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseNodeMessage, parseTestEnvironment } from '@hornhoof/protocol';
import { readTestEnvironment } from '../src/test-environment.js';
import { buildOf, runNode } from '../src/main.js';
import { prepareNodeStop } from '../src/lifecycle.js';
import { ProgramUpdates } from '../src/program-updates.js';
import { antigravityAdapter } from '../src/providers/antigravity.js';
import { TerminalHost } from '../src/terminal/host.js';
import { claudeProgram } from '../src/terminal/programs.js';
import { Tmux } from '../src/terminal/tmux.js';
import type { ProviderAdapter, RunInput } from '../src/runner.js';
import { isRemoved, writeState } from '../src/state.js';
import type { runTests } from '../src/tests.js';
import { testPort } from '../../../test-support/ports.mjs';

vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>();
  return { ...os, uptime: vi.fn(os.uptime) };
});

const adapter: ProviderAdapter = {
  install: async () => {},
  loggedIn: async () => true,
  login: async () => {},
  secrets: async () => [],
  run: async () => ({ ok: true, sessionId: 'sess-9', result: 'ready', output: '', error: null, limits: { status: 'allowed', windows: [] } }),
};

function grantCheck(socket: WebSocket, frame: { type: string; id?: string }, allowed: boolean): void {
  if (allowed && frame.type === 'check.acquire') socket.send(JSON.stringify({ type: 'check.state', id: frame.id, state: 'running', position: 0 }));
}

async function fakeServer(grantChecks = true) {
  const server = new WebSocketServer({ port: await testPort(), host: '127.0.0.1' });
  onTestFinished(() => server.close());
  await new Promise(r => server.once('listening', r));
  const received: { type: string; [k: string]: unknown }[] = [];
  let socket: WebSocket | null = null;
  server.on('connection', s => {
    socket = s;
    s.on('message', data => {
      const frame = JSON.parse(String(data)) as { type: string; id?: string };
      received.push(frame);
      grantCheck(s, frame, grantChecks);
    });
  });
  const wait = async (check: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 10));
    expect(check()).toBe(true);
  };
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received, send: (m: object) => socket!.send(JSON.stringify(m)), drop: () => socket!.terminate(), wait };
}

function nodeDir(server: string) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-data-'));
  writeState(dir, { server, subscriptionId: 's1', provider: 'claude', key: 'node-key-1234567890' });
  for (const sub of ['home', 'work']) {
    mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, sub, 'file'), 'x');
  }
  return dir;
}

describe('reporting the node lifecycle', () => {
  it('reports a real SIGKILL as an unclean exit with the previous process log after startup', async () => {
    const server = await fakeServer();
    const dir = nodeDir(server.url);
    const start = () => {
      const child = spawn(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'fakes', 'run-lifecycle.mjs')], { env: { TASK187_NODE_DIR: dir, PATH: process.env.PATH }, stdio: 'ignore' });
      onTestFinished(() => { child.kill('SIGKILL'); });
      return child;
    };
    const first = start();
    await server.wait(() => server.received.some(m => m.type === 'hello'), 6000);
    const boot = server.received[0]!.boot as { startedAt: string };
    const ended = once(first, 'exit');
    first.kill('SIGKILL');
    await ended;
    start();
    await server.wait(() => server.received.filter(m => m.type === 'hello').length === 2, 6000);
    expect(server.received.findLast(m => m.type === 'hello')).toMatchObject({ restart: { kind: 'unplanned', reason: 'unclean_exit', at: null, startedAt: boot.startedAt, log: expect.stringContaining(`Node started at ${boot.startedAt}.`) } });
    expect(server.received.filter(m => m.type === 'node.stopping')).toEqual([]);
  });

  it('reports a completed update before closing, and carries it into the next process hello', async () => {
    const server = await fakeServer();
    const dir = nodeDir(server.url);
    const first = await runNode({ dir, adapter, log: () => {} });
    onTestFinished(() => first.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    const boot = server.received[0]!.boot as { startedAt: string };
    prepareNodeStop(dir, 'node_update');
    first.stop();
    await server.wait(() => server.received.some(m => m.type === 'node.stopping'));
    expect(server.received.find(m => m.type === 'node.stopping')).toMatchObject({ startedAt: boot.startedAt, exit: { kind: 'planned', reason: 'node_update' } });
    const second = await runNode({ dir, adapter, log: () => {} });
    onTestFinished(() => second.stop());
    await server.wait(() => server.received.filter(m => m.type === 'hello').length === 2);
    expect(server.received.findLast(m => m.type === 'hello')).toMatchObject({ restart: { kind: 'planned', reason: 'node_update', startedAt: boot.startedAt, log: expect.stringContaining('Node stopping: node_update.') } });
  });

  it('sanitizes its own diagnostics before persistence or output and keeps agent output separate', async () => {
    const server = await fakeServer();
    const dir = nodeDir(server.url);
    const logs: string[] = [];
    const secret = 'opaque-provider-secret-12345';
    const node = await runNode({ dir, adapter: { ...adapter, secrets: async () => [secret] }, log: line => logs.push(line), install: async () => { throw new Error(`Installer failed with ${secret}, Authorization: Bearer auth-secret-123`); } });
    onTestFinished(() => node.stop());
    await server.wait(() => logs.some(line => line.includes('Could not install')));
    const state = readFileSync(join(dir, 'node-runtime.json'), 'utf8');
    for (const text of [state, logs.join('\n')]) {
      expect(text).toContain('Could not install');
      expect(text).not.toContain(secret);
      expect(text).not.toContain('auth-secret-123');
    }
    expect(state).not.toContain('sess-9');
  });

  it('sends the current log on a socket reconnect without claiming that the process ended', async () => {
    const server = await fakeServer();
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    const before = server.received[0]!;
    server.drop();
    await server.wait(() => server.received.filter(m => m.type === 'hello').length === 2, 6000);
    const after = server.received.findLast(m => m.type === 'hello')!;
    expect(after.boot).toEqual(before.boot);
    expect(after.restart).toMatchObject({ kind: 'unknown', reason: 'unknown' });
    expect(after.nodeLog).toContain('Connection closed');
    expect(server.received.filter(m => m.type === 'node.stopping')).toEqual([]);
  });
});

describe('reporting managed programs', () => {
  it('reports startup and explicit updates without stopping an active job, and coalesces requests', async () => {
    const server = await fakeServer();
    let version = '1.0.0';
    const releases: (() => void)[] = [];
    const programs = new ProgramUpdates([{ id: 'claude', readVersion: () => version, install: async () => {
      await new Promise<void>(resolve => releases.push(resolve));
      version = `${releases.length + 1}.0.0`;
    } }]);
    let finishJob: (() => void) | undefined;
    let cancelled = false;
    const running = { ...adapter, run: async (input: RunInput) => {
      input.signal?.addEventListener('abort', () => { cancelled = true; });
      await new Promise<void>(resolve => { finishJob = resolve; });
      return adapter.run(input);
    } };
    const node = await runNode({ dir: nodeDir(server.url), adapter: running, programs, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    expect(server.received[0]).toMatchObject({ programs: [{ id: 'claude', version: '1.0.0', updating: true, failed: false }] });
    releases[0]!();
    await server.wait(() => server.received.some(m => m.type === 'status' && JSON.stringify(m.programs).includes('2.0.0')));
    server.send({ type: 'job.run', jobId: 'active-update', subscriptionId: 's1', provider: 'claude', prompt: 'finish this', sessionId: null, model: null, timeoutMs: 20000, secret: null, instructions: null, toolToken: null });
    await server.wait(() => finishJob !== undefined);
    server.send({ type: 'programs.update' });
    server.send({ type: 'programs.update' });
    server.send({ type: 'agent.say', agentKey: 'none', text: 'barrier', ref: 'updates-queued' });
    await server.wait(() => server.received.some(m => m.type === 'agent.said' && m.ref === 'updates-queued'));
    expect(releases).toHaveLength(2);
    expect(server.received.filter(m => m.type === 'status').at(-1)).toMatchObject({ programs: [{ version: '2.0.0', updating: true, failed: false }] });
    releases[1]!();
    await server.wait(() => server.received.some(m => m.type === 'status' && JSON.stringify(m.programs).includes('3.0.0')));
    expect(cancelled).toBe(false);
    expect(server.received.some(m => m.type === 'job.done' && m.jobId === 'active-update')).toBe(false);
    finishJob!();
    await server.wait(() => server.received.some(m => m.type === 'job.done' && m.jobId === 'active-update'));
    expect(server.received.find(m => m.type === 'job.done' && m.jobId === 'active-update')).toMatchObject({ ok: true, result: 'ready' });
  });

  it('reports an update failure without npm output and permits an explicit retry', async () => {
    const server = await fakeServer();
    let version = '1.0.0';
    let attempts = 0;
    const programs = new ProgramUpdates([{ id: 'claude', readVersion: () => version, install: async () => {
      if (++attempts === 1) throw new Error('private npm credential');
      version = '2.0.0';
    } }]);
    const node = await runNode({ dir: nodeDir(server.url), adapter, programs, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    expect(server.received[0]).toMatchObject({ programs: [{ version: '1.0.0', updating: false, failed: true }] });
    expect(JSON.stringify(server.received)).not.toContain('private npm credential');
    server.send({ type: 'programs.update' });
    await server.wait(() => server.received.some(m => m.type === 'status' && JSON.stringify(m.programs).includes('2.0.0')));
    expect(server.received.filter(m => m.type === 'status').at(-1)).toMatchObject({ programs: [{ version: '2.0.0', updating: false, failed: false }] });
  });

  it('does not replay a delivered live event when its connection comes back', async () => {
    const server = await fakeServer();
    const node = await runNode({ dir: nodeDir(server.url), log: () => {}, adapter: {
      ...adapter, run: async input => { input.onEvent?.({ kind: 'text', text: 'Delivered once.' }); return adapter.run(input); },
    } });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'job.run', jobId: 'delivered', subscriptionId: 's1', provider: 'claude', prompt: 'Say once.', sessionId: null, model: null, timeoutMs: 5000, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.some(m => m.type === 'job.done' && m.jobId === 'delivered'));
    expect(server.received.filter(m => m.type === 'job.event' && m.jobId === 'delivered')).toHaveLength(1);
    server.drop();
    await server.wait(() => server.received.filter(m => m.type === 'hello').length === 2, 6000);
    server.send({ type: 'agent.say', agentKey: 'none', text: 'barrier', ref: 'reconnected' });
    await server.wait(() => server.received.some(m => m.type === 'agent.said' && m.ref === 'reconnected'));
    expect(server.received.filter(m => m.type === 'job.event' && m.jobId === 'delivered')).toHaveLength(1);
  });

  it('replays current snapshots after hello and reconnect instead of older queued update states', async () => {
    const server = await fakeServer();
    let installed = 1;
    const programs = new ProgramUpdates([{ id: 'codex', readVersion: () => `${installed}.0.0`, install: async () => { installed++; } }]);
    const node = await runNode({ dir: nodeDir(server.url), adapter, programs, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    await server.wait(() => server.received.filter(m => m.type === 'status').length >= 2);
    const snapshot = [{ id: 'codex', version: '2.0.0', updating: false, failed: false }];
    expect(server.received[0]).toMatchObject({ programs: snapshot });
    for (const status of server.received.filter(m => m.type === 'status')) expect(status.programs).toEqual(snapshot);
    server.drop();
    await programs.update();
    await server.wait(() => server.received.filter(m => m.type === 'hello').length === 2, 6000);
    const hello = server.received.findLastIndex(m => m.type === 'hello');
    expect(server.received[hello]).toMatchObject({ programs: [{ id: 'codex', version: '3.0.0', updating: false, failed: false }] });
    for (const status of server.received.slice(hello + 1).filter(m => m.type === 'status')) expect(status.programs).toEqual(programs.snapshot());
  });
  it('ignores unsupported handoff controls without starting or acknowledging a job', async () => {
    const server = await fakeServer();
    let runs = 0;
    const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, run: async input => { runs++; return adapter.run(input); } }, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    const binding = {
      workspaceId: '88888888-8888-4888-8888-888888888888', taskId: '22222222-2222-4222-8222-222222222222', agentId: '99999999-9999-4999-8999-999999999999',
      nodeId: { kind: 'node', nodeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, assignmentEpoch: 3, bindingVersion: 2,
      repositoryId: '77777777-7777-4777-8777-777777777777', taskBranch: 'task-abc', baseSha: 'a'.repeat(40),
    };
    const base = { version: 1, handoffId: '11111111-1111-4111-8111-111111111111', taskId: binding.taskId, binding };
    const deadline = '2026-11-06T07:00:00.000Z';
    server.send({ ...base, type: 'task.handoff.capture', fromJobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', workspaceId: binding.workspaceId, repositoryId: binding.repositoryId, expectedWipSha: null, deadline });
    server.send({ ...base, type: 'task.handoff.offer', candidateAgentId: '66666666-6666-4666-8666-666666666666', repositoryId: binding.repositoryId, baseSha: binding.baseSha, checkpointSha: binding.baseSha, deadline });
    server.send({ ...base, type: 'task.handoff.resume_source', cancelId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', workspaceId: binding.workspaceId });
    server.send({ ...base, type: 'task.handoff.release', reservationId: '44444444-4444-4444-8444-444444444444', reason: 'stale' });
    server.send({ type: 'agent.say', agentKey: 'none', text: 'barrier', ref: 'handoff-controls-ignored' });
    await server.wait(() => server.received.some(m => m.type === 'agent.said' && m.ref === 'handoff-controls-ignored'));
    expect(runs).toBe(0);
    expect(server.received.some(m => m.type === 'job.done')).toBe(false);
    expect(server.received.some(m => m.type.startsWith('task.handoff.'))).toBe(false);
  });
});

describe('a node that runs agents in terminals', () => {
  it.each([
    ['a personal node without an agent session', true, null],
    ['an API agent workspace without a terminal', false, 'api-agent'],
  ] as const)('keeps the runtime timeout for %s', async (_name, terminal, key) => {
    const server = await fakeServer();
    const dir = nodeDir(server.url);
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const tmux = new Tmux({ socket: `hh-program-timeout-${process.pid}`, env: { PATH: process.env.PATH ?? '', HOME: dir } });
    const node = await runNode({ dir, log: () => {}, adapter: { ...adapter, run: async input => { await pending; return adapter.run(input); } },
      ...(terminal ? { terminal: { tmux, program: claudeProgram, bin: 'claude', home: join(dir, 'home'), signedOut: /not logged in/i } } : {}),
    });
    onTestFinished(() => node.stop());
    try {
      await server.wait(() => server.received.some(m => m.type === 'hello'));
      server.send({ type: 'job.run', jobId: 'runtime-timeout', subscriptionId: 's1', provider: 'claude', prompt: 'Use a runtime timeout.', sessionId: null, model: null, timeoutMs: 80, secret: null, instructions: null, toolToken: null, ...(key ? { workspace: { key, repo: null } } : {}) });
      await server.wait(() => server.received.some(m => m.type === 'job.done' && m.jobId === 'runtime-timeout'));
      expect(server.received.find(m => m.type === 'job.done' && m.jobId === 'runtime-timeout')).toMatchObject({ ok: false, error: 'timeout' });
    } finally {
      release();
    }
  });

  it('keeps a live receipt across a short reconnect', async () => {
    vi.mocked(uptime).mockReturnValueOnce(3600);
    const server = await fakeServer();
    const dir = nodeDir(server.url);
    let receipt!: (ok: boolean) => void;
    let entered = false;
    const pending = new Promise<boolean>(resolve => { receipt = resolve; });
    const say = vi.spyOn(TerminalHost.prototype, 'say').mockImplementation(() => { entered = true; return pending; });
    onTestFinished(() => say.mockRestore());
    const log: string[] = [];
    const tmux = new Tmux({ env: { HOME: dir } });
    const node = await runNode({ dir, adapter, log: line => log.push(line), terminal: { tmux, program: claudeProgram, bin: 'claude', home: dir, signedOut: /not logged in/i } });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'agent.say', agentKey: 'agent-1', text: 'Keep these words.', ref: 'offline' });
    await server.wait(() => entered);
    server.drop();
    await server.wait(() => log.some(line => line.includes('Connection closed')));
    receipt(true);
    await server.wait(() => server.received.filter(m => m.type === 'hello').length === 2, 5000);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(server.received.filter(m => m.type === 'agent.said')).toEqual([{ type: 'agent.said', ref: 'offline', ok: true }]);
  });

  it("says it writes an agent's skills as files, so Hornhoof sends them as files", async () => {
    const server = await fakeServer();
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    expect(server.received[0]).toMatchObject({ type: 'hello', skillFiles: true });
  });

  it('says the build CI wrote into its image, so Hornhoof can tell a node of another build', async () => {
    const build = 'c0ffee'.padEnd(40, '0');
    const server = await fakeServer();
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: () => {}, build });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    expect(server.received[0]).toMatchObject({ type: 'hello', build });
  });

  it('says no build when it was given none, as a node built by hand', async () => {
    const server = await fakeServer();
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    expect(server.received[0]).not.toHaveProperty('build');
  });

  it('takes its build from HORNHOOF_NODE_BUILD only when it is a commit', () => {
    const commit = 'c0ffee'.padEnd(40, '0');
    expect(buildOf({ HORNHOOF_NODE_BUILD: commit })).toBe(commit);
    expect(buildOf({ HORNHOOF_NODE_BUILD: 'local' })).toBeUndefined();
    expect(buildOf({ HORNHOOF_NODE_BUILD: '' })).toBeUndefined();
    expect(buildOf({})).toBeUndefined();
  });

  it('ends a view it cannot show when it runs no terminals', async () => {
    const server = await fakeServer();
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    expect(server.received[0]).toMatchObject({ terminals: false });
    server.send({ type: 'term.open', termId: 't9', agentKey: 'agent-1', cols: 90, rows: 30, write: true });
    await server.wait(() => server.received.some(m => m.type === 'term.exit' && m.termId === 't9'));
  });

  it('says words for a running turn did not go in when it runs no terminals', async () => {
    vi.mocked(uptime).mockReturnValueOnce(3600);
    const server = await fakeServer();
    const log = vi.fn();
    const node = await runNode({ dir: nodeDir(server.url), adapter, log });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'agent.say', agentKey: 'agent-1', text: 'Use the new schema.', ref: 'r-1' });
    await server.wait(() => server.received.some(m => m.type === 'agent.said'));
    expect(server.received.find(m => m.type === 'agent.said')).toEqual({ type: 'agent.said', ref: 'r-1', ok: false });
    expect(log.mock.calls.filter(([line]) => line.includes('live words'))).toEqual([['Agent agent-1: live words were not delivered: the terminal host is not running.']]);
  });
});

describe('runNode', () => {
  it('runs a job and reports the limits it brought, then the job, so Hornhoof knows of a plan at its limit as the job ends', async () => {
    const server = await fakeServer();
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 5000, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.some(m => m.type === 'job.done'));
    expect(server.received.map(m => m.type)).toEqual(['hello', 'job.started', 'status', 'job.done']);
    expect(server.received[2]).toMatchObject({ loggedIn: true, limits: { status: 'allowed', windows: [] } });
    expect(server.received[3]).toMatchObject({ jobId: 'j1', ok: true, result: 'ready', sessionId: 'sess-9' });
  });

  it('sends a finished job again after the connection drops before Hornhoof confirms it, and stops once Hornhoof does', async () => {
    const server = await fakeServer();
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: () => {} });
    onTestFinished(() => node.stop());
    const hellos = () => server.received.filter(m => m.type === 'hello');
    const dones = () => server.received.filter(m => m.type === 'job.done' && m.jobId === 'j1');
    await server.wait(() => hellos().length === 1);
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 5000, secret: null, instructions: null, toolToken: null });
    await server.wait(() => dones().length === 1);
    server.drop();
    await server.wait(() => dones().length === 2, 5000);
    expect(hellos()[1]).toMatchObject({ running: ['j1'] });
    expect(dones()[1]).toMatchObject({ ok: true, result: 'ready' });

    server.send({ type: 'job.ack', jobId: 'j1' });
    await new Promise(r => setTimeout(r, 50));
    server.drop();
    await server.wait(() => hellos().length === 3, 5000);
    await new Promise(r => setTimeout(r, 100));
    expect(hellos()[2]).toMatchObject({ running: [] });
    expect(dones()).toHaveLength(2);
  });

  it('ends a job even when its program cannot list its models then, and keeps the models it listed before', async () => {
    const server = await fakeServer();
    let asked = 0;
    const models = async () => {
      if (asked++ > 0) throw new Error('models unreachable');
      return [{ id: 'opus', name: 'Opus' }];
    };
    const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, models }, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 5000, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.some(m => m.type === 'job.done'));
    expect(server.received.find(m => m.type === 'status')).toMatchObject({ models: [{ id: 'opus', name: 'Opus' }] });
  });

  it("asks its program for the plan's limits on its own, now and then, and says each reading, also one that moved nothing, so they do not go stale in Hornhoof", async () => {
    const server = await fakeServer();
    const seen = [0.1, 0.1, 0.25];
    let asked = 0;
    const limits = async () => ({ status: 'allowed' as const, windows: [{ name: 'seven_day', utilization: seen[Math.min(asked++, seen.length - 1)]!, resetsAt: null }] });
    const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, limits }, log: () => {}, limitsMs: 40 });
    onTestFinished(() => node.stop());
    const readings = () => server.received.filter(m => m.type === 'status' && m.limits !== null).map(m => (m.limits as { windows: { utilization: number }[] }).windows[0]!.utilization);
    await server.wait(() => readings().length >= 3);
    expect(readings().slice(0, 3)).toEqual([0.1, 0.1, 0.25]);
  });

  it('says no limits in a status with no reading behind it, so Hornhoof does not take old ones for fresh, in a frame Hornhoof still reads', async () => {
    const server = await fakeServer();
    const reading = { status: 'allowed' as const, windows: [{ name: 'seven_day', utilization: 0.4, resetsAt: null }], complete: true };
    const answers: (() => Promise<typeof reading | null>)[] = [async () => reading];
    const limits = () => (answers.shift() ?? (async () => { throw new Error('the source is down'); }))();
    const run = async (input: RunInput) => ({ ok: input.prompt !== 'signed out', sessionId: 'sess-9', result: 'ready', output: '', error: input.prompt === 'signed out' ? 'not_logged_in' as const : null, limits: null });
    const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, run, limits }, log: () => {}, limitsMs: 60_000 });
    onTestFinished(() => node.stop());
    const statuses = () => server.received.filter(m => m.type === 'status');
    const job = (jobId: string, prompt: string) => ({ type: 'job.run', jobId, subscriptionId: 's1', provider: 'claude', prompt, sessionId: null, model: null, timeoutMs: 5000, secret: null, instructions: null, toolToken: null });
    await server.wait(() => statuses().some(m => m.limits !== null));

    /* The reading after the job fails: the status that says the job is over knows nothing new of the limits. */
    const told = statuses().length;
    server.send(job('j1', 'hi'));
    await server.wait(() => server.received.some(m => m.type === 'job.done' && m.jobId === 'j1'));
    expect(statuses().length).toBeGreaterThan(told);

    /* It reads nothing and fails nothing: the program cannot tell now. */
    answers.push(async () => null);
    server.send(job('j2', 'hi'));
    await server.wait(() => server.received.some(m => m.type === 'job.done' && m.jobId === 'j2'));

    /* The status of a sign-in lost, sent apart from the job's end. */
    const before = statuses().length;
    server.send(job('j3', 'signed out'));
    await server.wait(() => statuses().length >= before + 2);

    const after = statuses().slice(told);
    expect(after.length).toBeGreaterThanOrEqual(4);
    for (const status of after) expect(status).toMatchObject({ limits: null });
    for (const status of after) expect(parseNodeMessage(JSON.stringify(status))).not.toBeNull();
  });

  it('says a move to another plan of its maker when it looks for the limits, though it read none', async () => {
    const server = await fakeServer();
    let account = { email: 'x@y.z', tier: 'pro' };
    let looks = 0;
    const limits = async () => {
      looks++;
      return null;
    };
    const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, account: async () => account, limits }, log: () => {}, limitsMs: 15 });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello') && looks >= 4);
    /* A look that read nothing has nothing to say. */
    expect(server.received.filter(m => m.type === 'status')).toEqual([]);
    account = { email: 'x@y.z', tier: 'max' };
    await server.wait(() => server.received.some(m => m.type === 'status'));
    expect(server.received.find(m => m.type === 'status')).toMatchObject({ account, limits: null });
  });

  it('says a reading once, in the next status that goes out, whichever that is', async () => {
    const server = await fakeServer();
    const dir = nodeDir(server.url);
    let browser: string | null = 'libnss3.so missing';
    const turn = { status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.2, resetsAt: null }] };
    const run = async () => ({ ok: true, sessionId: 'sess-9', result: 'ready', output: '', error: null, limits: turn });
    const node = await runNode({ dir, adapter: { ...adapter, run }, log: () => {}, checkBrowser: async () => browser, browserCheckMs: 30 });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 5000, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.some(m => m.type === 'job.done'));
    expect(server.received.filter(m => m.type === 'status').map(m => m.limits)).toEqual([turn]);

    /* A browser that recovers has nothing to say of the limits. */
    browser = null;
    await server.wait(() => server.received.filter(m => m.type === 'status').length >= 2);
    expect(server.received.filter(m => m.type === 'status')[1]).toMatchObject({ limits: null, browserError: null });
  });

  it('asks for no new list of models with each reading, only when the account moved', async () => {
    const server = await fakeServer();
    let listed = 0;
    let account = { email: 'x@y.z', tier: 'pro' };
    const models = async () => {
      listed++;
      return [{ id: 'opus', name: 'Opus' }];
    };
    const limits = async () => ({ status: 'allowed' as const, windows: [{ name: 'seven_day', utilization: 0.1, resetsAt: null }] });
    const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, models, limits, account: async () => account }, log: () => {}, limitsMs: 15 });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.filter(m => m.type === 'status' && m.limits !== null).length >= 5);
    expect(listed).toBe(1);
    expect(server.received.filter(m => m.type === 'status').at(-1)).toMatchObject({ models: [{ id: 'opus', name: 'Opus' }] });
    account = { email: 'x@y.z', tier: 'max' };
    await server.wait(() => listed === 2);
  });

  describe('while Hornhoof is away', () => {
    const readingOf = (m: { [k: string]: unknown }) => (m.limits as { windows: { utilization: number }[] }).windows[0]!.utilization;
    const usage = (utilization: number) => ({ status: 'allowed' as const, windows: [{ name: 'seven_day', utilization, resetsAt: null }] });
    const job = (jobId: string) => ({ type: 'job.run', jobId, subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 5000, secret: null, instructions: null, toolToken: null });
    const framesAfterHello = (received: { type: string; [k: string]: unknown }[]) => received.slice(received.findLastIndex(m => m.type === 'hello') + 1);
    const helloAgain = (server: Awaited<ReturnType<typeof fakeServer>>) => server.wait(() => server.received.filter(m => m.type === 'hello').length === 2, 6000);

    it('keeps no reading in the queue, and says only the newest when it is back', async () => {
      const server = await fakeServer();
      let asked = 0;
      const limits = async () => usage(++asked / 100_000);
      const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, limits }, log: () => {}, limitsMs: 10 });
      onTestFinished(() => node.stop());
      await server.wait(() => server.received.some(m => m.type === 'status' && m.limits !== null));
      const askedBefore = asked;
      server.drop();
      await helloAgain(server);
      await server.wait(() => framesAfterHello(server.received).some(m => m.type === 'status'));
      const first = framesAfterHello(server.received).find(m => m.type === 'status')!;
      /* Hundreds were read while it was away; the oldest of them would come first from a queue. */
      expect(readingOf(first)).toBeGreaterThan((askedBefore + 5) / 100_000);
    });

    it('puts no reading in a status that waits for the connection, and says it once it is back, before the job it came with', async () => {
      const server = await fakeServer();
      const turn = usage(0.3);
      let end: () => void = () => {};
      const run = () => new Promise<Awaited<ReturnType<ProviderAdapter['run']>>>(done => { end = () => done({ ok: true, sessionId: 'sess-9', result: 'ready', output: '', error: null, limits: turn }); });
      const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, run, limits: async () => null }, log: () => {}, limitsMs: 60_000 });
      onTestFinished(() => node.stop());
      await server.wait(() => server.received.some(m => m.type === 'hello'));
      server.send(job('j1'));
      await server.wait(() => server.received.some(m => m.type === 'job.started'));
      server.drop();
      /* The node hears of the drop, and the job ends with it away. */
      await new Promise(r => setTimeout(r, 50));
      end();
      await helloAgain(server);
      await server.wait(() => framesAfterHello(server.received).some(m => m.type === 'job.done'));
      const after = framesAfterHello(server.received);
      const statuses = after.filter(m => m.type === 'status');
      expect(statuses.filter(m => m.limits !== null).map(m => m.limits)).toEqual([turn]);
      expect(after.findIndex(m => m.type === 'status' && m.limits !== null)).toBeLessThan(after.findIndex(m => m.type === 'job.done'));
    });

    it('forgets a reading that waits when the next one fails: by the time Hornhoof hears it, it would be old', async () => {
      const server = await fakeServer();
      let away = false;
      let last = false;
      const limits = async () => {
        if (!away) return usage(0.1);
        if (last) return null;
        last = true;
        return usage(0.2);
      };
      const run = async () => ({ ok: true, sessionId: 'sess-9', result: 'ready', output: '', error: null, limits: null });
      const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, run, limits }, log: () => {}, limitsMs: 10 });
      onTestFinished(() => node.stop());
      await server.wait(() => server.received.some(m => m.type === 'status' && m.limits !== null));
      away = true;
      server.drop();
      await helloAgain(server);
      server.send(job('j1'));
      await server.wait(() => server.received.some(m => m.type === 'job.done'));
      const statuses = framesAfterHello(server.received).filter(m => m.type === 'status');
      expect(statuses.length).toBeGreaterThan(0);
      for (const status of statuses) expect(status).toMatchObject({ limits: null });
    });

    it('forgets the reading of a job that ended meanwhile the same way', async () => {
      const server = await fakeServer();
      const turn = usage(0.3);
      let looks = 0;
      let end: () => void = () => {};
      const run = () => new Promise<Awaited<ReturnType<ProviderAdapter['run']>>>(done => { end = () => done({ ok: true, sessionId: 'sess-9', result: 'ready', output: '', error: null, limits: turn }); });
      const limits = async () => {
        looks++;
        return null;
      };
      const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, run, limits }, log: () => {}, limitsMs: 10 });
      onTestFinished(() => node.stop());
      await server.wait(() => server.received.some(m => m.type === 'hello'));
      server.send(job('j1'));
      await server.wait(() => server.received.some(m => m.type === 'job.started'));
      server.drop();
      await new Promise(r => setTimeout(r, 50));
      end();
      /* A look or two after the job's end. */
      const seen = looks;
      await server.wait(() => looks >= seen + 3);
      await helloAgain(server);
      await server.wait(() => framesAfterHello(server.received).some(m => m.type === 'job.done'));
      for (const status of framesAfterHello(server.received).filter(m => m.type === 'status')) expect(status).toMatchObject({ limits: null });
    });

    it('keeps a reading through a failed one while Hornhoof is there, as the status that says it is on its way', async () => {
      const server = await fakeServer();
      const turn = usage(0.3);
      let asked = 0;
      let gate: Promise<void> = Promise.resolve();
      let open: () => void = () => {};
      const models = async () => {
        await gate;
        return [{ id: 'opus', name: 'Opus' }];
      };
      const limits = async () => {
        asked++;
        return null;
      };
      const run = async () => ({ ok: true, sessionId: 'sess-9', result: 'ready', output: '', error: null, limits: turn });
      const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, run, models, limits }, log: () => {}, limitsMs: 10 });
      onTestFinished(() => node.stop());
      await server.wait(() => server.received.some(m => m.type === 'hello'));
      gate = new Promise(resolve => { open = resolve; });
      server.send(job('j1'));
      await server.wait(() => server.received.some(m => m.type === 'job.started'));
      /* The job's status waits for the models while readings fail. */
      await new Promise(r => setTimeout(r, 20));
      const seen = asked;
      await server.wait(() => asked >= seen + 3);
      open();
      await server.wait(() => server.received.some(m => m.type === 'job.done'));
      expect(server.received.filter(m => m.type === 'status').map(m => m.limits)).toContainEqual(turn);
    });
  });

  it('reports Antigravity limits on schedule and after a job, and invents no reached limit when the source fails', async () => {
    const server = await fakeServer();
    const dir = nodeDir(server.url);
    writeState(dir, { server: server.url, subscriptionId: 's1', provider: 'antigravity', key: 'node-key-1234567890' });
    const home = join(dir, 'home');
    const tools = join(dir, 'tools');
    const bin = fileURLToPath(new URL('./fakes/agy', import.meta.url));
    const usageWith = (fiveHourRemaining: number) => JSON.stringify({
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
          groups: [{
            name: 'Gemini Models',
            buckets: [
              { id: 'gemini-5h', window: '5h', remaining_fraction: fiveHourRemaining, reset_time: '2026-11-04T21:41:44Z' },
              { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.6, reset_time: '2026-11-10T00:41:44Z' },
            ],
          }],
        },
      },
    });
    const agy = antigravityAdapter({ home, tools, bin, person: () => null });
    /* Avoid spawning tmux setup checks during a non-terminal limits test. */
    const node = await runNode({ dir, adapter: { ...agy, setupNeeded: async () => false }, log: () => {}, limitsMs: 60 });
    onTestFinished(() => {
      delete process.env.FAKE_LIMITS_MODE;
      node.stop();
    });

    await server.wait(() => server.received.some(m => m.type === 'status' && m.limits !== null));
    expect(server.received.filter(m => m.type === 'status').at(-1)!.limits).toEqual({
      status: 'allowed',
      windows: [
        { name: 'five_hour', utilization: 1 - 0.6985989809036255, resetsAt: '2026-11-04T21:41:44.000Z' },
        { name: 'seven_day', utilization: 1 - 0.6328346133232117, resetsAt: '2026-11-10T00:41:44.000Z' },
      ],
      complete: true,
    });

    /* A broken source leaves the node running and never fabricates status: rejected. */
    process.env.FAKE_LIMITS_MODE = 'fail';
    await new Promise(r => setTimeout(r, 150));
    expect(server.received.filter(m => m.type === 'status').every(m => (m.limits as { status?: string } | null)?.status !== 'rejected')).toBe(true);
    delete process.env.FAKE_LIMITS_MODE;

    /* A job updates the limits right away before reporting job.done. */
    writeFileSync(join(home, 'fake-agy-usage.json'), usageWith(0.25));
    const statusesBefore = server.received.filter(m => m.type === 'status').length;
    server.send({ type: 'job.run', jobId: 'j-agy', subscriptionId: 's1', provider: 'antigravity', prompt: 'say ready', sessionId: null, model: null, timeoutMs: 5000, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.some(m => m.type === 'job.done' && m.jobId === 'j-agy'));
    expect(server.received.filter(m => m.type === 'status').length).toBeGreaterThan(statusesBefore);
    const done = server.received.findIndex(m => m.type === 'job.done' && m.jobId === 'j-agy');
    /* Among the statuses before the job's end: a reading on schedule may still come after it. */
    expect(server.received.slice(0, done).filter(m => m.type === 'status').map(m => m.limits)).toContainEqual({
      status: 'allowed',
      windows: [
        { name: 'five_hour', utilization: 0.75, resetsAt: '2026-11-04T21:41:44.000Z' },
        { name: 'seven_day', utilization: 0.4, resetsAt: '2026-11-10T00:41:44.000Z' },
      ],
      complete: true,
    });
  });

  it('keeps the windows it knew when a turn tells only some of them, and takes a full list as it is', async () => {
    const server = await fakeServer();
    const week = { status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.1, resetsAt: null }, { name: 'seven_day', utilization: 0.9, resetsAt: null }], complete: true };
    const turns = [
      { status: 'warning' as const, windows: [{ name: 'five_hour', utilization: 0.8, resetsAt: null }] },
      { status: 'allowed' as const, windows: [{ name: 'seven_day', utilization: 0.95, resetsAt: null }], complete: true },
    ];
    const run = async () => ({ ok: true, sessionId: 'sess-9', result: 'ready', output: '', error: null, limits: turns.shift()! });
    const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, run, limits: async () => week }, log: () => {}, limitsMs: 60_000 });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.filter(m => m.type === 'status').length >= 1);
    const job = (jobId: string) => ({ type: 'job.run', jobId, subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 5000, secret: null, instructions: null, toolToken: null });
    server.send(job('j1'));
    await server.wait(() => server.received.filter(m => m.type === 'status').length >= 2);
    expect(server.received.filter(m => m.type === 'status').at(-1)!.limits).toEqual({
      status: 'warning',
      windows: [{ name: 'five_hour', utilization: 0.8, resetsAt: null }, { name: 'seven_day', utilization: 0.9, resetsAt: null }],
      complete: true,
    });
    server.send(job('j2'));
    await server.wait(() => server.received.filter(m => m.type === 'status').length >= 3);
    expect(server.received.filter(m => m.type === 'status').at(-1)!.limits).toEqual({ status: 'allowed', windows: [{ name: 'seven_day', utilization: 0.95, resetsAt: null }], complete: true });
  });

  it('stays at a reached limit while a window it keeps from before is still full', async () => {
    const server = await fakeServer();
    const opus = { status: 'rejected' as const, windows: [{ name: 'seven_day', utilization: 0.6, resetsAt: null }, { name: 'seven_day_opus', utilization: 1, resetsAt: '2099-11-04T00:00:00.000Z' }], complete: true };
    const turn = { status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.2, resetsAt: null }, { name: 'seven_day', utilization: 0.61, resetsAt: null }] };
    const run = async () => ({ ok: true, sessionId: 'sess-9', result: 'ready', output: '', error: null, limits: turn });
    const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, run, limits: async () => opus }, log: () => {}, limitsMs: 60_000 });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.filter(m => m.type === 'status').length >= 1);
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 5000, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.filter(m => m.type === 'status').length >= 2);
    expect(server.received.filter(m => m.type === 'status').at(-1)!.limits).toMatchObject({ status: 'rejected' });
  });

  it('keeps the last fifty ends of jobs a server does not confirm', async () => {
    const server = await fakeServer();
    const run = async () => ({ ok: true, sessionId: null, result: 'ready', output: '', error: null, limits: null });
    const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, run }, log: () => {} });
    onTestFinished(() => node.stop());
    const hellos = () => server.received.filter(m => m.type === 'hello');
    await server.wait(() => hellos().length === 1);
    for (let i = 1; i <= 52; i++) server.send({ type: 'job.run', jobId: `j${i}`, subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 5000, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.filter(m => m.type === 'job.done').length === 52, 15000);
    server.drop();
    await server.wait(() => hellos().length === 2, 5000);
    const running = hellos()[1]!.running as string[];
    expect(running).toHaveLength(50);
    expect(running).not.toContain('j1');
    expect(running).toContain('j52');
  });

  it('says in hello how it came up: the same after a dropped connection, anew once it starts again', async () => {
    const server = await fakeServer();
    const dir = nodeDir(server.url);
    const first = await runNode({ dir, adapter, log: () => {} });
    const hellos = () => server.received.filter(m => m.type === 'hello').map(m => m.boot as { startedAt: string; machineUpAt: string; container: string });
    await server.wait(() => hellos().length === 1);
    const [boot] = hellos();
    expect(boot).toEqual({ startedAt: expect.any(String), machineUpAt: expect.any(String), container: hostname() });
    expect(Math.abs(Date.parse(boot!.machineUpAt) - (Date.now() - uptime() * 1000))).toBeLessThan(5000);
    expect(Date.parse(boot!.startedAt)).toBeGreaterThan(Date.parse(boot!.machineUpAt));
    server.drop();
    await server.wait(() => hellos().length === 2);
    expect(hellos()[1]).toEqual(boot);
    first.stop();
    await new Promise(r => setTimeout(r, 5));
    const second = await runNode({ dir, adapter, log: () => {} });
    onTestFinished(() => second.stop());
    await server.wait(() => hellos().length === 3);
    expect(hellos()[2]!.startedAt).not.toBe(boot!.startedAt);
    expect(hellos()[2]!.container).toBe(boot!.container);
  });

  it('sends the key its sign-ins are sealed to in hello', async () => {
    const server = await fakeServer();
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    expect(server.received[0]).toMatchObject({ type: 'hello', publicKey: expect.stringMatching(/^age1[0-9a-z]{58}$/) });
  });

  it('sends the models its program can run in hello and status', async () => {
    const server = await fakeServer();
    const models = [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }];
    const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, models: async () => models }, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    expect(server.received[0]).toMatchObject({ type: 'hello', models });
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'codex', prompt: 'hi', sessionId: null, model: null, timeoutMs: 5000, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.some(m => m.type === 'status'));
    expect(server.received.find(m => m.type === 'status')).toMatchObject({ models });
  });

  it('revokes sign-in and retains workspaces, source and journals when removed', async () => {
    const server = await fakeServer();
    const dir = nodeDir(server.url);
    const retained = ['work/agents/a/repositories/r/repo/unpublished.txt', 'work/agents/a/task-workspaces/w/repo/dirty.txt', 'work/agents/a/task-workspaces/w/private-context', 'workspace-journals/operation.json'];
    for (const path of retained) {
      const target = join(dir, path);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, `retained:${path}`);
    }
    const node = await runNode({ dir, adapter, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'remove' });
    await server.wait(() => server.received.some(m => m.type === 'removed'));
    expect(existsSync(join(dir, 'home'))).toBe(false);
    for (const path of retained) expect(readFileSync(join(dir, path), 'utf8')).toBe(`retained:${path}`);
    expect(isRemoved(dir)).toBe(true);
  });

  it('settles running jobs before revocation while retaining their work on removal', async () => {
    const server = await fakeServer();
    const dir = nodeDir(server.url);
    let folderAtStop: boolean | null = null;
    const slow: ProviderAdapter = {
      ...adapter,
      run: input =>
        new Promise(done => {
          input.signal?.addEventListener('abort', () => {
            folderAtStop = existsSync(input.workDir);
            done({ ok: false, sessionId: null, result: '', output: 'stopped', error: 'agent_failed', limits: null });
          });
        }),
    };
    const node = await runNode({ dir, adapter: slow, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 60000, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.some(m => m.type === 'job.started'));
    server.send({ type: 'remove' });
    await server.wait(() => server.received.some(m => m.type === 'removed'));
    expect(folderAtStop).toBe(true);
    expect(readFileSync(join(dir, 'work', 'file'), 'utf8')).toBe('x');
  });

  it('answers agent_failed and keeps serving when a job cannot even start', async () => {
    const server = await fakeServer();
    let picks = 0;
    const pick = () => {
      if (++picks === 1) throw new Error('no program for this job');
      return adapter;
    };
    const node = await runNode({ dir: nodeDir(server.url), adapter: pick, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    const run = (jobId: string) => server.send({ type: 'job.run', jobId, subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 5000, secret: null, instructions: null, toolToken: null });
    const doneOf = (jobId: string) => server.received.find(m => m.type === 'job.done' && m.jobId === jobId);
    run('j1');
    await server.wait(() => !!doneOf('j1'));
    expect(doneOf('j1')).toMatchObject({ ok: false, error: 'agent_failed' });
    run('j2');
    await server.wait(() => !!doneOf('j2'));
    expect(doneOf('j2')).toMatchObject({ ok: true, result: 'ready' });
  });

  it('streams the agent\'s work as numbered events before the job ends, with the tools at <server>/mcp', async () => {
    const server = await fakeServer();
    let seen: RunInput | null = null;
    const talkative: ProviderAdapter = {
      ...adapter,
      run: async input => {
        seen = input;
        input.onEvent?.({ kind: 'text', text: 'Hello' });
        input.onEvent?.({ kind: 'tool', name: 'hornhoof.company', input: '{}' });
        input.onEvent?.({ kind: 'tool_result', ok: true, summary: 'Acme' });
        return { ok: true, sessionId: 'sess-9', result: 'Hello', output: '', error: null, limits: null };
      },
    };
    const node = await runNode({ dir: nodeDir(server.url), adapter: talkative, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 5000, secret: null, instructions: 'Be brief.', toolToken: 'tool-token-0123456789' });
    await server.wait(() => server.received.some(m => m.type === 'job.done'));
    expect(server.received.filter(m => m.type !== 'hello' && m.type !== 'status').map(m => (m.type === 'job.event' ? `event ${m.seq}` : m.type))).toEqual([
      'job.started', 'event 0', 'event 1', 'event 2', 'job.done',
    ]);
    expect(server.received.find(m => m.type === 'job.event')).toMatchObject({ jobId: 'j1', event: { kind: 'text', text: 'Hello' } });
    expect(seen!.tools).toEqual({ url: `${server.url}/mcp`, token: 'tool-token-0123456789' });
  });

  it('waits at headless launch if an update starts during job preparation', async () => {
    const server = await fakeServer();
    let releaseInstall!: () => void;
    let releasePreparation!: () => void;
    const install = new Promise<void>(resolve => { releaseInstall = resolve; });
    const preparation = new Promise<void>(resolve => { releasePreparation = resolve; });
    let installs = 0;
    let preparing = false;
    let prepared = 0;
    let blockPreparation = false;
    const launches: boolean[] = [];
    const programs = new ProgramUpdates([{ id: 'claude', readVersion: () => '1.0.0', install: async () => { if (++installs > 1) await install; } }]);
    const node = await runNode({ dir: nodeDir(server.url), programs, log: () => {}, adapter: {
      ...adapter,
      secrets: async () => { if (blockPreparation) { preparing = true; await preparation; } prepared++; return []; },
      run: async input => { launches.push(programs.snapshot()[0]!.updating); return adapter.run(input); },
    } });
    onTestFinished(() => node.stop());
    try {
      await server.wait(() => server.received.some(m => m.type === 'hello'));
      await programs.ready();
      prepared = 0;
      blockPreparation = true;
      server.send({ type: 'job.run', jobId: 'late-update', subscriptionId: 's1', provider: 'claude', prompt: 'Wait for the programs.', sessionId: null, model: null, timeoutMs: 100, secret: null, instructions: null, toolToken: null });
      await server.wait(() => preparing);
      server.send({ type: 'programs.update' });
      await server.wait(() => installs === 2);
      blockPreparation = false;
      releasePreparation();
      await server.wait(() => prepared >= 2);
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(server.received.some(m => m.type === 'job.done' && m.jobId === 'late-update')).toBe(false);
      expect(launches).toEqual([]);
    } finally {
      releasePreparation();
      releaseInstall();
    }
    await server.wait(() => server.received.some(m => m.type === 'job.done' && m.jobId === 'late-update'));
    expect(launches).toEqual([false]);
    expect(server.received.find(m => m.type === 'job.done' && m.jobId === 'late-update')).toMatchObject({ ok: true });
  });

  it('does not run a job cancelled while its program update is pending', async () => {
    const server = await fakeServer();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const programs = new ProgramUpdates([{ id: 'claude', install: () => pending, readVersion: () => '1.0.0' }]);
    const started: string[] = [];
    const node = await runNode({ dir: nodeDir(server.url), programs, log: () => {}, adapter: {
      ...adapter, run: async input => { started.push(input.prompt); return adapter.run(input); },
    } });
    onTestFinished(() => node.stop());
    try {
      await server.wait(() => server.received.some(m => m.type === 'hello'));
      server.send({ type: 'job.run', jobId: 'waiting-update', subscriptionId: 's1', provider: 'claude', prompt: 'Do not run this.', sessionId: null, model: null, timeoutMs: 5000, secret: null, instructions: null, toolToken: null });
      await server.wait(() => server.received.some(m => m.type === 'job.started'));
      expect(started).toEqual([]);
      server.send({ type: 'job.cancel', jobId: 'waiting-update' });
      server.send({ type: 'agent.say', agentKey: 'unused', text: 'barrier', ref: 'after-cancel' });
      await server.wait(() => server.received.some(m => m.type === 'agent.said' && m.ref === 'after-cancel'));
      await server.wait(() => server.received.some(m => m.type === 'job.done' && m.jobId === 'waiting-update'));
      expect(server.received.find(m => m.type === 'job.done' && m.jobId === 'waiting-update')).toMatchObject({ ok: false, error: 'cancelled' });
      expect(started).toEqual([]);
      expect(programs.snapshot()[0]?.updating).toBe(true);
    } finally {
      release();
    }
  });

  it('calls a running job off when Hornhoof asks and ignores ids it does not run', async () => {
    const server = await fakeServer();
    const slow: ProviderAdapter = {
      ...adapter,
      run: input => new Promise(done => input.signal?.addEventListener('abort', () => done({ ok: false, sessionId: null, result: '', output: 'killed', error: 'agent_failed', limits: null }))),
    };
    const node = await runNode({ dir: nodeDir(server.url), adapter: slow, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 60000, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.some(m => m.type === 'job.started'));
    server.send({ type: 'job.cancel', jobId: 'other' });
    server.send({ type: 'job.cancel', jobId: 'j1' });
    await server.wait(() => server.received.some(m => m.type === 'job.done'));
    expect(server.received.find(m => m.type === 'job.done')).toMatchObject({ jobId: 'j1', ok: false, error: 'cancelled' });
  });

  it("says how busy its machine is in hello and every while after, with the agent jobs it runs", async () => {
    const server = await fakeServer();
    const slow: ProviderAdapter = { ...adapter, run: input => new Promise(done => input.signal?.addEventListener('abort', () => done({ ok: false, sessionId: null, result: '', output: '', error: 'agent_failed', limits: null }))) };
    const node = await runNode({ dir: nodeDir(server.url), adapter: slow, log: () => {}, loadMs: 40 });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    expect(server.received[0]!.load).toMatchObject({ cpus: expect.any(Number), load: expect.any(Number), memFree: expect.any(Number), memTotal: expect.any(Number), tests: 0, jobs: 0 });
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 60000, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.some(m => m.type === 'load' && m.jobs === 1));
    expect(server.received.find(m => m.type === 'load')).toMatchObject({ cpus: expect.any(Number), memTotal: expect.any(Number), tests: 0 });
    server.send({ type: 'job.cancel', jobId: 'j1' });
  });

  it('removes the folder older nodes ran their parts in as it comes up', async () => {
    const server = await fakeServer();
    const dir = nodeDir(server.url);
    mkdirSync(join(dir, 'tests', 'part-0'), { recursive: true });
    const node = await runNode({ dir, adapter, log: () => {} });
    onTestFinished(() => node.stop());
    expect(existsSync(join(dir, 'tests'))).toBe(false);
    expect(existsSync(join(dir, 'work', 'file'))).toBe(true);
  });

  it('offers no part of any run without a user of its own for them, says why, and turns down a part sent anyway', async () => {
    const server = await fakeServer();
    const ran: string[] = [];
    const runPart: typeof runTests = async m => (ran.push(m.partId), { type: 'tests.done', partId: m.partId, ok: true, exitCode: 0, error: null, commit: null, log: '' });
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: () => {}, loadMs: 40, runPart });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    expect(server.received[0]).toMatchObject({ type: 'hello', work: false, noRuns: expect.stringMatching(/user of its own/) });
    server.send({ type: 'tests.run', partId: 'p1', repo: { url: 'https://github.com/acme/shop.git', token: '' }, branch: null, task: 3, command: 'npm test', part: 1, parts: 1, timeoutMs: 60000 });
    await server.wait(() => server.received.some(m => m.type === 'tests.done'));
    expect(server.received.find(m => m.type === 'tests.done')).toMatchObject({ partId: 'p1', ok: false, error: 'failed', log: expect.stringMatching(/user of its own/) });
    expect(ran).toEqual([]);
  });

  it('runs a part of a test run, counts it in its load, sends its end until Hornhoof confirms it, and stops a part when asked', async () => {
    const server = await fakeServer();
    const given: unknown[] = [];
    const runPart: typeof runTests = async (m, { signal, files }) => {
      given.push(files);
      await new Promise<void>(done => {
        const timer = setTimeout(done, m.command === 'slow' ? 60_000 : 300);
        signal?.addEventListener('abort', () => (clearTimeout(timer), done()));
      });
      const stopped = signal?.aborted ?? false;
      return { type: 'tests.done', partId: m.partId, ok: !stopped, exitCode: stopped ? null : 0, error: stopped ? 'cancelled' : null, commit: null, log: stopped ? 'Stopped.' : 'all passed' };
    };
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: () => {}, loadMs: 40, runPart, testUser: { uid: 20001, gid: 20001 } });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    expect(server.received[0]).toMatchObject({ type: 'hello', work: true });
    expect(server.received[0]).not.toHaveProperty('noRuns');
    const part = { type: 'tests.run', repo: { url: 'https://github.com/acme/shop.git', token: '' }, branch: null, task: 3, part: 1, parts: 1, timeoutMs: 60000 };
    server.send({ ...part, partId: 'p1', command: 'npm test' });
    await server.wait(() => server.received.some(m => m.type === 'tests.started' && m.partId === 'p1'));
    await server.wait(() => server.received.some(m => m.type === 'load' && m.tests === 1));
    await server.wait(() => server.received.some(m => m.type === 'tests.done'));
    expect(server.received.find(m => m.type === 'tests.done')).toMatchObject({ partId: 'p1', ok: true, exitCode: 0, error: null, log: 'all passed' });
    expect(given[0]).toMatchObject({ get: expect.any(Function), put: expect.any(Function) });

    const hellos = () => server.received.filter(m => m.type === 'hello');
    server.drop();
    await server.wait(() => hellos().length === 2, 5000);
    expect(hellos()[1]).toMatchObject({ tests: ['p1'] });
    await server.wait(() => server.received.filter(m => m.type === 'tests.done').length === 2);
    server.send({ type: 'tests.ack', partId: 'p1' });
    await new Promise(r => setTimeout(r, 50));
    server.drop();
    await server.wait(() => hellos().length === 3, 5000);
    expect(hellos()[2]).toMatchObject({ tests: [] });

    server.send({ ...part, partId: 'p2', command: 'slow' });
    await server.wait(() => server.received.some(m => m.type === 'tests.started' && m.partId === 'p2'));
    server.send({ type: 'tests.cancel', partId: 'p2' });
    await server.wait(() => server.received.some(m => m.type === 'tests.done' && m.partId === 'p2'));
    expect(server.received.find(m => m.type === 'tests.done' && m.partId === 'p2')).toMatchObject({ ok: false, error: 'cancelled' });
  });

  it('takes a machine check slot before preparing a part or reporting that it started', async () => {
    const server = await fakeServer(false), ran: string[] = [];
    const runPart: typeof runTests = async m => { ran.push(m.partId); return { type: 'tests.done', partId: m.partId, ok: true, exitCode: 0, error: null, commit: null, log: 'checked' }; };
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: () => {}, runPart, testUser: { uid: 20001, gid: 20001 } });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'tests.run', partId: 'queued-part', repo: null, branch: null, task: 3, command: 'check', part: 1, parts: 1, timeoutMs: 60000 });
    await server.wait(() => server.received.some(m => m.type === 'check.acquire'));
    const id = server.received.find(m => m.type === 'check.acquire')!.id;
    server.send({ type: 'check.state', id, state: 'queued', position: 2 });
    await server.wait(() => server.received.some(m => m.type === 'tests.waiting'));
    expect(ran).toEqual([]);
    expect(server.received.filter(m => m.type === 'tests.started')).toEqual([]);
    server.send({ type: 'check.state', id, state: 'running', position: 0 });
    await server.wait(() => server.received.some(m => m.type === 'tests.done'));
    expect(ran).toEqual(['queued-part']);
    expect(server.received.findIndex(m => m.type === 'check.release')).toBeGreaterThan(server.received.findIndex(m => m.type === 'tests.started'));
  });

  it('cancels a queued part without starting preparation or claiming execution began', async () => {
    const server = await fakeServer(false), ran: string[] = [];
    const runPart: typeof runTests = async m => { ran.push(m.partId); return { type: 'tests.done', partId: m.partId, ok: true, exitCode: 0, error: null, commit: null, log: '' }; };
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: () => {}, runPart, testUser: { uid: 20001, gid: 20001 } });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'tests.run', partId: 'cancelled-part', repo: null, branch: null, task: 3, command: 'check', part: 1, parts: 1, timeoutMs: 60000 });
    await server.wait(() => server.received.some(m => m.type === 'check.acquire'));
    server.send({ type: 'tests.cancel', partId: 'cancelled-part' });
    await server.wait(() => server.received.some(m => m.type === 'tests.done'));
    expect(server.received.find(m => m.type === 'tests.done')).toMatchObject({ partId: 'cancelled-part', error: 'cancelled' });
    expect(server.received.filter(m => m.type === 'tests.started')).toEqual([]);
    expect(ran).toEqual([]);
  });

  it('stays idle once removed', async () => {
    const lines: string[] = [];
    const dir = nodeDir('http://127.0.0.1:9');
    writeFileSync(join(dir, 'removed'), '');
    const node = await runNode({ dir, adapter, log: l => lines.push(l) });
    node.stop();
    expect(lines).toEqual(['This node was removed in Hornhoof.']);
  });

  it('checks Playwright Chromium before greeting Hornhoof, logs and reports a named failure, and clears it once healthy', async () => {
    const server = await fakeServer();
    const dir = nodeDir(server.url);
    const lines: string[] = [];
    let currentError: string | null = 'libnss3.so: cannot open shared object file';
    const node = await runNode({
      dir,
      adapter,
      testUser: { uid: 20001, gid: 20001 },
      log: line => lines.push(line),
      checkBrowser: async () => currentError,
      browserCheckMs: 40,
    });
    onTestFinished(() => node.stop());

    await server.wait(() => server.received.some(m => m.type === 'hello'));
    const hello = server.received.find(m => m.type === 'hello')!;
    expect(hello).toMatchObject({
      type: 'hello',
      browserError: 'libnss3.so: cannot open shared object file',
      noRuns: expect.stringContaining('libnss3.so: cannot open shared object file'),
      nodeLog: expect.stringContaining('Playwright Chromium could not start: libnss3.so: cannot open shared object file'),
    });
    expect(lines.some(line => line.includes('Playwright Chromium could not start: libnss3.so'))).toBe(true);
    expect(readFileSync(join(dir, 'browser-error'), 'utf8').trim()).toBe('libnss3.so: cannot open shared object file');

    server.send({ type: 'job.run', jobId: 'j-agent', subscriptionId: 's1', provider: 'claude', prompt: 'hello', sessionId: null, model: null, timeoutMs: 5000, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.some(m => m.type === 'job.done' && m.jobId === 'j-agent'));
    expect(server.received.find(m => m.type === 'job.done' && m.jobId === 'j-agent')).toMatchObject({ ok: true, error: null });

    server.send({ type: 'tests.run', partId: 'p-broken', repo: { url: 'https://github.com/acme/shop.git', token: '' }, branch: null, task: 3, command: 'npm test', part: 1, parts: 1, timeoutMs: 60000 });
    await server.wait(() => server.received.some(m => m.type === 'tests.done' && m.partId === 'p-broken'));
    expect(server.received.find(m => m.type === 'tests.done' && m.partId === 'p-broken')).toMatchObject({
      ok: false,
      error: 'failed',
      log: 'Playwright Chromium could not start: libnss3.so: cannot open shared object file',
    });

    currentError = null;
    await server.wait(() => server.received.some(m => m.type === 'status' && m.browserError === null));
    expect(server.received.findLast(m => m.type === 'status')).toMatchObject({
      type: 'status',
      browserError: null,
      noRuns: null,
    });
    expect(lines).toContain('Playwright Chromium is ready.');
    expect(existsSync(join(dir, 'browser-error'))).toBe(false);
  });
});

function descriptionRepo(dir: string) {
  const root = join(dir, 'description-source'); mkdirSync(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '--allow-empty', '-m', 'No descriptor'], { cwd: root });
  const localUrl = new URL(`file://${root}`).href, url = 'https://example.test/description.git';
  const read: typeof readTestEnvironment = (repo, scope, sha, context) => readTestEnvironment({ ...repo, url: localUrl }, { ...scope, repoUrlHash: createHash('sha256').update(localUrl).digest('hex') }, sha, context);
  return { read, repo: { url, token: '' }, commitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), repositoryScope: { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: createHash('sha256').update(url).digest('hex') } };
}

const environmentTestUid = 2_000_000_000 + (process.getuid?.() ?? 0) % 1_000_000;
const environmentTestUser = { uid: environmentTestUid, gid: environmentTestUid };

it('queues description discovery before reading a cold mirror and replies with a typed missing descriptor', async () => {
  const server = await fakeServer(false), dir = nodeDir(server.url), source = descriptionRepo(dir);
  const node = await runNode({ dir, adapter, log: () => {}, testUser: environmentTestUser, describeEnvironment: source.read }); onTestFinished(() => node.stop());
  await server.wait(() => server.received.some(frame => frame.type === 'hello'));
  expect(server.received.find(frame => frame.type === 'hello')).toMatchObject({ testEnvironmentVersion: 1, testRuntimes: expect.arrayContaining([expect.objectContaining({ id: 'node' })]) });
  const requestId = '33333333-3333-4333-8333-333333333333'; server.send({ type: 'tests.describe', requestId, ...source });
  await server.wait(() => server.received.some(frame => frame.type === 'check.acquire'));
  expect(server.received.filter(frame => frame.type === 'tests.described')).toEqual([]);
  const acquired = server.received.find(frame => frame.type === 'check.acquire')!;
  server.send({ type: 'check.state', id: acquired.id, state: 'running', position: 0 });
  await server.wait(() => server.received.some(frame => frame.type === 'tests.described'));
  expect(server.received.find(frame => frame.type === 'tests.described')).toMatchObject({ requestId, commitSha: source.commitSha, result: { status: 'error', problem: { code: 'environment_missing' } } });
  await server.wait(() => server.received.some(frame => frame.type === 'check.release'));
});

it('waits for its turn to get a product harness ready, says how it went, and says it takes harnesses', async () => {
  const server = await fakeServer(false), dir = nodeDir(server.url), source = descriptionRepo(dir);
  const node = await runNode({ dir, adapter, log: () => {}, testUser: environmentTestUser, describeEnvironment: source.read }); onTestFinished(() => node.stop());
  await server.wait(() => server.received.some(frame => frame.type === 'hello'));
  expect(server.received.find(frame => frame.type === 'hello')).toMatchObject({ testHarness: 1 });
  const requestId = '55555555-5555-4555-8555-555555555555';
  server.send({ type: 'tests.harness', requestId, repositoryScope: source.repositoryScope, repo: source.repo, commitSha: source.commitSha });
  await server.wait(() => server.received.some(frame => frame.type === 'check.acquire'));
  expect(server.received.filter(frame => frame.type === 'tests.harness.done')).toEqual([]);
  const acquired = server.received.find(frame => frame.type === 'check.acquire')!;
  server.send({ type: 'check.state', id: acquired.id, state: 'running', position: 0 });
  await server.wait(() => server.received.some(frame => frame.type === 'tests.harness.done'));
  expect(server.received.find(frame => frame.type === 'tests.harness.done')).toMatchObject({ requestId, commitSha: source.commitSha, result: { status: 'error' } });
  await server.wait(() => server.received.some(frame => frame.type === 'check.release'));
});

/* Without its fingerprints the server runs everything, whatever it has kept. */
it('describes a product by itself with what lets the server reuse results', async () => {
  const server = await fakeServer(), dir = nodeDir(server.url), root = join(dir, 'described-source');
  mkdirSync(join(root, '.hornhoof'), { recursive: true }); mkdirSync(join(root, 'test'));
  writeFileSync(join(root, '.hornhoof/test-environment.json'), JSON.stringify({
    version: 1, defaultProfile: 'fast', profiles: [{ id: 'fast', requiredSuiteIds: ['unit'] }, { id: 'full', requiredSuiteIds: ['unit'] }], runtimes: [{ id: 'node', version: process.versions.node.split('.')[0] }],
    execution: { version: 2, fullRun: { everyTurns: 5, replaces: 'fast', profile: 'full' } },
    dependencies: { adapter: 'none', inputs: [], install: [], paths: [], cache: 'none' }, services: [], prepare: [], reset: null,
    suites: [{ id: 'unit', root: '.', files: ['test/*.js'], run: { program: 'node', args: ['run.js'], cwd: '.' }, split: { kind: 'argv-files' }, profiles: ['fast', 'full'] }],
    impact: { adapter: 'whole-package', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'None.' } }, mutation: { status: 'unsupported', language: 'typescript', reason: 'None.' },
  }));
  writeFileSync(join(root, 'run.js'), ''); writeFileSync(join(root, 'test/a.js'), '');
  execFileSync('git', ['init', '--quiet'], { cwd: root }); execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'Described'], { cwd: root });
  const url = 'https://example.test/described.git', commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const repositoryScope = { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: createHash('sha256').update(url).digest('hex') };
  /* The commit is in the mirror already, so the node asks no one for it. */
  const cached = join(dir, 'cache', repositoryScope.companyId, repositoryScope.repositoryOwnerId, repositoryScope.repoUrlHash);
  mkdirSync(cached, { recursive: true, mode: 0o700 });
  execFileSync('git', ['clone', '--quiet', '--bare', root, join(cached, 'mirror.git')]);
  const node = await runNode({ dir, adapter, log: () => {}, testUser: environmentTestUser }); onTestFinished(() => node.stop());
  await server.wait(() => server.received.some(frame => frame.type === 'hello'));
  server.send({ type: 'tests.describe', requestId: '66666666-6666-4666-8666-666666666666', repo: { url, token: '' }, commitSha, repositoryScope });
  await server.wait(() => server.received.some(frame => frame.type === 'tests.described'), 15_000);
  expect(server.received.find(frame => frame.type === 'tests.described')).toMatchObject({ result: { status: 'ready', fingerprints: [{ suiteId: 'unit', file: 'test/a.js' }] } });
});

it('cancels a queued description before repository materialization', async () => {
  const server = await fakeServer(false), dir = nodeDir(server.url), source = descriptionRepo(dir);
  const node = await runNode({ dir, adapter, log: () => {}, testUser: environmentTestUser, describeEnvironment: source.read }); onTestFinished(() => node.stop());
  await server.wait(() => server.received.some(frame => frame.type === 'hello'));
  const requestId = '44444444-4444-4444-8444-444444444444'; server.send({ type: 'tests.describe', requestId, ...source });
  await server.wait(() => server.received.some(frame => frame.type === 'check.acquire'));
  server.send({ type: 'tests.describe.cancel', requestId });
  await server.wait(() => server.received.some(frame => frame.type === 'tests.described'));
  expect(server.received.find(frame => frame.type === 'tests.described')).toMatchObject({ result: { status: 'error', problem: { code: 'cancelled' } } });
  expect(existsSync(join(dir, 'cache', source.repositoryScope.companyId))).toBe(false);
});

it('reports a metadata deadline and replays its settled reply without acquiring another slot', async () => {
  const server = await fakeServer(), dir = nodeDir(server.url), source = descriptionRepo(dir);
  const node = await runNode({ dir, adapter, log: () => {}, testUser: environmentTestUser, describeEnvironment: async () => { throw new DOMException('Description deadline expired.', 'TimeoutError'); } }); onTestFinished(() => node.stop());
  await server.wait(() => server.received.some(frame => frame.type === 'hello'));
  const request = { type: 'tests.describe', requestId: '66666666-6666-4666-8666-666666666666', ...source };
  server.send(request); await server.wait(() => server.received.some(frame => frame.type === 'tests.described'));
  expect(server.received.find(frame => frame.type === 'tests.described')).toMatchObject({ result: { status: 'error', problem: { code: 'timeout' } } });
  server.send(request); await server.wait(() => server.received.filter(frame => frame.type === 'tests.described').length === 2);
  expect(server.received.filter(frame => frame.type === 'check.acquire')).toHaveLength(1);
});

it('keeps a stopped part cleanup exclusive when another machine slot is granted to the same test user', async () => {
  const server = await fakeServer(), dir = nodeDir(server.url);
  let release!: () => void, cleaning = false;
  const cleanup = new Promise<void>(done => { release = done; });
  const runPart = vi.fn<typeof runTests>(async (message, options) => {
    if (message.partId === 'first') {
      await new Promise<void>(done => { if (options.signal!.aborted) done(); else options.signal!.addEventListener('abort', () => done(), { once: true }); });
      cleaning = true; await cleanup;
    }
    return { type: 'tests.done', partId: message.partId, ok: message.partId !== 'first', exitCode: message.partId === 'first' ? null : 0, error: message.partId === 'first' ? 'cancelled' : null, commit: null, log: 'cleanup finished' };
  });
  const node = await runNode({ dir, adapter, testUser: environmentTestUser, runPart, log: () => {} });
  onTestFinished(() => { release(); node.stop(); });
  await server.wait(() => server.received.some(frame => frame.type === 'hello'));
  const part = { type: 'tests.run', repo: { url: 'https://example.test/repo.git', token: '' }, branch: null, task: 1, command: 'check', part: 1, parts: 1, timeoutMs: 1000 };
  server.send({ ...part, partId: 'first' }); await server.wait(() => vi.mocked(runPart).mock.calls.length === 1);
  server.send({ type: 'tests.cancel', partId: 'first' }); await server.wait(() => cleaning);
  server.send({ ...part, partId: 'second' }); await server.wait(() => server.received.filter(frame => frame.type === 'check.acquire').length === 2);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(runPart).toHaveBeenCalledTimes(1);
  expect(server.received.some(frame => frame.type === 'tests.started' && frame.partId === 'second')).toBe(false);
  expect(server.received).toContainEqual({ type: 'tests.waiting', partId: 'second', position: 1 });
  release(); await server.wait(() => server.received.some(frame => frame.type === 'tests.done' && frame.partId === 'second'));
  expect(runPart).toHaveBeenCalledTimes(2);
});

describe('checking work before admission', () => {
  it.each(['npm ci && npm run build', 'vitest run first.test.ts', 'crapper --use-existing-coverage src/a.ts', 'npm run ordinary'])('refuses %s before any part preparation', async command => {
    const server = await fakeServer(), dir = nodeDir(server.url);
    const sentinel = join(dir, 'payload-started');
    const runPart: typeof runTests = async part => {
      writeFileSync(sentinel, 'part preparation started');
      return { type: 'tests.done', partId: part.partId, ok: true, exitCode: 0, error: null, commit: null, log: 'fixture part ran' };
    };
    const node = await runNode({ dir, adapter, testUser: environmentTestUser, runPart, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(frame => frame.type === 'hello'));
    const stale = join(dir, 'runs', 'checking-work', 'work');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'package.json'), JSON.stringify({ scripts: { ordinary: 'echo stale-authorization' } }));
    server.send({ type: 'tests.run', kind: 'work', partId: 'checking-work', repo: null, branch: null, task: 1, command, part: 1, parts: 1, timeoutMs: 1000 });
    await server.wait(() => server.received.some(frame => frame.type === 'tests.done' && frame.partId === 'checking-work'));
    expect(existsSync(sentinel)).toBe(false);
    expect(server.received.filter(frame => frame.type === 'check.acquire')).toEqual([]);
    expect(server.received.filter(frame => frame.type === 'tests.started')).toEqual([]);
    expect(server.received.find(frame => frame.type === 'tests.done' && frame.partId === 'checking-work')).toMatchObject({ ok: false, exitCode: null, error: 'failed', commit: null, log: expect.stringContaining('запусти через run_tests') });
  });

  it('refuses a product selection labelled work before its lifecycle starts', async () => {
    const server = await fakeServer(), dir = nodeDir(server.url), sentinel = join(dir, 'product-started');
    const runPart: typeof runTests = async part => {
      writeFileSync(sentinel, 'product preparation started');
      return { type: 'tests.done', partId: part.partId, ok: true, exitCode: 0, error: null, commit: null, log: 'unexpected product execution' };
    };
    const node = await runNode({ dir, adapter, testUser: environmentTestUser, runPart, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(frame => frame.type === 'hello'));
    const manifest = parseTestEnvironment({ version: 1, defaultProfile: 'fast', runtimes: [], profiles: [{ id: 'fast', requiredSuiteIds: ['unit'] }],
      dependencies: { adapter: 'npm', inputs: [], install: [], paths: [], cache: 'none' }, services: [], prepare: [], reset: null,
      suites: [{ id: 'unit', root: '.', files: ['one.test.js'], run: { program: 'node', args: ['one.test.js'], cwd: '.' }, split: { kind: 'argv-files' }, profiles: ['fast'] }],
      impact: { adapter: 'whole-package', fullPackageGlobs: [], migrationCheck: { status: 'unsupported', reason: 'Fixture.' } }, mutation: { status: 'unsupported', language: 'javascript', reason: 'Fixture.' } });
    const manifestSource = JSON.stringify(manifest), commitSha = 'a'.repeat(40);
    const repositoryScope = { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: 'b'.repeat(64) };
    const description = { version: 1, repositoryScope, commitSha, manifestSource, manifestHash: createHash('sha256').update(manifestSource).digest('hex'), manifest, inputDigests: [], inventory: [{ suiteId: 'unit', file: 'one.test.js', selectionUnit: 'one.test.js' }], runtimeCapabilities: [] };
    server.send({ type: 'tests.run', kind: 'work', partId: 'product-work', repo: { url: 'https://example.test/product.git', token: '' }, repositoryScope, commitSha, branch: null, task: 1, command: '', part: 1, parts: 1, timeoutMs: 1000,
      environment: { snapshot: { description, profile: 'fast' }, selection: { kind: 'suite', suiteId: 'unit', files: ['one.test.js'] } } });
    await server.wait(() => server.received.some(frame => frame.type === 'tests.done' && frame.partId === 'product-work'));
    expect(existsSync(sentinel)).toBe(false);
    expect(server.received.filter(frame => frame.type === 'check.acquire' || frame.type === 'tests.started')).toEqual([]);
    expect(server.received.find(frame => frame.type === 'tests.done' && frame.partId === 'product-work')).toMatchObject({ ok: false, exitCode: null, log: expect.stringMatching(/^запусти через run_tests\n/) });
  });

  it.each(['npm ci', 'echo prepared'])('keeps non-check work %s inside one existing slot', async command => {
    const server = await fakeServer(), dir = nodeDir(server.url);
    const sentinel = join(dir, 'payload-started');
    const runPart: typeof runTests = async part => {
      writeFileSync(sentinel, part.kind ?? 'test');
      return { type: 'tests.done', partId: part.partId, ok: false, exitCode: 7, error: 'failed', commit: null, log: 'original work output' };
    };
    const node = await runNode({ dir, adapter, testUser: environmentTestUser, runPart, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(frame => frame.type === 'hello'));
    server.send({ type: 'tests.run', kind: 'work', partId: 'ordinary-work', repo: null, branch: null, task: 1, command, part: 1, parts: 1, timeoutMs: 1000 });
    await server.wait(() => server.received.some(frame => frame.type === 'tests.done' && frame.partId === 'ordinary-work'));
    expect(readFileSync(sentinel, 'utf8')).toBe('work');
    expect(server.received.filter(frame => frame.type === 'check.acquire')).toHaveLength(1);
    expect(server.received.filter(frame => frame.type === 'tests.started')).toHaveLength(1);
    expect(server.received.find(frame => frame.type === 'tests.done' && frame.partId === 'ordinary-work')).toMatchObject({ ok: false, exitCode: 7, log: 'original work output' });
  });
});
