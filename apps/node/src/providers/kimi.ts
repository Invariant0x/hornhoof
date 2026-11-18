import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent, ModelOption } from '@hornhoof/protocol';
import { CRED_FILES, credentialSecrets } from '../credentials.js';
import type { JobUser } from '../isolation.js';
import { toldPlace } from '../program-folder.js';
import type { ProviderAdapter, RunInput, RunResult } from '../runner.js';
import { withProgramExit } from '../program-exit.js';
import { kimiPlanLimits } from './kimi-terminal.js';
import { contentText, inputText, isRecord, objectLine, toolName } from './events.js';
import { childEnv, ensureDir, installPackage, interactiveLogin, runProgram, tokensIn, withEfforts, writePrivate } from './process.js';
import { KIMI_NO_AUTO_UPDATE } from './session-updates.js';
import { NPM_PACKAGES } from './packages.js';

type Options = { home: string; tools: string; bin?: string; user?: JobUser | null };

const SIGNED_OUT = /no model configured|\/login|not logged in/i;
/* What Kimi Code's screen or error code says when it is not signed in. Narrower than the words above, since a screen also shows
   what the agent did, which can name a /login page. */
export const SCREEN_SIGNED_OUT = /Run \/login or \/provider to get started|"\/login" to login|Send \/login to login|not set, run \/login|try \/login|\bprovider\.auth_error\b/;

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

/* What a stream-json line shows people: assistant text with its tool calls, and each tool's output. Read from Kimi Code 2.4's source, not yet from a signed-in run. */
export function kimiEvents(line: unknown): AgentEvent[] {
  if (!isRecord(line)) return [];
  if (line.role === 'tool') return [{ kind: 'tool_result', ok: true, summary: contentText(line.content) }];
  if (line.role !== 'assistant') return [];
  const events: AgentEvent[] = [];
  const text = textOf(line.content);
  if (text.trim()) events.push({ kind: 'text', text });
  for (const call of Array.isArray(line.tool_calls) ? line.tool_calls : []) {
    if (isRecord(call) && isRecord(call.function) && typeof call.function.name === 'string') {
      events.push({ kind: 'tool', name: toolName(call.function.name), input: inputText(call.function.arguments) });
    }
  }
  return events;
}

/* The [models."<alias>"] tables in Kimi's config.toml, with their plain values. A model's own
   [models."<alias>".overrides] win over what the plan wrote for it, as in Kimi. -m takes the alias. */
function modelTables(config: string): { id: string; values: Map<string, string> }[] {
  const tables = new Map<string, { base: Map<string, string>; overrides: Map<string, string> }>();
  let current: Map<string, string> | null = null;
  for (const line of config.split('\n')) {
    const table = /^\s*\[models\.(?:"([^"]+)"|([\w-]+))(\.overrides)?\]\s*$/.exec(line);
    if (table) {
      const id = (table[1] ?? table[2])!.slice(0, 80);
      const found = tables.get(id) ?? { base: new Map(), overrides: new Map() };
      tables.set(id, found);
      current = table[3] ? found.overrides : found.base;
      continue;
    }
    if (/^\s*\[/.test(line)) current = null;
    const pair = current && /^\s*(\w+)\s*=\s*(?:"([^"]*)"|(\[[^\]]*\])|(\S+))/.exec(line);
    if (current && pair) current.set(pair[1]!, pair[2] ?? pair[3] ?? pair[4]!);
  }
  return [...tables].map(([id, t]) => ({ id, values: new Map([...t.base, ...t.overrides]) }));
}

/* The models Kimi's plan wrote into its settings once it was signed in, by the name Kimi shows each under. */
export function kimiModels(config: string): ModelOption[] {
  return modelTables(config)
    .slice(0, 60)
    .map(t => ({ id: t.id, name: (t.values.get('display_name') || t.id).slice(0, 80), ...withEfforts(strings(t.values.get('support_efforts')), t.values.get('default_effort')) }));
}

/* The strings of a one-line TOML list, as Kimi writes support_efforts. */
const strings = (list: string | undefined) => [...(list ?? '').matchAll(/"([^"]*)"|'([^']*)'/g)].map(m => m[1] ?? m[2]);

/* How many tokens a model's context takes, as Kimi counts it for its screen: what it may send, else its whole context.
   No model named is the default one. */
export function kimiContextSize(config: string, model: string | null): number | null {
  const id = model ?? /^\s*default_model\s*=\s*"([^"]+)"/m.exec(config.split(/^\s*\[/m)[0] ?? '')?.[1];
  const values = modelTables(config).find(t => t.id === id)?.values;
  const size = Number(values?.get('max_input_size') ?? values?.get('max_context_size'));
  return Number.isInteger(size) && size > 0 ? size : null;
}

/* Kimi Code reads what it is told from the folder it works in. */
function tellKimi(input: RunInput, instructions: string, user: JobUser | null): void {
  const { file } = toldPlace('kimi', input);
  writePrivate(file, instructions + '\n', user);
}

export function kimiAdapter({ home, tools, bin = join(tools, 'bin', 'kimi'), user = null }: Options): ProviderAdapter {
  const env = (toolToken: string | null = null) => {
    const own = childEnv(tools, { KIMI_CODE_HOME: ensureDir(home), ...KIMI_NO_AUTO_UPDATE, ...(toolToken ? { HH_TOOL_TOKEN: toolToken } : {}) });
    /* The effort is the agent's, set below; without one Kimi thinks at its own default, not at one the machine set. */
    delete own.KIMI_MODEL_THINKING_EFFORT;
    return own;
  };
  const credentials = () => files(join(home, 'credentials'));

  return {
    async install() {
      await installPackage(tools, NPM_PACKAGES.kimi);
    },

    /* Signed in with /login, or with a membership key this node was given. */
    async loggedIn() {
      return credentials().length > 0 || existsSync(join(home, CRED_FILES.kimi_key));
    },

    async models() {
      try {
        return kimiModels(readFileSync(join(home, 'config.toml'), 'utf8'));
      } catch {
        /* Not signed in yet: no settings, and Kimi runs its default. */
        return [];
      }
    },

    async limits() {
      return kimiPlanLimits(home);
    },

    async login(io) {
      await interactiveLogin(bin, ['login'], env(), io, user);
    },

    run: input => runKimi(input, false),

    /* Print mode is Kimi Code's one call, and its stream-json output needs it. */
    oneCall: input => runKimi({ ...input, sessionId: null }, true),

    async secrets() {
      return [...credentials().flatMap(tokensIn), ...credentialSecrets(home)];
    },
  };

  async function runKimi(input: RunInput, once: boolean): Promise<RunResult> {
    const args = [...(once ? ['--print'] : []), `--prompt=${input.prompt}`, '--output-format', 'stream-json'];
    if (input.sessionId) args.push('--session', input.sessionId);
    if (input.model) args.push('-m', input.model);

    /* Kimi has no MCP flag: it reads mcp.json from its home, and the token from the env variable named there. */
    const mcpJson = join(ensureDir(home), 'mcp.json');
    if (input.tools) {
      const server = { transport: 'http', url: input.tools.url, bearerTokenEnvVar: 'HH_TOOL_TOKEN' };
      writePrivate(mcpJson, JSON.stringify({ mcpServers: { hornhoof: server } }), user);
    } else rmSync(mcpJson, { force: true });
    if (input.instructions) tellKimi(input, input.instructions, user);

    let sessionId: string | null = input.sessionId;
    let answer = '';
    const done = await runProgram({
      bin,
      args,
      env: { ...env(input.tools?.token ?? null), ...(input.effort ? { KIMI_MODEL_THINKING_EFFORT: input.effort } : {}), ...input.env },
      user,
      cwd: input.workDir,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      onLine(line) {
        const ev = objectLine(line) as KimiEvent | null;
        if (!ev) return;
        for (const event of kimiEvents(ev)) input.onEvent?.(event);
        const id = ev.session_id ?? ev.sessionId;
        if (typeof id === 'string') sessionId = id;
        if (ev.role === 'assistant') answer = textOf(ev.content) || answer;
      },
    });

    const ended = withProgramExit(done.output, done);
    if (done.timedOut) return { ok: false, sessionId, result: '', ...ended, error: 'timeout', limits: null };
    if (done.code === 0 && answer) return { ok: true, sessionId, result: answer, output: done.output, error: null, limits: null };
    return { ok: false, sessionId, result: answer, ...ended, error: SIGNED_OUT.test(done.output) ? 'not_logged_in' : 'agent_failed', limits: null };
  }
}
