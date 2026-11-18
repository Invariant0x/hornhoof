import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { applyCredential, credentialSecrets, dropCredential, heldCredential } from '../src/credentials.js';
import { nodeIdentity, seal, unseal } from '../src/keys.js';
import { runNode } from '../src/main.js';
import { kimiModels } from '../src/providers/kimi.js';
import type { ProviderAdapter } from '../src/runner.js';
import { writeState } from '../src/state.js';
import { planToken } from '../src/providers/claude-terminal.js';
import { readAccount } from '../src/account.js';
import { claudeAdapter } from '../src/providers/claude.js';
import { eventually } from '../../../test-support/eventually.mjs';
import { testPort } from '../../../test-support/ports.mjs';

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
  const server = new WebSocketServer({ port: await testPort(), host: '127.0.0.1' });
  onTestFinished(() => server.close());
  await new Promise(r => server.once('listening', r));
  const received: { type: string; [k: string]: unknown }[] = [];
  let socket: WebSocket | null = null;
  server.on('connection', s => {
    socket = s;
    s.on('message', data => received.push(JSON.parse(String(data))));
  });
  const wait = (check: () => boolean) => eventually(check);
  const send = (m: object) => socket!.send(JSON.stringify(m));
  /* A node with no sign-in to start answers at once, after everything it sent before. */
  const marked = async () => {
    const answers = received.filter(m => m.type === 'login.done').length;
    send({ type: 'login.start', fresh: false });
    await wait(() => received.filter(m => m.type === 'login.done').length > answers);
  };
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, received, send, wait, marked };
}

/* The node's own timers that look again, on a clock the test moves. */
const fakeLooks = () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  onTestFinished(() => { vi.useRealTimers(); });
};

async function node(more: Partial<Parameters<typeof runNode>[0]> = {}, dir = mkdtempSync(join(tmpdir(), 'hh-cred-'))) {
  const server = await fakeServer();
  writeState(dir, { server: server.url, subscriptionId: 's1', provider: 'claude', key: 'node-key-1234567890' });
  const lines: string[] = [];
  const running = await runNode({ dir, adapter, log: l => void lines.push(l), ...more });
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
    dropCredential(home, 'kimi_key');
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

describe('a sign-in its program refused', () => {
  it('keeps the node signed out until the sign-in changes, so turns do not go round on it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-cred-'));
    const refusing: ProviderAdapter = { ...adapter, run: async () => ({ ok: false, sessionId: null, result: '', output: 'Not logged in', error: 'not_logged_in', limits: null }) };
    fakeLooks();
    const { server, me } = await node({ adapter: refusing, loginCheckMs: 30 }, dir);
    server.send({ type: 'cred.put', kind: 'claude_token', version: 1, sealed: await seal(bytes(TOKEN), [me.recipient]) });
    await server.wait(() => existsSync(join(dir, 'home', 'claude-oauth-token')));
    server.send({ type: 'job.run', jobId: 'j1', provider: 'claude', secret: null, subscriptionId: 's1', sessionId: null, model: null, timeoutMs: 2_147_483_647 - 30_000, prompt: 'hi', instructions: null, toolToken: null });
    await server.wait(() => server.received.filter(m => m.type === 'status').at(-1)?.loggedIn === false);
    /* Three looks again find the same sign-in, and what they would say comes before the mark. */
    await vi.advanceTimersByTimeAsync(90);
    await server.marked();
    expect(server.received.filter(m => m.type === 'status').at(-1)).toMatchObject({ loggedIn: false });
    /* A new sign-in from Hornhoof is tried again. */
    server.send({ type: 'cred.put', kind: 'claude_token', version: 2, sealed: await seal(bytes(TOKEN.replace('a', 'b')), [me.recipient]) });
    await server.wait(() => server.received.filter(m => m.type === 'status').at(-1)?.loggedIn === true);
  });

  /* A provider that refuses every sign-in for a while must not get a new turn in a terminal every look. */
  it.each([
    ['ended on the sign-in', { error: 'not_logged_in' as const }],
    ['failed on the sign-in', { error: 'agent_failed' as const, failure: { kind: 'auth' as const, text: 'authentication_failed: Please run /login', retryable: false } }],
  ])('keeps the node signed out after a turn that %s, with no sign-in from Hornhoof to compare, until one comes', async (_, ended) => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-cred-'));
    const refusing: ProviderAdapter = { ...adapter, run: async () => ({ ok: false, sessionId: null, result: '', output: '', limits: null, ...ended }) };
    fakeLooks();
    const { server, me } = await node({ adapter: refusing, loginCheckMs: 30 }, dir);
    server.send({ type: 'job.run', jobId: 'j1', provider: 'claude', secret: null, subscriptionId: 's1', sessionId: null, model: null, timeoutMs: 2_147_483_647 - 30_000, prompt: 'hi', instructions: null, toolToken: null });
    await server.wait(() => server.received.filter(m => m.type === 'status').at(-1)?.loggedIn === false);
    await vi.advanceTimersByTimeAsync(90);
    await server.marked();
    expect(server.received.filter(m => m.type === 'status').at(-1)).toMatchObject({ loggedIn: false });
    server.send({ type: 'cred.put', kind: 'claude_token', version: 1, sealed: await seal(bytes(TOKEN), [me.recipient]) });
    await server.wait(() => server.received.filter(m => m.type === 'status').at(-1)?.loggedIn === true);
  });
});

describe("sign-in files in the agents' home", () => {
  /* Agents own the plan's home and can put a link there to a file only the node reads, such as its key. */
  const swapped = (make: (target: string, path: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-swap-'));
    const home = join(dir, 'home');
    mkdirSync(home);
    const key = join(dir, 'node-key');
    writeFileSync(key, `AGE-SECRET-KEY-1${'Q'.repeat(40)}\n`);
    for (const f of ['claude-oauth-token', 'auth.json', 'kimi-key', 'glm-key', 'config.toml']) make(key, join(home, f));
    return { dir, home };
  };

  for (const [what, make] of [['a link', symlinkSync], ['a second name', linkSync]] as const) {
    it(`are not read through ${what} an agent put there, so no file of the node reaches the agents`, async () => {
      const { dir, home } = swapped(make);
      expect(planToken(home)).toBeNull();
      expect(heldCredential(home, 'claude_token')).toBeNull();
      expect(heldCredential(home, 'codex_auth')).toBeNull();
      expect(credentialSecrets(home)).toEqual([]);
      expect(await readAccount('codex', home, {})).toBeNull();
      /* A GLM plan's program does not get the file in its env either. */
      expect(await claudeAdapter({ home, tools: dir, mode: 'glm' }).loggedIn()).toBe(false);
      /* A Kimi key keeps the settings it finds; a swapped settings file is not one. */
      applyCredential(dir, home, 'kimi_key', bytes('sk-kimi-0123456789abcdef'));
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).not.toContain('AGE-SECRET-KEY');
    });
  }
});

describe("a Codex plan's lease on a node", () => {
  const auth = (n: number) => JSON.stringify({ tokens: { access_token: `codex-access-${n}-0123456789abcdef`, refresh_token: `codex-refresh-${n}-0123456789abcdef` } });
  const holder = (dir: string) => {
    mkdirSync(join(dir, 'home'), { recursive: true });
    writeFileSync(join(dir, 'home', 'auth.json'), auth(1));
    writeFileSync(join(dir, 'codex-lease'), '');
  };
  const JOB = { type: 'job.run', provider: 'codex', secret: null, subscriptionId: 's1', sessionId: null, model: null, timeoutMs: 2_147_483_647 - 30_000, prompt: 'hi', instructions: null, toolToken: null };
  const sealedCount = (received: { type: string }[]) => received.filter(m => m.type === 'cred.sealed').length;

  it('seals a sign-in Codex renewed in a turn once for the plan, and nothing when it stayed the same', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-cred-'));
    holder(dir);
    let next: string | null = null;
    const renewing: ProviderAdapter = {
      ...adapter,
      run: async () => {
        if (next) writeFileSync(join(dir, 'home', 'auth.json'), next);
        return { ok: true, sessionId: null, result: '', output: '', error: null, limits: null };
      },
    };
    const { server, me } = await node({ adapter: renewing }, dir);
    const peer = await nodeIdentity(mkdtempSync(join(tmpdir(), 'hh-peer-')));
    server.send({ type: 'cred.seal', kind: 'codex_auth', version: 4, recipients: [{ nodeId: 'n-self', publicKey: me.recipient }, { nodeId: 'n-peer', publicKey: peer.recipient }] });
    await server.wait(() => sealedCount(server.received) === 1);
    next = auth(2);
    server.send({ ...JOB, jobId: 'j1' });
    await server.wait(() => sealedCount(server.received) === 2);
    const renewed = server.received.filter((m): m is { type: string; kind: string; version: number; envelopes: { nodeId: string; sealed: string }[] } => m.type === 'cred.sealed')[1];
    expect(renewed).toMatchObject({ kind: 'codex_auth', version: 5 });
    expect(new TextDecoder().decode(await unseal(renewed.envelopes.find(e => e.nodeId === 'n-peer')!.sealed, peer.identity))).toBe(auth(2));
    next = null;
    server.send({ ...JOB, jobId: 'j2' });
    await server.wait(() => server.received.some(m => m.type === 'job.done' && m.jobId === 'j2'));
    /* Each sealing takes the next number at once, so the next renewal shows whether the turn that changed nothing sealed. */
    next = auth(3);
    server.send({ ...JOB, jobId: 'j3' });
    await server.wait(() => sealedCount(server.received) === 3);
    const third = server.received.filter((m): m is { type: string; version: number; envelopes: { nodeId: string; sealed: string }[] } => m.type === 'cred.sealed')[2]!;
    expect(third.version).toBe(6);
    expect(new TextDecoder().decode(await unseal(third.envelopes.find(e => e.nodeId === 'n-peer')!.sealed, peer.identity))).toBe(auth(3));
  });

  it('seals a renewed sign-in for a node that joined under the same number too, and takes no list under an older one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-cred-'));
    holder(dir);
    const { server, me } = await node({ leaseCheckMs: 50 }, dir);
    const peer = await nodeIdentity(mkdtempSync(join(tmpdir(), 'hh-peer-')));
    const askToSeal = (version: number, nodeId: string, publicKey: string) => server.send({ type: 'cred.seal', kind: 'codex_auth', version, recipients: [{ nodeId, publicKey }] });
    server.send({ type: 'cred.seal', kind: 'codex_auth', version: 4, recipients: [{ nodeId: 'n-self', publicKey: me.recipient }, { nodeId: 'n-peer', publicKey: peer.recipient }] });
    await server.wait(() => sealedCount(server.received) === 1);
    askToSeal(4, 'n-late', peer.recipient);
    await server.wait(() => sealedCount(server.received) === 2);
    askToSeal(4, 'n-peer', peer.recipient);
    await server.wait(() => sealedCount(server.received) === 3);
    askToSeal(3, 'n-old', peer.recipient);
    await server.wait(() => sealedCount(server.received) === 4);
    writeFileSync(join(dir, 'home', 'auth.json'), auth(2));
    await server.wait(() => sealedCount(server.received) === 5);
    const renewed = server.received.filter((m): m is { type: string; version: number; envelopes: { nodeId: string }[] } & { [k: string]: unknown } => m.type === 'cred.sealed')[4]!;
    expect(renewed.version).toBe(5);
    expect(renewed.envelopes.map(e => e.nodeId).sort()).toEqual(['n-late', 'n-peer', 'n-self']);
  });

  it('holds no sign-in of a plan on the built-in node, whatever it is told', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-cred-'));
    const server = await fakeServer();
    const running = await runNode({ dir, adapter, log: () => {}, builtin: { server: server.url, key: 'node-key-1234567890' } });
    onTestFinished(() => running.stop());
    await server.wait(() => server.received.some(m => m.type === 'hello'));
    const me = await nodeIdentity(dir);
    server.send({ type: 'cred.lease', hold: true });
    server.send({ type: 'cred.put', kind: 'codex_auth', version: 1, sealed: await seal(bytes(auth(1)), [me.recipient]) });
    /* Both went in turn before the mark, and the built-in node turns each down at once. */
    await server.marked();
    expect(existsSync(join(dir, 'codex-lease'))).toBe(false);
    expect(existsSync(join(dir, 'home', 'auth.json'))).toBe(false);
  });

  it('seals a sign-in Codex renewed between turns when it looks again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-cred-'));
    holder(dir);
    fakeLooks();
    const { server, me } = await node({ leaseCheckMs: 50 }, dir);
    server.send({ type: 'cred.seal', kind: 'codex_auth', version: 1, recipients: [{ nodeId: 'n-self', publicKey: me.recipient }] });
    await server.wait(() => sealedCount(server.received) === 1);
    writeFileSync(join(dir, 'home', 'auth.json'), auth(3));
    await vi.advanceTimersByTimeAsync(50);
    await server.wait(() => sealedCount(server.received) === 2);
    /* Three more looks find it the same. Each sealing takes the next number at once, so the next renewal shows whether
       they sealed. */
    await vi.advanceTimersByTimeAsync(150);
    writeFileSync(join(dir, 'home', 'auth.json'), auth(4));
    await vi.advanceTimersByTimeAsync(50);
    await server.wait(() => sealedCount(server.received) === 3);
    const sealed = server.received.filter((m): m is { type: string; version: number; envelopes: { nodeId: string; sealed: string }[] } => m.type === 'cred.sealed');
    expect(sealed.map(m => m.version)).toEqual([1, 2, 3]);
    expect(new TextDecoder().decode(await unseal(sealed[2]!.envelopes[0]!.sealed, me.identity))).toBe(auth(4));
  });

  it('takes the plan over from the messages of a move sent all at once, and seals what it got and what Codex renews', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-cred-'));
    const { server, me } = await node({ leaseCheckMs: 50 }, dir);
    const peer = await nodeIdentity(mkdtempSync(join(tmpdir(), 'hh-peer-')));
    const recipients = [{ nodeId: 'n-self', publicKey: me.recipient }, { nodeId: 'n-peer', publicKey: peer.recipient }];
    server.send({ type: 'cred.lease', hold: true });
    server.send({ type: 'cred.put', kind: 'codex_auth', version: 2, sealed: await seal(bytes(auth(5)), [me.recipient]) });
    server.send({ type: 'cred.seal', kind: 'codex_auth', version: 2, recipients });
    await server.wait(() => sealedCount(server.received) === 1);
    const first = server.received.find(m => m.type === 'cred.sealed') as unknown as { version: number; envelopes: { nodeId: string; sealed: string }[] };
    expect(first.version).toBe(2);
    expect(new TextDecoder().decode(await unseal(first.envelopes.find(e => e.nodeId === 'n-peer')!.sealed, peer.identity))).toBe(auth(5));
    writeFileSync(join(dir, 'home', 'auth.json'), auth(6));
    await server.wait(() => sealedCount(server.received) === 2);
    expect(server.received.filter(m => m.type === 'cred.sealed')[1]).toMatchObject({ version: 3 });
  });

  it('as a spare machine stays signed out though a Codex still running there writes its file back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-cred-'));
    holder(dir);
    fakeLooks();
    const { server, me } = await node({ adapter: { ...adapter, loggedIn: async () => existsSync(join(dir, 'home', 'auth.json')) }, loginCheckMs: 30 }, dir);
    server.send({ type: 'cred.lease', hold: false });
    await server.wait(() => server.received.some(m => m.type === 'status' && m.loggedIn === false));
    expect(existsSync(join(dir, 'codex-spare'))).toBe(true);
    writeFileSync(join(dir, 'home', 'auth.json'), auth(9));
    /* Three looks again find it spare, and what they would say comes before the mark. */
    await vi.advanceTimersByTimeAsync(90);
    await server.marked();
    expect(server.received.filter(m => m.type === 'status').at(-1)).toMatchObject({ loggedIn: false });
    /* Given the plan, it works again. */
    server.send({ type: 'cred.lease', hold: true });
    server.send({ type: 'cred.put', kind: 'codex_auth', version: 3, sealed: await seal(bytes(auth(10)), [me.recipient]) });
    await server.wait(() => server.received.filter(m => m.type === 'status').at(-1)?.loggedIn === true);
    expect(existsSync(join(dir, 'codex-spare'))).toBe(false);
  });

  it('given up, takes the sign-in away and says the node is signed out; held again, keeps the one it gets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-cred-'));
    holder(dir);
    const signedIn: ProviderAdapter = { ...adapter, loggedIn: async () => existsSync(join(dir, 'home', 'auth.json')) };
    const { server, me } = await node({ adapter: signedIn }, dir);
    server.send({ type: 'cred.lease', hold: false });
    await server.wait(() => server.received.some(m => m.type === 'status' && m.loggedIn === false));
    expect(existsSync(join(dir, 'home', 'auth.json'))).toBe(false);
    expect(existsSync(join(dir, 'codex-lease'))).toBe(false);
    server.send({ type: 'cred.lease', hold: true });
    server.send({ type: 'cred.put', kind: 'codex_auth', version: 2, sealed: await seal(bytes(auth(7)), [me.recipient]) });
    await server.wait(() => server.received.some(m => m.type === 'status' && m.loggedIn === true));
    expect(readFileSync(join(dir, 'home', 'auth.json'), 'utf8')).toBe(auth(7));
  });
});
