import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { applyCredential, credentialSecrets, dropCredential, heldCredential } from '../src/credentials.js';
import { nodeIdentity, seal, unseal } from '../src/keys.js';
import { runNode } from '../src/main.js';
import { kimiModels } from '../src/providers/kimi.js';
import type { ProviderAdapter } from '../src/runner.js';
import { writeState } from '../src/state.js';

const TOKEN = 'sk-ant-oat01-' + 'a'.repeat(40);
const bytes = (s: string) => new TextEncoder().encode(s);

const adapter: ProviderAdapter = {
  install: async () => {},
  loggedIn: async () => true,
  login: async () => {},
  secrets: async () => [],
  run: async () => ({ ok: true, sessionId: null, result: '', output: '', error: null, limits: null }),
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

async function node() {
  const server = await fakeServer();
  const dir = mkdtempSync(join(tmpdir(), 'hh-cred-'));
  writeState(dir, { server: server.url, subscriptionId: 's1', provider: 'claude', key: 'node-key-1234567890' });
  const lines: string[] = [];
  const running = await runNode({ dir, adapter, log: l => void lines.push(l) });
  onTestFinished(() => running.stop());
  await server.wait(() => server.received.some(m => m.type === 'hello'));
  const me = await nodeIdentity(dir);
  return { server, dir, home: join(dir, 'home'), me, lines };
}

describe('a sign-in Hornhoof hands a node', () => {
  it('is opened with its key and kept where Claude Code reads it, readable by the node alone', async () => {
    const { server, home, me } = await node();
    server.send({ type: 'cred.put', kind: 'claude_token', version: 1, sealed: await seal(bytes(TOKEN), [me.recipient]) });
    const file = join(home, 'claude-oauth-token');
    await server.wait(() => existsSync(file));
    expect(readFileSync(file, 'utf8').trim()).toBe(TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    /* The node says it is signed in now. */
    await server.wait(() => server.received.some(m => m.type === 'status' && m.loggedIn === true));
  });

  it('sealed to another node changes nothing, and the node says so without the value', async () => {
    const { server, home, lines } = await node();
    const other = await nodeIdentity(mkdtempSync(join(tmpdir(), 'hh-other-')));
    server.send({ type: 'cred.put', kind: 'claude_token', version: 1, sealed: await seal(bytes(TOKEN), [other.recipient]) });
    await server.wait(() => lines.some(l => l.includes('not for this node')));
    expect(existsSync(join(home, 'claude-oauth-token'))).toBe(false);
    expect(lines.join('\n')).not.toContain(TOKEN);
  });

  it('is sealed again for the nodes Hornhoof names, each of which opens only its own', async () => {
    const { server, me } = await node();
    server.send({ type: 'cred.put', kind: 'claude_token', version: 3, sealed: await seal(bytes(TOKEN), [me.recipient]) });
    await server.wait(() => server.received.some(m => m.type === 'status'));
    const [one, two, three] = await Promise.all([1, 2, 3].map(() => nodeIdentity(mkdtempSync(join(tmpdir(), 'hh-peer-')))));
    server.send({ type: 'cred.seal', kind: 'claude_token', version: 3, recipients: [{ nodeId: 'node-1', publicKey: one!.recipient }, { nodeId: 'node-2', publicKey: two!.recipient }] });
    await server.wait(() => server.received.some(m => m.type === 'cred.sealed'));
    const sealed = server.received.find(m => m.type === 'cred.sealed') as unknown as { kind: string; version: number; envelopes: { nodeId: string; sealed: string }[] };
    expect(sealed).toMatchObject({ kind: 'claude_token', version: 3 });
    expect(sealed.envelopes.map(e => e.nodeId)).toEqual(['node-1', 'node-2']);
    expect(new TextDecoder().decode(await unseal(sealed.envelopes[0]!.sealed, one!.identity))).toBe(TOKEN);
    expect(new TextDecoder().decode(await unseal(sealed.envelopes[1]!.sealed, two!.identity))).toBe(TOKEN);
    await expect(unseal(sealed.envelopes[0]!.sealed, three!.identity)).rejects.toThrow();
    await expect(unseal(sealed.envelopes[1]!.sealed, one!.identity)).rejects.toThrow();
  });

  it('is thrown out when Hornhoof drops it', async () => {
    const { server, home, me } = await node();
    server.send({ type: 'cred.put', kind: 'claude_token', version: 1, sealed: await seal(bytes(TOKEN), [me.recipient]) });
    const file = join(home, 'claude-oauth-token');
    await server.wait(() => existsSync(file));
    server.send({ type: 'cred.drop', kind: 'claude_token' });
    await server.wait(() => !existsSync(file));
  });
});

describe('applying a sign-in', () => {
  const dirs = () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-apply-'));
    return { dir, home: join(dir, 'home') };
  };

  it("writes a Kimi key as a provider of Kimi Code's settings and keeps what was there", () => {
    const { dir, home } = dirs();
    mkdirSync(home, { recursive: true });
    const before = [
      'default_model = "kimi-code/k3"',
      'show_thinking = true',
      '',
      '[models."kimi-code/k3"]',
      'provider = "managed:kimi-code"',
      'model = "k3"',
      'max_context_size = 262144',
      'display_name = "K3"',
      '',
      '[models."kimi-code/kimi-for-coding".overrides]',
      'max_output_size = 32000',
      '',
    ].join('\n');
    writeFileSync(join(home, 'config.toml'), before);
    applyCredential(dir, home, 'kimi_key', bytes('sk-kimi-0123456789abcdef\n'));
    const after = readFileSync(join(home, 'config.toml'), 'utf8');
    expect(after).toContain('[providers."hornhoof-key"]\ntype = "kimi"\nbase_url = "https://api.kimi.com/coding/v1"\napi_key = "sk-kimi-0123456789abcdef"\n');
    expect(after).toContain('[models."kimi-code/kimi-for-coding"]\nprovider = "hornhoof-key"\nmodel = "kimi-for-coding"\n');
    expect(after).toMatch(/^default_model = "kimi-code\/kimi-for-coding"\n/);
    expect(after).toContain('show_thinking = true');
    expect(after).toContain('[models."kimi-code/kimi-for-coding".overrides]\nmax_output_size = 32000');
    expect(after.match(/default_model/g)).toHaveLength(1);
    expect(kimiModels(after).map(m => m.id).sort()).toEqual(['kimi-code/k3', 'kimi-code/kimi-for-coding']);
    /* A second key replaces the first instead of adding another provider. */
    applyCredential(dir, home, 'kimi_key', bytes('sk-kimi-fedcba9876543210'));
    const again = readFileSync(join(home, 'config.toml'), 'utf8');
    expect(again.match(/\[providers\."hornhoof-key"\]/g)).toHaveLength(1);
    expect(again).not.toContain('sk-kimi-0123456789abcdef');
    expect(heldCredential(home, 'kimi_key')).toEqual(bytes('sk-kimi-fedcba9876543210'));
    expect(credentialSecrets(home)).toEqual(['sk-kimi-fedcba9876543210']);
    dropCredential(dir, home, 'kimi_key');
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).not.toContain('hornhoof-key');
    expect(heldCredential(home, 'kimi_key')).toBeNull();
  });

  it('refuses a key that is not one plain word, which could break the settings it goes into', () => {
    const { dir, home } = dirs();
    expect(() => applyCredential(dir, home, 'kimi_key', bytes('sk-kimi"\n[providers.evil]'))).toThrow();
    expect(() => applyCredential(dir, home, 'claude_token', bytes('two words'))).toThrow();
    expect(existsSync(join(home, 'config.toml'))).toBe(false);
  });

  it("writes a Codex sign-in only while the node holds the plan's lease", () => {
    const { dir, home } = dirs();
    const auth = JSON.stringify({ tokens: { access_token: 'codex-access-0123456789abcdef', refresh_token: 'codex-refresh-0123456789abcdef' } });
    expect(applyCredential(dir, home, 'codex_auth', bytes(auth))).toBe(false);
    expect(existsSync(join(home, 'auth.json'))).toBe(false);
    writeFileSync(join(dir, 'codex-lease'), '');
    expect(applyCredential(dir, home, 'codex_auth', bytes(auth))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'))).toEqual(JSON.parse(auth));
    expect(() => applyCredential(dir, home, 'codex_auth', bytes('not json'))).toThrow();
  });

  it('writes a GLM key where Claude Code in GLM mode reads it', () => {
    const { dir, home } = dirs();
    applyCredential(dir, home, 'glm_key', bytes('glm-key-0123456789abcdef'));
    expect(readFileSync(join(home, 'glm-key'), 'utf8').trim()).toBe('glm-key-0123456789abcdef');
    expect(credentialSecrets(home)).toEqual(['glm-key-0123456789abcdef']);
  });
});
