import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { buildOf, runNode } from '../src/main.js';
import { ProgramUpdates } from '../src/program-updates.js';
import { TerminalHost } from '../src/terminal/host.js';
import { claudeProgram } from '../src/terminal/programs.js';
import { Tmux } from '../src/terminal/tmux.js';
import type { ProviderAdapter, RunInput } from '../src/runner.js';
import { isRemoved, writeState } from '../src/state.js';
import type { runTests } from '../src/tests.js';

const adapter: ProviderAdapter = {
  install: async () => {},
  loggedIn: async () => true,
  login: async () => {},
  secrets: async () => [],
  run: async () => ({ ok: true, sessionId: 'sess-9', result: 'ready', output: '', error: null, limits: { status: 'allowed', windows: [] } }),
};

async function fakeServer() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  onTestFinished(() => server.close());
  await new Promise(r => server.once('listening', r));
  const received: { type: string; [k: string]: unknown }[] = [];
  let socket: WebSocket | null = null;
  server.on('connection', s => {
    socket = s;
    s.on('message', data => received.push(JSON.parse(String(data))));
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

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
})();

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
      ...(terminal ? { terminal: { tmux, program: claudeProgram, bin: new URL('./fakes/fake-term.mjs', import.meta.url).pathname, home: join(dir, 'home'), signedOut: /not logged in/i } } : {}),
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

  it.skipIf(!hasTmux)('passes the live word budget to the host and accepts older servers without it', async () => {
    const server = await fakeServer();
    const dir = nodeDir(server.url);
    const tmux = new Tmux({ socket: `hh-within-${process.pid}`, env: { PATH: process.env.PATH ?? '', HOME: dir } });
    const say = vi.spyOn(TerminalHost.prototype, 'say').mockResolvedValue(true);
    onTestFinished(() => say.mockRestore());
    const fake = new URL('./fakes/fake-term.mjs', import.meta.url).pathname;
    const node = await runNode({ dir, adapter, log: () => {}, terminal: { tmux, program: claudeProgram, bin: fake, home: join(dir, 'home'), signedOut: /not logged in/i } });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    const words = { type: 'agent.say', agentKey: 'agent-1', text: 'Use the new schema.' };
    server.send({ ...words, ref: 'budget', within: 15_000 });
    await server.wait(() => server.received.some(m => m.type === 'agent.said' && m.ref === 'budget'));
    expect(say).toHaveBeenLastCalledWith('agent-1', words.text, 15_000);
    server.send({ ...words, ref: 'older' });
    await server.wait(() => server.received.some(m => m.type === 'agent.said' && m.ref === 'older'));
    expect(say).toHaveBeenLastCalledWith('agent-1', words.text, undefined);
  });

  it.skipIf(!hasTmux)("says so, runs an agent's turn in its session, shows the session and keeps test jobs as they were", async () => {
    const server = await fakeServer();
    const dir = nodeDir(server.url);
    const tmux = new Tmux({ socket: `hh-main-${process.pid}`, env: { PATH: process.env.PATH ?? '', HOME: dir } });
    const fake = new URL('./fakes/fake-term.mjs', import.meta.url).pathname;
    const node = await runNode({ dir, adapter, log: () => {}, terminal: { tmux, program: claudeProgram, bin: fake, home: join(dir, 'home'), signedOut: /not logged in/i } });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    expect(server.received[0]).toMatchObject({ type: 'hello', terminals: true });

    const run = { type: 'job.run', subscriptionId: 's1', provider: 'claude', sessionId: null, model: null, timeoutMs: 20000, secret: null, instructions: 'Be brief.', toolToken: 'tok-1' };
    server.send({ ...run, jobId: 'j1', prompt: 'hi', workspace: { key: 'agent-1', repo: null } });
    await server.wait(() => server.received.some(m => m.type === 'job.done'), 15000);
    expect(server.received.find(m => m.type === 'job.done')).toMatchObject({ jobId: 'j1', ok: true, result: 'echo: hi' });
    expect(server.received).toContainEqual({ type: 'job.event', jobId: 'j1', seq: 0, event: { kind: 'text', text: 'echo: hi' } });

    server.send({ type: 'term.open', termId: 't1', agentKey: 'agent-1', cols: 90, rows: 30, write: false });
    await server.wait(() => server.received.some(m => m.type === 'term.data' && String(m.data).includes('echo: hi')), 8000);

    server.send({ ...run, jobId: 'j2', prompt: 'test', toolToken: null });
    await server.wait(() => server.received.some(m => m.type === 'job.done' && m.jobId === 'j2'));
    expect(server.received.find(m => m.type === 'job.done' && m.jobId === 'j2')).toMatchObject({ ok: true, result: 'ready' });
  });

  it.skipIf(!hasTmux)("installs the agents' program before a turn in a session, and says the turn failed when it cannot", async () => {
    const server = await fakeServer();
    const dir = nodeDir(server.url);
    const tmux = new Tmux({ socket: `hh-install-${process.pid}`, env: { PATH: process.env.PATH ?? '', HOME: dir } });
    onTestFinished(() => tmux.run(['kill-server']).catch(() => {}));
    const fake = new URL('./fakes/fake-term.mjs', import.meta.url).pathname;
    let installs = 0;
    const install = async () => {
      installs++;
      throw new Error('npm: offline');
    };
    const node = await runNode({ dir, adapter, log: () => {}, install, terminal: { tmux, program: claudeProgram, bin: fake, home: join(dir, 'home'), signedOut: /not logged in/i } });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    const before = installs;
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', sessionId: null, model: null, timeoutMs: 20000, secret: null, instructions: null, toolToken: 'tok-1', prompt: 'hi', workspace: { key: 'agent-1', repo: null } });
    await server.wait(() => server.received.some(m => m.type === 'job.done'), 15000);
    expect(installs).toBeGreaterThan(before);
    expect(server.received.find(m => m.type === 'job.done')).toMatchObject({ jobId: 'j1', ok: false, error: 'agent_failed' });
    expect(await tmux.has('a-agent-1')).toBe(false);
  });

  it.skipIf(!hasTmux)("hides on a screen a program's token from after the node started, with no Hornhoof turn since", async () => {
    const server = await fakeServer();
    const dir = nodeDir(server.url);
    const tmux = new Tmux({ socket: `hh-learn-${process.pid}`, env: { PATH: process.env.PATH ?? '', HOME: dir } });
    const fake = new URL('./fakes/fake-term.mjs', import.meta.url).pathname;
    const tokens: string[] = [];
    const node = await runNode({ dir, adapter: { ...adapter, secrets: async () => tokens }, log: () => {}, learnMs: 50, terminal: { tmux, program: claudeProgram, bin: fake, home: join(dir, 'home'), signedOut: /not logged in/i } });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', sessionId: null, model: null, timeoutMs: 20000, secret: null, instructions: 'Be brief.', toolToken: 'tok-1', prompt: 'hi', workspace: { key: 'agent-1', repo: null } });
    await server.wait(() => server.received.some(m => m.type === 'job.done'), 15000);
    tokens.push('late-token-1234567890');
    await new Promise(r => setTimeout(r, 200));
    server.send({ type: 'term.open', termId: 't1', agentKey: 'agent-1', cols: 90, rows: 30, write: true });
    const screen = () => server.received.flatMap(m => (m.type === 'term.data' ? [String(m.data)] : [])).join('');
    await server.wait(() => screen().length > 0, 8000);
    server.send({ type: 'term.input', termId: 't1', data: 'say late-token-1234567890\r' });
    await server.wait(() => server.received.some(m => m.type === 'turn.open'), 8000);
    server.send({ type: 'turn.opened', agentKey: 'agent-1', jobId: null, toolToken: null });
    await server.wait(() => screen().includes('echo: say'), 8000);
    expect(screen()).toContain('[hidden]');
    expect(screen()).not.toContain('late-token-1234567890');
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
    const server = await fakeServer();
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'agent.say', agentKey: 'agent-1', text: 'Use the new schema.', ref: 'r-1' });
    await server.wait(() => server.received.some(m => m.type === 'agent.said'));
    expect(server.received.find(m => m.type === 'agent.said')).toEqual({ type: 'agent.said', ref: 'r-1', ok: false });
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

  it("asks its program for the plan's limits on its own, now and then, and says when they change", async () => {
    const server = await fakeServer();
    const seen = [0.1, 0.1, 0.25];
    let asked = 0;
    const limits = async () => ({ status: 'allowed' as const, windows: [{ name: 'seven_day', utilization: seen[Math.min(asked++, seen.length - 1)]!, resetsAt: null }] });
    const node = await runNode({ dir: nodeDir(server.url), adapter: { ...adapter, limits }, log: () => {}, limitsMs: 40 });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.filter(m => m.type === 'status').length >= 2);
    const statuses = server.received.filter(m => m.type === 'status').map(m => (m.limits as { windows: { utilization: number }[] }).windows[0]!.utilization);
    expect(statuses.slice(0, 2)).toEqual([0.1, 0.25]);
    expect(asked).toBeGreaterThanOrEqual(3);
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

  it('cleans up and says so when Hornhoof removes the subscription', async () => {
    const server = await fakeServer();
    const dir = nodeDir(server.url);
    const node = await runNode({ dir, adapter, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'remove' });
    await server.wait(() => server.received.some(m => m.type === 'removed'));
    expect(existsSync(join(dir, 'home'))).toBe(false);
    expect(existsSync(join(dir, 'work'))).toBe(false);
    expect(isRemoved(dir)).toBe(true);
  });

  it('stops its running jobs before it deletes their folders on removal', async () => {
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
    expect(existsSync(join(dir, 'work'))).toBe(false);
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

  it('stays idle once removed', async () => {
    const lines: string[] = [];
    const dir = nodeDir('http://127.0.0.1:9');
    writeFileSync(join(dir, 'removed'), '');
    const node = await runNode({ dir, adapter, log: l => lines.push(l) });
    node.stop();
    expect(lines).toEqual(['This node was removed in Hornhoof.']);
  });
});
