import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { API_MODELS, CLAUDE_ALIASES, type AgentEvent, type ApiEndpoint, type Limits, type TurnTokens } from '@hornhoof/protocol';
import type { JobUser } from '../isolation.js';
import type { ProviderAdapter, RunInput, RunResult } from '../runner.js';
import { withProgramExit } from '../program-exit.js';
import { credentialSecrets } from '../credentials.js';
import { readAccount } from '../account.js';
import { claudePlanLimits, planToken } from './claude-terminal.js';
import { contentText, inputText, isoFrom, isRecord, objectLine, toolName } from './events.js';
import { askHidden, childEnv, ensureDir, exitsCleanly, installPackage, interactiveLogin, readPrivate, runProgram, tokensIn, writePrivate } from './process.js';
import { CLAUDE_UNSIGNED } from './claude-attribution.js';
import { CLAUDE_NO_AUTO_UPDATE } from './session-updates.js';
import { anthropicTokens, claudeModel, withModel } from '../turn-tokens.js';
import { NPM_PACKAGES } from './packages.js';

/* Claude Code serves three kinds of subscription: a personal plan, a company Anthropic key, and a GLM Coding Plan through Z.ai's Anthropic-compatible endpoint. */
type ClaudeMode = 'plan' | 'api_key' | 'glm';

/* api: an API by the token at an address, in Anthropic's protocol, such as OpenRouter: a key there runs at that address. */
type Options = { home: string; tools: string; bin?: string; secret?: string | null; mode: ClaudeMode; user?: JobUser | null; api?: ApiEndpoint | null };

/* Claude Code at an address of Anthropic's protocol, as OpenRouter has it run: the key is its bearer token and its own
   Anthropic key is set empty, so it signs in nowhere else. Every alias names the model the turn runs, as such an API may
   have none of Anthropic's names. */
function endpointEnv(api: ApiEndpoint, key: string, model: string | null): Record<string, string> {
  const aliases: Record<string, string> = model ? { ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model } : {};
  return { ANTHROPIC_BASE_URL: api.baseUrl, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: '', ...aliases };
}

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


export function limitsFrom(info: RateInfo): Limits {
  const status = info.status === 'rejected' ? 'rejected' : info.status === 'allowed_warning' ? 'warning' : 'allowed';
  const unified = Object.entries(info.unifiedWindows ?? {}).map(([name, w]) => ({
    name,
    utilization: typeof w.utilization === 'number' ? Math.min(1, Math.max(0, w.utilization)) : null,
    resetsAt: isoFrom(w.resetsAt),
  }));
  const windows = unified.length ? unified : info.rateLimitType ? [{ name: info.rateLimitType, utilization: null, resetsAt: isoFrom(info.resetsAt) }] : [];
  return { status, windows: windows.slice(0, 8), ...(unified.length ? { complete: true } : {}) };
}

type Outcome = { text: string; isError: boolean; sessionId: string | null; tokens: TurnTokens | null };

const TODO_STATES: Record<string, 'todo' | 'doing' | 'done'> = { pending: 'todo', in_progress: 'doing', completed: 'done' };

/* What a stream-json line shows people: the agent's text, its tool calls and their results, and its plan. */
export function claudeEvents(line: unknown): AgentEvent[] {
  if (!isRecord(line) || (line.type !== 'assistant' && line.type !== 'user') || !isRecord(line.message)) return [];
  const blocks = Array.isArray(line.message.content) ? line.message.content : [];
  return blocks.flatMap((b): AgentEvent[] => {
    if (!isRecord(b)) return [];
    if (line.type === 'assistant' && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) return [{ kind: 'text', text: b.text }];
    if (b.type === 'tool_use' && typeof b.name === 'string') {
      if (b.name === 'TodoWrite' && isRecord(b.input) && Array.isArray(b.input.todos)) {
        const items = b.input.todos.filter(isRecord).map(t => ({ text: String(t.content ?? ''), state: TODO_STATES[String(t.status)] ?? 'todo' }));
        return [{ kind: 'todo', items }];
      }
      return [{ kind: 'tool', name: toolName(b.name), input: inputText(b.input) }];
    }
    if (b.type === 'tool_result') return [{ kind: 'tool_result', ok: b.is_error !== true, summary: contentText(b.content) }];
    return [];
  });
}

/* The line Claude Code logs when a person stops a turn with Escape; it calls no stop hook then. */
export function claudeInterrupted(line: unknown): boolean {
  if (!isRecord(line) || line.type !== 'user' || !isRecord(line.message)) return false;
  const content = line.message.content;
  const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter(isRecord).map(b => (typeof b.text === 'string' ? b.text : '')) : [];
  return texts.some(t => t.startsWith('[Request interrupted by user'));
}

export const SIGNED_OUT = /not logged in|please run \/login|invalid api key|authentication/i;

export function claudeAdapter({ home, tools, bin = join(tools, 'bin', 'claude'), secret = null, mode, user = null, api = null }: Options): ProviderAdapter {
  const keyFile = join(home, 'glm-key');
  /* The agents own the home, so the key is not read through a link they could put there. */
  const glmKey = () => readPrivate(keyFile)?.trim() ?? '';

  function env(jobSecret: string | null, model: string | null = null): NodeJS.ProcessEnv {
    const extra: Record<string, string> = { CLAUDE_CONFIG_DIR: ensureDir(home), ...CLAUDE_NO_AUTO_UPDATE };
    /* A job user cannot write the node's own HOME, so its home is the key's folder. */
    if (user) extra.HOME = home;
    if (mode === 'api_key' && api) Object.assign(extra, endpointEnv(api, jobSecret ?? secret ?? '', model));
    else if (mode === 'api_key') extra.ANTHROPIC_API_KEY = jobSecret ?? secret ?? '';
    if (mode === 'glm') Object.assign(extra, GLM_ENV, { ANTHROPIC_AUTH_TOKEN: glmKey() });
    /* A plan signed in once on another machine: its long token, which this node was given. */
    const token = mode === 'plan' ? planToken(home) : null;
    if (token) extra.CLAUDE_CODE_OAUTH_TOKEN = token;
    return childEnv(tools, extra);
  }

  return {
    async install() {
      await installPackage(tools, NPM_PACKAGES.claude);
    },

    /* Z.ai maps the aliases to its GLM models, so a GLM plan offers only the default. */
    async models() {
      /* An API at an address runs the models its connection was given, which Hornhoof keeps. */
      if (api) return [];
      return mode === 'plan' ? CLAUDE_ALIASES : mode === 'api_key' ? API_MODELS.anthropic_api : [];
    },

    /* A company key and a GLM plan have no Claude plan limits. */
    async limits() {
      return mode === 'plan' ? claudePlanLimits(home) : null;
    },

    async account() {
      return mode === 'plan' ? readAccount('claude', home, env(null), bin, user) : null;
    },

    async loggedIn() {
      if (mode === 'api_key') return true;
      if (mode === 'glm') return glmKey().length > 0;
      return exitsCleanly(bin, ['auth', 'status'], env(null), user);
    },

    async login(io) {
      if (mode === 'api_key') return;
      if (mode === 'glm') {
        io.output.write('Paste your GLM Coding Plan key from z.ai (not a general API key).\n');
        const key = await askHidden(io, 'GLM key: ');
        if (!key) throw new Error('No key was entered.');
        ensureDir(home);
        writePrivate(keyFile, key + '\n', user);
        return;
      }
      await interactiveLogin(bin, ['auth', 'login'], env(null), io, user);
    },

    run: input => runClaude(input, false),

    /* Print mode is Claude Code's one call; it keeps the session nowhere, so the next call remembers nothing of it. */
    oneCall: input => runClaude({ ...input, sessionId: null }, true),

    async secrets() {
      if (mode === 'api_key') return secret ? [secret] : [];
      if (mode === 'glm') return [glmKey()].filter(Boolean);
      return [...tokensIn(join(home, '.credentials.json')), ...credentialSecrets(home)];
    },
  };

  async function runClaude(input: RunInput, once: boolean): Promise<RunResult> {
    const session = input.sessionId ? ['--resume', input.sessionId] : ['--session-id', randomUUID()];
    const args = ['-p', '--output-format', 'stream-json', '--verbose', ...session, ...(once ? ['--no-session-persistence'] : []), '--permission-mode', 'bypassPermissions', '--settings', JSON.stringify(CLAUDE_UNSIGNED)];
    /* In a file of the agent's folder, as the live terminal gives them: Linux holds one argument to 128 KiB. */
    if (input.instructions) {
      const file = join(input.workDir, '.hh-instructions.md');
      writePrivate(file, input.instructions + '\n', user);
      args.push('--append-system-prompt-file', file);
    }
    /* The token sits in a file only the node reads, for this run alone, never on the command line. */
    const mcpFile = input.tools ? join(ensureDir(home), `mcp-${randomUUID()}.json`) : null;
    if (mcpFile && input.tools) {
      const server = { type: 'http', url: input.tools.url, headers: { Authorization: `Bearer ${input.tools.token}` } };
      writePrivate(mcpFile, JSON.stringify({ mcpServers: { hornhoof: server } }), user);
      args.push('--mcp-config', mcpFile, '--strict-mcp-config');
    }
    if (input.model) args.push('--model', input.model);
    if (input.effort) args.push('--effort', input.effort);
    args.push('--', input.prompt);
    /* Hornhoof's window for this agent, or Claude Code's own when it sets none. */
    const compact: Record<string, string> = input.compactWindow ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(input.compactWindow) } : {};

    let result: Outcome | null = null;
    let sessionId: string | null = input.sessionId;
    let limits: Limits | null = null;
    let signedOut = false;
    let model: string | null = null;
    const done = await runProgram({
      bin,
      args,
      env: { ...env(input.secret, input.model), ...input.env, ...compact },
      cwd: input.workDir,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      user,
      onLine(line) {
        const ev = objectLine(line);
        if (!ev) return;
        if (typeof ev.session_id === 'string') sessionId = ev.session_id;
        model = claudeModel(ev, model);
        if (ev.type === 'assistant' && ev.error === 'authentication_failed') signedOut = true;
        if (ev.type === 'rate_limit_event' && ev.rate_limit_info) limits = limitsFrom(ev.rate_limit_info as RateInfo);
        /* A finished background task adds an empty result after the real one, which must not replace it. */
        const text = String(ev.result ?? '');
        if (ev.type === 'result' && (text || ev.is_error === true || !result)) result = { text, isError: ev.is_error === true, sessionId, tokens: withModel(anthropicTokens(ev.usage), model) };
        for (const event of claudeEvents(ev)) input.onEvent?.(event);
      },
    }).finally(() => {
      if (mcpFile) rmSync(mcpFile, { force: true });
    });

    /* Assigned in onLine, which TypeScript does not follow. */
    const final = result as Outcome | null;
    const ended = withProgramExit(done.output, done);
    const tokens = final?.tokens ?? null;
    if (done.timedOut) return { ok: false, sessionId, result: '', ...ended, error: 'timeout', limits, tokens };
    if (final && !final.isError && done.code === 0) return { ok: true, sessionId, result: final.text, output: done.output, error: null, limits, tokens };
    const out = signedOut || SIGNED_OUT.test(final?.text ?? '');
    /* A GLM key Z.ai rejects is dropped, so the status says signed out and the next sign-in asks for a new key. */
    if (out && mode === 'glm') rmSync(keyFile, { force: true });
    return { ok: false, sessionId, result: final?.text ?? '', ...ended, error: out ? 'not_logged_in' : 'agent_failed', limits, tokens };
  }
}
