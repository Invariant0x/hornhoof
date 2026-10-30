import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { API_MODELS, type AgentEvent, type ModelOption } from '@hornhoof/protocol';
import type { JobUser } from '../isolation.js';
import type { ProviderAdapter, RunInput, RunResult } from '../runner.js';
import { contentText, inputText, isRecord } from './events.js';
import { childEnv, ensureDir, exitsCleanly, installPackage, interactiveLogin, runProgram, tokensIn, writePrivate } from './process.js';

/* Codex serves a ChatGPT plan, or a company OpenAI key on the built-in node. */
type Options = { home: string; tools: string; bin?: string; secret?: string | null; mode: 'plan' | 'api_key'; user?: JobUser | null };

/* The container is the sandbox, so Codex's own approvals and sandbox are off; resume takes no -C or -s. */
const FLAGS = ['--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox'];
export const SIGNED_OUT = /401 Unauthorized|Missing bearer|invalid_api_key|not logged in/i;

/* What a --json line shows people: messages, MCP calls, shell commands with their results, and the plan. */
export function codexEvents(line: unknown): AgentEvent[] {
  if (!isRecord(line) || !isRecord(line.item)) return [];
  const item = line.item;
  const started = line.type === 'item.started';
  const completed = line.type === 'item.completed';
  if (item.type === 'agent_message' && completed && typeof item.text === 'string' && item.text.trim()) return [{ kind: 'text', text: item.text }];
  if (item.type === 'mcp_tool_call') {
    if (started) return [{ kind: 'tool', name: `${String(item.server)}.${String(item.tool)}`, input: inputText(item.arguments) }];
    if (completed) {
      const error = isRecord(item.error) ? String(item.error.message ?? 'failed') : '';
      return [{ kind: 'tool_result', ok: item.status === 'completed' && !error, summary: error || contentText(isRecord(item.result) ? item.result.content : null) }];
    }
  }
  if (item.type === 'command_execution') {
    if (started) return [{ kind: 'tool', name: 'shell', input: String(item.command ?? '') }];
    if (completed) return [{ kind: 'tool_result', ok: item.exit_code === 0, summary: String(item.aggregated_output ?? '').trim() }];
  }
  if (item.type === 'todo_list' && Array.isArray(item.items)) {
    return [{ kind: 'todo', items: item.items.filter(isRecord).map(i => ({ text: String(i.text ?? ''), state: i.completed === true ? ('done' as const) : ('todo' as const) })) }];
  }
  return [];
}

type CachedModel = { slug?: unknown; display_name?: unknown; visibility?: unknown };

function cachedModels(file: string): ModelOption[] {
  try {
    const { models } = JSON.parse(readFileSync(file, 'utf8')) as { models?: CachedModel[] };
    return (models ?? [])
      .filter((m): m is { slug: string; display_name: string } => m.visibility === 'list' && typeof m.slug === 'string' && typeof m.display_name === 'string')
      .map(m => ({ id: m.slug.slice(0, 80), name: m.display_name.slice(0, 80) }))
      .slice(0, 60);
  } catch {
    return [];
  }
}

export function codexAdapter({ home, tools, bin = join(tools, 'bin', 'codex'), secret = null, mode, user = null }: Options): ProviderAdapter {
  function env(jobSecret: string | null, toolToken: string | null = null): NodeJS.ProcessEnv {
    const extra: Record<string, string> = { CODEX_HOME: ensureDir(home) };
    /* A job user cannot write the node's own HOME, so its home is the key's folder. */
    if (user) extra.HOME = home;
    if (mode === 'api_key') extra.CODEX_API_KEY = jobSecret ?? secret ?? '';
    if (toolToken) extra.HH_TOOL_TOKEN = toolToken;
    return childEnv(tools, extra);
  }

  return {
    async install() {
      await installPackage(tools, '@openai/codex');
    },

    /* Codex keeps the models a plan offers in its home; the ones its picker shows are visibility "list". */
    async models() {
      if (mode === 'api_key') return API_MODELS.openai_api;
      return cachedModels(join(home, 'models_cache.json'));
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
      /* Codex reads the token from the env variable the config names, so it never shows in the process list. */
      const mcp = input.tools ? ['-c', `mcp_servers.hornhoof.url=${JSON.stringify(input.tools.url)}`, '-c', 'mcp_servers.hornhoof.bearer_token_env_var="HH_TOOL_TOKEN"'] : [];
      if (input.instructions) writePrivate(join(input.workDir, 'AGENTS.md'), input.instructions + '\n', user);
      const args = input.sessionId
        ? ['exec', 'resume', ...mcp, ...FLAGS, ...model, '--', input.sessionId, input.prompt]
        : ['exec', ...mcp, ...FLAGS, '-C', input.workDir, ...model, '--', input.prompt];

      let sessionId: string | null = input.sessionId;
      let answer = '';
      let completed = false;
      let failure = '';
      const done = await runProgram({
        bin,
        args,
        env: { ...env(input.secret, input.tools?.token ?? null), ...input.env },
        cwd: input.workDir,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        user,
        onLine(line) {
          let ev: { type?: string; thread_id?: string; item?: { type?: string; text?: string }; error?: { message?: string }; message?: string };
          try {
            ev = JSON.parse(line);
          } catch {
            return;
          }
          for (const event of codexEvents(ev)) input.onEvent?.(event);
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
