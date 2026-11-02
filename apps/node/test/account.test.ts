import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { WebSocketServer } from 'ws';
import { readAccount } from '../src/account.js';
import { runNode } from '../src/main.js';
import { claudeAdapter } from '../src/providers/claude.js';
import type { ProviderAdapter } from '../src/runner.js';
import { writeState } from '../src/state.js';

const FAKE_CLAUDE = fileURLToPath(new URL('./fakes/claude', import.meta.url));
const PATH = process.env.PATH ?? '';
const jwt = (payload: object) => ['{"alg":"none"}', JSON.stringify(payload)].map(s => Buffer.from(s).toString('base64url')).join('.') + '.c2ln';
const codexHome = (idToken: string) => {
  const home = mkdtempSync(join(tmpdir(), 'hh-account-'));
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { id_token: idToken, access_token: 'a', refresh_token: 'r' } }));
  return home;
};

describe('the account a plan runs on', () => {
  it('for Codex is the address and plan in the sign-in token Codex keeps', async () => {
    const home = codexHome(jwt({ email: 'x@y.z', 'https://api.openai.com/auth': { chatgpt_plan_type: 'free' } }));
    expect(await readAccount('codex', home, {})).toEqual({ email: 'x@y.z', tier: 'free' });
  });

  it('for Codex is unknown without a sign-in or with a token that is not one', async () => {
    expect(await readAccount('codex', codexHome('not-a-token'), {})).toBeNull();
    expect(await readAccount('codex', codexHome(jwt({ email: 42 })), {})).toEqual({ email: null, tier: null });
    expect(await readAccount('codex', mkdtempSync(join(tmpdir(), 'hh-account-')), {})).toBeNull();
  });

  it('for Claude Code is what its sign-in status says, and nothing more with a long token', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hh-account-'));
    const plan = claudeAdapter({ home, tools: home, bin: FAKE_CLAUDE, mode: 'plan' });
    expect(await plan.account?.()).toEqual({ email: 'x@y.z', tier: 'max' });
    writeFileSync(join(home, 'claude-oauth-token'), 'sk-ant-oat01-' + 'a'.repeat(40) + '\n');
    expect(await plan.account?.()).toEqual({ email: null, tier: null });
    expect(await readAccount('kimi', home, { PATH })).toBeNull();
  });

  it('goes out with the hello and again once a sign-in came', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    onTestFinished(() => server.close());
    await new Promise(r => server.once('listening', r));
    const received: { type: string; [k: string]: unknown }[] = [];
    server.on('connection', s => s.on('message', data => received.push(JSON.parse(String(data)))));
    const dir = mkdtempSync(join(tmpdir(), 'hh-account-'));
    writeState(dir, { server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, subscriptionId: 's1', provider: 'claude', key: 'node-key-1234567890' });
    let account = { email: 'x@y.z', tier: 'pro' };
    const adapter: ProviderAdapter = {
      install: async () => {},
      loggedIn: async () => true,
      login: async () => {},
      secrets: async () => [],
      account: async () => account,
      run: async () => ({ ok: true, sessionId: null, result: '', output: '', error: null, limits: null }),
    };
    const running = await runNode({ dir, adapter, log: () => {} });
    onTestFinished(() => running.stop());
    const until = async (check: () => boolean) => {
      for (const end = Date.now() + 3000; !check() && Date.now() < end; ) await new Promise(r => setTimeout(r, 10));
      expect(check()).toBe(true);
    };
    await until(() => received.some(m => m.type === 'hello'));
    expect(received.find(m => m.type === 'hello')).toMatchObject({ account: { email: 'x@y.z', tier: 'pro' } });
    account = { email: 'x@y.z', tier: 'max' };
    const [socket] = [...server.clients];
    socket!.send(JSON.stringify({ type: 'cred.drop', kind: 'claude_token' }));
    await until(() => received.some(m => m.type === 'status' && (m.account as { tier?: string } | undefined)?.tier === 'max'));
  });
});
