import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CLAUDE_ALIASES, MAX_INSTRUCTIONS, type AgentEvent, type ProviderId, type ServerMessage } from '@hornhoof/protocol';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { adapterFor } from '../src/providers/index.js';
import { claudeEvents, claudeInterrupted, limitsFrom } from '../src/providers/claude.js';
import { codexEvents, codexRateLimits } from '../src/providers/codex.js';
import { kimiContextSize, kimiEvents, kimiModels } from '../src/providers/kimi.js';
import { agyModels, agyStream, installAgy } from '../src/providers/antigravity.js';
import { childEnv, lastUrl } from '../src/providers/process.js';
import { runJob, type RunInput } from '../src/runner.js';

const FAKES = fileURLToPath(new URL('./fakes/', import.meta.url));
const FAKE_BIN: Record<ProviderId, string> = {
  claude: 'claude', anthropic_api: 'claude', glm: 'claude', codex: 'codex', openai_api: 'codex', kimi: 'kimi', antigravity: 'agy',
};
const LOGIN_URL = 'https://login.example.test/device?code=ABC';
const CLAUDE_SESSION = '5e55c1a0-0000-4000-8000-000000000001';
const CODEX_THREAD = 'c0dec000-0000-7000-8000-000000000001';
const KIMI_SESSION = 'k1m1c0de-0000-4000-8000-000000000001';
/* The conversations in agy's own stream-json examples. */
const AGY_NEW = 'c3b66b04-872b-4fbe-a3a4-058a026ef20a';
const AGY_RESUMED = '9ec58bfd-4d67-4f5e-83a5-9d907e9c6b1f';
const AGY_FLAGS = ['--output-format', 'stream-json', '--print-timeout', '0s', '--dangerously-skip-permissions'];
/* Codex reads AGENTS.md only up to project_doc_max_bytes, 32 KiB unless set. */
const FLAGS = ['--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-c', 'project_doc_max_bytes=1048576'];

type Logged = {
  name: string; argv: string[]; cwd: string; pid: number; env: Record<string, string>; grandchild?: number;
  mcpConfig?: { path: string; mode: number; json: unknown }; agentsMd?: string; kimiMcp?: unknown; agyMcp?: { mode: number; json: unknown };
};

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
  for (const k of ['FAKE_LOG', 'FAKE_MODE', 'FAKE_ERROR_SECRET', 'NODE_KEY', 'HORNHOOF_DATA']) delete process.env[k];
});

const adapter = (provider: ProviderId, secret: string | null = null) => adapterFor(provider, { home, tools, bin: join(FAKES, FAKE_BIN[provider]), secret, plugins: [] });
const input = (over: Partial<RunInput> = {}): RunInput => ({ prompt: 'say ready', sessionId: null, model: null, workDir: work, secret: null, timeoutMs: 15000, instructions: null, tools: null, ...over });
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
/* The child a hanging program started, once its whole line is in the log. A busy machine takes longer to start the
   program than any short wait, so a test stops it only after this. */
const hangingChild = async (): Promise<number> => {
  for (;; await sleep(20)) {
    const pid = existsSync(logFile) && /"grandchild":(\d+)\}\n/.exec(readFileSync(logFile, 'utf8'))?.[1];
    if (pid) return Number(pid);
  }
};
/* Runs a hanging program into its timeout, on a clock that moves only once the program is up. The timeout ends the
   program's child, and the program, which takes no notice of it, goes after the grace. In between the program collects
   its ended child, as it would in the grace a real clock gives it; killed first, it would leave it to the system. */
const timedOut = async (provider: ProviderId) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const run = adapter(provider).run(input({ timeoutMs: 200 }));
    const child = await hangingChild();
    await vi.advanceTimersByTimeAsync(200);
    for (const end = Date.now() + 5000; alive(child) && Date.now() < end; ) await sleep(20);
    await vi.runAllTimersAsync();
    return await run;
  } finally {
    vi.useRealTimers();
  }
};

describe('output a program should not print', () => {
  it.each(['claude', 'codex', 'kimi'] as const)('%s goes on past lines that are JSON but no object', async provider => {
    process.env.FAKE_MODE = 'odd-lines';
    const res = await adapter(provider).run(input());
    expect(res.ok).toBe(true);
  });

  it('reads a limit whose reset no date can hold as unknown', () => {
    const far = 1e20;
    expect(limitsFrom({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: far } } }).windows).toEqual([{ name: 'five_hour', utilization: 0.5, resetsAt: null }]);
    expect(limitsFrom({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: Number.NaN }).windows[0]!.resetsAt).toBeNull();
    expect(codexRateLimits({ rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: far } } })!.windows[0]!.resetsAt).toBeNull();
  });
});

describe('failed program diagnostics', () => {
  it.each(['claude', 'codex', 'kimi'] as const)('%s ends failed output with its observed exit code and UTC time', async provider => {
    process.env.FAKE_MODE = 'fail';
    const res = await adapter(provider).run(input());
    expect(res).toMatchObject({ ok: false, error: 'agent_failed' });
    const last = res.output.split('\n').at(-1)!;
    expect(last).toMatch(/^Program ended: code 1, signal none, at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(last.length).toBeLessThanOrEqual(400);
  });

  it.each(['claude', 'codex', 'kimi'] as const)('%s reports KILL with the output preceding it', async provider => {
    process.env.FAKE_MODE = 'killed';
    const res = await adapter(provider).run(input());
    expect(res).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(res.output).toMatch(/boom\nProgram ended: code none, signal KILL \(9\), at /);
  });

  it.each(['claude', 'codex', 'kimi'] as const)('%s keeps 50 output lines and redacts them before producing the job tail', async provider => {
    const secret = 'known-job-secret-0123456789abcdef';
    process.env.FAKE_MODE = 'fail-long';
    process.env.FAKE_ERROR_SECRET = secret;
    const msg: Extract<ServerMessage, { type: 'job.run' }> = {
      type: 'job.run', jobId: 'diagnostics', subscriptionId: 'test', provider, prompt: 'fail',
      sessionId: null, model: null, timeoutMs: 5000, secret, instructions: null, toolToken: null,
    };
    const done = await runJob(adapter(provider), msg, dir);
    expect(done).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(done.tail.split('\n').at(-1)).toMatch(/^Program ended: code 3, signal none, at /);
    expect(done.tail.split('\n').slice(0, -1)).toEqual([
      ...Array.from({ length: 49 }, (_, i) => `output ${i + 11}`), 'boom [hidden]',
    ]);
    expect(done.tail).not.toContain(secret);
    expect(Buffer.byteLength(done.tail)).toBeLessThanOrEqual(4096);
  });
});

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

  it('compacts the conversation at the window Hornhoof set, or at its own when none is set', async () => {
    await adapter('claude').run(input({ compactWindow: 500_000 }));
    expect(lastRun().env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('500000');
    await adapter('claude').run(input());
    expect(lastRun().env).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  });

  it('thinks as hard as the agent was set to', async () => {
    await adapter('claude').run(input({ effort: 'high' }));
    const { argv } = lastRun();
    expect(argv.slice(argv.indexOf('--effort'), argv.indexOf('--effort') + 2)).toEqual(['--effort', 'high']);
    expect(argv.indexOf('--effort')).toBeLessThan(argv.indexOf('--'));
    await adapter('claude').run(input());
    expect(lastRun().argv).not.toContain('--effort');
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

  it('keeps the answer when a background task adds an empty result after it', async () => {
    process.env.FAKE_MODE = 'background';
    expect(await adapter('claude').run(input())).toMatchObject({ ok: true, result: 'ready' });
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
    const res = await timedOut('claude');
    expect(res).toMatchObject({ ok: false, error: 'timeout' });
    const pid = logged().find(l => l.argv)!.pid;
    const grandchild = logged().find(l => l.grandchild)!.grandchild!;
    expect(alive(pid)).toBe(false);
    expect(alive(grandchild)).toBe(false);
  });

  it("runs with the plan's sign-in its node was given, and hides it in what the agent says", async () => {
    const token = 'sk-ant-oat01-' + 'b'.repeat(40);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'claude-oauth-token'), token + '\n', { mode: 0o600 });
    process.env.FAKE_MODE = 'say_token';
    const events: AgentEvent[] = [];
    const msg = { type: 'job.run' as const, jobId: 'j1', subscriptionId: 's1', provider: 'claude' as const, prompt: 'hi', sessionId: null, model: null, timeoutMs: 15000, secret: null, instructions: null, toolToken: null };
    const done = await runJob(adapter('claude'), msg, work, { onEvent: e => void events.push(e) });
    expect(lastRun().env.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
    expect(events).toContainEqual({ kind: 'text', text: 'my token is [hidden]' });
    expect(JSON.stringify(done)).not.toContain(token);
    expect(await adapter('claude').secrets()).toContain(token);
  });

  it('runs without a token when its node was given none', async () => {
    await adapter('claude').run(input());
    expect(lastRun().env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
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

  it('forgets a key Z.ai rejects, so the next sign-in asks for a new one', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'glm-key'), `${KEY}\n`);
    process.env.FAKE_MODE = 'auth_error';
    const a = adapter('glm');
    expect(await a.run(input())).toMatchObject({ ok: false, error: 'not_logged_in' });
    expect(await a.loggedIn()).toBe(false);
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

  it('thinks as hard as the agent was set to', async () => {
    await adapter('codex').run(input({ effort: 'xhigh' }));
    const { argv } = lastRun();
    expect(argv[argv.indexOf('model_reasoning_effort="xhigh"') - 1]).toBe('-c');
    expect(argv.indexOf('model_reasoning_effort="xhigh"')).toBeLessThan(argv.indexOf('--'));
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
    expect(await timedOut('codex')).toMatchObject({ ok: false, error: 'timeout' });
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

describe('models', () => {
  it("groups the models agy lists by the levels in their names, and keeps one with a single level by its own id", () => {
    const listed = agyModels(readFileSync(new URL('./fixtures/agy-models.txt', import.meta.url), 'utf8'));
    expect(listed).toEqual([
      { id: 'Gemini 4 Argon', name: 'Gemini 4 Argon', efforts: ['medium', 'high'] },
      { id: 'Gemini 3.8 Flash', name: 'Gemini 3.8 Flash', efforts: ['medium', 'high'] },
      { id: 'Gemini 3.7 Flash', name: 'Gemini 3.7 Flash', efforts: ['medium', 'high'] },
      { id: 'Gemini 3.6 Flash', name: 'Gemini 3.6 Flash', efforts: ['medium', 'high'] },
      { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)' },
    ]);
    expect(agyModels('claude-opus-5-5-thinking   Claude Opus 5.5 (Thinking)\nno columns here\n')).toEqual([{ id: 'claude-opus-5-5-thinking', name: 'Claude Opus 5.5 (Thinking)' }]);
  });

  it('lists the Codex models its plan shows in its picker', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'models_cache.json'), JSON.stringify({
      fetched_at: '2026-10-30T00:00:00Z',
      models: [
        {
          slug: 'gpt-6.1-sol',
          display_name: 'GPT-6.1 Sol',
          visibility: 'list',
          default_reasoning_level: 'low',
          supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }, { effort: 'xhigh', description: 'Extra' }, { effort: 'ultra', description: 'Most' }],
        },
        { slug: 'gpt-6-internal', display_name: 'Internal', visibility: 'hide' },
        { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'list', supported_reasoning_levels: [{ effort: 'Not A Level' }, 'medium'] },
      ],
    }));
    expect(await adapter('codex').models!()).toEqual([
      { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', efforts: ['low', 'xhigh', 'ultra'], defaultEffort: 'low' },
      { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
    ]);
    writeFileSync(join(home, 'models_cache.json'), '{ not json');
    expect(await adapter('codex').models!()).toEqual([]);
  });

  it("reads the plan's limits from Codex's own server, with no turn, and nothing while signed out", async () => {
    expect(await adapter('codex').limits!()).toEqual({
      status: 'allowed',
      windows: [
        { name: 'five_hour', utilization: 0.12, resetsAt: '2026-10-31T03:00:00.000Z' },
        { name: 'seven_day', utilization: 0.73, resetsAt: '2026-11-04T10:00:00.000Z' },
      ],
      complete: true,
    });
    expect(lastRun().argv).toEqual(['app-server']);
    process.env.FAKE_MODE = 'signed_out';
    expect(await adapter('codex').limits!()).toBeNull();
  });

  it("reads Codex's windows by their length, and a reached limit", () => {
    const weekly = { usedPercent: 73, windowDurationMins: 10080, resetsAt: 1793774136 };
    expect(codexRateLimits({ rateLimits: { primary: weekly, secondary: null, rateLimitReachedType: null } })).toEqual({
      status: 'allowed',
      windows: [{ name: 'seven_day', utilization: 0.73, resetsAt: new Date(1793774136 * 1000).toISOString() }],
      complete: true,
    });
    expect(codexRateLimits({ rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null }, secondary: { usedPercent: 5, windowDurationMins: 1440, resetsAt: null }, rateLimitReachedType: 'primary' } })).toEqual({
      status: 'rejected',
      windows: [
        { name: 'five_hour', utilization: 1, resetsAt: null },
        { name: 'one_day', utilization: 0.05, resetsAt: null },
      ],
      complete: true,
    });
    /* Codex can say the plan takes no ordinary work while no window is full. */
    expect(codexRateLimits({ rateLimits: { primary: weekly, secondary: null, rateLimitReachedType: null }, ordinaryUsageAllowed: false })?.status).toBe('rejected');
    expect(codexRateLimits({ rateLimits: { primary: weekly, secondary: null, rateLimitReachedType: null }, ordinaryUsageAllowed: null })?.status).toBe('allowed');
    expect(codexRateLimits({ rateLimits: { primary: null, secondary: null } })).toBeNull();
    expect(codexRateLimits('nonsense')).toBeNull();
  });

  it("asks Claude's plan limits with no turn, and nothing for a key or a home not signed in", async () => {
    const claude = adapter('claude');
    expect(claude.limits).toBeTypeOf('function');
    expect(await claude.limits!()).toBeNull();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'claude-access', expiresAt: Date.now() - 60_000 } }));
    expect(await claude.limits!()).toBeNull();
    expect(await adapter('anthropic_api', 'sk-ant-api03-key').limits!()).toBeNull();
  });

  it("lists Claude's aliases, and nothing for programs that do not say", async () => {
    expect(await adapter('claude').models!()).toEqual(CLAUDE_ALIASES);
    expect(await adapter('codex').models!()).toEqual([]);
    expect(await adapter('kimi').models!()).toEqual([]);
  });

  it('lists the Kimi models its plan wrote into its settings, by the names Kimi shows', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.toml'),
      [
        'default_model = "kimi-code/kimi-for-coding"',
        '',
        '[providers."managed:kimi-code"]',
        'type = "kimi"',
        '',
        '[models."kimi-code/kimi-for-coding"]',
        'provider = "managed:kimi-code"',
        'model = "kimi-for-coding"',
        'display_name = "K2.8 Preview"',
        'support_efforts = [ "low", "high", "max" ]',
        'default_effort = "max"',
        '',
        '[models."kimi-code/k3.1-pro"]',
        'model = "k3.1-pro"',
        'display_name = "K3.1 Pro"',
        "support_efforts = ['low', 'high']",
        'default_effort = "high"',
        '',
        '[models.local]',
        'model = "local"',
        '',
        '[thinking]',
        'enabled = true',
      ].join('\n'),
    );
    expect(await adapter('kimi').models!()).toEqual([
      { id: 'kimi-code/kimi-for-coding', name: 'K2.8 Preview', efforts: ['low', 'high', 'max'], defaultEffort: 'max' },
      { id: 'kimi-code/k3.1-pro', name: 'K3.1 Pro', efforts: ['low', 'high'], defaultEffort: 'high' },
      { id: 'local', name: 'local' },
    ]);
  });

  it("knows how much its model's context holds, by the alias -m takes or the default one", () => {
    const config = [
      'default_model = "kimi-code/kimi-for-coding"',
      '',
      '[models."kimi-code/kimi-for-coding"]',
      'max_context_size = 1048576',
      '',
      '[models."kimi-code/k3"]',
      'max_context_size = 262144',
      'max_input_size = 200000',
      '',
      '[models.bare]',
      'model = "bare"',
      '',
      '[models."kimi-code/k3.1-pro"]',
      'max_context_size = 1048576',
      '',
      '[models."kimi-code/k3.1-pro".overrides]',
      'max_input_size = 300000',
      '',
      '[models.bare.overrides]',
      'display_name = "Bare"',
    ].join('\n');
    expect(kimiContextSize(config, null)).toBe(1_048_576);
    expect(kimiContextSize(config, 'kimi-code/k3')).toBe(200_000);
    /* A model's own overrides win over what the plan wrote for it. */
    expect(kimiContextSize(config, 'kimi-code/k3.1-pro')).toBe(300_000);
    expect(kimiModels(config).map(m => m.name)).toEqual(['kimi-code/kimi-for-coding', 'kimi-code/k3', 'Bare', 'kimi-code/k3.1-pro']);
    expect(kimiContextSize(config, 'bare')).toBeNull();
    expect(kimiContextSize(config, 'missing')).toBeNull();
  });

  it("asks Kimi's plan limits only with a token that is still fresh", async () => {
    mkdirSync(join(home, 'credentials'), { recursive: true });
    writeFileSync(join(home, 'credentials', 'kimi-code.json'), JSON.stringify({ access_token: 'old', refresh_token: 'r', expires_at: Date.now() / 1000 - 60 }));
    expect(await adapter('kimi').limits!()).toBeNull();
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
    expect(lastRun().env).not.toHaveProperty('KIMI_MODEL_THINKING_EFFORT');
  });

  it("thinks at Kimi's own default when the agent names no effort, whatever the machine's env says", async () => {
    process.env.KIMI_MODEL_THINKING_EFFORT = 'low';
    onTestFinished(() => void delete process.env.KIMI_MODEL_THINKING_EFFORT);
    await adapter('kimi').run(input());
    expect(lastRun().env).not.toHaveProperty('KIMI_MODEL_THINKING_EFFORT');
  });

  it('thinks as hard as the agent was set to, through the setting Kimi reads from its env', async () => {
    await adapter('kimi').run(input({ effort: 'max' }));
    expect(lastRun().env.KIMI_MODEL_THINKING_EFFORT).toBe('max');
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

  it('counts as signed in with a key its node was given, and hides the key', async () => {
    const a = adapter('kimi');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'kimi-key'), 'sk-kimi-0123456789abcdef\n', { mode: 0o600 });
    expect(await a.loggedIn()).toBe(true);
    expect(await a.secrets()).toContain('sk-kimi-0123456789abcdef');
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

describe('Antigravity CLI', () => {
  it('runs a prompt in print mode with every tool allowed in its own home, and goes on in the conversation it named', async () => {
    const a = adapter('antigravity');
    const first = await a.run(input());
    expect(lastRun().argv).toEqual(['--print=say ready', ...AGY_FLAGS]);
    expect(lastRun().env).toMatchObject({ HOME: home, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' });
    expect(first).toMatchObject({ ok: true, sessionId: AGY_NEW, result: expect.stringMatching(/^Git rebase destructively rewrites .* base commit\.$/) });

    const again = await a.run(input({ sessionId: AGY_NEW, model: 'Gemini 4 Argon', effort: 'high' }));
    expect(lastRun().argv).toEqual(['--print=say ready', ...AGY_FLAGS, '--conversation', AGY_NEW, '--model', 'Gemini 4 Argon', '--effort', 'high']);
    expect(again).toMatchObject({ ok: true, sessionId: AGY_RESUMED, result: 'apple' });
  });

  it('reports a failed run as agent_failed with its error, and a signed-out one as not_logged_in', async () => {
    process.env.FAKE_MODE = 'fail';
    const failed = await adapter('antigravity').run(input());
    expect(failed).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(failed.output).toContain('is not recognized as a known model');
    process.env.FAKE_MODE = 'signed_out';
    expect(await adapter('antigravity').run(input())).toMatchObject({ ok: false, error: 'not_logged_in' });
  });

  it('counts as signed in once agy lists its models, and lists them by model with the levels each takes', async () => {
    process.env.FAKE_MODE = 'needs_login';
    const a = adapter('antigravity');
    expect(await a.loggedIn()).toBe(false);
    expect(await a.models!()).toEqual([]);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'fake-signed-in'), '');
    expect(await a.loggedIn()).toBe(true);
    const listed = await a.models!();
    expect(listed[0]).toEqual({ id: 'Gemini 4 Argon', name: 'Gemini 4 Argon', efforts: ['medium', 'high'] });
    /* A sign-in that went away keeps the models agy listed before. */
    rmSync(join(home, 'fake-signed-in'));
    expect(await a.models!()).toEqual(listed);
  });

  it('hides the tokens agy keeps in its files', async () => {
    const a = adapter('antigravity');
    expect(await a.secrets()).toEqual([]);
    mkdirSync(join(home, '.config', 'antigravity'), { recursive: true });
    writeFileSync(join(home, '.config', 'antigravity', 'plugin-secrets.json'), JSON.stringify({ github: { token: 'gho_plugin0123456789abcdef' } }));
    mkdirSync(join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    writeFileSync(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), JSON.stringify({ access_token: 'ya29.access0123456789abcdef', refresh_token: '1//refresh0123456789abcdef' }));
    writeFileSync(join(home, '.gemini', 'antigravity-cli', 'installation_id'), 'b1f3c7de-0000-4000-8000-000000000001');
    expect((await a.secrets()).sort()).toEqual(['1//refresh0123456789abcdef', 'gho_plugin0123456789abcdef', 'ya29.access0123456789abcdef']);
  });

  it('stops at the timeout', async () => {
    process.env.FAKE_MODE = 'hang';
    expect(await adapter('antigravity').run(input({ timeoutMs: 200 }))).toMatchObject({ ok: false, error: 'timeout' });
  });

  it("installs agy the way Google's install script does: the release its manifest names, checked by SHA-512", async () => {
    const release = join(dir, 'release');
    mkdirSync(release);
    writeFileSync(join(release, 'antigravity'), '#!/bin/sh\necho agy 1.4.12\n');
    execFileSync('tar', ['-czf', join(dir, 'cli.tar.gz'), '-C', release, 'antigravity']);
    const archive = readFileSync(join(dir, 'cli.tar.gz'));
    let sha512 = createHash('sha512').update(archive).digest('hex');
    const asked: string[] = [];
    const server = createServer((req, res) => {
      asked.push(req.url!);
      if (req.url === '/manifests/linux_arm64.json') return void res.end(JSON.stringify({ version: '1.4.12', url: `${base}/1.4.12-1/linux-arm/cli_linux_arm64.tar.gz`, sha512 }));
      if (req.url === '/1.4.12-1/linux-arm/cli_linux_arm64.tar.gz') return void res.end(archive);
      res.writeHead(404).end();
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    onTestFinished(() => void server.close());

    await installAgy(tools, base, 'linux_arm64');
    expect(asked).toEqual(['/manifests/linux_arm64.json', '/1.4.12-1/linux-arm/cli_linux_arm64.tar.gz']);
    expect(execFileSync(join(tools, 'bin', 'agy'), { encoding: 'utf8' })).toBe('agy 1.4.12\n');
    expect(statSync(join(tools, 'bin', 'agy')).mode & 0o755).toBe(0o755);

    rmSync(join(tools, 'bin', 'agy'));
    sha512 = '0'.repeat(128);
    await expect(installAgy(tools, base, 'linux_arm64')).rejects.toThrow(/does not match/);
    expect(existsSync(join(tools, 'bin', 'agy'))).toBe(false);
  });
});

describe('calling a job off', () => {
  it.each(['claude', 'codex', 'kimi', 'antigravity'] as const)('stops the whole process group of %s', async provider => {
    process.env.FAKE_MODE = 'hang';
    const stop = new AbortController();
    const run = adapter(provider).run(input({ timeoutMs: 15000, signal: stop.signal }));
    const child = await hangingChild();
    const started = Date.now();
    stop.abort();
    await run;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(alive(child)).toBe(false);
  });
});

const TOOLS = { url: 'http://hub.example.test/mcp', token: 'tool-token-0123456789abcdef' };
const INSTRUCTIONS = 'You are the orchestrator of Acme.';

function withTools(provider: ProviderId) {
  process.env.FAKE_MODE = 'tools';
  const events: AgentEvent[] = [];
  return { events, run: (over: Partial<RunInput> = {}) => adapter(provider).run(input({ instructions: INSTRUCTIONS, tools: TOOLS, onEvent: e => events.push(e), ...over })) };
}

describe('Hornhoof tools and instructions', () => {
  it.each([null, CLAUDE_SESSION])('give Claude Code the plugins the node has, for the run only (session %s)', async sessionId => {
    const sp = join(dir, 'superpowers');
    mkdirSync(sp);
    await adapterFor('claude', { home, tools, bin: join(FAKES, FAKE_BIN.claude), plugins: [sp] }).run(input({ sessionId }));
    const { argv } = lastRun();
    expect(argv[argv.indexOf('--plugin-dir') + 1]).toBe(sp);
    expect(argv.indexOf('--plugin-dir')).toBeLessThan(argv.indexOf('--'));
  });

  it('give Claude Code the instructions in a file of its folder, as one argument may hold only 128 KiB on Linux', async () => {
    await adapter('claude').run(input({ instructions: 'x'.repeat(MAX_INSTRUCTIONS) }));
    const { argv } = lastRun();
    const file = argv[argv.indexOf('--append-system-prompt-file') + 1]!;
    expect(file).toBe(join(work, '.hh-instructions.md'));
    expect(readFileSync(file, 'utf8')).toBe(`${'x'.repeat(MAX_INSTRUCTIONS)}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(argv).not.toContain('--append-system-prompt');
    expect(Math.max(...argv.map(a => a.length))).toBeLessThan(1000);
  });

  it('give Claude Code the instructions and a private MCP config it deletes after the run', async () => {
    const { events, run } = withTools('claude');
    await run();
    const { argv, mcpConfig } = lastRun();
    expect(argv).toEqual(expect.arrayContaining(['--append-system-prompt-file', join(work, '.hh-instructions.md'), '--mcp-config', mcpConfig!.path, '--strict-mcp-config']));
    expect(argv.indexOf('--')).toBe(argv.length - 2);
    expect(argv.join(' ')).not.toContain(TOOLS.token);
    expect(mcpConfig!.json).toEqual({ mcpServers: { hornhoof: { type: 'http', url: TOOLS.url, headers: { Authorization: `Bearer ${TOOLS.token}` } } } });
    expect(mcpConfig!.mode & 0o777).toBe(0o600);
    expect(existsSync(mcpConfig!.path)).toBe(false);
    expect(events).toContainEqual({ kind: 'tool', name: 'hornhoof.ping', input: '{"note":"hi"}' });
  });

  it('give Codex AGENTS.md and the server by config, with the token only in its env', async () => {
    const { events, run } = withTools('codex');
    await run();
    const { argv, env, agentsMd } = lastRun();
    expect(agentsMd).toBe(INSTRUCTIONS + '\n');
    expect(argv).toEqual(['exec', '-c', `mcp_servers.hornhoof.url="${TOOLS.url}"`, '-c', 'mcp_servers.hornhoof.bearer_token_env_var="HH_TOOL_TOKEN"', ...FLAGS, '-C', work, '--', 'say ready']);
    expect(env.HH_TOOL_TOKEN).toBe(TOOLS.token);
    expect(events).toContainEqual({ kind: 'tool', name: 'hornhoof.ping', input: '{"note":"hi"}' });

    await run({ sessionId: CODEX_THREAD });
    expect(lastRun().argv.slice(0, 6)).toEqual(['exec', 'resume', '-c', `mcp_servers.hornhoof.url="${TOOLS.url}"`, '-c', 'mcp_servers.hornhoof.bearer_token_env_var="HH_TOOL_TOKEN"']);
  });

  it('give Kimi Code AGENTS.md and an mcp.json in its home that names the env variable, not the token', async () => {
    const { events, run } = withTools('kimi');
    await run();
    const { env, agentsMd, kimiMcp } = lastRun();
    expect(agentsMd).toBe(INSTRUCTIONS + '\n');
    expect(kimiMcp).toEqual({ mcpServers: { hornhoof: { transport: 'http', url: TOOLS.url, bearerTokenEnvVar: 'HH_TOOL_TOKEN' } } });
    expect(env.HH_TOOL_TOKEN).toBe(TOOLS.token);
    expect(events).toContainEqual({ kind: 'tool', name: 'hornhoof.ping', input: '{"note":"hi"}' });
  });

  it("give Antigravity AGENTS.md and the server with the turn's token in its folder's MCP settings, removed after the run", async () => {
    const { events, run } = withTools('antigravity');
    const res = await run();
    const { argv, agentsMd, agyMcp } = lastRun();
    expect(res.ok).toBe(true);
    expect(agentsMd).toBe(INSTRUCTIONS + '\n');
    expect(argv.join(' ')).not.toContain(TOOLS.token);
    expect(agyMcp!.json).toEqual({ mcpServers: { hornhoof: { serverUrl: TOOLS.url, headers: { Authorization: `Bearer ${TOOLS.token}` } } } });
    expect(agyMcp!.mode & 0o777).toBe(0o600);
    expect(existsSync(join(work, '.agents', 'mcp_config.json'))).toBe(false);
    expect(events).toContainEqual({ kind: 'tool', name: 'run_command', input: 'echo hello_headless_demo' });
  });

  it('give Antigravity the start of instructions it would cut, in whole lines, and the whole text in a file only its user reads', async () => {
    /* Fewer letters than agy's 24,000 bytes, two bytes each, as agy counts bytes. */
    const long = Array.from({ length: 300 }, (_, i) => `${i} ${'я'.repeat(60)}`).join('\n');
    await adapter('antigravity').run(input({ instructions: long }));
    const file = join(work, '.hh-instructions.md');
    expect(readFileSync(file, 'utf8')).toBe(long + '\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const { agentsMd } = lastRun();
    expect(Buffer.byteLength(agentsMd!)).toBeLessThan(23_000);
    const [start, pointer, ...rest] = agentsMd!.split('\n\n');
    expect(rest).toEqual([]);
    expect(start!.length).toBeGreaterThan(0);
    expect(long.startsWith(`${start}\n`)).toBe(true);
    expect(pointer).toContain(file);
  });

  it.each(['codex', 'kimi', 'antigravity'] as const)('never follow a link the %s agent left where its files go', async provider => {
    const { run } = withTools(provider);
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'keep me');
    mkdirSync(home, { recursive: true });
    symlinkSync(outside, join(work, 'AGENTS.md'));
    if (provider === 'kimi') symlinkSync(outside, join(home, 'mcp.json'));
    await run();
    expect(readFileSync(outside, 'utf8')).toBe('keep me');
    expect(lstatSync(join(work, 'AGENTS.md')).isSymbolicLink()).toBe(false);
    expect(lastRun().agentsMd).toBe(INSTRUCTIONS + '\n');
    if (provider === 'kimi') expect(lastRun().kimiMcp).toMatchObject({ mcpServers: { hornhoof: { url: TOOLS.url } } });
  });

  it('run as the job user with the key folder as HOME, the MCP config handed to that user', async () => {
    process.env.FAKE_MODE = 'tools';
    const user = { uid: process.getuid!(), gid: process.getgid!() };
    const res = await adapterFor('anthropic_api', { home, tools, bin: join(FAKES, 'claude'), secret: 'company-key-0123456789', user }).run(input({ tools: TOOLS }));
    expect(res.ok).toBe(true);
    expect(lastRun().env.HOME).toBe(home);
    expect(lastRun().mcpConfig!.json).toMatchObject({ mcpServers: { hornhoof: { url: TOOLS.url } } });
  });

  it('leave the Hornhoof server out of a run without tools', async () => {
    process.env.FAKE_MODE = 'tools';
    await adapter('kimi').run(input({ tools: TOOLS }));
    await adapter('kimi').run(input());
    expect(lastRun().kimiMcp).toBeUndefined();
    expect(lastRun().env).not.toHaveProperty('HH_TOOL_TOKEN');
  });
});

const linesOf = (file: string): unknown[] => readFileSync(new URL(`./fixtures/${file}.jsonl`, import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l));

describe("the turn's repository", () => {
  it('reaches every program as git access in its environment', async () => {
    const env = { GIT_ASKPASS: '/app/git-askpass', HH_GIT_PASSWORD: 'ghp_repo1234', GIT_TERMINAL_PROMPT: '0' };
    for (const provider of ['claude', 'codex', 'kimi', 'antigravity'] as const) {
      await adapter(provider).run(input({ env }));
      expect(lastRun().env).toMatchObject(env);
    }
  });
});

describe('live events', () => {
  it('read the tool call, its result and the answer from Claude Code', () => {
    expect(linesOf('claude-tools').flatMap(claudeEvents)).toEqual([
      { kind: 'tool', name: 'hornhoof.ping', input: '{"note":"hi"}' },
      { kind: 'tool_result', ok: true, summary: 'pong hi' },
      { kind: 'text', text: expect.stringContaining('returned "pong hi"') },
    ]);
  });

  it('read Codex messages, its MCP call and a shell command', () => {
    expect(linesOf('codex-tools').flatMap(codexEvents)).toEqual([
      { kind: 'text', text: expect.stringContaining('ping tool') },
      { kind: 'text', text: expect.stringContaining('plan tool') },
      { kind: 'tool', name: 'hornhoof.ping', input: '{"note":"hi"}' },
      { kind: 'tool_result', ok: true, summary: 'pong hi' },
      { kind: 'text', text: expect.stringContaining('HERON') },
      { kind: 'tool', name: 'shell', input: "/bin/bash -lc 'echo start'" },
      { kind: 'tool_result', ok: true, summary: 'start' },
    ]);
  });

  it('read Kimi Code assistant lines with tool calls and the tool lines', () => {
    expect(linesOf('kimi-tools').flatMap(kimiEvents)).toEqual([
      { kind: 'text', text: 'Pinging the server.' },
      { kind: 'tool', name: 'hornhoof.ping', input: '{"note":"hi"}' },
      { kind: 'tool_result', ok: true, summary: 'pong hi' },
      { kind: 'text', text: 'HERON' },
    ]);
  });

  it("read Antigravity's reply from its parts once its step is done, and its tool steps", () => {
    const read = agyStream();
    expect(linesOf('agy-resume').flatMap(read)).toEqual([{ kind: 'text', text: 'apple\n' }]);
    expect(linesOf('agy-tools').flatMap(agyStream())).toEqual([
      { kind: 'tool', name: 'run_command', input: 'echo hello_headless_demo' },
      { kind: 'tool_result', ok: true, summary: 'hello_headless_demo' },
    ]);
    /* A failed tool carries an error with its type and message instead of output. */
    const [step] = linesOf('agy-tools') as { step_update: { tool_info: Record<string, unknown> } }[];
    step!.step_update.tool_info = { name: 'run_command', parameters: { CommandLine: 'false' }, error: { type: 'EXIT_CODE', message: 'exit status 1' } };
    expect(agyStream()(step)).toEqual([
      { kind: 'tool', name: 'run_command', input: 'false' },
      { kind: 'tool_result', ok: false, summary: 'exit status 1' },
    ]);
  });

  it('keep the names of built-in tools and show a shell command as it is', () => {
    const use = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la', description: 'List' } }] } };
    expect(claudeEvents(use)).toEqual([{ kind: 'tool', name: 'Bash', input: 'ls -la' }]);
    const failed = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Exit code 137', is_error: true }] } };
    expect(claudeEvents(failed)).toEqual([{ kind: 'tool_result', ok: false, summary: 'Exit code 137' }]);
  });

  it('turn a TodoWrite call and a Codex todo list into a plan', () => {
    const todos = [{ content: 'Ask about products', status: 'completed' }, { content: 'Propose', status: 'in_progress' }, { content: 'Build', status: 'pending' }];
    expect(claudeEvents({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos } }] } })).toEqual([
      { kind: 'todo', items: [{ text: 'Ask about products', state: 'done' }, { text: 'Propose', state: 'doing' }, { text: 'Build', state: 'todo' }] },
    ]);
    expect(codexEvents({ type: 'item.updated', item: { id: 'i1', type: 'todo_list', items: [{ text: 'Ask', completed: true }, { text: 'Propose', completed: false }] } })).toEqual([
      { kind: 'todo', items: [{ text: 'Ask', state: 'done' }, { text: 'Propose', state: 'todo' }] },
    ]);
  });

  it('tell when a person stopped a Claude Code turn with Escape', () => {
    expect(claudeInterrupted({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })).toBe(true);
    expect(claudeInterrupted({ type: 'user', message: { role: 'user', content: '[Request interrupted by user for tool use]' } })).toBe(true);
    expect(claudeInterrupted({ type: 'user', message: { role: 'user', content: 'Please say [Request interrupted by user]' } })).toBe(false);
    expect(claudeInterrupted({ type: 'assistant', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } })).toBe(false);
  });

  it('give nothing for lines they do not show', () => {
    for (const line of [null, 'x', 42, { type: 'system', subtype: 'init' }, { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hm' }] } }]) expect(claudeEvents(line)).toEqual([]);
    for (const line of [null, { type: 'turn.started' }, { type: 'item.completed', item: { type: 'reasoning', text: 'hm' } }]) expect(codexEvents(line)).toEqual([]);
    for (const line of [null, { role: 'meta', type: 'system.version' }, { role: 'assistant', content: '' }]) expect(kimiEvents(line)).toEqual([]);
    for (const line of [null, ...linesOf('agy-new').slice(0, 2), linesOf('agy-new')[3], linesOf('agy-resume')[2]]) expect(agyStream()(line)).toEqual([]);
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

  it("keeps the node's own NODE_ENV from the child env, so npm ci and tests in a repository run as on a laptop", () => {
    const own = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    onTestFinished(() => void (process.env.NODE_ENV = own));
    expect(childEnv(tools, {})).not.toHaveProperty('NODE_ENV');
    expect(childEnv(tools, { NODE_ENV: 'development' }).NODE_ENV).toBe('development');
  });

  it('finds the last link behind colors and terminal hyperlinks', () => {
    expect(lastUrl('\x1b[1mfirst https://a.example.test/x\x1b[0m then \x1b]8;;https://b.example.test/y\x1b\\here\x1b]8;;\x1b\\')).toBe('https://b.example.test/y');
    expect(lastUrl('no link')).toBeNull();
  });
});
