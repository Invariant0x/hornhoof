import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Limits } from '@hornhoof/protocol';
import type { ProviderAdapter, RunInput, RunResult } from '../runner.js';
import { askHidden, childEnv, ensureDir, exitsCleanly, installPackage, interactiveLogin, runProgram, tokensIn } from './process.js';

/* Claude Code serves three kinds of subscription: a personal plan, a company Anthropic key, and a GLM Coding Plan through Z.ai's Anthropic-compatible endpoint. */
export type ClaudeMode = 'plan' | 'api_key' | 'glm';

type Options = { home: string; tools: string; bin?: string; secret?: string | null; mode: ClaudeMode };

const GLM_ENV = {
  ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
  API_TIMEOUT_MS: '3000000',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.3[1m]',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.3[1m]',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash[1m]',
};

type RateInfo = {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
};

const iso = (epochSeconds?: number) => (typeof epochSeconds === 'number' ? new Date(epochSeconds * 1000).toISOString() : null);

export function limitsFrom(info: RateInfo): Limits {
  const status = info.status === 'rejected' ? 'rejected' : info.status === 'allowed_warning' ? 'warning' : 'allowed';
  const windows = Object.entries(info.unifiedWindows ?? {}).map(([name, w]) => ({
    name,
    utilization: typeof w.utilization === 'number' ? Math.min(1, Math.max(0, w.utilization)) : null,
    resetsAt: iso(w.resetsAt),
  }));
  if (!windows.length && info.rateLimitType) windows.push({ name: info.rateLimitType, utilization: null, resetsAt: iso(info.resetsAt) });
  return { status, windows: windows.slice(0, 8) };
}

type Outcome = { text: string; isError: boolean; sessionId: string | null };

const SIGNED_OUT = /not logged in|please run \/login|invalid api key|authentication/i;

export function claudeAdapter({ home, tools, bin = join(tools, 'bin', 'claude'), secret = null, mode }: Options): ProviderAdapter {
  const keyFile = join(home, 'glm-key');
  const glmKey = () => (existsSync(keyFile) ? readFileSync(keyFile, 'utf8').trim() : '');

  function env(jobSecret: string | null): NodeJS.ProcessEnv {
    const extra: Record<string, string> = { CLAUDE_CONFIG_DIR: ensureDir(home) };
    if (mode === 'api_key') extra.ANTHROPIC_API_KEY = jobSecret ?? secret ?? '';
    if (mode === 'glm') Object.assign(extra, GLM_ENV, { ANTHROPIC_AUTH_TOKEN: glmKey() });
    return childEnv(tools, extra);
  }

  return {
    async install() {
      await installPackage(tools, '@anthropic-ai/claude-code');
    },

    async loggedIn() {
      if (mode === 'api_key') return true;
      if (mode === 'glm') return glmKey().length > 0;
      return exitsCleanly(bin, ['auth', 'status'], env(null));
    },

    async login(io) {
      if (mode === 'api_key') return;
      if (mode === 'glm') {
        io.output.write('Paste your GLM Coding Plan key from z.ai (not a general API key).\n');
        const key = await askHidden(io, 'GLM key: ');
        if (!key) throw new Error('No key was entered.');
        ensureDir(home);
        writeFileSync(keyFile, key + '\n', { mode: 0o600 });
        return;
      }
      await interactiveLogin(bin, ['auth', 'login'], env(null), io);
    },

    async run(input: RunInput): Promise<RunResult> {
      const session = input.sessionId ? ['--resume', input.sessionId] : ['--session-id', randomUUID()];
      const args = ['-p', '--output-format', 'stream-json', '--verbose', ...session, '--permission-mode', 'bypassPermissions'];
      if (input.model) args.push('--model', input.model);
      args.push('--', input.prompt);

      let result: Outcome | null = null;
      let sessionId: string | null = input.sessionId;
      let limits: Limits | null = null;
      let signedOut = false;
      const done = await runProgram({
        bin,
        args,
        env: env(input.secret),
        cwd: input.workDir,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        onLine(line) {
          let ev: Record<string, unknown>;
          try {
            ev = JSON.parse(line);
          } catch {
            return;
          }
          if (typeof ev.session_id === 'string') sessionId = ev.session_id;
          if (ev.type === 'assistant' && ev.error === 'authentication_failed') signedOut = true;
          if (ev.type === 'rate_limit_event' && ev.rate_limit_info) limits = limitsFrom(ev.rate_limit_info as RateInfo);
          if (ev.type === 'result') result = { text: String(ev.result ?? ''), isError: ev.is_error === true, sessionId };
        },
      });

      /* Assigned in onLine, which TypeScript does not follow. */
      const final = result as Outcome | null;
      if (done.timedOut) return { ok: false, sessionId, result: '', output: done.output, error: 'timeout', limits };
      if (final && !final.isError && done.code === 0) return { ok: true, sessionId, result: final.text, output: done.output, error: null, limits };
      const out = signedOut || SIGNED_OUT.test(final?.text ?? '');
      /* A GLM key Z.ai rejects is dropped, so the status says signed out and the next sign-in asks for a new key. */
      if (out && mode === 'glm') rmSync(keyFile, { force: true });
      return { ok: false, sessionId, result: final?.text ?? '', output: done.output, error: out ? 'not_logged_in' : 'agent_failed', limits };
    },

    async secrets() {
      if (mode === 'api_key') return secret ? [secret] : [];
      if (mode === 'glm') return [glmKey()].filter(Boolean);
      return tokensIn(join(home, '.credentials.json'));
    },
  };
}
