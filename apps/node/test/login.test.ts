import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { CutAtToken, tokenIn, type LoginSetup } from '../src/login.js';
import { runNode } from '../src/main.js';
import type { ProviderAdapter } from '../src/runner.js';
import { writeState } from '../src/state.js';
import { claudeProgram } from '../src/terminal/programs.js';
import { Tmux } from '../src/terminal/tmux.js';

/* The sign-in to a plan that its owner does in Hornhoof: the node runs the program's sign-in in a terminal of its own,
   which the owner watches and types into, and keeps what it gives. Real tmux, fake programs. */

const FAKES = fileURLToPath(new URL('./fakes/', import.meta.url));
const TOKEN = 'sk-ant-oat01-' + 'Ab3_-x9q'.repeat(11);

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
})();

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
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
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

const socketName = (what: string) => `hh-signin-${what}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

async function node(provider: 'claude' | 'codex', env: Record<string, string> = {}, dir = mkdtempSync(join(tmpdir(), 'hh-login-')), more: Partial<Parameters<typeof runNode>[0]> = {}, socket = socketName(provider)) {
  const server = await fakeServer();
  writeState(dir, { server: server.url, subscriptionId: 's1', provider, key: 'node-key-1234567890' });
  const tmux = new Tmux({ socket, env: { PATH: process.env.PATH ?? '', HOME: dir }, recordingsDir: join(dir, '.hh-recordings') });
  const log = join(dir, 'fake.log');
  const login: LoginSetup = { provider, bin: join(FAKES, provider), tmux, env: { PATH: process.env.PATH ?? '', FAKE_TOKEN: TOKEN, FAKE_WRAP: '40', FAKE_LOG: log, ...env } };
  const running = await runNode({ dir, adapter, log: () => {}, login, ...more });
  onTestFinished(async () => {
    running.stop();
    await tmux.run(['kill-server']).catch(() => {});
  });
  await until(() => server.received.some(m => m.type === 'hello'));
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);
  return { server, dir, home: join(dir, 'home'), tmux, running, calls };
}

const prompted = (tmux: Tmux) => until(async () => (await tmux.screen('login')).includes('Paste code here'));

describe('a plan sign-in in a terminal on the node', () => {
  it.skipIf(!hasTmux)('takes the code the owner types, keeps the long token and never shows it, wrapped or not', async () => {
    const { server, home, tmux, calls } = await node('claude');
    server.send({ type: 'login.start', fresh: false });
    await prompted(tmux);
    /* A narrow window, so the token wraps on the screen as well as in the program's own lines. */
    server.send({ type: 'term.open', termId: 't1', agentKey: 'login', cols: 30, rows: 30, write: true });
    await until(() => server.frames('t1').includes('Paste code'));
    server.send({ type: 'term.input', termId: 't1', data: 'code123\r' });
    await until(() => Boolean(server.done()));
    expect(server.done()).toMatchObject({ ok: true, error: null });
    expect(readFileSync(join(home, 'claude-oauth-token'), 'utf8').trim()).toBe(TOKEN);
    const frames = server.frames('t1');
    expect(frames).toContain('[hidden]');
    for (let i = 'sk-ant-oat01-'.length; i + 10 <= TOKEN.length; i++) expect(frames).not.toContain(TOKEN.slice(i, i + 10));
    /* The node says it is signed in before it says the sign-in is done, so Hornhoof seals what it holds. */
    const order = server.received.map(m => m.type);
    expect(order.lastIndexOf('status')).toBeLessThan(order.indexOf('login.done'));
    /* It ran setup-token apart from the plan's own settings, and left nothing of it behind. */
    const setup = calls().find(c => c.argv.join(' ') === 'setup-token');
    expect(setup.env.CLAUDE_CONFIG_DIR).not.toBe(home);
    await until(async () => !(await tmux.has('login')));
    expect(existsSync(setup.env.CLAUDE_CONFIG_DIR)).toBe(false);
  });

  it.skipIf(!hasTmux)('that fails says so in plain words and keeps nothing', async () => {
    const { server, home, tmux } = await node('claude', { FAKE_MODE: 'login_fail' });
    server.send({ type: 'login.start', fresh: false });
    await prompted(tmux);
    server.send({ type: 'term.open', termId: 't1', agentKey: 'login', cols: 120, rows: 30, write: true });
    await until(() => server.frames('t1').includes('Paste code'));
    server.send({ type: 'term.input', termId: 't1', data: 'code123\r' });
    await until(() => Boolean(server.done()));
    expect(server.done()).toMatchObject({ ok: false, error: expect.stringMatching(/^[A-Z][^\n]{10,200}$/) });
    expect(existsSync(join(home, 'claude-oauth-token'))).toBe(false);
  });

  it.skipIf(!hasTmux)('stopped half way ends only the sign-in: agents keep their sessions and nothing is kept', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-login-'));
    const agents = new Tmux({ socket: socketName('agents'), env: { PATH: process.env.PATH ?? '', HOME: dir } });
    onTestFinished(() => agents.run(['kill-server']).catch(() => {}));
    const terminal = { tmux: agents, program: claudeProgram, bin: join(FAKES, 'claude'), home: join(dir, 'home'), signedOut: /not logged in/i };
    const { server, home, tmux } = await node('claude', {}, dir, { terminal });
    await agents.launch('a-agent', { cwd: dir, command: ['sleep', '30'], cols: 80, rows: 24 });
    server.send({ type: 'login.start', fresh: false });
    await prompted(tmux);
    server.send({ type: 'login.stop' });
    await until(() => Boolean(server.done()));
    expect(server.done()).toMatchObject({ ok: false, error: 'The sign-in was stopped.' });
    expect(await tmux.has('login')).toBe(false);
    expect(await agents.alive('a-agent')).toBe(true);
    expect(existsSync(join(home, 'claude-oauth-token'))).toBe(false);
  });

  it.skipIf(!hasTmux)('started again begins anew, without a word about the one it replaced', async () => {
    const { server, tmux, calls } = await node('claude');
    server.send({ type: 'login.start', fresh: false });
    await prompted(tmux);
    server.send({ type: 'login.start', fresh: true });
    await until(() => calls().filter(c => c.argv.join(' ') === 'setup-token').length === 2);
    await prompted(tmux);
    expect(server.done()).toBeUndefined();
  });

  it.skipIf(!hasTmux)('does not outlive the node: a stop ends it, and a start clears what a crash left', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-login-'));
    const first = await node('claude', {}, dir);
    first.server.send({ type: 'login.start', fresh: false });
    await prompted(first.tmux);
    first.running.stop();
    await until(async () => !(await first.tmux.has('login')));

    /* A node that crashed in a sign-in left its session and its folder. */
    const left = join(first.home, '.hh-login');
    mkdirSync(left, { recursive: true });
    writeFileSync(join(left, 'auth.json'), '{}');
    const again = new Tmux({ socket: first.tmux.socket, env: { PATH: process.env.PATH ?? '', HOME: dir } });
    await again.launch('login', { cwd: dir, command: ['sleep', '30'], cols: 80, rows: 24 });
    const second = await node('claude', {}, dir, {}, first.tmux.socket);
    expect(await second.tmux.has('login')).toBe(false);
    expect(await again.has('login')).toBe(false);
    expect(existsSync(left)).toBe(false);
    expect(existsSync(join(second.home, 'claude-oauth-token'))).toBe(false);
  });

  it.skipIf(!hasTmux)('for Codex runs apart from the plan, so a failed sign-in keeps the one it had', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-login-'));
    mkdirSync(join(dir, 'home'));
    writeFileSync(join(dir, 'home', 'auth.json'), '{"old":true}');
    writeFileSync(join(dir, 'codex-lease'), '');
    const { server, home } = await node('codex', { FAKE_MODE: 'login_fail' }, dir);
    server.send({ type: 'login.start', fresh: true });
    await until(() => Boolean(server.done()));
    expect(server.done()).toMatchObject({ ok: false });
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe('{"old":true}');
  });

  it.skipIf(!hasTmux)('for Codex keeps the new sign-in and holds the plan on this machine', async () => {
    const { server, dir, home, calls } = await node('codex');
    server.send({ type: 'login.start', fresh: true });
    await until(() => Boolean(server.done()));
    expect(server.done()).toMatchObject({ ok: true, error: null });
    expect(JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'))).toEqual({ tokens: { access_token: TOKEN } });
    expect(existsSync(join(dir, 'codex-lease'))).toBe(true);
    const signIn = calls().find(c => c.argv.join(' ') === 'login --device-auth');
    expect(signIn.env.CODEX_HOME).not.toBe(home);
  });

  it.skipIf(!hasTmux)("keeps the sign-in at least 80 columns wide, so a narrow view never splits the token's start", async () => {
    const { server, home, tmux } = await node('claude', { FAKE_WRAP: 'tty' });
    server.send({ type: 'login.start', fresh: false });
    await prompted(tmux);
    server.send({ type: 'term.open', termId: 't1', agentKey: 'login', cols: 10, rows: 5, write: true });
    await until(() => server.frames('t1').includes('Paste'));
    server.send({ type: 'term.resize', termId: 't1', cols: 12, rows: 5 });
    await new Promise(r => setTimeout(r, 300));
    server.send({ type: 'term.input', termId: 't1', data: 'code123\r' });
    await until(() => Boolean(server.done()));
    expect(server.done()).toMatchObject({ ok: true });
    expect(readFileSync(join(home, 'claude-oauth-token'), 'utf8').trim()).toBe(TOKEN);
    const frames = server.frames('t1');
    for (let i = 'sk-ant-oat01-'.length; i + 10 <= TOKEN.length; i++) expect(frames).not.toContain(TOKEN.slice(i, i + 10));
  });

  it.skipIf(!hasTmux)('stopped while it checks the new sign-in keeps nothing of it', async () => {
    const { server, home, tmux, calls } = await node('claude', { FAKE_STATUS_SLEEP: '1500' });
    server.send({ type: 'login.start', fresh: false });
    await prompted(tmux);
    server.send({ type: 'term.open', termId: 't1', agentKey: 'login', cols: 120, rows: 30, write: true });
    await until(() => server.frames('t1').includes('Paste code'));
    server.send({ type: 'term.input', termId: 't1', data: 'code123\r' });
    await until(() => calls().some(c => c.argv.join(' ') === 'auth status'));
    server.send({ type: 'login.stop' });
    await until(() => Boolean(server.done()));
    await new Promise(r => setTimeout(r, 1800));
    expect(server.done()).toMatchObject({ ok: false, error: 'The sign-in was stopped.' });
    expect(existsSync(join(home, 'claude-oauth-token'))).toBe(false);
    expect(server.received.filter(m => m.type === 'login.done')).toHaveLength(1);
  });

  it.skipIf(!hasTmux)('installs its program before the sign-in, and says the sign-in failed when it cannot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-login-'));
    let installs = 0;
    const { server, calls } = await node('claude', {}, dir, { install: async () => { installs++; throw new Error('npm: offline'); } });
    /* It starts installing as the node starts, so a node that got its sign-in from Hornhoof has its program too. */
    await until(() => installs >= 1);
    const before = installs;
    server.send({ type: 'login.start', fresh: false });
    await until(() => Boolean(server.done()));
    expect(installs).toBeGreaterThan(before);
    expect(server.done()).toMatchObject({ ok: false, error: 'The sign-in failed on this machine, so nothing changed.' });
    expect(calls().some(c => c.argv.join(' ') === 'setup-token')).toBe(false);
  });

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
