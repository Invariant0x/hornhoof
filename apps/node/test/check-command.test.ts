import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { CheckClient } from '../src/check-client.js';
import { currentCheckLease, setCheckClient, withCheckSlot } from '../src/check-queue.js';
import { configureCheckCommands } from '../src/check-command-runner.js';
import { classifyAgentCommand } from '../src/command-guard.js';
import { createAgentCommandGuard } from '../src/check-runtime.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../src/terminal/bridge.js';
import { procOwner } from '../src/terminal/peer.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('heavy command bridge', () => {
  beforeEach(() => {
    configureCheckCommands(null, (_key, input) => classifyAgentCommand({ ...input, workspaceRoot: '/tmp' }));
    onTestFinished(() => configureCheckCommands(null));
  });
  it('runs a command through a granted slot with its output and exit code', async () => {
    const key = '10000000-0000-4000-8000-000000000001';
    const client = new CheckClient(frame => {
      if (frame.type === 'check.acquire') queueMicrotask(() => client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 }));
      return true;
    });
    client.online(true); setCheckClient(client);
    const bridge = new Bridge('http://127.0.0.1:1', () => {});
    await bridge.start(); bridge.setToken(key, 'turn');
    onTestFinished(() => { bridge.stop(); client.online(false); setCheckClient(null); });
    const url = bridge.agent(key).hookUrl.replace('/hook/', '/check/');
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ command: [process.execPath, '-e', 'process.stdout.write("check output");process.stderr.write("check error");process.exit(7)'], cwd: '/tmp', env: { PATH: process.env.PATH } }) });
    expect(response.status).toBe(200);
    const frames = (await response.text()).trim().split('\n').map(line => JSON.parse(line) as { type: string; data?: string; code?: number });
    expect(frames.filter(f => f.type === 'stdout').map(f => Buffer.from(f.data!, 'base64').toString()).join('')).toBe('check output');
    expect(frames.filter(f => f.type === 'stderr').map(f => Buffer.from(f.data!, 'base64').toString()).join('')).toBe('check error');
    expect(frames.at(-1)).toMatchObject({ type: 'exit', code: 7 });
  });

  it('makes the CLI preserve command output and its nonzero exit status', async () => {
    const key = '10000000-0000-4000-8000-000000000002';
    const client = new CheckClient(frame => {
      if (frame.type === 'check.acquire') queueMicrotask(() => client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 }));
      return true;
    });
    client.online(true); setCheckClient(client);
    const bridge = new Bridge('http://127.0.0.1:1', () => {}); await bridge.start(); bridge.setToken(key, 'turn');
    onTestFinished(() => { bridge.stop(); client.online(false); setCheckClient(null); });
    const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/check-command.js', import.meta.url)), '--', process.execPath, '-e', 'process.stdout.write("from CLI");process.exit(7)'], {
      cwd: '/tmp', env: { PATH: process.env.PATH, HH_BRIDGE: bridge.agent(key).hookUrl }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; child.stdout.on('data', chunk => { stdout += String(chunk); });
    const code = await new Promise(resolve => child.on('close', resolve));
    expect(code).toBe(7); expect(stdout).toBe('from CLI');
  });

  it('allows nested wrappers and hooks from its own checked command while rejecting another agent', async () => {
    const key = '10000000-0000-4000-8000-000000000005', other = '10000000-0000-4000-8000-000000000006';
    let acquired = 0, pane = 0;
    const client = new CheckClient(frame => {
      if (frame.type === 'check.acquire') { acquired++; queueMicrotask(() => client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 })); }
      return true;
    });
    client.online(true); setCheckClient(client);
    const owner = procOwner('/proc')(async agent => agent === key ? [pane] : []);
    const bridge = new Bridge('http://127.0.0.1:1', () => {}, owner.owns, { capture: owner.capture });
    await bridge.start(); bridge.setToken(key, 'turn'); bridge.setToken(other, 'other-turn');
    onTestFinished(() => { bridge.stop(); client.online(false); setCheckClient(null); });
    const cli = fileURLToPath(new URL('../dist/check-command.js', import.meta.url));
    const script = `
      const { spawnSync } = await import('node:child_process');
      const nested = spawnSync(process.execPath, [${JSON.stringify(cli)}, '--', process.execPath, '-e', 'process.stdout.write("nested")'], { env: process.env, encoding: 'utf8' });
      process.stdout.write(nested.stdout); process.stderr.write(nested.stderr);
      const request = { method: 'POST', headers: { 'x-hh-pid': String(process.pid) }, body: '{}' };
      const own = await fetch(${JSON.stringify(bridge.agent(key).hookUrl + '/tool')}, request);
      const foreign = await fetch(${JSON.stringify(bridge.agent(other).hookUrl.replace('/hook/', '/check/'))}, request);
      process.stdout.write(':' + own.status + ':' + foreign.status);
      process.exitCode = nested.status ?? 1;
    `;
    const child = spawn(process.execPath, [cli, '--', process.execPath, '--input-type=module', '-e', script], {
      cwd: '/tmp', env: { PATH: process.env.PATH, HH_BRIDGE: bridge.agent(key).hookUrl }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    pane = child.pid!;
    onTestFinished(() => { child.kill('SIGKILL'); });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); }); child.stderr.on('data', chunk => { stderr += String(chunk); });
    const code = await new Promise(resolve => child.once('close', resolve));
    expect({ code, stdout, stderr, acquired }).toEqual({ code: 0, stdout: 'nested:200:403', stderr: '', acquired: 1 });
  });

  it('cleans the group and returns the slot when the command leader leaves an open output pipe', async () => {
    const key = '10000000-0000-4000-8000-000000000007';
    let released = false;
    const client = new CheckClient(frame => {
      if (frame.type === 'check.acquire') queueMicrotask(() => client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 }));
      else released = true;
      return true;
    });
    client.online(true); setCheckClient(client);
    const bridge = new Bridge('http://127.0.0.1:1', () => {}); await bridge.start(); bridge.setToken(key, 'turn');
    onTestFinished(() => { bridge.stop(); client.online(false); setCheckClient(null); });
    const response = await fetch(bridge.agent(key).hookUrl.replace('/hook/', '/check/'), {
      method: 'POST', body: JSON.stringify({ command: ['/bin/bash', '-c', 'sleep 60 & echo leader-exiting; exit 0'], cwd: '/tmp', env: { PATH: process.env.PATH } }),
    });
    const output = response.text();
    const result = await Promise.race([output.then(text => ({ ended: true, text })), new Promise<{ ended: boolean; text: string }>(resolve => setTimeout(() => resolve({ ended: false, text: '' }), 1500))]);
    expect(result.ended).toBe(true);
    expect(result.text).toContain('"type":"exit","code":0');
    expect(released).toBe(true);
  });

  it('requires the authenticated agent process and a current turn before accepting a command', async () => {
    const key = '10000000-0000-4000-8000-000000000003';
    const owned = new Bridge('http://127.0.0.1:1', () => {}, async () => false);
    const outside = new Bridge('http://127.0.0.1:1', () => {});
    await owned.start(); await outside.start(); owned.setToken(key, 'turn');
    onTestFinished(() => { owned.stop(); outside.stop(); });
    const input = JSON.stringify({ command: [process.execPath, '-e', 'process.exit(0)'], cwd: '/tmp', env: {} });
    expect((await fetch(owned.agent(key).hookUrl.replace('/hook/', '/check/'), { method: 'POST', body: input })).status).toBe(403);
    expect((await fetch(outside.agent(key).hookUrl.replace('/hook/', '/check/'), { method: 'POST', body: input })).status).toBe(409);
  });

  it('retains the slot while a cancelled command ignores TERM and is killed after its grace', async () => {
    const key = '10000000-0000-4000-8000-000000000004';
    let released = false;
    const client = new CheckClient(frame => {
      if (frame.type === 'check.acquire') queueMicrotask(() => client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 }));
      else released = true;
      return true;
    });
    client.online(true); setCheckClient(client);
    const bridge = new Bridge('http://127.0.0.1:1', () => {}); await bridge.start(); bridge.setToken(key, 'turn');
    onTestFinished(() => { bridge.stop(); client.online(false); setCheckClient(null); });
    const command = 'process.on("SIGTERM",()=>{});process.stdout.write(String(process.pid));setInterval(()=>{},1000)';
    const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/check-command.js', import.meta.url)), '--', process.execPath, '-e', command], {
      cwd: '/tmp', env: { PATH: process.env.PATH, HH_BRIDGE: bridge.agent(key).hookUrl }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    onTestFinished(() => { child.kill('SIGKILL'); });
    const pid = Number(await new Promise<string>(resolve => child.stdout.once('data', chunk => resolve(String(chunk)))));
    const started = performance.now();
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('close', resolve));
    expect(released).toBe(false);
    while (!released) await new Promise(resolve => setTimeout(resolve, 20));
    expect(performance.now() - started).toBeGreaterThanOrEqual(4500);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});


/* Real child sentinel and queue protocol, but no real compiler or native CLI.
   The fixture executable only records whether the forbidden payload started. */
async function guardedCommandFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hh-guard-command-'));
  const key = '10000000-0000-4000-8000-000000000050';
  const root = join(dir, 'work', 'agents', key);
  mkdirSync(root, { recursive: true });
  const bin = join(root, 'bin'), sentinel = join(root, 'payload-started');
  mkdirSync(bin);
  const compiler = join(bin, 'tsc');
  writeFileSync(compiler, '#!/bin/sh\nprintf spawned > "$HH_GUARD_SENTINEL"\n');
  chmodSync(compiler, 0o755);
  let acquired = 0;
  const client = new CheckClient(frame => {
    if (frame.type === 'check.acquire') {
      acquired++;
      queueMicrotask(() => client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 }));
    }
    return true;
  });
  client.online(true); setCheckClient(client); configureCheckCommands(null);
  const bridge = new Bridge('http://127.0.0.1:1', () => {});
  await bridge.start(); bridge.setToken(key, 'current-fixture-turn');
  onTestFinished(() => { bridge.stop(); client.online(false); setCheckClient(null); configureCheckCommands(null); rmSync(dir, { recursive: true, force: true }); });
  const run = async (lease?: string, command = ['tsc', '--noEmit'], signal?: AbortSignal) => {
    const response = await fetch(bridge.agent(key).hookUrl.replace('/hook/', '/check/'), {
      method: 'POST', signal, body: JSON.stringify({ command, cwd: root, env: { PATH: bin, HH_GUARD_SENTINEL: sentinel, HH_CHECK_SLOT: lease ?? 'forged-claim' }, ...(lease ? { lease } : {}) }),
    });
    return response.text();
  };
  return { dir, root, bin, key, run, acquired: () => acquired, sentinel };
}

describe('command policy boundary', () => {
  it('denies a missing guard before a heavy sentinel or a slot can start', async () => {
    const c = await guardedCommandFixture();
    const text = await c.run();
    expect(existsSync(c.sentinel)).toBe(false);
    expect(c.acquired()).toBe(0);
    expect(text).toContain('запусти через run_tests');
    expect(text).not.toContain('"type":"exit"');
  });

  it('denies heavy agent payload even while the same agent holds a genuine lease', async () => {
    const c = await guardedCommandFixture();
    configureCheckCommands(null, createAgentCommandGuard(c.dir));
    const text = await withCheckSlot(() => c.run(currentCheckLease()), { agentId: c.key });
    expect(existsSync(c.sentinel)).toBe(false);
    expect(c.acquired()).toBe(1);
    expect(text).toContain('запусти через run_tests');
    expect(text).not.toContain('"type":"exit"');
  });

  it('turns a throwing policy into a closed refusal before admission', async () => {
    const c = await guardedCommandFixture();
    configureCheckCommands(null, async () => { throw new Error('private diagnostic'); });
    const text = await c.run();
    expect({ started: existsSync(c.sentinel), acquired: c.acquired() }).toEqual({ started: false, acquired: 0 });
    expect(text).toContain('запусти через run_tests');
    expect(text).not.toContain('private diagnostic');
  });

  it('preserves a classified single-file command output and original nonzero exit', async () => {
    const c = await guardedCommandFixture();
    const program = join(c.bin, 'vitest');
    writeFileSync(program, '#!/bin/sh\nprintf single-file-output\nexit 7\n'); chmodSync(program, 0o755);
    writeFileSync(join(c.root, 'one.test.ts'), 'export {};');
    configureCheckCommands(null, createAgentCommandGuard(c.dir));
    const text = await c.run(undefined, ['vitest', 'run', 'one.test.ts']);
    expect(text).toContain(Buffer.from('single-file-output').toString('base64'));
    expect(text).toContain('"type":"exit","code":7');
    expect(c.acquired()).toBe(1);
  });

  it('does not admit a command cancelled while its guard is pending', async () => {
    const c = await guardedCommandFixture(), stop = new AbortController();
    let entered!: () => void, release!: () => void, settled!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const finished = new Promise<void>(resolve => { settled = resolve; });
    configureCheckCommands(null, async () => { entered(); await gate; settled(); return { allow: true, kind: 'ordinary', coverage: 'opaque' }; });
    const request = c.run(undefined, undefined, stop.signal).catch(() => null);
    await began; stop.abort(); await request;
    release(); await finished;
    await new Promise(resolve => setImmediate(resolve));
    expect({ started: existsSync(c.sentinel), acquired: c.acquired() }).toEqual({ started: false, acquired: 0 });
  });
});
