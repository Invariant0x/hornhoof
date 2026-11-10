import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { runNode } from '../src/main.js';
import type { ProviderAdapter } from '../src/runner.js';
import { writeState } from '../src/state.js';
import { eventually } from '../../../test-support/eventually.mjs';
import { testPort } from '../../../test-support/ports.mjs';

/* A signed-in program that may wait for a first setup only the plan's owner passes, such as agy's terms. It counts the
   node's looks at the setup. */
const program = (setup: { pending: boolean; looks?: number }): ProviderAdapter => ({
  install: async () => {},
  loggedIn: async () => true,
  setupNeeded: async () => {
    setup.looks = (setup.looks ?? 0) + 1;
    return setup.pending;
  },
  login: async () => {},
  secrets: async () => [],
  run: async () => ({ ok: false, sessionId: null, result: '', output: 'Terms of Service & Data Use', error: 'agent_failed', limits: null, failure: { kind: 'setup', text: 'The terms wait for the owner.', retryable: false } }),
});

async function node(adapter: ProviderAdapter) {
  const server = new WebSocketServer({ port: await testPort(), host: '127.0.0.1' });
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
  const running = await runNode({ dir, adapter, log: () => {}, loginCheckMs: 30, setupCheckMs: 30 });
  onTestFinished(() => running.stop());
  const wait = (check: () => boolean) => eventually(check);
  const last = () => received.filter(m => m.type === 'status').at(-1);
  const send = (m: object) => socket!.send(JSON.stringify(m));
  /* A node with no sign-in to start answers at once, after everything it sent before. */
  const marked = async () => {
    const answers = received.filter(m => m.type === 'login.done').length;
    send({ type: 'login.start', fresh: false });
    await wait(() => received.filter(m => m.type === 'login.done').length > answers);
  };
  await wait(() => received.some(m => m.type === 'hello'));
  return { received, send, wait, last, marked };
}

const job = (jobId: string) => ({ type: 'job.run', jobId, provider: 'antigravity', secret: null, subscriptionId: 's1', sessionId: null, model: null, timeoutMs: 2_147_483_647 - 30_000, prompt: 'hi', instructions: null, toolToken: null });

describe("a program's first setup that only the plan's owner passes", () => {
  it('is said in the hello of a signed-in node and leaves it once the owner passed it', async () => {
    const setup = { pending: true };
    const { received, wait, last } = await node(program(setup));
    expect(received.find(m => m.type === 'hello')).toMatchObject({ loggedIn: true, setupNeeded: true });
    setup.pending = false;
    await wait(() => last()?.loggedIn === true && last()?.setupNeeded === undefined);
  });

  it('takes a sign-in it finds by looking again while signed out, and then waits for the setup', async () => {
    const setup = { pending: true };
    const signed = { in: false };
    const { received, wait, last } = await node({ ...program(setup), loggedIn: async () => signed.in });
    expect(received.find(m => m.type === 'hello')).toMatchObject({ loggedIn: false });
    expect(received.find(m => m.type === 'hello')).not.toHaveProperty('setupNeeded');
    signed.in = true;
    await wait(() => last()?.loggedIn === true);
    expect(last()).toMatchObject({ loggedIn: true, setupNeeded: true });
  });

  it('holds the node after a turn met it, until the owner passed it', async () => {
    const setup = { pending: false, looks: 0 };
    const { received, send, wait, last, marked } = await node(program(setup));
    expect(received.find(m => m.type === 'hello')).not.toHaveProperty('setupNeeded');
    setup.pending = true;
    send(job('j1'));
    await wait(() => received.some(m => m.type === 'job.done' && m.jobId === 'j1'));
    expect(received.find(m => m.type === 'job.done')).toMatchObject({ ok: false, failure: { kind: 'setup' } });
    /* The status that goes before the end of the turn says so already, so Hornhoof sends the plan no turns there meanwhile. */
    const done = received.findIndex(m => m.type === 'job.done' && m.jobId === 'j1');
    expect(received.slice(0, done).filter(m => m.type === 'status').at(-1)).toMatchObject({ loggedIn: true, setupNeeded: true });
    await wait(() => last()?.setupNeeded === true);
    /* Two more looks while it waits: the first of them has ended, with any status it gave, once the second begins. */
    const looked = setup.looks;
    await wait(() => setup.looks >= looked + 2);
    await marked();
    expect(last()).toMatchObject({ loggedIn: true, setupNeeded: true });
    /* Looking again while it waits leaves the sign-in as it was: a turn now still finds the node signed in. */
    send(job('j2'));
    await wait(() => received.some(m => m.type === 'job.done' && m.jobId === 'j2'));
    const second = received.findIndex(m => m.type === 'job.done' && m.jobId === 'j2');
    expect(received.slice(0, second).filter(m => m.type === 'status').at(-1)).toMatchObject({ loggedIn: true, setupNeeded: true });
    setup.pending = false;
    await wait(() => last()?.setupNeeded === undefined);
    expect(last()).toMatchObject({ loggedIn: true });
  });
});
