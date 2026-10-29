import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderAdapter, RunInput, RunResult } from '../runner.js';
import { childEnv, ensureDir, installPackage, interactiveLogin, runProgram, tokensIn } from './process.js';

type Options = { home: string; tools: string; bin?: string };

const SIGNED_OUT = /no model configured|\/login|not logged in/i;

const files = (dir: string) => {
  try {
    return readdirSync(dir).map(f => join(dir, f));
  } catch {
    return [];
  }
};

type KimiEvent = { role?: string; type?: string; content?: unknown; session_id?: string; sessionId?: string };

/* Kimi's stream-json is not verified against a signed-in run yet: the parser takes the last assistant text and any session id it sees. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => (c && typeof c === 'object' && 'text' in c ? String(c.text) : '')).join('');
  return '';
}

export function kimiAdapter({ home, tools, bin = join(tools, 'bin', 'kimi') }: Options): ProviderAdapter {
  const env = () => childEnv(tools, { KIMI_CODE_HOME: ensureDir(home) });
  const credentials = () => files(join(home, 'credentials'));

  return {
    async install() {
      await installPackage(tools, '@moonshot-ai/kimi-code');
    },

    async loggedIn() {
      return credentials().length > 0;
    },

    async login(io) {
      await interactiveLogin(bin, ['login'], env(), io);
    },

    async run(input: RunInput): Promise<RunResult> {
      const args = [`--prompt=${input.prompt}`, '--output-format', 'stream-json'];
      if (input.sessionId) args.push('--session', input.sessionId);
      if (input.model) args.push('-m', input.model);

      let sessionId: string | null = input.sessionId;
      let answer = '';
      const done = await runProgram({
        bin,
        args,
        env: env(),
        cwd: input.workDir,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        onLine(line) {
          let ev: KimiEvent;
          try {
            ev = JSON.parse(line);
          } catch {
            return;
          }
          const id = ev.session_id ?? ev.sessionId;
          if (typeof id === 'string') sessionId = id;
          if (ev.role === 'assistant') answer = textOf(ev.content) || answer;
        },
      });

      if (done.timedOut) return { ok: false, sessionId, result: '', output: done.output, error: 'timeout', limits: null };
      if (done.code === 0 && answer) return { ok: true, sessionId, result: answer, output: done.output, error: null, limits: null };
      return { ok: false, sessionId, result: answer, output: done.output, error: SIGNED_OUT.test(done.output) ? 'not_logged_in' : 'agent_failed', limits: null };
    },

    async secrets() {
      return credentials().flatMap(tokensIn);
    },
  };
}
