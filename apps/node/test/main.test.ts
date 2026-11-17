import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { HELLO_IDS_BEFORE_ACKS, parseNodeMessage, parseTestEnvironment } from '@hornhoof/protocol';
import { readTestEnvironment } from '../src/test-environment.js';
import { DEFAULT_BACKOFF } from '../src/connection.js';
import { buildOf, runNode } from '../src/main.js';
import { prepareNodeStop } from '../src/lifecycle.js';
import { Outbox } from '../src/outbox.js';
import { ProgramUpdates } from '../src/program-updates.js';
import { antigravityAdapter } from '../src/providers/antigravity.js';
import { TerminalHost, type TermJob } from '../src/terminal/host.js';
import { StreamMask } from '../src/terminal/mask.js';
import { claudeProgram } from '../src/terminal/programs.js';
import { Tmux } from '../src/terminal/tmux.js';
import type { ProviderAdapter, RunInput } from '../src/runner.js';
import { isRemoved, writeState } from '../src/state.js';
import type { runTests } from '../src/tests.js';
import { eventually } from '../../../test-support/eventually.mjs';
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

/* grantChecks: it gives every check slot a node asks for at once. acks: it says in its upgrade answer that it confirms
   numbered messages, as a server of this build does. port: the one a server of the same node listened on before. */
async function fakeServer({ grantChecks = true, acks = false, port }: { grantChecks?: boolean; acks?: boolean; port?: number } = {}) {
  const server = new WebSocketServer({ port: port ?? await testPort(), host: '127.0.0.1' });
  onTestFinished(() => server.close());
  if (acks) server.on('headers', headers => headers.push('Hornhoof-Acks: 1'));
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
  const wait = (check: () => boolean) => eventually(check);
  const send = (m: object) => socket!.send(JSON.stringify(m));
  /* Everything the node sent before it answers these words has come in: the answer follows it on the same socket. */
  const barrier = async (ref: string) => {
    send({ type: 'agent.say', agentKey: 'none', text: 'barrier', ref });
    await wait(() => received.some(m => m.type === 'agent.said' && m.ref === ref));
  };
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received, send, drop: () => socket!.terminate(), wait, barrier,
    /* The server closes the socket with a code, and how many sockets it has open. */
    close: (code: number) => socket!.close(code),
    open: () => server.clients.size,
    port: (server.address() as AddressInfo).port,
    /* The server goes away, as an app that is restarting does. */
    stop: () => {
      for (const client of server.clients) client.terminate();
      return new Promise<void>(done => server.close(() => done()));
    },
  };
}

/* A job's own limit that cannot run out in a test: runJob gives up a tenth of it later, 30 s at most, and setTimeout takes
   no delay above 2_147_483_647 ms. */
const NO_LIMIT = 2_147_483_647 - 30_000;
/* A round of the node that no test waits for: the largest delay setTimeout takes. */
const NEVER = 2_147_483_647;
/* The longest pause the node takes before it connects again after a connection that worked: firstMs and a quarter more. */
const RETRY_MS = DEFAULT_BACKOFF.firstMs * 1.25;

/* The node's timeouts, and with `rounds` its intervals, on a fake clock the test moves. It goes in before the node starts:
   the node takes setTimeout for its pause before it connects again as it first connects. */
const fakeClock = (rounds = false) => vi.useFakeTimers({ toFake: rounds ? ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] : ['setTimeout', 'clearTimeout'] });
/* Only the node's rounds on a fake clock: how often it reads the limits, says its load, looks at its browser. */
const fakeRounds = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
/* The real clock is back before a test's node stops, so its last message leaves before its socket closes. */
afterEach(() => { vi.useRealTimers(); });

/* Drops the node's socket and waits until the node has heard of it, from its log. */
async function dropped(server: Awaited<ReturnType<typeof fakeServer>>, logs: string[]) {
  const closed = () => logs.filter(line => line.includes('Connection closed')).length;
  const before = closed();
  server.drop();
  await server.wait(() => closed() > before);
}
/* Moves the fake clock past the node's pause before it connects again. */
const comeBack = () => vi.advanceTimersByTimeAsync(RETRY_MS);
async function dropAndReturn(server: Awaited<ReturnType<typeof fakeServer>>, logs: string[]) {
  await dropped(server, logs);
  await comeBack();
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
      const child = spawn(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'fakes', 'run-lifecycle.mjs')], { env: { FAKE_LIFECYCLE_NODE_DIR: dir, PATH: process.env.PATH }, stdio: 'ignore' });
      onTestFinished(() => { child.kill('SIGKILL'); });
      return child;
    };
    const first = start();
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    const boot = server.received[0]!.boot as { startedAt: string };
    const ended = once(first, 'exit');
    first.kill('SIGKILL');
    await ended;
    start();
    await server.wait(() => server.received.filter(m => m.type === 'hello').length === 2);
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
    const server = await fakeServer(), logs: string[] = [];
    fakeClock();
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: line => logs.push(line) });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    const before = server.received[0]!;
    await dropAndReturn(server, logs);
    await server.wait(() => server.received.filter(m => m.type === 'hello').length === 2);
    const after = server.received.findLast(m => m.type === 'hello')!;
    expect(after.boot).toEqual(before.boot);
    expect(after.restart).toMatchObject({ kind: 'unknown', reason: 'unknown' });
    expect(after.nodeLog).toContain('Connection closed');
    expect(server.received.filter(m => m.type === 'node.stopping')).toEqual([]);
  });

  it('gives Hornhoof its current log when asked', async () => {
    const server = await fakeServer();
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'node.log.read', requestId: '0b7c6d4e-1f2a-4b3c-8d9e-0f1a2b3c4d5e' });
    await server.wait(() => server.received.some(m => m.type === 'node.log'));
    expect(server.received.find(m => m.type === 'node.log')).toMatchObject({ requestId: '0b7c6d4e-1f2a-4b3c-8d9e-0f1a2b3c4d5e', log: expect.stringContaining('Node started at') });
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
    server.send({ type: 'job.run', jobId: 'active-update', subscriptionId: 's1', provider: 'claude', prompt: 'finish this', sessionId: null, model: null, timeoutMs: NO_LIMIT, secret: null, instructions: null, toolToken: null });
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
    const logs: string[] = [];
    const node = await runNode({ dir: nodeDir(server.url), adapter, programs, log: line => logs.push(line) });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    expect(server.received[0]).toMatchObject({ programs: [{ version: '1.0.0', updating: false, failed: true }] });
    expect(JSON.stringify(server.received)).not.toContain('private npm credential');
    /* npm's words stay on the machine, in its own output, and never in the log the node gives Hornhoof. */
    await eventually(() => logs.includes('Could not update claude: private npm credential'));
    server.send({ type: 'programs.update' });
    await server.wait(() => server.received.some(m => m.type === 'status' && JSON.stringify(m.programs).includes('2.0.0')));
    expect(server.received.filter(m => m.type === 'status').at(-1)).toMatchObject({ programs: [{ version: '2.0.0', updating: false, failed: false }] });
  });

  it('does not replay a delivered live event when its connection comes back', async () => {
    const server = await fakeServer(), logs: string[] = [];
    fakeClock();
    const node = await runNode({ dir: nodeDir(server.url), log: line => logs.push(line), adapter: {
      ...adapter, run: async input => { input.onEvent?.({ kind: 'text', text: 'Delivered once.' }); return adapter.run(input); },
    } });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'job.run', jobId: 'delivered', subscriptionId: 's1', provider: 'claude', prompt: 'Say once.', sessionId: null, model: null, timeoutMs: NO_LIMIT, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.some(m => m.type === 'job.done' && m.jobId === 'delivered'));
    expect(server.received.filter(m => m.type === 'job.event' && m.jobId === 'delivered')).toHaveLength(1);
    await dropAndReturn(server, logs);
    await server.wait(() => server.received.filter(m => m.type === 'hello').length === 2);
    server.send({ type: 'agent.say', agentKey: 'none', text: 'barrier', ref: 'reconnected' });
    await server.wait(() => server.received.some(m => m.type === 'agent.said' && m.ref === 'reconnected'));
    expect(server.received.filter(m => m.type === 'job.event' && m.jobId === 'delivered')).toHaveLength(1);
  });

  it('replays current snapshots after hello and reconnect instead of older queued update states', async () => {
    const server = await fakeServer();
    let installed = 1;
    const programs = new ProgramUpdates([{ id: 'codex', readVersion: () => `${installed}.0.0`, install: async () => { installed++; } }]);
    const logs: string[] = [];
    fakeClock();
    const node = await runNode({ dir: nodeDir(server.url), adapter, programs, log: line => logs.push(line) });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    await server.wait(() => server.received.filter(m => m.type === 'status').length >= 2);
    const snapshot = [{ id: 'codex', version: '2.0.0', updating: false, failed: false }];
    expect(server.received[0]).toMatchObject({ programs: snapshot });
    for (const status of server.received.filter(m => m.type === 'status')) expect(status.programs).toEqual(snapshot);
    await dropped(server, logs);
    await programs.update();
    await comeBack();
    await server.wait(() => server.received.filter(m => m.type === 'hello').length === 2);
    const hello = server.received.findLastIndex(m => m.type === 'hello');
    expect(server.received[hello]).toMatchObject({ programs: [{ id: 'codex', version: '3.0.0', updating: false, failed: false }] });
    for (const status of server.received.slice(hello + 1).filter(m => m.type === 'status')) expect(status.programs).toEqual(programs.snapshot());
  });
});

describe('a node that runs agents in terminals', () => {
  it.each([
    ['a personal node without an agent session', true, null],
    ['an API agent workspace without a terminal', false, 'api-agent'],
  ] as const)('keeps the runtime timeout for %s', async (_name, terminal, key) => {
    const server = await fakeServer();
    const dir = nodeDir(server.url);
    let release!: () => void, running = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const tmux = new Tmux({ socket: `hh-program-timeout-${process.pid}`, env: { PATH: process.env.PATH ?? '', HOME: dir } });
    const node = await runNode({ dir, log: () => {}, adapter: { ...adapter, run: async input => { running = true; await pending; return adapter.run(input); } },
      ...(terminal ? { terminal: { tmux, program: claudeProgram, bin: 'claude', home: join(dir, 'home'), signedOut: /not logged in/i } } : {}),
    });
    onTestFinished(() => node.stop());
    try {
      await server.wait(() => server.received.some(m => m.type === 'hello'));
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      server.send({ type: 'job.run', jobId: 'runtime-timeout', subscriptionId: 's1', provider: 'claude', prompt: 'Use a runtime timeout.', sessionId: null, model: null, timeoutMs: 80, secret: null, instructions: null, toolToken: null, ...(key ? { workspace: { key, repo: null } } : {}) });
      await server.wait(() => running);
      /* The node gives the program a tenth of its 80 ms more, 88 ms in all, before it ends the job itself. */
      await vi.advanceTimersByTimeAsync(87);
      await server.barrier('before-timeout');
      expect(server.received.some(m => m.type === 'job.done')).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
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
    fakeClock();
    const node = await runNode({ dir, adapter, log: line => log.push(line), terminal: { tmux, program: claudeProgram, bin: 'claude', home: dir, signedOut: /not logged in/i } });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'agent.say', agentKey: 'agent-1', text: 'Keep these words.', ref: 'offline' });
    await server.wait(() => entered);
    await dropped(server, log);
    receipt(true);
    await comeBack();
    await server.wait(() => server.received.filter(m => m.type === 'hello').length === 2);
    await server.barrier('back');
    expect(server.received.filter(m => m.type === 'agent.said' && m.ref !== 'back')).toEqual([{ type: 'agent.said', ref: 'offline', ok: true }]);
  });

  it('learns a renewed program token between turns and gives it to an existing terminal mask', async () => {
    const server = await fakeServer(), dir = nodeDir(server.url);
    const tokens: string[] = [];
    const tmux = new Tmux({ env: { HOME: dir } });
    const stopAll = vi.spyOn(tmux, 'stopAll').mockResolvedValue();
    const start = vi.spyOn(TerminalHost.prototype, 'start').mockResolvedValue();
    const stop = vi.spyOn(TerminalHost.prototype, 'stop').mockResolvedValue();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let node: Awaited<ReturnType<typeof runNode>> | undefined;
    try {
      node = await runNode({ dir, adapter: { ...adapter, secrets: async () => [...tokens] }, log: () => {}, learnMs: 100,
        terminal: { tmux, program: claudeProgram, bin: 'claude', home: dir, signedOut: /not logged in/i },
      });
      await server.wait(() => server.received.some(m => m.type === 'hello'));
      const host = start.mock.instances[0]! as TerminalHost;
      const mask = new StreamMask(host['opts'].secrets);
      const token = 'late-token-1234567890';
      expect(host['opts'].secrets()).not.toContain(token);
      tokens.push(token);
      await vi.advanceTimersByTimeAsync(100);
      expect(host['opts'].secrets()).toContain(token);
      expect(mask.push(`renewed ${token} here\n`) + mask.flush()).toBe('renewed [hidden] here\n');
      expect(server.received.some(m => m.type === 'job.done' || m.type === 'turn.open')).toBe(false);
    } finally {
      node?.stop();
      vi.useRealTimers();
      stopAll.mockRestore(); start.mockRestore(); stop.mockRestore();
    }
  });

  it("hands the terminal an assistant's whole conversation along with the turn's words", async () => {
    const server = await fakeServer(), dir = nodeDir(server.url);
    const tmux = new Tmux({ env: { HOME: dir } });
    const stopAll = vi.spyOn(tmux, 'stopAll').mockResolvedValue();
    const start = vi.spyOn(TerminalHost.prototype, 'start').mockResolvedValue();
    const stop = vi.spyOn(TerminalHost.prototype, 'stop').mockResolvedValue();
    const jobs: TermJob[] = [];
    const run = vi.spyOn(TerminalHost.prototype, 'run').mockImplementation(async job => {
      jobs.push(job);
      return { ok: true, sessionId: 's1', result: 'Done.', output: '', error: null, limits: null };
    });
    let node: Awaited<ReturnType<typeof runNode>> | undefined;
    try {
      node = await runNode({ dir, adapter, log: () => {}, terminal: { tmux, program: claudeProgram, bin: 'claude', home: dir, signedOut: /not logged in/i } });
      await server.wait(() => server.received.some(m => m.type === 'hello'));
      const turn = { type: 'job.run', subscriptionId: 's1', provider: 'claude', prompt: 'Max: and?', sessionId: 's1', model: null, timeoutMs: 10_000, secret: null, instructions: null, toolToken: null, workspace: { key: 'assistant', repo: null } };
      server.send({ ...turn, jobId: 'with', freshPrompt: 'Max: hi\n\nMax: and?' });
      server.send({ ...turn, jobId: 'without' });
      await server.wait(() => ['with', 'without'].every(id => server.received.some(m => m.type === 'job.done' && m.jobId === id)));
      expect(jobs.find(job => job.input.jobId === 'with')).toMatchObject({ freshPrompt: 'Max: hi\n\nMax: and?', input: { prompt: 'Max: and?' } });
      expect(jobs.find(job => job.input.jobId === 'without')?.freshPrompt).toBeUndefined();
    } finally {
      node?.stop();
      stopAll.mockRestore(); start.mockRestore(); stop.mockRestore(); run.mockRestore();
    }
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
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: NO_LIMIT, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.some(m => m.type === 'job.done'));
    expect(server.received.map(m => m.type)).toEqual(['hello', 'job.started', 'status', 'job.done']);
    expect(server.received[2]).toMatchObject({ loggedIn: true, limits: { status: 'allowed', windows: [] } });
    expect(server.received[3]).toMatchObject({ jobId: 'j1', ok: true, result: 'ready', sessionId: 'sess-9' });
  });

  it("runs a one-shot call in its program's one-call mode only once the machine's check queue gives it a slot", async () => {
    const server = await fakeServer({ grantChecks: false });
    const asked: string[] = [];
    const calling: ProviderAdapter = { ...adapter, oneCall: async input => { asked.push(input.prompt); return { ok: true, sessionId: null, result: 'two findings', output: '', error: null, limits: null }; } };
    const node = await runNode({ dir: nodeDir(server.url), adapter: calling, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'job.run', jobId: 'c1', subscriptionId: 's1', provider: 'claude', prompt: 'review this', sessionId: null, model: null, timeoutMs: NO_LIMIT, secret: null, instructions: null, toolToken: null, call: true });
    await server.wait(() => server.received.some(m => m.type === 'check.acquire'));
    await server.barrier('before-slot');
    expect(asked).toEqual([]);
    const ask = server.received.find(m => m.type === 'check.acquire')!;
    expect(ask).toMatchObject({ label: 'A one-shot call' });
    server.send({ type: 'check.state', id: ask.id, state: 'running', position: 0 });
    await server.wait(() => server.received.some(m => m.type === 'job.done'));
    expect(asked).toEqual(['review this']);
    expect(server.received.find(m => m.type === 'job.done')).toMatchObject({ jobId: 'c1', ok: true, result: 'two findings' });
  });

  it('sends a finished job again after the connection drops before Hornhoof confirms it, and stops once Hornhoof does', async () => {
    const server = await fakeServer(), logs: string[] = [];
    fakeClock();
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: line => logs.push(line) });
    onTestFinished(() => node.stop());
    const hellos = () => server.received.filter(m => m.type === 'hello');
    const dones = () => server.received.filter(m => m.type === 'job.done' && m.jobId === 'j1');
    await server.wait(() => hellos().length === 1);
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: NO_LIMIT, secret: null, instructions: null, toolToken: null });
    await server.wait(() => dones().length === 1);
    await dropAndReturn(server, logs);
    await server.wait(() => dones().length === 2);
    expect(hellos()[1]).toMatchObject({ running: ['j1'] });
    expect(dones()[1]).toMatchObject({ ok: true, result: 'ready' });

    server.send({ type: 'job.ack', jobId: 'j1' });
    await server.barrier('acknowledged');
    await dropAndReturn(server, logs);
    await server.wait(() => hellos().length === 3);
    await server.barrier('back');
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
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: NO_LIMIT, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.some(m => m.type === 'job.done'));
    expect(server.received.find(m => m.type === 'status')).toMatchObject({ models: [{ id: 'opus', name: 'Opus' }] });
  });

  it("asks its program for the plan's limits on its own, now and then, and says each reading, also one that moved nothing, so they do not go stale in Hornhoof", async () => {
    const server = await fakeServer();
    const seen = [0.1, 0.1, 0.25];
    let asked = 0;
    const limits = async () => ({ status: 'allowed' as const, windows: [{ name: 'seven_day', utilization: seen[Math.min(asked++, seen.length - 1)]!, resetsAt: null }] });
    fakeRounds();
    const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, limits }, log: () => {}, limitsMs: 40 });
    onTestFinished(() => node.stop());
    const readings = () => server.received.filter(m => m.type === 'status' && m.limits !== null).map(m => (m.limits as { windows: { utilization: number }[] }).windows[0]!.utilization);
    await server.wait(() => readings().length === 1);
    await vi.advanceTimersByTimeAsync(40);
    await server.wait(() => readings().length === 2);
    await vi.advanceTimersByTimeAsync(40);
    await server.wait(() => readings().length === 3);
    expect(readings()).toEqual([0.1, 0.1, 0.25]);
  });

  it('says no limits in a status with no reading behind it, so Hornhoof does not take old ones for fresh, in a frame Hornhoof still reads', async () => {
    const server = await fakeServer();
    const reading = { status: 'allowed' as const, windows: [{ name: 'seven_day', utilization: 0.4, resetsAt: null }], complete: true };
    const answers: (() => Promise<typeof reading | null>)[] = [async () => reading];
    const limits = () => (answers.shift() ?? (async () => { throw new Error('the source is down'); }))();
    const run = async (input: RunInput) => ({ ok: input.prompt !== 'signed out', sessionId: 'sess-9', result: 'ready', output: '', error: input.prompt === 'signed out' ? 'not_logged_in' as const : null, limits: null });
    const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, run, limits }, log: () => {}, limitsMs: NEVER });
    onTestFinished(() => node.stop());
    const statuses = () => server.received.filter(m => m.type === 'status');
    const job = (jobId: string, prompt: string) => ({ type: 'job.run', jobId, subscriptionId: 's1', provider: 'claude', prompt, sessionId: null, model: null, timeoutMs: NO_LIMIT, secret: null, instructions: null, toolToken: null });
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
    fakeRounds();
    const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, account: async () => account, limits }, log: () => {}, limitsMs: 15 });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello') && looks === 1);
    await vi.advanceTimersByTimeAsync(45);
    await server.wait(() => looks === 4);
    await server.barrier('looked');
    /* A look that read nothing has nothing to say. */
    expect(server.received.filter(m => m.type === 'status')).toEqual([]);
    account = { email: 'x@y.z', tier: 'max' };
    await vi.advanceTimersByTimeAsync(15);
    await server.wait(() => server.received.some(m => m.type === 'status'));
    expect(server.received.find(m => m.type === 'status')).toMatchObject({ account, limits: null });
  });

  it('says a reading once, in the next status that goes out, whichever that is', async () => {
    const server = await fakeServer();
    const dir = nodeDir(server.url);
    let browser: string | null = 'libnss3.so missing';
    const turn = { status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.2, resetsAt: null }] };
    const run = async () => ({ ok: true, sessionId: 'sess-9', result: 'ready', output: '', error: null, limits: turn });
    fakeRounds();
    const node = await runNode({ dir, adapter: { ...adapter, run }, log: () => {}, checkBrowser: async () => browser, browserCheckMs: 30 });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: NO_LIMIT, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.some(m => m.type === 'job.done'));
    expect(server.received.filter(m => m.type === 'status').map(m => m.limits)).toEqual([turn]);

    /* A browser that recovers has nothing to say of the limits. */
    browser = null;
    await vi.advanceTimersByTimeAsync(30);
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
    fakeRounds();
    const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, models, limits, account: async () => account }, log: () => {}, limitsMs: 15 });
    onTestFinished(() => node.stop());
    const readings = () => server.received.filter(m => m.type === 'status' && m.limits !== null).length;
    await server.wait(() => readings() === 1);
    await vi.advanceTimersByTimeAsync(60);
    await server.wait(() => readings() === 5);
    expect(listed).toBe(1);
    expect(server.received.filter(m => m.type === 'status').at(-1)).toMatchObject({ models: [{ id: 'opus', name: 'Opus' }] });
    account = { email: 'x@y.z', tier: 'max' };
    await vi.advanceTimersByTimeAsync(15);
    await server.wait(() => listed === 2);
  });

  describe('while Hornhoof is away', () => {
    const readingOf = (m: { [k: string]: unknown }) => (m.limits as { windows: { utilization: number }[] }).windows[0]!.utilization;
    const usage = (utilization: number) => ({ status: 'allowed' as const, windows: [{ name: 'seven_day', utilization, resetsAt: null }] });
    const job = (jobId: string) => ({ type: 'job.run', jobId, subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: NO_LIMIT, secret: null, instructions: null, toolToken: null });
    const framesAfterHello = (received: { type: string; [k: string]: unknown }[]) => received.slice(received.findLastIndex(m => m.type === 'hello') + 1);
    const helloAgain = (server: Awaited<ReturnType<typeof fakeServer>>) => server.wait(() => server.received.filter(m => m.type === 'hello').length === 2);

    it('keeps no reading in the queue, and says only the newest when it is back', async () => {
      const server = await fakeServer(), logs: string[] = [];
      let asked = 0;
      const limits = async () => usage(++asked / 100_000);
      fakeClock(true);
      const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, limits }, log: line => logs.push(line), limitsMs: 10 });
      onTestFinished(() => node.stop());
      await server.wait(() => server.received.some(m => m.type === 'status' && m.limits !== null));
      const askedBefore = asked;
      await dropped(server, logs);
      /* A round each 10 ms through its pause of 750 ms or more before it connects again. */
      await comeBack();
      await helloAgain(server);
      await server.wait(() => framesAfterHello(server.received).some(m => m.type === 'status'));
      const first = framesAfterHello(server.received).find(m => m.type === 'status')!;
      /* Scores were read while it was away; the oldest of them would come first from a queue. */
      expect(readingOf(first)).toBeGreaterThan((askedBefore + 5) / 100_000);
    });

    it('puts no reading in a status that waits for the connection, and says it once it is back, before the job it came with', async () => {
      const server = await fakeServer();
      const turn = usage(0.3);
      let end: () => void = () => {};
      const run = () => new Promise<Awaited<ReturnType<ProviderAdapter['run']>>>(done => { end = () => done({ ok: true, sessionId: 'sess-9', result: 'ready', output: '', error: null, limits: turn }); });
      const logs: string[] = [];
      fakeClock();
      const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, run, limits: async () => null }, log: line => logs.push(line), limitsMs: NEVER });
      onTestFinished(() => node.stop());
      await server.wait(() => server.received.some(m => m.type === 'hello'));
      server.send(job('j1'));
      await server.wait(() => server.received.some(m => m.type === 'job.started'));
      /* The node hears of the drop, and the job ends with it away. */
      await dropped(server, logs);
      end();
      await comeBack();
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
      const logs: string[] = [];
      fakeClock(true);
      const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, run, limits }, log: line => logs.push(line), limitsMs: 10 });
      onTestFinished(() => node.stop());
      await server.wait(() => server.received.some(m => m.type === 'status' && m.limits !== null));
      away = true;
      await dropped(server, logs);
      /* Rounds go by while it is away: the first reads, the next one fails. */
      await comeBack();
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
      const logs: string[] = [];
      fakeClock(true);
      const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, run, limits }, log: line => logs.push(line), limitsMs: 10 });
      onTestFinished(() => node.stop());
      await server.wait(() => server.received.some(m => m.type === 'hello'));
      server.send(job('j1'));
      await server.wait(() => server.received.some(m => m.type === 'job.started'));
      await dropped(server, logs);
      end();
      /* A look or two after the job's end. */
      const seen = looks;
      await vi.advanceTimersByTimeAsync(30);
      await server.wait(() => looks >= seen + 3);
      await comeBack();
      await helloAgain(server);
      await server.wait(() => framesAfterHello(server.received).some(m => m.type === 'job.done'));
      for (const status of framesAfterHello(server.received).filter(m => m.type === 'status')) expect(status).toMatchObject({ limits: null });
    });

    it('keeps a reading through a failed one while Hornhoof is there, as the status that says it is on its way', async () => {
      const server = await fakeServer();
      const turn = usage(0.3);
      let asked = 0, listing = 0;
      let gate: Promise<void> = Promise.resolve();
      let open: () => void = () => {};
      const models = async () => {
        listing++;
        await gate;
        return [{ id: 'opus', name: 'Opus' }];
      };
      const limits = async () => {
        asked++;
        return null;
      };
      const run = async () => ({ ok: true, sessionId: 'sess-9', result: 'ready', output: '', error: null, limits: turn });
      fakeRounds();
      const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, run, models, limits }, log: () => {}, limitsMs: 10 });
      onTestFinished(() => node.stop());
      await server.wait(() => server.received.some(m => m.type === 'hello'));
      gate = new Promise(resolve => { open = resolve; });
      server.send(job('j1'));
      /* The job's status waits for the models while readings fail. */
      await server.wait(() => listing === 2);
      const seen = asked;
      await vi.advanceTimersByTimeAsync(30);
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
    let looks = 0;
    const limits = async () => { try { return await agy.limits!(); } finally { looks++; } };
    fakeRounds();
    /* Avoid spawning tmux setup checks during a non-terminal limits test. */
    const node = await runNode({ dir, adapter: { ...agy, limits, setupNeeded: async () => false }, log: () => {}, limitsMs: 60 });
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
    const seen = looks;
    await vi.advanceTimersByTimeAsync(60);
    await server.wait(() => looks > seen);
    await server.barrier('failed-look');
    expect(server.received.filter(m => m.type === 'status').every(m => (m.limits as { status?: string } | null)?.status !== 'rejected')).toBe(true);
    delete process.env.FAKE_LIMITS_MODE;

    /* A job updates the limits right away before reporting job.done. */
    writeFileSync(join(home, 'fake-agy-usage.json'), usageWith(0.25));
    const statusesBefore = server.received.filter(m => m.type === 'status').length;
    server.send({ type: 'job.run', jobId: 'j-agy', subscriptionId: 's1', provider: 'antigravity', prompt: 'say ready', sessionId: null, model: null, timeoutMs: NO_LIMIT, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.some(m => m.type === 'job.done' && m.jobId === 'j-agy'));
    expect(server.received.filter(m => m.type === 'status').length).toBeGreaterThan(statusesBefore);
    const done = server.received.findIndex(m => m.type === 'job.done' && m.jobId === 'j-agy');
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
    const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, run, limits: async () => week }, log: () => {}, limitsMs: NEVER });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.filter(m => m.type === 'status').length >= 1);
    const job = (jobId: string) => ({ type: 'job.run', jobId, subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: NO_LIMIT, secret: null, instructions: null, toolToken: null });
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

  it('stays at a reached limit while a model week from the usage page is still full, even after a complete turn reading', async () => {
    const server = await fakeServer();
    const opus = { status: 'rejected' as const, windows: [{ name: 'seven_day', utilization: 0.6, resetsAt: null }, { name: 'seven_day_opus', utilization: 1, resetsAt: '2099-11-04T00:00:00.000Z' }], complete: true };
    const turn = { status: 'allowed' as const, windows: [{ name: 'seven_day', utilization: 0.61, resetsAt: null }], complete: true };
    const run = async () => ({ ok: true, sessionId: 'sess-9', result: 'ready', output: '', error: null, limits: turn });
    const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, run, limits: async () => opus }, log: () => {}, limitsMs: NEVER });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.filter(m => m.type === 'status').length >= 1);
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: NO_LIMIT, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.filter(m => m.type === 'status').length >= 2);
    expect(server.received.filter(m => m.type === 'status').at(-1)!.limits).toEqual({
      status: 'rejected',
      windows: [
        { name: 'seven_day', utilization: 0.61, resetsAt: null },
        { name: 'seven_day_opus', utilization: 1, resetsAt: '2099-11-04T00:00:00.000Z' },
      ],
      complete: true,
    });
  });

  it('says in hello how it came up: the same after a dropped connection, anew once it starts again', async () => {
    const server = await fakeServer(), logs: string[] = [];
    const dir = nodeDir(server.url);
    /* The node's clock, and the machine up for an hour under it. */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: Date.parse('2026-11-06T08:00:00.000Z') });
    vi.mocked(uptime).mockReturnValueOnce(3600).mockReturnValueOnce(3600);
    const first = await runNode({ dir, adapter, log: line => logs.push(line) });
    const hellos = () => server.received.filter(m => m.type === 'hello').map(m => m.boot as { startedAt: string; machineUpAt: string; container: string });
    await server.wait(() => hellos().length === 1);
    const [boot] = hellos();
    expect(boot).toEqual({ startedAt: '2026-11-06T08:00:00.000Z', machineUpAt: '2026-11-06T07:00:00.000Z', container: hostname() });
    await dropAndReturn(server, logs);
    await server.wait(() => hellos().length === 2);
    expect(hellos()[1]).toEqual(boot);
    first.stop();
    /* Its last message leaves and its socket closes, and a minute goes by before it starts again. */
    await vi.advanceTimersByTimeAsync(60_000);
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
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'codex', prompt: 'hi', sessionId: null, model: null, timeoutMs: NO_LIMIT, secret: null, instructions: null, toolToken: null });
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
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: NO_LIMIT, secret: null, instructions: null, toolToken: null });
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
    const run = (jobId: string) => server.send({ type: 'job.run', jobId, subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: NO_LIMIT, secret: null, instructions: null, toolToken: null });
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
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: NO_LIMIT, secret: null, instructions: 'Be brief.', toolToken: 'tool-token-0123456789' });
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
    const ready = vi.spyOn(programs, 'ready');
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
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      server.send({ type: 'job.run', jobId: 'late-update', subscriptionId: 's1', provider: 'claude', prompt: 'Wait for the programs.', sessionId: null, model: null, timeoutMs: 100, secret: null, instructions: null, toolToken: null });
      await server.wait(() => preparing);
      server.send({ type: 'programs.update' });
      await server.wait(() => installs === 2);
      blockPreparation = false;
      releasePreparation();
      await server.wait(() => prepared >= 2);
      /* At its launch the job asks again whether the programs are ready: after the test, and as it started. */
      await server.wait(() => ready.mock.calls.length === 3);
      /* Its own limit of 100 ms, and the tenth more the node gives it, do not run while it waits there. */
      await vi.advanceTimersByTimeAsync(110);
      await server.barrier('waiting-at-launch');
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
      server.send({ type: 'job.run', jobId: 'waiting-update', subscriptionId: 's1', provider: 'claude', prompt: 'Do not run this.', sessionId: null, model: null, timeoutMs: NO_LIMIT, secret: null, instructions: null, toolToken: null });
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
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: NO_LIMIT, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.some(m => m.type === 'job.started'));
    server.send({ type: 'job.cancel', jobId: 'other' });
    server.send({ type: 'job.cancel', jobId: 'j1' });
    await server.wait(() => server.received.some(m => m.type === 'job.done'));
    expect(server.received.find(m => m.type === 'job.done')).toMatchObject({ jobId: 'j1', ok: false, error: 'cancelled' });
  });

  it("says how busy its machine is in hello and every while after, with the agent jobs it runs", async () => {
    const server = await fakeServer();
    const slow: ProviderAdapter = { ...adapter, run: input => new Promise(done => input.signal?.addEventListener('abort', () => done({ ok: false, sessionId: null, result: '', output: '', error: 'agent_failed', limits: null }))) };
    fakeRounds();
    const node = await runNode({ dir: nodeDir(server.url), adapter: slow, log: () => {}, loadMs: 40 });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    expect(server.received[0]!.load).toMatchObject({ cpus: expect.any(Number), load: expect.any(Number), memFree: expect.any(Number), memTotal: expect.any(Number), tests: 0, jobs: 0 });
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: NO_LIMIT, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.some(m => m.type === 'job.started'));
    await vi.advanceTimersByTimeAsync(40);
    await server.wait(() => server.received.some(m => m.type === 'load' && m.jobs === 1));
    expect(server.received.find(m => m.type === 'load')).toMatchObject({ cpus: expect.any(Number), memTotal: expect.any(Number), tests: 0 });
    /* It runs no programs in terminals, so it names none. */
    expect(server.received.filter(m => m.type === 'hello' || m.type === 'load').every(m => !('live' in m))).toBe(true);
    server.send({ type: 'job.cancel', jobId: 'j1' });
  });

  it('names the agents whose programs run in its terminals in hello and with each load', async () => {
    const server = await fakeServer();
    const dir = nodeDir(server.url);
    const agent = '7f1c2a9e-0b1d-4c55-9d1e-3f0a8b6c2d11';
    const tmux = new Tmux({ socket: `hh-live-${process.pid}`, env: { PATH: process.env.PATH ?? '', HOME: dir } });
    const live = vi.spyOn(tmux, 'livePrograms').mockResolvedValue([agent]);
    const node = await runNode({ dir, adapter, log: () => {}, loadMs: 40, terminal: { tmux, program: claudeProgram, bin: 'claude', home: dir, signedOut: /not logged in/i } });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    expect(server.received.find(m => m.type === 'hello')).toMatchObject({ live: [agent] });
    live.mockResolvedValue([]);
    await server.wait(() => server.received.some(m => m.type === 'load' && Array.isArray(m.live) && m.live.length === 0));
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
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: () => {}, runPart });
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
    let finish = () => {};
    /* A part ends when the test says so, or a slow one when it is stopped. */
    const runPart: typeof runTests = async (m, { signal, files }) => {
      given.push(files);
      await new Promise<void>(done => {
        if (m.command !== 'slow') finish = done;
        signal?.addEventListener('abort', () => done());
      });
      const stopped = signal?.aborted ?? false;
      return { type: 'tests.done', partId: m.partId, ok: !stopped, exitCode: stopped ? null : 0, error: stopped ? 'cancelled' : null, commit: null, log: stopped ? 'Stopped.' : 'all passed' };
    };
    const logs: string[] = [];
    fakeClock(true);
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: line => logs.push(line), loadMs: 40, runPart, testUser: { uid: 20001, gid: 20001 } });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    expect(server.received[0]).toMatchObject({ type: 'hello', work: true });
    expect(server.received[0]).not.toHaveProperty('noRuns');
    const part = { type: 'tests.run', repo: { url: 'https://github.com/acme/shop.git', token: '' }, branch: null, task: 3, part: 1, parts: 1, timeoutMs: 60000 };
    server.send({ ...part, partId: 'p1', command: 'npm test' });
    await server.wait(() => server.received.some(m => m.type === 'tests.started' && m.partId === 'p1'));
    await vi.advanceTimersByTimeAsync(40);
    await server.wait(() => server.received.some(m => m.type === 'load' && m.tests === 1));
    finish();
    await server.wait(() => server.received.some(m => m.type === 'tests.done'));
    expect(server.received.find(m => m.type === 'tests.done')).toMatchObject({ partId: 'p1', ok: true, exitCode: 0, error: null, log: 'all passed' });
    expect(given[0]).toMatchObject({ get: expect.any(Function), put: expect.any(Function) });

    const hellos = () => server.received.filter(m => m.type === 'hello');
    await dropAndReturn(server, logs);
    await server.wait(() => hellos().length === 2);
    expect(hellos()[1]).toMatchObject({ tests: ['p1'] });
    await server.wait(() => server.received.filter(m => m.type === 'tests.done').length === 2);
    server.send({ type: 'tests.ack', partId: 'p1' });
    await server.barrier('acknowledged');
    await dropAndReturn(server, logs);
    await server.wait(() => hellos().length === 3);
    expect(hellos()[2]).toMatchObject({ tests: [] });

    server.send({ ...part, partId: 'p2', command: 'slow' });
    await server.wait(() => server.received.some(m => m.type === 'tests.started' && m.partId === 'p2'));
    server.send({ type: 'tests.cancel', partId: 'p2' });
    await server.wait(() => server.received.some(m => m.type === 'tests.done' && m.partId === 'p2'));
    expect(server.received.find(m => m.type === 'tests.done' && m.partId === 'p2')).toMatchObject({ ok: false, error: 'cancelled' });
  });

  it('takes a machine check slot before preparing a part or reporting that it started', async () => {
    const server = await fakeServer({ grantChecks: false }), ran: string[] = [];
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

  /* #1060: a socket that drops for a moment, as home-api's did while it took 125 MB of dependencies, stops no part. Its
     slot is claimed again once the node is back, the part goes on, and its end goes out on the new connection. */
  it('keeps a part running under its slot through a short drop and sends its end once back', async () => {
    fakeClock();
    const server = await fakeServer(), logs: string[] = [];
    let finish!: () => void, signal: AbortSignal | undefined;
    const ending = new Promise<void>(done => (finish = done));
    const runPart: typeof runTests = async (m, options) => {
      signal = options.signal;
      await ending;
      return { type: 'tests.done', partId: m.partId, ok: true, exitCode: 0, error: null, commit: null, log: 'checked' };
    };
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: line => logs.push(line), runPart, testUser: { uid: 20001, gid: 20001 } });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'tests.run', partId: 'p4', repo: null, branch: null, task: 3, command: 'check', part: 4, parts: 4, timeoutMs: 600000 });
    await server.wait(() => server.received.some(m => m.type === 'tests.started' && m.partId === 'p4'));
    const id = server.received.find(m => m.type === 'check.acquire')!.id;
    await dropAndReturn(server, logs);
    await server.wait(() => server.received.filter(m => m.type === 'hello').length === 2);
    await server.barrier('back');
    expect(signal?.aborted, 'the part stopped with the drop').toBe(false);
    await server.wait(() => server.received.some(m => m.type === 'check.acquire' && m.resume === true));
    const again = server.received.findIndex(m => m.type === 'check.acquire' && m.resume === true);
    expect(server.received[again]).toMatchObject({ id });
    expect(again).toBeGreaterThan(server.received.findLastIndex(m => m.type === 'hello'));
    expect(server.received.findLast(m => m.type === 'hello')).toMatchObject({ tests: ['p4'] });
    finish();
    await server.wait(() => server.received.some(m => m.type === 'tests.done' && m.partId === 'p4'));
    expect(server.received.find(m => m.type === 'tests.done' && m.partId === 'p4')).toMatchObject({ ok: true });
  });

  it('cancels a queued part without starting preparation or claiming execution began', async () => {
    const server = await fakeServer({ grantChecks: false }), ran: string[] = [];
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
    fakeRounds();
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
      nodeLog: expect.stringContaining('Playwright browsers could not start: libnss3.so: cannot open shared object file'),
    });
    expect(lines.some(line => line.includes('Playwright browsers could not start: libnss3.so'))).toBe(true);
    expect(readFileSync(join(dir, 'browser-error'), 'utf8').trim()).toBe('libnss3.so: cannot open shared object file');

    server.send({ type: 'job.run', jobId: 'j-agent', subscriptionId: 's1', provider: 'claude', prompt: 'hello', sessionId: null, model: null, timeoutMs: NO_LIMIT, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.some(m => m.type === 'job.done' && m.jobId === 'j-agent'));
    expect(server.received.find(m => m.type === 'job.done' && m.jobId === 'j-agent')).toMatchObject({ ok: true, error: null });

    server.send({ type: 'tests.run', partId: 'p-broken', repo: { url: 'https://github.com/acme/shop.git', token: '' }, branch: null, task: 3, command: 'npm test', part: 1, parts: 1, timeoutMs: 60000 });
    await server.wait(() => server.received.some(m => m.type === 'tests.done' && m.partId === 'p-broken'));
    expect(server.received.find(m => m.type === 'tests.done' && m.partId === 'p-broken')).toMatchObject({
      ok: false,
      error: 'failed',
      log: 'Playwright browsers could not start: libnss3.so: cannot open shared object file',
    });

    currentError = null;
    await vi.advanceTimersByTimeAsync(40);
    await server.wait(() => server.received.some(m => m.type === 'status' && m.browserError === null));
    expect(server.received.findLast(m => m.type === 'status')).toMatchObject({
      type: 'status',
      browserError: null,
      noRuns: null,
    });
    expect(lines).toContain('Playwright Chromium, Firefox and WebKit are ready.');
    expect(existsSync(join(dir, 'browser-error'))).toBe(false);
  });

  describe('numbered messages', () => {
    const run = { type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 5000, secret: null, instructions: null, toolToken: null };
    const numbered = (server: Awaited<ReturnType<typeof fakeServer>>, from = 0) => server.received.slice(from).filter(m => typeof m.n === 'number');
    const helloCount = (server: Awaited<ReturnType<typeof fakeServer>>) => server.received.filter(m => m.type === 'hello').length;

    /* A program that says two things and then, once the test lets it, ends. */
    function gated() {
      let open!: () => void;
      const gate = new Promise<void>(r => (open = r));
      const talking: ProviderAdapter = {
        ...adapter,
        run: async input => {
          input.onEvent?.({ kind: 'text', text: 'first' });
          await gate;
          input.onEvent?.({ kind: 'text', text: 'second' });
          return adapter.run(input);
        },
      };
      return { adapter: talking, open };
    }

    it('sends numbered messages again until the server confirms them', async () => {
      const server = await fakeServer({ acks: true });
      const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, run: async input => (input.onEvent?.({ kind: 'text', text: 'a' }), input.onEvent?.({ kind: 'text', text: 'b' }), adapter.run(input)) }, log: () => {} });
      onTestFinished(() => node.stop());
      await server.wait(() => server.received.some(m => m.type === 'hello'));
      server.send(run);
      await server.wait(() => server.received.some(m => m.type === 'job.done'));
      const first = numbered(server);
      expect(first.map(m => [m.type, m.n])).toEqual([['job.started', 1], ['job.event', 2], ['job.event', 3], ['job.done', 4]]);

      const seen = server.received.length;
      server.drop();
      await server.wait(() => helloCount(server) === 2);
      await server.wait(() => numbered(server, seen).length === 4);
      expect(numbered(server, seen)).toEqual(first);
      expect(server.received[seen]).toMatchObject({ type: 'hello', stream: expect.any(String) });
      expect(server.received[0]).toMatchObject({ stream: server.received[seen]!.stream });

      server.send({ type: 'ack', upto: 4 });
      await server.barrier('confirmed');
      const before = server.received.length;
      server.drop();
      await server.wait(() => helloCount(server) === 3);
      await server.barrier('third-hello');
      expect(numbered(server, before)).toEqual([]);
      expect(server.received[before]).toMatchObject({ type: 'hello', running: [] });
    });

    it('keeps its messages through its own restart', async () => {
      const first = await fakeServer({ acks: true });
      const dir = nodeDir(first.url);
      const talking = gated();
      const node = await runNode({ dir, adapter: talking.adapter, log: () => {} });
      onTestFinished(() => node.stop());
      await first.wait(() => first.received.some(m => m.type === 'hello'));
      first.send(run);
      await first.wait(() => first.received.some(m => m.type === 'job.event'));
      const stream = String(first.received[0]!.stream);
      await first.stop();
      talking.open();
      await first.wait(() => readFileSync(join(dir, 'outbox.jsonl'), 'utf8').includes('"second"'));
      node.stop();

      const second = await fakeServer({ acks: true, port: first.port });
      const again = await runNode({ dir, adapter, log: () => {} });
      onTestFinished(() => again.stop());
      await second.wait(() => second.received.some(m => m.type === 'job.done'));
      expect(second.received[0]).toMatchObject({ type: 'hello', stream });
      expect(numbered(second).map(m => [m.type, m.n])).toEqual([['job.started', 1], ['job.event', 2], ['job.event', 3], ['job.done', 4]]);
      expect(numbered(second)[2]).toMatchObject({ event: { text: 'second' } });
    });

    it('talks to a server of the build before', async () => {
      const first = await fakeServer();
      const talking = gated();
      const dir = nodeDir(first.url);
      const lines: string[] = [];
      const node = await runNode({ dir, adapter: talking.adapter, log: line => lines.push(line) });
      onTestFinished(() => node.stop());
      await first.wait(() => first.received.some(m => m.type === 'hello'));
      first.send(run);
      await first.wait(() => first.received.some(m => m.type === 'job.event'));
      expect(first.received[0]).toMatchObject({ type: 'hello' });
      await first.stop();
      /* The node must see its socket gone first: what a server that confirms nothing was sent is given up. */
      await first.wait(() => lines.some(line => line.includes('Connection closed')));
      talking.open();
      /* The job has ended, with nobody to tell, once its end waits in the outbox. */
      await first.wait(() => readFileSync(join(dir, 'outbox.jsonl'), 'utf8').includes('"job.done"'));

      const second = await fakeServer({ port: first.port });
      await second.wait(() => second.received.some(m => m.type === 'job.done'));
      expect(numbered(second).map(m => m.type)).toEqual(['job.event', 'job.done']);
      expect(second.received[0]).toMatchObject({ type: 'hello', running: ['j1'] });

      const before = second.received.length;
      second.drop();
      await second.wait(() => helloCount(second) === 2);
      await second.wait(() => numbered(second, before).length > 0);
      await second.barrier('second-hello');
      expect(numbered(second, before).map(m => m.type)).toEqual(['job.done']);

      second.send({ type: 'job.ack', jobId: 'j1' });
      await second.barrier('confirmed');
      const last = second.received.length;
      second.drop();
      await second.wait(() => helloCount(second) === 3);
      await second.barrier('third-hello');
      expect(numbered(second, last)).toEqual([]);
    });

    it('does not run a part again whose end waits for its ack', async () => {
      const server = await fakeServer({ acks: true });
      const ran: string[] = [];
      const runPart: typeof runTests = async m => (ran.push(m.partId), { type: 'tests.done', partId: m.partId, ok: true, exitCode: 0, error: null, commit: null, log: '' });
      const node = await runNode({ dir: nodeDir(server.url), adapter, log: () => {}, runPart, testUser: { uid: 20001, gid: 20001 } });
      onTestFinished(() => node.stop());
      await server.wait(() => server.received.some(m => m.type === 'hello'));
      const part = { type: 'tests.run', partId: 'p1', repo: { url: 'https://github.com/acme/shop.git', token: '' }, branch: null, task: 3, command: 'npm test', part: 1, parts: 1, timeoutMs: 60000 };
      server.send(part);
      await server.wait(() => server.received.some(m => m.type === 'tests.done'));
      server.send(part);
      await server.barrier('asked-again');
      expect(ran).toEqual(['p1']);
      expect(server.received.filter(m => m.type === 'tests.started')).toHaveLength(1);
    });

    it("does not send a job's end again that a new connection sent and Hornhoof confirmed while the limits were read", async () => {
      const server = await fakeServer({ acks: true });
      let finish!: () => void;
      const reading = new Promise<void>(r => (finish = r));
      /* The first read is the node's start; the next is the one after the job, which the test holds. */
      let reads = 0;
      const models = async () => {
        if (++reads > 1) await reading;
        return [{ id: 'm', name: 'M' }];
      };
      const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, models }, log: () => {} });
      onTestFinished(() => node.stop());
      await server.wait(() => helloCount(server) === 1);
      server.send(run);
      await server.wait(() => reads === 2);
      expect(server.received.some(m => m.type === 'job.done')).toBe(false);

      server.drop();
      await server.wait(() => server.received.some(m => m.type === 'job.done'));
      const end = server.received.find(m => m.type === 'job.done')!;
      server.send({ type: 'ack', upto: end.n });
      await server.barrier('confirmed');

      finish();
      await server.wait(() => server.received.some(m => m.type === 'status'));
      await server.barrier('after-status');
      expect(server.received.filter(m => m.type === 'job.done')).toEqual([end]);
    });

    describe('a hello with many ends waiting', () => {
      const ends = (dir: string) => {
        const box = new Outbox(dir);
        for (let i = 0; i < 150; i++) box.hold({ type: 'job.done', jobId: `end-${i}`, ok: true, sessionId: null, result: '', tail: '', error: null });
        for (let i = 0; i < 120; i++) box.hold({ type: 'tests.done', partId: `part-${i}`, ok: true, exitCode: 0, error: null, commit: null, log: '' });
      };
      const lastHello = (server: Awaited<ReturnType<typeof fakeServer>>) => {
        const hello = server.received.findLast(m => m.type === 'hello')!;
        return { ...hello, running: hello.running as string[], tests: hello.tests as string[] };
      };

      it('lists them all to a server that confirms, and that server can read it', async () => {
        const server = await fakeServer({ acks: true });
        const dir = nodeDir(server.url);
        ends(dir);
        const node = await runNode({ dir, adapter, log: () => {} });
        onTestFinished(() => node.stop());
        await server.wait(() => helloCount(server) === 1);
        const hello = lastHello(server);
        expect(hello.running).toHaveLength(150);
        expect(hello.tests).toHaveLength(120);
        expect(parseNodeMessage(JSON.stringify(hello))).not.toBeNull();
      });

      it('stays within what an older server takes, the runs still going first', async () => {
        const server = await fakeServer();
        const dir = nodeDir(server.url);
        ends(dir);
        const talking = gated();
        const node = await runNode({ dir, adapter: talking.adapter, log: () => {} });
        onTestFinished(() => {
          talking.open();
          node.stop();
        });
        await server.wait(() => helloCount(server) === 1);
        expect(lastHello(server).running).toHaveLength(HELLO_IDS_BEFORE_ACKS);
        expect(lastHello(server).tests).toHaveLength(HELLO_IDS_BEFORE_ACKS);

        server.send(run);
        await server.wait(() => server.received.some(m => m.type === 'job.started'));
        server.drop();
        await server.wait(() => helloCount(server) === 2);
        expect(lastHello(server).running).toHaveLength(HELLO_IDS_BEFORE_ACKS);
        expect(lastHello(server).running[0]).toBe('j1');
      });
    });
  });

  describe('being removed', () => {
    const removals = (server: Awaited<ReturnType<typeof fakeServer>>) => server.received.filter(m => m.type === 'removed');
    const stopped = (lines: string[]) => lines.some(line => line.startsWith('Node stopping'));
    /* A node that answers has sent all it had to say and has not closed its socket. */
    const stillThere = (server: Awaited<ReturnType<typeof fakeServer>>) => server.barrier('still-there');

    async function connected(server: Awaited<ReturnType<typeof fakeServer>>, nodeAdapter = adapter) {
      const lines: string[] = [];
      const dir = nodeDir(server.url);
      const node = await runNode({ dir, adapter: nodeAdapter, log: line => lines.push(line) });
      onTestFinished(() => node.stop());
      await server.wait(() => server.received.some(m => m.type === 'hello'));
      return { dir, lines };
    }

    it('stays connected until Hornhoof confirms removed, and says it again on a new connection', async () => {
      const server = await fakeServer({ acks: true });
      const { dir, lines } = await connected(server);
      server.send({ type: 'remove' });
      await server.wait(() => removals(server).length === 1);
      await stillThere(server);
      expect(server.open()).toBe(1);
      expect(stopped(lines)).toBe(false);

      server.drop();
      await server.wait(() => removals(server).length === 2);
      expect(removals(server)[1]).toEqual(removals(server)[0]);

      server.send({ type: 'ack', upto: removals(server)[0]!.n });
      await server.wait(() => server.open() === 0);
      expect(stopped(lines)).toBe(true);
      expect(new Outbox(dir).pending()).toEqual([]);
    });

    /* The socket drops while the node's job stops, and the node goes on to say removed with no socket. */
    async function removedWhileAway(server: Awaited<ReturnType<typeof fakeServer>>) {
      let letGo!: () => void;
      const stopping = new Promise<void>(r => (letGo = r));
      const slow: ProviderAdapter = {
        ...adapter,
        run: input =>
          new Promise(done => {
            input.signal?.addEventListener('abort', () => void stopping.then(() => done({ ok: false, sessionId: null, result: '', output: 'stopped', error: 'agent_failed', limits: null })));
          }),
      };
      const { lines } = await connected(server, slow);
      server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 60000, secret: null, instructions: null, toolToken: null });
      await server.wait(() => server.received.some(m => m.type === 'job.started'));
      server.send({ type: 'remove' });
      server.drop();
      await server.wait(() => lines.some(line => line.startsWith('Connection closed')));
      letGo();
      await server.wait(() => removals(server).length === 1);
      expect(server.received.filter(m => m.type === 'hello')).toHaveLength(2);
      return lines;
    }

    it('says removed on the next connection when the socket drops while its jobs stop', async () => {
      const server = await fakeServer({ acks: true });
      const lines = await removedWhileAway(server);
      await stillThere(server);
      expect(stopped(lines)).toBe(false);
    });

    it('is over once it said removed on the next connection to an older server', async () => {
      const server = await fakeServer();
      const lines = await removedWhileAway(server);
      await server.wait(() => stopped(lines));
    });

    it('is over once removed went to an older server, which confirms nothing', async () => {
      const server = await fakeServer();
      const { dir, lines } = await connected(server);
      server.send({ type: 'remove' });
      await server.wait(() => server.open() === 0);
      expect(removals(server)).toHaveLength(1);
      expect(stopped(lines)).toBe(true);
      expect(new Outbox(dir).owes('removed')).toBe(false);
    });

    it('is over when Hornhoof refuses its key, which it does once it has heard', async () => {
      const server = await fakeServer({ acks: true });
      const { lines } = await connected(server);
      server.send({ type: 'remove' });
      await server.wait(() => removals(server).length === 1);
      server.close(4001);
      await server.wait(() => stopped(lines));
    });

    it('keeps going when Hornhoof refuses its key and nothing removed it', async () => {
      const server = await fakeServer({ acks: true });
      const { lines } = await connected(server);
      server.close(4001);
      await server.wait(() => lines.some(line => line.startsWith('Hornhoof does not know this machine')));
      /* A node that this stops says so in the same turn of the event loop. */
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(stopped(lines)).toBe(false);
    });
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
  const server = await fakeServer({ grantChecks: false }), dir = nodeDir(server.url), source = descriptionRepo(dir);
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
  const server = await fakeServer({ grantChecks: false }), dir = nodeDir(server.url), source = descriptionRepo(dir);
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
  await server.wait(() => server.received.some(frame => frame.type === 'tests.described'));
  expect(server.received.find(frame => frame.type === 'tests.described')).toMatchObject({ result: { status: 'ready', fingerprints: [{ suiteId: 'unit', file: 'test/a.js' }] } });
});

it('cancels a queued description before repository materialization', async () => {
  const server = await fakeServer({ grantChecks: false }), dir = nodeDir(server.url), source = descriptionRepo(dir);
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
  /* The second part has its machine slot and waits for the test user. */
  await server.wait(() => server.received.some(frame => frame.type === 'tests.waiting' && frame.partId === 'second'));
  await server.barrier('second-waits');
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
