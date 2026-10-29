import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { runNode } from '../src/main.js';
import type { ProviderAdapter } from '../src/runner.js';
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
  const wait = async (check: () => boolean) => {
    const end = Date.now() + 3000;
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

describe('runNode', () => {
  it('runs a job and reports it, then the limits', async () => {
    const server = await fakeServer();
    const node = await runNode({ dir: nodeDir(server.url), adapter, log: () => {} });
    onTestFinished(() => node.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'job.run', jobId: 'j1', subscriptionId: 's1', provider: 'claude', prompt: 'hi', sessionId: null, model: null, timeoutMs: 5000, secret: null });
    await server.wait(() => server.received.some(m => m.type === 'status'));
    expect(server.received.map(m => m.type)).toEqual(['hello', 'job.started', 'job.done', 'status']);
    expect(server.received[2]).toMatchObject({ jobId: 'j1', ok: true, result: 'ready', sessionId: 'sess-9' });
    expect(server.received[3]).toMatchObject({ loggedIn: true, limits: { status: 'allowed', windows: [] } });
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

  it('stays idle once removed', async () => {
    const lines: string[] = [];
    const dir = nodeDir('http://127.0.0.1:9');
    writeFileSync(join(dir, 'removed'), '');
    const node = await runNode({ dir, adapter, log: l => lines.push(l) });
    node.stop();
    expect(lines).toEqual(['This node was removed in Hornhoof.']);
  });
});
