import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { runNode } from '../src/main.js';
import type { ProviderAdapter } from '../src/runner.js';
import { writeState } from '../src/state.js';

/* A signed-in program that may wait for a first setup only the plan's owner passes, such as agy's terms. */
const program = (setup: { pending: boolean }): ProviderAdapter => ({
  install: async () => {},
  loggedIn: async () => true,
  setupNeeded: async () => setup.pending,
  login: async () => {},
  secrets: async () => [],
  run: async () => ({ ok: false, sessionId: null, result: '', output: 'Terms of Service & Data Use', error: 'agent_failed', limits: null, failure: { kind: 'setup', text: 'The terms wait for the owner.', retryable: false } }),
});

async function node(adapter: ProviderAdapter) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  onTestFinished(() => server.close());
  await new Promise(r => server.once('listening', r));
  const received: { type: string; [k: string]: unknown }[] = [];
  let socket: WebSocket | null = null;
  server.on('connection', s => {
    socket = s;
    s.on('message', data => received.push(JSON.parse(String(data))));
  });
  const dir = mkdtempSync(join(tmpdir(), 'hh-setup-'));
  writeState(dir, { server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, subscriptionId: 's1', provider: 'antigravity', key: 'node-key-1234567890' });
  const running = await runNode({ dir, adapter, log: () => {}, loginCheckMs: 30 });
  onTestFinished(() => running.stop());
  const wait = async (check: () => boolean, ms = 3000) => {
    for (const end = Date.now() + ms; !check() && Date.now() < end; ) await new Promise(r => setTimeout(r, 10));
    expect(check()).toBe(true);
  };
  const last = () => received.filter(m => m.type === 'status').at(-1);
  await wait(() => received.some(m => m.type === 'hello'));
  return { received, send: (m: object) => socket!.send(JSON.stringify(m)), wait, last };
}

const job = (jobId: string) => ({ type: 'job.run', jobId, provider: 'antigravity', secret: null, subscriptionId: 's1', sessionId: null, model: null, timeoutMs: 10000, prompt: 'hi', instructions: null, toolToken: null });

describe("a program's first setup that only the plan's owner passes", () => {
  it('is said in the hello of a signed-in node and leaves it once the owner passed it', async () => {
    const setup = { pending: true };
    const { received, wait, last } = await node(program(setup));
    expect(received.find(m => m.type === 'hello')).toMatchObject({ loggedIn: true, setupNeeded: true });
    setup.pending = false;
    await wait(() => last()?.loggedIn === true && last()?.setupNeeded === undefined);
  });

  it('holds the node after a turn met it, until the owner passed it', async () => {
    const setup = { pending: false };
    const { received, send, wait, last } = await node(program(setup));
    expect(received.find(m => m.type === 'hello')).not.toHaveProperty('setupNeeded');
    setup.pending = true;
    send(job('j1'));
    await wait(() => received.some(m => m.type === 'job.done' && m.jobId === 'j1'));
    expect(received.find(m => m.type === 'job.done')).toMatchObject({ ok: false, failure: { kind: 'setup' } });
    await wait(() => last()?.setupNeeded === true);
    await new Promise(r => setTimeout(r, 200));
    expect(last()).toMatchObject({ loggedIn: true, setupNeeded: true });
    setup.pending = false;
    await wait(() => last()?.setupNeeded === undefined);
    expect(last()).toMatchObject({ loggedIn: true });
  });
});
