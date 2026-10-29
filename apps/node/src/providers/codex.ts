import { join } from 'node:path';
import type { ProviderAdapter, RunInput, RunResult } from '../runner.js';
import { childEnv, ensureDir, exitsCleanly, installPackage, interactiveLogin, runProgram, tokensIn } from './process.js';

/* Codex serves a ChatGPT plan, or a company OpenAI key on the built-in node. */
type Options = { home: string; tools: string; bin?: string; secret?: string | null; mode: 'plan' | 'api_key' };

/* The container is the sandbox, so Codex's own approvals and sandbox are off; resume takes no -C or -s. */
const FLAGS = ['--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
const SIGNED_OUT = /401 Unauthorized|Missing bearer|invalid_api_key|not logged in/i;

export function codexAdapter({ home, tools, bin = join(tools, 'bin', 'codex'), secret = null, mode }: Options): ProviderAdapter {
  function env(jobSecret: string | null): NodeJS.ProcessEnv {
    const extra: Record<string, string> = { CODEX_HOME: ensureDir(home) };
    if (mode === 'api_key') extra.CODEX_API_KEY = jobSecret ?? secret ?? '';
    return childEnv(tools, extra);
  }

  return {
    async install() {
      await installPackage(tools, '@openai/codex');
    },

    async loggedIn() {
      if (mode === 'api_key') return true;
      return exitsCleanly(bin, ['login', 'status'], env(null));
    },

    async login(io) {
      if (mode === 'api_key') return;
      io.output.write('Codex signs in with a device code. If ChatGPT refuses the code, turn on device code sign-in in ChatGPT: Settings, Security.\n');
      await interactiveLogin(bin, ['login', '--device-auth'], env(null), io);
    },

    async run(input: RunInput): Promise<RunResult> {
      const model = input.model ? ['-m', input.model] : [];
      const args = input.sessionId
        ? ['exec', 'resume', ...FLAGS, ...model, '--', input.sessionId, input.prompt]
        : ['exec', ...FLAGS, '-C', input.workDir, ...model, '--', input.prompt];

      let sessionId: string | null = input.sessionId;
      let answer = '';
      let completed = false;
      let failure = '';
      const done = await runProgram({
        bin,
        args,
        env: env(input.secret),
        cwd: input.workDir,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        onLine(line) {
          let ev: { type?: string; thread_id?: string; item?: { type?: string; text?: string }; error?: { message?: string }; message?: string };
          try {
            ev = JSON.parse(line);
          } catch {
            return;
          }
          if (ev.type === 'thread.started' && ev.thread_id) sessionId = ev.thread_id;
          if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') answer = ev.item.text ?? '';
          if (ev.type === 'turn.completed') completed = true;
          if (ev.type === 'turn.failed') failure = ev.error?.message ?? 'The turn failed.';
          if (ev.type === 'error' && ev.message) failure = ev.message;
        },
      });

      if (done.timedOut) return { ok: false, sessionId, result: '', output: done.output, error: 'timeout', limits: null };
      if (completed && done.code === 0) return { ok: true, sessionId, result: answer, output: done.output, error: null, limits: null };
      const error = SIGNED_OUT.test(failure || done.output) ? 'not_logged_in' : 'agent_failed';
      return { ok: false, sessionId, result: answer, output: done.output, error, limits: null };
    },

    async secrets() {
      if (mode === 'api_key') return secret ? [secret] : [];
      return tokensIn(join(home, 'auth.json'));
    },
  };
}
