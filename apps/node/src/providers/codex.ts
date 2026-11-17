import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { API_MODELS, type AgentEvent, type ApiEndpoint, type Limits, type ModelOption, type TurnTokens } from '@hornhoof/protocol';
import { readAccount } from '../account.js';
import type { JobUser } from '../isolation.js';
import { toldPlace } from '../program-folder.js';
import type { ProviderAdapter, RunInput, RunResult } from '../runner.js';
import { withProgramExit } from '../program-exit.js';
import { contentText, inputText, isoFrom, isRecord, objectLine } from './events.js';
import { childEnv, ensureDir, exitsCleanly, installPackage, interactiveLogin, runProgram, tokensIn, withEfforts, writePrivate } from './process.js';
import { CODEX_NO_AUTO_UPDATE } from './session-updates.js';
import { addTokens, openaiTokens } from '../turn-tokens.js';
import { NPM_PACKAGES } from './packages.js';

/* Codex serves a ChatGPT plan, or a company OpenAI key on the built-in node, or a key of an API by the token at an address
   in OpenAI's protocol. */
type Options = { home: string; tools: string; bin?: string; secret?: string | null; mode: 'plan' | 'api_key'; user?: JobUser | null; api?: ApiEndpoint | null };

/* Codex at an address of OpenAI's protocol, as a provider of its own: it reads the key from the env variable it names,
   never from the command line, and talks the Responses API, which Codex runs on. */
const ENDPOINT_KEY = 'HH_API_KEY';
function endpointArgs(api: ApiEndpoint): string[] {
  const set = (key: string, value: string) => ['-c', `model_providers.hornhoof.${key}=${JSON.stringify(value)}`];
  return ['-c', 'model_provider="hornhoof"', ...set('name', 'API'), ...set('base_url', api.baseUrl), ...set('env_key', ENDPOINT_KEY), ...set('wire_api', 'responses')];
}

/* Codex reads AGENTS.md only up to project_doc_max_bytes, 32 KiB unless set. A mebibyte holds the longest instructions
   at four bytes a character, and the conversation from before that a live session's AGENTS.md carries too. */
export const WHOLE_AGENTS_MD = ['-c', `project_doc_max_bytes=${1 << 20}`];

/* The container is the sandbox, so Codex's own approvals and sandbox are off; resume takes no -C or -s. */
const FLAGS = ['--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', ...WHOLE_AGENTS_MD, ...CODEX_NO_AUTO_UPDATE];
export const SIGNED_OUT = /401 Unauthorized|Missing bearer|invalid_api_key|not logged in|(?:^|\n)\s*unauthorized:/i;

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

/* Codex names its windows by their length in minutes. */
const WINDOW_NAMES: Record<number, string> = { 300: 'five_hour', 1440: 'one_day', 10080: 'seven_day' };
const LIMITS_WAIT_MS = 15_000;

/* The plan's limits as Codex's app server reads them: up to two windows, the used share and when each starts over. */
export function codexRateLimits(result: unknown): Limits | null {
  const rate = isRecord(result) && isRecord(result.rateLimits) ? result.rateLimits : null;
  if (!rate) return null;
  const windows = [rate.primary, rate.secondary].filter(isRecord).flatMap(w => {
    const used = Number(w.usedPercent);
    const mins = Number(w.windowDurationMins);
    if (!Number.isFinite(used) || !Number.isFinite(mins)) return [];
    const reset = isoFrom(w.resetsAt);
    return [{ name: WINDOW_NAMES[mins] ?? `${mins}_minutes`, utilization: Math.min(1, Math.max(0, used / 100)), resetsAt: reset }];
  });
  if (!windows.length) return null;
  /* Codex can also say the plan takes no ordinary work at all now, while no window is full. */
  const blocked = rate.rateLimitReachedType || (isRecord(result) && result.ordinaryUsageAllowed === false);
  return { status: blocked ? 'rejected' : 'allowed', windows, complete: true };
}

/* Asks Codex's app server for the plan's limits over JSON-RPC. It keeps its own sign-in fresh, so no turn is needed. */
function askLimits(bin: string, env: NodeJS.ProcessEnv, user: JobUser | null): Promise<Limits | null> {
  return new Promise(resolve => {
    /* Codex writes its state into its home as it starts, as the agents' user who run it. */
    let child: ChildProcessByStdio<Writable, Readable, null>;
    try {
      child = spawn(bin, ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'], uid: user?.uid, gid: user?.gid });
    } catch {
      return resolve(null);
    }
    let buf = '';
    const done = (limits: Limits | null) => {
      clearTimeout(timer);
      child.kill();
      resolve(limits);
    };
    const timer = setTimeout(() => done(null), LIMITS_WAIT_MS);
    const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + '\n');
    child.on('error', () => done(null));
    child.on('exit', () => done(null));
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m: unknown;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRecord(m)) continue;
        if (m.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (m.id === 2) done(codexRateLimits(m.result));
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'hornhoof', title: 'Hornhoof', version: '1' } } });
  });
}

type CachedModel = { slug?: unknown; display_name?: unknown; visibility?: unknown; supported_reasoning_levels?: unknown; default_reasoning_level?: unknown };

function cachedModels(file: string): ModelOption[] {
  try {
    const { models } = JSON.parse(readFileSync(file, 'utf8')) as { models?: CachedModel[] };
    return (models ?? [])
      .filter((m): m is CachedModel & { slug: string; display_name: string } => m.visibility === 'list' && typeof m.slug === 'string' && typeof m.display_name === 'string')
      .map(m => ({ id: m.slug.slice(0, 80), name: m.display_name.slice(0, 80), ...withEfforts(levels(m.supported_reasoning_levels), m.default_reasoning_level) }))
      .slice(0, 60);
  } catch {
    return [];
  }
}

/* Codex lists each level as an object with its name and a description for its picker. */
const levels = (value: unknown) => (Array.isArray(value) ? value.map(l => (isRecord(l) ? l.effort : null)) : []);

export function codexAdapter({ home, tools, bin = join(tools, 'bin', 'codex'), secret = null, mode, user = null, api = null }: Options): ProviderAdapter {
  function env(jobSecret: string | null, toolToken: string | null = null): NodeJS.ProcessEnv {
    const extra: Record<string, string> = { CODEX_HOME: ensureDir(home) };
    /* A job user cannot write the node's own HOME, so its home is the key's folder. */
    if (user) extra.HOME = home;
    /* OpenAI's own key would send it to OpenAI, so a key of another address goes in its provider's variable alone. */
    if (mode === 'api_key') extra[api ? ENDPOINT_KEY : 'CODEX_API_KEY'] = jobSecret ?? secret ?? '';
    if (toolToken) extra.HH_TOOL_TOKEN = toolToken;
    return childEnv(tools, extra);
  }

  return {
    async install() {
      await installPackage(tools, NPM_PACKAGES.codex);
    },

    /* Codex keeps the models a plan offers in its home; the ones its picker shows are visibility "list". */
    async models() {
      /* An API at an address runs the models its connection was given, which Hornhoof keeps. */
      if (api) return [];
      if (mode === 'api_key') return API_MODELS.openai_api;
      return cachedModels(join(home, 'models_cache.json'));
    },

    async loggedIn() {
      if (mode === 'api_key') return true;
      return exitsCleanly(bin, ['login', 'status'], env(null), user);
    },

    /* A company key has no plan limits. */
    async limits() {
      return mode === 'api_key' ? null : askLimits(bin, env(null), user);
    },

    async account() {
      return mode === 'api_key' ? null : readAccount('codex', home, env(null), bin, user);
    },

    async login(io) {
      if (mode === 'api_key') return;
      io.output.write('Codex signs in with a device code. If ChatGPT refuses the code, turn on device code sign-in in ChatGPT: Settings, Security.\n');
      await interactiveLogin(bin, ['login', '--device-auth'], env(null), io, user);
    },

    run: input => runCodex(input, false),

    /* exec is Codex's one call; ephemeral keeps its thread nowhere, so the next call remembers nothing of it. */
    oneCall: input => runCodex({ ...input, sessionId: null }, true),

    async secrets() {
      if (mode === 'api_key') return secret ? [secret] : [];
      return tokensIn(join(home, 'auth.json'));
    },
  };

  async function runCodex(input: RunInput, once: boolean): Promise<RunResult> {
    const model = [...(api ? endpointArgs(api) : []), ...(input.model ? ['-m', input.model] : []), ...(input.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(input.effort)}`] : [])];
    /* Codex reads the token from the env variable the config names, so it never shows in the process list. */
    const mcp = input.tools ? ['-c', `mcp_servers.hornhoof.url=${JSON.stringify(input.tools.url)}`, '-c', 'mcp_servers.hornhoof.bearer_token_env_var="HH_TOOL_TOKEN"'] : [];
    const told = toldPlace('codex', input);
    if (input.instructions) writePrivate(told.file, told.head + input.instructions + '\n', user);
    const args = input.sessionId
      ? ['exec', 'resume', ...mcp, ...FLAGS, ...model, '--', input.sessionId, input.prompt]
      : ['exec', ...(once ? ['--ephemeral'] : []), ...mcp, ...FLAGS, '-C', input.workDir, ...model, '--', input.prompt];

    let sessionId: string | null = input.sessionId;
    let answer = '';
    let completed = false;
    let failure = '';
    let tokens: TurnTokens | null = null;
    const done = await runProgram({
      bin,
      args,
      env: { ...env(input.secret, input.tools?.token ?? null), ...input.env },
      cwd: input.workDir,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      user,
      onLine(line) {
        const ev = objectLine(line) as { type?: string; thread_id?: string; item?: { type?: string; text?: string }; error?: { message?: string }; message?: string; usage?: unknown } | null;
        if (!ev) return;
        for (const event of codexEvents(ev)) input.onEvent?.(event);
        if (ev.type === 'thread.started' && ev.thread_id) sessionId = ev.thread_id;
        if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') answer = ev.item.text ?? '';
        if (ev.type === 'turn.completed') {
          completed = true;
          tokens = addTokens(tokens, openaiTokens(ev.usage));
        }
        if (ev.type === 'turn.failed') failure = ev.error?.message ?? 'The turn failed.';
        if (ev.type === 'error' && ev.message) failure = ev.message;
      },
    });

    const ended = withProgramExit(done.output, done);
    if (done.timedOut) return { ok: false, sessionId, result: '', ...ended, error: 'timeout', limits: null, tokens };
    if (completed && done.code === 0) return { ok: true, sessionId, result: answer, output: done.output, error: null, limits: null, tokens };
    const error = SIGNED_OUT.test(failure || done.output) ? 'not_logged_in' : 'agent_failed';
    return { ok: false, sessionId, result: answer, ...ended, error, limits: null, tokens };
  }
}
