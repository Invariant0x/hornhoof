import { describe, expect, it, onTestFinished } from 'vitest';
import { CheckClient } from '../src/check-client.js';
import { setCheckClient } from '../src/check-queue.js';
import { Bridge } from '../src/terminal/bridge.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('heavy command bridge', () => {
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
