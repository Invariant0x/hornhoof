import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { ProviderId } from '@hornhoof/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adapterFor } from '../src/providers/index.js';
import { limitsFrom } from '../src/providers/claude.js';
import { childEnv, lastUrl } from '../src/providers/process.js';
import type { RunInput } from '../src/runner.js';

const FAKES = fileURLToPath(new URL('./fakes/', import.meta.url));
const FAKE_BIN: Record<ProviderId, string> = {
  claude: 'claude', anthropic_api: 'claude', glm: 'claude', codex: 'codex', openai_api: 'codex', kimi: 'kimi',
};
const LOGIN_URL = 'https://login.example.test/device?code=ABC';
const CLAUDE_SESSION = '5e55c1a0-0000-4000-8000-000000000001';
const CODEX_THREAD = 'c0dec000-0000-7000-8000-000000000001';
const KIMI_SESSION = 'k1m1c0de-0000-4000-8000-000000000001';
const FLAGS = ['--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];

type Logged = { name: string; argv: string[]; cwd: string; pid: number; env: Record<string, string>; grandchild?: number };

let dir: string;
let home: string;
let tools: string;
let work: string;
let logFile: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'hh-providers-')));
  home = join(dir, 'home');
  tools = join(dir, 'tools');
  work = join(dir, 'work');
  mkdirSync(work);
  logFile = join(dir, 'fake.log');
  process.env.FAKE_LOG = logFile;
  process.env.NODE_KEY = 'node-key-that-must-not-reach-the-agent';
  process.env.HORNHOOF_DATA = '/data';
  delete process.env.FAKE_MODE;
});

afterEach(() => {
  for (const k of ['FAKE_LOG', 'FAKE_MODE', 'NODE_KEY', 'HORNHOOF_DATA']) delete process.env[k];
});

const adapter = (provider: ProviderId, secret: string | null = null) => adapterFor(provider, { home, tools, bin: join(FAKES, FAKE_BIN[provider]), secret });
const input = (over: Partial<RunInput> = {}): RunInput => ({ prompt: 'say ready', sessionId: null, model: null, workDir: work, secret: null, timeoutMs: 15000, ...over });
const logged = (): Logged[] => readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const lastRun = () => logged().filter(l => l.argv)[logged().filter(l => l.argv).length - 1]!;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function loginIo() {
  const output = new PassThrough();
  let printed = '';
  output.on('data', c => (printed += c));
  return { io: { input: new PassThrough(), output, urlFile: join(dir, 'login-url') }, printed: () => printed };
}

describe('Claude Code', () => {
  it('starts a new session with its own id and the prompt after --', async () => {
    const res = await adapter('claude').run(input({ prompt: '-rf looks like a flag' }));
    const { argv, cwd } = lastRun();
    expect(argv).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--session-id', expect.stringMatching(/^[0-9a-f-]{36}$/),
      '--permission-mode', 'bypassPermissions', '--', '-rf looks like a flag',
    ]);
    expect(cwd).toBe(work);
    expect(res).toMatchObject({ ok: true, result: 'ready', sessionId: CLAUDE_SESSION, error: null });
  });

  it('resumes a session and passes the model', async () => {
    const res = await adapter('claude').run(input({ sessionId: CLAUDE_SESSION, model: 'opus' }));
    expect(lastRun().argv).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--resume', CLAUDE_SESSION,
      '--permission-mode', 'bypassPermissions', '--model', 'opus', '--', 'say ready',
    ]);
    expect(res).toMatchObject({ ok: true, result: 'ready', sessionId: CLAUDE_SESSION });
  });

  it('reads the plan limits from the rate limit event', async () => {
    const res = await adapter('claude').run(input());
    expect(res.limits).toEqual({
      status: 'allowed',
      windows: [
        { name: 'five_hour', utilization: 0.38, resetsAt: new Date(1793307000 * 1000).toISOString() },
        { name: 'seven_day', utilization: 0.66, resetsAt: new Date(1793516400 * 1000).toISOString() },
      ],
    });
  });

  it('keeps its config in the home and never passes the node key or Hornhoof settings', async () => {
    await adapter('claude').run(input());
    const { env } = lastRun();
    expect(env.CLAUDE_CONFIG_DIR).toBe(home);
    expect(env.PATH!.startsWith(`${tools}/bin:`)).toBe(true);
    expect(env).not.toHaveProperty('NODE_KEY');
    expect(env).not.toHaveProperty('HORNHOOF_DATA');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL');
  });

  it('reports a failed run as agent_failed', async () => {
    process.env.FAKE_MODE = 'fail';
    const res = await adapter('claude').run(input());
    expect(res).toMatchObject({ ok: false, error: 'agent_failed', result: 'Something broke' });
  });

  it('reports a signed-out run as not_logged_in and sees it in auth status', async () => {
    process.env.FAKE_MODE = 'signed_out';
    const a = adapter('claude');
    expect(await a.run(input())).toMatchObject({ ok: false, error: 'not_logged_in' });
    expect(await a.loggedIn()).toBe(false);
    expect(lastRun().argv).toEqual(['auth', 'status']);
    delete process.env.FAKE_MODE;
    expect(await a.loggedIn()).toBe(true);
  });

  it('takes authentication_failed as signed out whatever the message says', async () => {
    process.env.FAKE_MODE = 'auth_error';
    expect(await adapter('claude').run(input())).toMatchObject({ ok: false, error: 'not_logged_in', result: 'Token expired' });
  });

  it('stops the whole process group at the timeout', async () => {
    process.env.FAKE_MODE = 'hang';
    const res = await adapter('claude').run(input({ timeoutMs: 200 }));
    expect(res).toMatchObject({ ok: false, error: 'timeout' });
    const pid = logged().find(l => l.argv)!.pid;
    const grandchild = logged().find(l => l.grandchild)!.grandchild!;
    expect(alive(pid)).toBe(false);
    expect(alive(grandchild)).toBe(false);
  });

  it('hides the tokens of its credentials file', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'access-token-0123456789abcdef', refreshToken: 'refresh-token-0123456789abcdef', expiresAt: 1793307000000, scopes: ['user:inference'] },
    }));
    expect(await adapter('claude').secrets()).toEqual(['access-token-0123456789abcdef', 'refresh-token-0123456789abcdef']);
  });

  it('signs in through auth login and saves the link it prints', async () => {
    const { io, printed } = loginIo();
    await adapter('claude').login(io);
    expect(lastRun().argv).toEqual(['auth', 'login']);
    expect(readFileSync(io.urlFile, 'utf8')).toBe(`${LOGIN_URL}\n`);
    expect(printed()).toContain('Open this link');
  });
});

describe('Anthropic API key', () => {
  it('passes the job secret as ANTHROPIC_API_KEY and needs no sign-in', async () => {
    const a = adapter('anthropic_api');
    await a.run(input({ secret: 'company-anthropic-key-000000' }));
    expect(lastRun().env.ANTHROPIC_API_KEY).toBe('company-anthropic-key-000000');
    expect(await a.loggedIn()).toBe(true);
  });

  it('hides the key it was given', async () => {
    expect(await adapter('anthropic_api', 'company-anthropic-key-000000').secrets()).toEqual(['company-anthropic-key-000000']);
  });
});

describe('GLM Coding Plan', () => {
  const KEY = 'glm-coding-plan-key-0123456789';

  it('asks for the key without showing it and keeps it readable only by the node', async () => {
    const a = adapter('glm');
    expect(await a.loggedIn()).toBe(false);
    const { io, printed } = loginIo();
    const done = a.login(io);
    io.input.write(`${KEY}\n`);
    await done;
    const keyFile = join(home, 'glm-key');
    expect(readFileSync(keyFile, 'utf8').trim()).toBe(KEY);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(printed()).not.toContain(KEY);
    expect(await a.loggedIn()).toBe(true);
    expect(await a.secrets()).toEqual([KEY]);
  });

  it('points Claude Code at Z.ai with the GLM models', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'glm-key'), `${KEY}\n`);
    const res = await adapter('glm').run(input());
    expect(res.ok).toBe(true);
    expect(lastRun().env).toMatchObject({
      CLAUDE_CONFIG_DIR: home,
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: KEY,
      API_TIMEOUT_MS: '3000000',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash[1m]',
    });
  });
});

describe('Codex', () => {
  it('starts a new thread in the work folder with the prompt after --', async () => {
    const res = await adapter('codex').run(input({ prompt: '-v looks like a flag' }));
    const { argv, cwd, env } = lastRun();
    expect(argv).toEqual(['exec', ...FLAGS, '-C', work, '--', '-v looks like a flag']);
    expect(cwd).toBe(work);
    expect(env.CODEX_HOME).toBe(home);
    expect(env).not.toHaveProperty('NODE_KEY');
    expect(env).not.toHaveProperty('CODEX_API_KEY');
    expect(res).toMatchObject({ ok: true, result: 'ready', sessionId: CODEX_THREAD, error: null });
  });

  it('resumes a thread from the work folder', async () => {
    const res = await adapter('codex').run(input({ sessionId: CODEX_THREAD, model: 'gpt-5.5' }));
    const { argv, cwd } = lastRun();
    expect(argv).toEqual(['exec', 'resume', ...FLAGS, '-m', 'gpt-5.5', '--', CODEX_THREAD, 'say ready']);
    expect(cwd).toBe(work);
    expect(res).toMatchObject({ ok: true, result: 'ready', sessionId: CODEX_THREAD });
  });

  it('reports a failed turn as agent_failed', async () => {
    process.env.FAKE_MODE = 'fail';
    expect(await adapter('codex').run(input())).toMatchObject({ ok: false, error: 'agent_failed' });
  });

  it('reports a signed-out run as not_logged_in and sees it in login status', async () => {
    process.env.FAKE_MODE = 'signed_out';
    const a = adapter('codex');
    expect(await a.run(input())).toMatchObject({ ok: false, error: 'not_logged_in' });
    expect(await a.loggedIn()).toBe(false);
    expect(lastRun().argv).toEqual(['login', 'status']);
  });

  it('stops at the timeout', async () => {
    process.env.FAKE_MODE = 'hang';
    expect(await adapter('codex').run(input({ timeoutMs: 200 }))).toMatchObject({ ok: false, error: 'timeout' });
    expect(alive(logged().find(l => l.grandchild)!.grandchild!)).toBe(false);
  });

  it('hides the tokens of auth.json', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'auth.json'), JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { id_token: 'id-token-0123456789abcdef', access_token: 'access-token-0123456789abcdef', refresh_token: 'refresh-0123456789abcdef', account_id: 'acct-1' },
      last_refresh: '2026-10-29',
    }));
    expect(await adapter('codex').secrets()).toEqual(['id-token-0123456789abcdef', 'access-token-0123456789abcdef', 'refresh-0123456789abcdef']);
  });

  it('signs in with a device code and saves the link it prints', async () => {
    const { io, printed } = loginIo();
    await adapter('codex').login(io);
    expect(lastRun().argv).toEqual(['login', '--device-auth']);
    expect(readFileSync(io.urlFile, 'utf8')).toBe(`${LOGIN_URL}\n`);
    expect(printed()).toContain('device code sign-in');
  });
});

describe('OpenAI API key', () => {
  it('passes the job secret as CODEX_API_KEY and needs no sign-in', async () => {
    const a = adapter('openai_api');
    await a.run(input({ secret: 'company-openai-key-0000000000' }));
    expect(lastRun().env.CODEX_API_KEY).toBe('company-openai-key-0000000000');
    expect(await a.loggedIn()).toBe(true);
  });

  it('reports a rejected key as not_logged_in', async () => {
    process.env.FAKE_MODE = 'bad_key';
    expect(await adapter('openai_api').run(input({ secret: 'wrong' }))).toMatchObject({ ok: false, error: 'not_logged_in' });
  });
});

describe('Kimi Code', () => {
  it('starts and resumes a session with its home set', async () => {
    const a = adapter('kimi');
    const first = await a.run(input());
    expect(lastRun().argv).toEqual(['--prompt=say ready', '--output-format', 'stream-json']);
    expect(lastRun().env.KIMI_CODE_HOME).toBe(home);
    expect(first).toMatchObject({ ok: true, result: 'ready', sessionId: KIMI_SESSION });

    await a.run(input({ sessionId: KIMI_SESSION, model: 'kimi-k3' }));
    expect(lastRun().argv).toEqual(['--prompt=say ready', '--output-format', 'stream-json', '--session', KIMI_SESSION, '-m', 'kimi-k3']);
  });

  it('reports a failed run as agent_failed and a signed-out one as not_logged_in', async () => {
    process.env.FAKE_MODE = 'fail';
    expect(await adapter('kimi').run(input())).toMatchObject({ ok: false, error: 'agent_failed' });
    process.env.FAKE_MODE = 'signed_out';
    expect(await adapter('kimi').run(input())).toMatchObject({ ok: false, error: 'not_logged_in' });
  });

  it('counts as signed in once its credentials folder has a file, and hides the tokens in it', async () => {
    const a = adapter('kimi');
    expect(await a.loggedIn()).toBe(false);
    mkdirSync(join(home, 'credentials'), { recursive: true });
    writeFileSync(join(home, 'credentials', 'kimi-code.json'), JSON.stringify({ access_token: 'kimi-access-0123456789abcdef', expires_in: 3600 }));
    expect(await a.loggedIn()).toBe(true);
    expect(await a.secrets()).toEqual(['kimi-access-0123456789abcdef']);
  });

  it('stops at the timeout', async () => {
    process.env.FAKE_MODE = 'hang';
    expect(await adapter('kimi').run(input({ timeoutMs: 200 }))).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('signs in through login and saves the link it prints', async () => {
    const { io } = loginIo();
    await adapter('kimi').login(io);
    expect(lastRun().argv).toEqual(['login']);
    expect(readFileSync(io.urlFile, 'utf8')).toBe(`${LOGIN_URL}\n`);
  });
});

describe('helpers', () => {
  it('maps Claude rate limit statuses and clamps utilization', () => {
    expect(limitsFrom({ status: 'allowed_warning', unifiedWindows: { seven_day: { utilization: 1.4 } } })).toEqual({
      status: 'warning', windows: [{ name: 'seven_day', utilization: 1, resetsAt: null }],
    });
    expect(limitsFrom({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1793307000 })).toEqual({
      status: 'rejected', windows: [{ name: 'five_hour', utilization: null, resetsAt: new Date(1793307000 * 1000).toISOString() }],
    });
  });

  it('strips every NODE_KEY and HORNHOOF_ variable from the child env', () => {
    process.env.HORNHOOF_SERVER = 'https://hornhoof.example.test';
    const env = childEnv(tools, { EXTRA: '1' });
    delete process.env.HORNHOOF_SERVER;
    expect(Object.keys(env).filter(k => k === 'NODE_KEY' || k.startsWith('HORNHOOF_'))).toEqual([]);
    expect(env.EXTRA).toBe('1');
  });

  it('finds the last link behind colors and terminal hyperlinks', () => {
    expect(lastUrl('\x1b[1mfirst https://a.example.test/x\x1b[0m then \x1b]8;;https://b.example.test/y\x1b\\here\x1b]8;;\x1b\\')).toBe('https://b.example.test/y');
    expect(lastUrl('no link')).toBeNull();
  });
});
