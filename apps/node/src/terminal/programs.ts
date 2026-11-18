import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inLane, type Limits } from '@hornhoof/protocol';
import { ownFs, type AgentFs } from '../agent-fs.js';
import { CRED_FILES } from '../credentials.js';
import type { JobUser } from '../isolation.js';
import { agyPlanLimits } from '../providers/antigravity.js';
import { CLAUDE_UNSIGNED } from '../providers/claude-attribution.js';
import { readPrivate } from '../providers/process.js';
import { projectDocArgs } from '../providers/codex.js';
import { CLAUDE_NO_AUTO_UPDATE, CODEX_NO_AUTO_UPDATE, KIMI_NO_AUTO_UPDATE } from '../providers/session-updates.js';
import type { AgentUrls } from './bridge.js';
import { claudeUsageLimits, kimiUsageLimits } from './transcripts.js';

export type LaunchInput = {
  bin: string;
  /* Where the program keeps its sign-in, settings and session logs. */
  home: string;
  workDir: string;
  /* The session to go on with, or null for a new one. */
  sessionId: string | null;
  model: string | null;
  /* How hard the model thinks, as the program names it; none leaves it at the program's default. */
  effort?: string | null;
  /* How full Claude Code's context gets before it compacts the conversation; none leaves it at its own. */
  compactWindow?: number | null;
  instructionsFile: string | null;
  instructionsBytes?: number;
  urls: AgentUrls;
};
/* sessionId: known before the program starts, or null when the program names it later in its log. */
export type LaunchSpec = { command: string[]; env: Record<string, string>; sessionId: string | null };

export type LimitsRun = { bin?: string; user?: JobUser | null; signal?: AbortSignal };

export type TermProgram = {
  kind: 'claude' | 'codex' | 'kimi' | 'antigravity';
  launch(input: LaunchInput): LaunchSpec;
  /* The plan's limits, for a program that does not write them where the host reads. */
  limits?(home: string, run?: LimitsRun): Promise<Limits | null>;
};

const bridgeEnv = (urls: AgentUrls) => ({
  HH_BRIDGE: urls.hookUrl,
  /* hh-attach sends pictures through the bridge, which adds the turn's token; it only needs something to send. */
  HH_ATTACH_URL: urls.attachUrl,
  HH_ATTACH_PASS: 'bridge',
  COLORTERM: 'truecolor',
});

const hook = (event: string) => [{ hooks: [{ type: 'command', command: `hh-hook ${event}` }] }];

/* Claude Code and Codex draw on an alternate screen by default, of which tmux keeps no history, and scroll it themselves:
   a person's view of the session would have nothing to scroll back to. On the main screen what scrolls off stays in the
   pane's history, and the view gets it. Claude Code's variable wins over its setting and over CLAUDE_CODE_NO_FLICKER. */
const CLAUDE_MAIN_SCREEN = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' } as const;
const CODEX_MAIN_SCREEN = '--no-alt-screen';

/* The long token of a Claude plan signed in once on another machine, which this node was given; none otherwise. */
export function planToken(home: string): string | null {
  return readPrivate(join(home, CRED_FILES.claude_token))?.trim() || null;
}

/* Claude Code reads the address of its tools, with the agent's secret in it, from a file of the agent's folder that only the
   agent's user reads, while its program runs: on the command line any process of the machine would read it. */
export const claudeToolsFile = (workDir: string) => join(workDir, '.hh-mcp.json');

export async function writeClaudeTools(workDir: string, mcpUrl: string, fs: AgentFs = ownFs): Promise<void> {
  await fs.write(claudeToolsFile(workDir), JSON.stringify({ mcpServers: { hornhoof: { type: 'http', url: mcpUrl } } }));
}

export const claudeProgram: TermProgram = {
  kind: 'claude',
  launch({ bin, home, workDir, sessionId, model, effort, compactWindow, instructionsFile, urls }) {
    const id = sessionId ?? randomUUID();
    const settings = {
      ...CLAUDE_UNSIGNED,
      /* After compacting its conversation, Claude Code adds what hh-hook compact prints, which sends it back to its tools. */
      hooks: { SessionStart: [...hook('start'), { matcher: 'compact', ...hook('compact')[0]! }], UserPromptSubmit: hook('prompt'), Stop: hook('stop'), StopFailure: hook('stop'), PreToolUse: hook('tool'), PostToolUse: hook('tooldone'), PostToolUseFailure: hook('toolfail'), PermissionRequest: hook('ask'), SessionEnd: hook('end') },
      /* The status line hears the plan's limits; it shows nothing. */
      statusLine: { type: 'command', command: 'hh-hook status' },
    };
    const command = [
      bin,
      '--dangerously-skip-permissions',
      ...(sessionId ? ['--resume', sessionId] : ['--session-id', id]),
      '--strict-mcp-config',
      '--mcp-config',
      claudeToolsFile(workDir),
      '--settings',
      JSON.stringify(settings),
      ...(instructionsFile ? ['--append-system-prompt-file', instructionsFile] : []),
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
    ];
    const compact: Record<string, string> = compactWindow ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(compactWindow) } : {};
    const token = planToken(home);
    return { command, env: { CLAUDE_CONFIG_DIR: home, ...CLAUDE_NO_AUTO_UPDATE, ...CLAUDE_MAIN_SCREEN, ...bridgeEnv(urls), ...compact, ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}) }, sessionId: id };
  },
};

/* With 90% of its plan used, Codex asks after a turn whether to switch to a cheaper model. Nobody is there to answer. Words typed into
   that question are lost and Enter answers it with the first choice, so the agent gets another model and the turn waits for nothing. */
const CODEX_NO_MODEL_QUESTION = ['-c', 'notice.hide_rate_limit_model_nudge=true'];

const CODEX_SECRET_ENV = 'HH_MCP_SECRET';

export const codexProgram: TermProgram = {
  kind: 'codex',
  launch({ bin, home, workDir, sessionId, model, effort, instructionsBytes, urls }) {
    /* Codex sends the agent's secret from its environment as a bearer token, to the address that carries none. */
    const config = ['-c', `mcp_servers.hornhoof.url=${JSON.stringify(urls.mcpAddress)}`, '-c', `mcp_servers.hornhoof.bearer_token_env_var="${CODEX_SECRET_ENV}"`, ...projectDocArgs(instructionsBytes), ...CODEX_NO_AUTO_UPDATE, ...CODEX_NO_MODEL_QUESTION, ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : [])];
    const hooks = Object.entries({ Stop: 'stop', Interrupt: 'interrupt', PreToolUse: 'tool', PostToolUse: 'tooldone', SessionEnd: 'end' }).flatMap(([name, event]) => ['-c', `hooks.${name}=[{hooks=[{type="command",command="hh-hook ${event}"}]}]`]);
    const rest = ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', CODEX_MAIN_SCREEN, ...hooks, ...config, ...(model ? ['-m', model] : [])];
    /* A resumed session works in the folder it started in, which is the pane's. */
    const command = sessionId ? [bin, 'resume', sessionId, ...rest] : [bin, rest[0]!, '-C', workDir, ...rest.slice(1)];
    return { command, env: { CODEX_HOME: home, [CODEX_SECRET_ENV]: urls.secret, ...bridgeEnv(urls) }, sessionId };
  },
};

function claudeAccessToken(home: string): string | null {
  const longToken = planToken(home);
  if (longToken) return longToken;
  const oauth = readJson(join(home, '.credentials.json')).claudeAiOauth;
  const { accessToken: token, expiresAt: expires } = (oauth && typeof oauth === 'object' ? oauth : {}) as Record<string, unknown>;
  if (typeof token !== 'string' || !token) return null;
  return typeof expires === 'number' && expires < Date.now() + 30_000 ? null : token;
}

/* What Claude's /usage shows, asked from Anthropic's own servers only, with the long token Hornhoof keeps or the one
   Claude Code keeps fresh while it runs. A token that ran out gives nothing, and the host keeps what it knew. */
export async function claudePlanLimits(home: string, base = 'https://api.anthropic.com'): Promise<Limits | null> {
  const token = claudeAccessToken(home);
  if (!token) return null;
  try {
    const res = await fetch(`${base}/api/oauth/usage`, {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? claudeUsageLimits(await res.json()) : null;
  } catch {
    return null;
  }
}

/* Kimi Code's plan page, on its own servers only: the sign-in token goes nowhere else. KIMI_CODE_BASE_URL is Kimi's own
   way to point it elsewhere. */
const KIMI_BASE = 'https://api.kimi.com/coding/v1';
const KIMI_GLOBAL_BASE = 'https://api.kimi.ai/coding/v1';

export const kimiProgram: TermProgram = {
  kind: 'kimi',
  launch({ bin, home, sessionId, model, effort, urls }) {
    /* --auto decides everything on its own, as the others run without approvals. Kimi names a new session only when the
       first message starts it, and its start hook tells the host. */
    const command = [bin, '--auto', ...(sessionId ? ['-S', sessionId] : []), ...(model ? ['-m', model] : [])];
    /* The agent's folder is trusted, so Kimi reads the tools and instructions Hornhoof leaves there without asking. Kimi
       has no flag for effort; it reads this setting over its own. */
    const thinking: Record<string, string> = effort ? { KIMI_MODEL_THINKING_EFFORT: effort } : {};
    return { command, env: { KIMI_CODE_HOME: home, KIMI_CODE_TRUST_WORKSPACE: '1', PI_PROGRAM_STATUS: '1', ...KIMI_NO_AUTO_UPDATE, ...thinking, ...bridgeEnv(urls) }, sessionId };
  },
  limits: kimiPlanLimits,
};

export const agyProgram: TermProgram = {
  kind: 'antigravity',
  launch({ bin, home, workDir, sessionId, model, effort, urls }) {
    /* agy names a new conversation in its first invocation hook. Its feedback survey takes the input from the turn's words. */
    const command = [bin, ...(sessionId ? ['--conversation', sessionId] : []), ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), '--dangerously-skip-permissions', '--settings', JSON.stringify({ trustedWorkspaces: [workDir], showFeedbackSurvey: false })];
    /* agy keeps everything in HOME, and leaves the program in the node's tools folder as the node installed it. */
    return { command, env: { HOME: home, AGY_CLI_DISABLE_AUTO_UPDATE: 'true', ...bridgeEnv(urls) }, sessionId };
  },
  limits(home, run) {
    const tools = run?.bin ? dirname(dirname(run.bin)) : join(dirname(home), 'tools');
    return agyPlanLimits({ bin: run?.bin, home, tools, user: run?.user ?? null, signal: run?.signal });
  },
};

/* agy reads tools and hooks from the agent folder's .agents; the bridge adds the turn's token. */
export async function prepareAgy(workDir: string, mcpUrl: string, fs: AgentFs = ownFs): Promise<void> {
  const dir = join(workDir, '.agents');
  await fs.mkdir(dir);
  await fs.write(join(dir, 'mcp_config.json'), JSON.stringify({ mcpServers: { hornhoof: { serverUrl: mcpUrl } } }, null, 2));
  await fs.write(join(dir, 'hooks.json'), JSON.stringify({ hornhoof: {
    PreInvocation: [{ type: 'command', command: 'hh-hook invocation' }],
    Stop: [{ type: 'command', command: 'hh-hook stop' }],
  } }, null, 2));
}

/* Hornhoof's hooks in Kimi's settings: the start names the session, the prompt opens a person's turn before Kimi goes on. */
const KIMI_HOOKS = [
  ['SessionStart', 'start'],
  ['UserPromptSubmit', 'prompt'],
  ['UserPromptQueued', 'queued'],
  ['Stop', 'stop'],
  ['StopFailure', 'stop'],
  ['Interrupt', 'interrupt'],
  ['PreToolUse', 'tool'],
  ['PostToolUse', 'tooldone'],
  ['PostToolUseFailure', 'toolfail'],
  ['SessionEnd', 'end'],
] as const;

/* Kimi has no flags for tools or hooks. Its tools come from the agent folder's .kimi-code/mcp.json, through the bridge,
   and its hooks from config.toml in its home, which the person's own settings share: Hornhoof's are added at the end
   once. Settings that list their hooks on one line could take no more, and are left alone. */
export async function prepareKimi(home: string, workDir: string, mcpUrl: string, fs: AgentFs = ownFs): Promise<void> {
  const dir = join(workDir, '.kimi-code');
  await fs.mkdir(dir);
  await fs.write(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { hornhoof: { transport: 'http', url: mcpUrl } } }, null, 2));
  const file = join(home, 'config.toml');
  /* A home that was never signed in has none yet. */
  const config = (await fs.read(file)) ?? '';
  const entries = config.split(/\[\[hooks\]\]/).slice(1);
  const missing = KIMI_HOOKS.filter(([name, event]) => !entries.some(entry => new RegExp(`event\\s*=\\s*"${name}"`).test(entry) && entry.includes(`"hh-hook ${event}"`)));
  if (!missing.length || /^\s*hooks\s*=/m.test(config)) return;
  const added = missing.map(([name, event]) => `[[hooks]]\nevent = "${name}"\ncommand = "hh-hook ${event}"\n`).join('\n');
  await fs.mkdir(home);
  await fs.write(file, `${config}${config && !config.endsWith('\n') ? '\n' : ''}${config ? '\n' : ''}${added}`);
}

/* Kimi Code keeps a session's log by the folder's workspace and the session's id; the main agent has its own log. */
export function findKimiWire(home: string, sessionId: string): string | null {
  if (!/^[\w-]+$/.test(sessionId)) return null;
  const root = join(home, 'sessions');
  if (!existsSync(root)) return null;
  for (const workspace of readdirSync(root)) {
    const file = join(root, workspace, sessionId, 'agents', 'main', 'wire.jsonl');
    if (existsSync(file)) return file;
  }
  return null;
}

/* What Kimi's /usage shows, asked with the token Kimi keeps fresh while it runs. A token that went stale gives nothing,
   and the host keeps what it knew. */
export async function kimiPlanLimits(home: string): Promise<Limits | null> {
  const { access_token: token, expires_at: expires } = readJson(join(home, 'credentials', 'kimi-code.json'));
  if (typeof token !== 'string' || !token) return null;
  /* Kimi alone renews its token, with a lock its own processes share; a token that ran out would only be refused. */
  if (typeof expires === 'number' && expires * 1000 < Date.now() + 30_000) return null;
  let config = '';
  try {
    config = readFileSync(join(home, 'config.toml'), 'utf8');
  } catch {
    /* Signed in without settings: the default servers. */
  }
  const base = process.env.KIMI_CODE_BASE_URL ?? (config.includes(KIMI_GLOBAL_BASE) ? KIMI_GLOBAL_BASE : KIMI_BASE);
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/usages`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    return res.ok ? kimiUsageLimits(await res.json()) : null;
  } catch {
    return null;
  }
}

function readJson(file: string): Record<string, unknown> {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

const parsed = (text: string | null): Record<string, unknown> => {
  try {
    const data = JSON.parse(text ?? '');
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
};

/* Agents of one plan share its home, and each start reads and rewrites the same files there: one start at a time per home,
   so none writes back what it read before another added its folder. */
const answering = new Map<string, Promise<unknown>>();

/* A first run asks for a theme, shows notes, asks to trust the folder and to accept running without approvals. An agent
   cannot answer, so the answers are written first: the theme a first run picks, unless the person chose one. */
export function acceptClaudeDialogs(home: string, workDir: string, fs: AgentFs = ownFs): Promise<void> {
  return inLane(answering, home, () => answerDialogs(home, workDir, fs));
}

async function answerDialogs(home: string, workDir: string, fs: AgentFs): Promise<void> {
  const stateFile = join(home, '.claude.json');
  const state = parsed(await fs.read(stateFile));
  const projects = (state.projects && typeof state.projects === 'object' ? state.projects : {}) as Record<string, Record<string, unknown>>;
  if (state.hasCompletedOnboarding !== true || projects[workDir]?.hasTrustDialogAccepted !== true) {
    await fs.write(stateFile, JSON.stringify({ ...state, hasCompletedOnboarding: true, projects: { ...projects, [workDir]: { ...projects[workDir], hasTrustDialogAccepted: true } } }, null, 2));
  }
  const settingsFile = join(home, 'settings.json');
  const settings = parsed(await fs.read(settingsFile));
  if (settings.skipDangerousModePermissionPrompt !== true || !settings.theme) {
    await fs.write(settingsFile, JSON.stringify({ theme: 'dark', ...settings, skipDangerousModePermissionPrompt: true }, null, 2));
  }
}

/* Claude Code logs a session under its folder, each character that is not a letter or digit made a dash. */
export const claudeTranscript = (home: string, workDir: string, sessionId: string) => join(home, 'projects', workDir.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);

/* Every session log Codex keeps, with when each was last written. */
function rollouts(home: string): { file: string; mtime: number }[] {
  const files: { file: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (depth < 3) walk(path, depth + 1);
      else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) files.push({ file: path, mtime: statSync(path).mtimeMs });
    }
  };
  walk(join(home, 'sessions'), 0);
  return files;
}

/* The session logs there are now: a new session's log is none of them. */
export const rolloutFiles = (home: string): Set<string> => new Set(rollouts(home).map(r => r.file));

/* The log of a known Codex session, or the newest one Codex started in this folder since the given time, other than
   those before. Codex writes a new session's log only with its first message, so the last session's log, written a
   moment ago, would pass for it. */
export function findRollout(home: string, workDir: string, since: number, sessionId: string | null = null, before: ReadonlySet<string> = new Set()): { file: string; sessionId: string } | null {
  const files = rollouts(home).filter(({ file, mtime }) => !before.has(file) && (sessionId ? file.endsWith(`-${sessionId}.jsonl`) : mtime >= since));
  for (const { file } of files.sort((a, b) => b.mtime - a.mtime)) {
    const first = readFileSync(file, 'utf8').split('\n', 1)[0] ?? '';
    try {
      const meta = JSON.parse(first);
      if (meta?.type === 'session_meta' && meta.payload?.cwd === workDir && typeof meta.payload.id === 'string') return { file, sessionId: meta.payload.id };
    } catch {
      /* Not a session log. */
    }
  }
  return null;
}

/* agy keeps each conversation's transcript under its HOME; a hook cannot choose another file. */
export function agyTranscript(home: string, sessionId: string): string | null {
  return /^[\w-]+$/.test(sessionId) ? join(home, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript_full.jsonl') : null;
}
