import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { runNode } from '../src/main.js';
import { claudeProgram } from '../src/terminal/programs.js';
import { Tmux } from '../src/terminal/tmux.js';
import type { ProviderAdapter, RunInput } from '../src/runner.js';
import { isRemoved, writeState } from '../src/state.js';

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
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received, send: (m: object) => socket!.send(JSON.stringify(m)), wait };
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

describe('a node that runs agents in terminals', () => {
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

  it('ends a view it cannot show when it runs no terminals', async () => {
    const server = await fakeServer();
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    expect(server.received[0]).toMatchObject({ terminals: false });
    server.send({ type: 'term.open', termId: 't9', agentKey: 'agent-1', cols: 90, rows: 30, write: true });
    await server.wait(() => server.received.some(m => m.type === 'term.exit' && m.termId === 't9'));
  });
});

describe('runNode', () => {
  it('runs a job and reports it, then the limits', async () => {
    const server = await fakeServer();
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 5000, secret: null, instructions: null, toolToken: null });
    await server.wait(() => server.received.some(m => m.type === 'status'));
    expect(server.received.map(m => m.type)).toEqual(['hello', 'job.started', 'job.done', 'status']);
    expect(server.received[2]).toMatchObject({ jobId: 'j1', ok: true, result: 'ready', sessionId: 'sess-9' });
    expect(server.received[3]).toMatchObject({ loggedIn: true, limits: { status: 'allowed', windows: [] } });
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

  it('stays idle once removed', async () => {
    const lines: string[] = [];
    const dir = nodeDir('http://127.0.0.1:9');
    writeFileSync(join(dir, 'removed'), '');
    const node = await runNode({ dir, adapter, log: l => lines.push(l) });
    node.stop();
    expect(lines).toEqual(['This node was removed in Hornhoof.']);
  });
});
