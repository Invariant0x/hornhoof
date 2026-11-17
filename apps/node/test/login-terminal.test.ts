import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { NodeMessage } from '@hornhoof/protocol';
import { SIGNIN_ERRORS } from '@hornhoof/protocol/signin';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginTerminal } from '../src/login.js';
import { withProgramExit } from '../src/program-exit.js';
import { Tmux } from '../src/terminal/tmux.js';
import { eventually } from '../../../test-support/eventually.mjs';

/* A plan's sign-in on the node, our side of it: what the node starts, what the owner sees and types, and what it keeps.
   tmux and the program's sign-in never run; the screens are written as Claude Code's setup-token prints them. */
const TOKEN = 'sk-ant-oat01-' + 'Ab3_-x9q'.repeat(11);
const CLAUDE = fileURLToPath(new URL('./fakes/claude', import.meta.url));
const until = async (check: () => boolean) => {
  await vi.advanceTimersByTimeAsync(60);
  await eventually(check);
};
const wrapped = (width: number) => TOKEN.match(new RegExp(`.{1,${width}}`, 'g'))!.join('\n');
const printed = (width: number) => `✓ Long-lived authentication token created successfully!\n\nYour OAuth token (valid for 1 year):\n\n\x1b[33m${wrapped(width)}\x1b[39m\n\nStore this token securely.\n`;

type View = ChildProcessWithoutNullStreams & { stdout: PassThrough; typed: string[] };
function view(): View {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stdin: new PassThrough(), stderr: new PassThrough(), pid: 0, killed: false, typed: [] as string[] });
  child.stdin.on('data', (chunk: Buffer) => child.typed.push(chunk.toString()));
  return Object.assign(child, { kill: () => { child.killed = true; child.emit('exit', 0, null); return true; } }) as unknown as View;
}

const stops: (() => Promise<void>)[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] }));
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function signIn(env: Record<string, string> = {}, install?: () => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-login-'));
  const home = join(dir, 'home');
  const tmux = new Tmux({ socket: 'hh-login-test', env: { HOME: dir }, recordingsDir: join(dir, 'recordings') });
  vi.spyOn(tmux, 'run').mockResolvedValue('');
  vi.spyOn(tmux, 'scratch').mockReturnValue(dir);
  const launch = vi.spyOn(tmux, 'launch').mockResolvedValue();
  const alive = vi.spyOn(tmux, 'alive').mockResolvedValue(true);
  vi.spyOn(tmux, 'kill').mockResolvedValue();
  vi.spyOn(tmux, 'stopAll').mockResolvedValue();
  const end = vi.spyOn(tmux, 'exitSnapshot').mockResolvedValue(null);
  const screen = vi.spyOn(tmux, 'screen').mockResolvedValue('');
  const views: { child: View; cols: number; rows: number; write: boolean }[] = [];
  vi.spyOn(tmux, 'attach').mockImplementation((_name, cols, rows, write) => {
    const child = view();
    views.push({ child, cols, rows, write });
    return child;
  });
  const sent: NodeMessage[] = [];
  const logged: string[] = [];
  const signedIn = vi.fn(async () => { sent.push({ type: 'status' } as NodeMessage); });
  const login = new LoginTerminal({ setup: { provider: 'claude', bin: CLAUDE, tmux, env: { PATH: process.env.PATH ?? '', ...env } }, dir, home, send: m => sent.push(m), secrets: () => [], signedIn, install, log: line => logged.push(line), pollMs: 10 });
  stops.push(() => login.shutdown());
  /* The program ends, having printed what it printed, with its exit code. */
  const ends = (output: string, code: number, shown = output) => {
    end.mockResolvedValue({ ...withProgramExit(output, { code, signal: null, at: new Date().toISOString() }), complete: true });
    screen.mockResolvedValue(shown);
    alive.mockResolvedValue(false);
  };
  const frames = (termId: string) => sent.flatMap(m => (m.type === 'term.data' && m.termId === termId ? [m.data] : [])).join('');
  const done = () => sent.find((m): m is Extract<NodeMessage, { type: 'login.done' }> => m.type === 'login.done');
  return { login, dir, home, launch, views, sent, ends, frames, done, signedIn, logged };
}

describe("a plan's sign-in in a terminal on the node", () => {
  it('runs setup-token in a folder of its own with its own settings, in a window at least 80 columns wide', async () => {
    const s = signIn();
    await s.login.start(false);
    const [name, spec] = s.launch.mock.calls[0]!;
    expect(name).toBe('login');
    expect(spec.command).toEqual([CLAUDE, 'setup-token']);
    expect(spec.cwd).toBe(join(s.home, '.hh-login'));
    expect(readFileSync(spec.envFile!, 'utf8')).toContain(`CLAUDE_CONFIG_DIR='${join(s.home, '.hh-login')}'`);
    await s.login.open({ type: 'term.open', termId: 't1', agentKey: 'login', cols: 30, rows: 5, write: true });
    expect(s.views[0]).toMatchObject({ cols: 80, rows: 10, write: true });
  });

  it.each([30, 80, 200])('keeps the long token from what the owner sees, wrapped at %i columns, and keeps it for the plan', async width => {
    const s = signIn();
    await s.login.start(false);
    await s.login.open({ type: 'term.open', termId: 't1', agentKey: 'login', cols: 120, rows: 30, write: true });
    const out = s.views[0]!.child.stdout;
    const shown = printed(width);
    /* The screen comes in pieces, one of them cut inside the token's start. */
    out.write(shown.slice(0, shown.indexOf('sk-ant') + 5));
    out.write(shown.slice(shown.indexOf('sk-ant') + 5));
    await until(() => s.frames('t1').includes('[hidden]'));
    s.ends(shown, 0);
    await until(() => Boolean(s.done()));
    expect(s.done()).toMatchObject({ ok: true, error: null });
    for (let i = 'sk-ant-oat01-'.length; i + 10 <= TOKEN.length; i++) expect(s.frames('t1')).not.toContain(TOKEN.slice(i, i + 10));
    expect(readFileSync(join(s.home, 'claude-oauth-token'), 'utf8').trim()).toBe(TOKEN);
    /* The node says it is signed in before it says the sign-in is done, and leaves nothing of the sign-in's folder. */
    const order = s.sent.map(m => m.type);
    expect(order.indexOf('status')).toBeLessThan(order.indexOf('login.done'));
    expect(existsSync(join(s.home, '.hh-login'))).toBe(false);
  });

  it('that fails says so in plain words and keeps nothing', async () => {
    const s = signIn();
    await s.login.start(false);
    s.ends(printed(80), 1);
    await until(() => Boolean(s.done()));
    expect(s.done()).toMatchObject({ ok: false, error: expect.any(String) });
    expect(existsSync(join(s.home, 'claude-oauth-token'))).toBe(false);
    expect(s.signedIn).not.toHaveBeenCalled();
  });

  /* The owner sees only that the sign-in ended early; the machine's output keeps why, for whoever helps them. */
  it("whose program ends at once says in the machine's output how it ended and what it printed last", async () => {
    const s = signIn();
    await s.login.start(false);
    s.ends("node:internal/modules/cjs/loader:1228\n  throw err;\n\nError: Cannot find module '/data/tools/lib/node_modules/@anthropic-ai/claude-code/cli.js'\n", 1);
    await until(() => Boolean(s.done()));
    expect(s.done()).toMatchObject({ ok: false });
    expect(s.logged).toEqual([expect.stringMatching(/^The sign-in program ended with code 1: .*Cannot find module '\/data\/tools\/lib\/node_modules\/@anthropic-ai\/claude-code\/cli\.js'/)]);
  });

  it("keeps every piece of a printed token out of the machine's output", async () => {
    const s = signIn();
    await s.login.start(false);
    s.ends(printed(30), 1);
    await until(() => Boolean(s.done()));
    expect(s.logged).toEqual(['The sign-in program ended with code 1.']);
    expect(s.done()).toMatchObject({ ok: false, code: 1, line: null });
  });

  /* The owner sees why: its code and the last line it said, with nothing in it that looks like a key. */
  it.each(['AbCdMARKER7c41EfGh1234IjKlMnOp5678', 'marker7c41abcdefghijklmnopqrstuvwxyz', 'prefix~marker7c41abcdefghijklmnopqrstuvwxyz'])('whose program ends at once masks its code and last line, including Bearer %s', async bearer => {
    const s = signIn();
    await s.login.start(false);
    const key = 'sk-ant-api03-MARKER7c41qZ9xT2vB8nL0pW';
    s.ends(`Checking the account\n\x1b[31mError: the key ${key} was refused (Bearer ${bearer})\x1b[0m\n\n`, 1);
    await until(() => Boolean(s.done()));
    expect(s.done()).toEqual({ type: 'login.done', ok: false, error: SIGNIN_ERRORS.unfinished, code: 1, line: 'Error: the key [hidden] was refused (Bearer [hidden])' });
    expect(JSON.stringify(s.sent)).not.toContain('MARKER7c41');
    expect(s.logged.join('\n')).not.toContain('MARKER7c41');
    expect(JSON.stringify(s.sent)).not.toContain(bearer);
    expect(s.logged.join('\n')).not.toContain(bearer);
  });

  it('keeps a named OAuth credential out of the early-exit message and machine log', async () => {
    const s = signIn();
    await s.login.start(false);
    s.ends('Error: access_token=securitymarker7lowercase was refused', 1);
    await until(() => Boolean(s.done()));
    expect(s.done()).toMatchObject({ code: 1, line: 'Error: access_token=[hidden] was refused' });
    expect(JSON.stringify(s.sent)).not.toContain('securitymarker7lowercase');
    expect(s.logged.join('\n')).not.toContain('securitymarker7lowercase');
  });

  it('cuts a long last line and keeps no terminal codes in it', async () => {
    const s = signIn();
    await s.login.start(false);
    s.ends(`\x1b]0;title\x07\x1b[1m${'word '.repeat(100)}\x1b[0m\x07\n`, 2);
    await until(() => Boolean(s.done()));
    const line = s.done()!.line!;
    expect([...line]).toHaveLength(200);
    expect(line.endsWith('…')).toBe(true);
    expect(line).not.toMatch(/[\u0000-\u001f]/);
    expect(s.done()).toMatchObject({ code: 2 });
  });

  it('keeps nothing of a token its program does not take', async () => {
    const s = signIn();
    await s.login.start(false);
    s.ends(printed(200).replace(TOKEN, 'sk-ant-oat01-short'), 0);
    await until(() => Boolean(s.done()));
    expect(s.done()).toMatchObject({ ok: false });
    expect(existsSync(join(s.home, 'claude-oauth-token'))).toBe(false);
  });

  it('passes what the owner types to the sign-in, and nothing a watcher who may not type sends', async () => {
    const s = signIn();
    await s.login.start(false);
    await s.login.open({ type: 'term.open', termId: 'owner', agentKey: 'login', cols: 80, rows: 24, write: true });
    await s.login.open({ type: 'term.open', termId: 'watcher', agentKey: 'login', cols: 80, rows: 24, write: false });
    s.login.input({ type: 'term.input', termId: 'owner', data: 'code123\r' });
    s.login.input({ type: 'term.input', termId: 'watcher', data: 'sneaky\r' });
    await until(() => s.views[0]!.child.typed.join('') === 'code123\r');
    expect(s.views[1]).toMatchObject({ write: false });
    expect(s.views[1]!.child.typed).toEqual([]);
  });

  it('stopped half way ends only the sign-in and keeps nothing', async () => {
    const s = signIn();
    await s.login.start(false);
    await s.login.stop();
    expect(s.done()).toMatchObject({ ok: false, error: expect.any(String) });
    expect(existsSync(join(s.home, 'claude-oauth-token'))).toBe(false);
  });

  it('installs its program before the sign-in, and says the program could not be installed when it cannot', async () => {
    const s = signIn({}, async () => { throw new Error('npm failed'); });
    await s.login.start(false);
    expect(s.launch).not.toHaveBeenCalled();
    expect(s.done()).toMatchObject({ ok: false, error: expect.any(String) });
  });
});
