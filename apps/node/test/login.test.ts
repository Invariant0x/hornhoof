import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { CutAtToken, tokenIn } from '../src/login.js';
import { runNode } from '../src/main.js';
import type { ProviderAdapter } from '../src/runner.js';
import { writeState } from '../src/state.js';
import { testPort } from '../../../test-support/ports.mjs';

/* The sign-in to a plan that its owner does in Hornhoof: the node runs the program's sign-in in a terminal of its own,
   which the owner watches and types into, and keeps what it gives. Only our side is tested here: the token read from a
   recorded screen and kept from what a person sees. */

const TOKEN = 'sk-ant-oat01-' + 'Ab3_-x9q'.repeat(11);

const until = async (check: () => boolean | Promise<boolean>, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) if (await check()) return;
  throw new Error('timed out');
};

const adapter: ProviderAdapter = {
  install: async () => {},
  loggedIn: async () => true,
  login: async () => {},
  secrets: async () => [],
  run: async () => ({ ok: true, sessionId: null, result: '', output: '', error: null, limits: null }),
};

type Received = { type: string; [k: string]: unknown };

async function fakeServer() {
  const server = new WebSocketServer({ port: await testPort(), host: '127.0.0.1' });
  onTestFinished(() => server.close());
  await new Promise(r => server.once('listening', r));
  const received: Received[] = [];
  let socket: WebSocket | null = null;
  server.on('connection', s => {
    socket = s;
    s.on('message', data => received.push(JSON.parse(String(data))));
  });
  const done = () => received.find(m => m.type === 'login.done');
  const frames = (termId: string) => received.filter(m => m.type === 'term.data' && m.termId === termId).map(m => String(m.data)).join('');
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received, done, frames, send: (m: object) => socket!.send(JSON.stringify(m)) };
}

describe('a plan sign-in in a terminal on the node', () => {

  it('on a node that has no sign-in terminal, says the sign-in cannot run there', async () => {
    const server = await fakeServer();
    const dir = mkdtempSync(join(tmpdir(), 'hh-login-'));
    writeState(dir, { server: server.url, subscriptionId: 's1', provider: 'kimi', key: 'node-key-1234567890' });
    const running = await runNode({ dir, adapter, log: () => {} });
    onTestFinished(() => running.stop());
    await until(() => server.received.some(m => m.type === 'hello'));
    server.send({ type: 'login.start', fresh: false });
    server.send({ type: 'term.open', termId: 't1', agentKey: 'login', cols: 80, rows: 24, write: true });
    await until(() => Boolean(server.done()) && server.received.some(m => m.type === 'term.exit'));
    expect(server.done()).toMatchObject({ ok: false, error: expect.any(String) });
  });
});

describe('the long token on a screen', () => {
  it('is read whole when Ink wrapped it, and not joined with the words after it', () => {
    const printed = `Your OAuth token (valid for 1 year):\r\n\r\n  \x1b[33m${TOKEN.slice(0, 40)}\x1b[39m\r\n  \x1b[33m${TOKEN.slice(40)}\x1b[39m\r\nStore this token securely.\r\n`;
    expect(tokenIn(printed)).toBe(TOKEN);
    expect(tokenIn('sk-ant-oat01-short\n')).toBeNull();
    expect(tokenIn('Paste code here if prompted >')).toBeNull();
  });

  it('is cut from what a person sees even when its start comes in two pieces', () => {
    const cut = new CutAtToken();
    expect(cut.push('token: sk-an')).toBe('token: ');
    expect(cut.push('t-oat01-' + TOKEN.slice(13, 30))).toBe('[hidden]');
    expect(cut.push(TOKEN.slice(30) + '\r\nStore this token')).toBe('');
    const other = new CutAtToken();
    expect(other.push('ask sk')).toBe('ask ');
    expect(other.push('ip it')).toBe('skip it');
  });
});
