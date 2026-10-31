import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Limits } from '@hornhoof/protocol';
import { writePrivate } from '../providers/process.js';
import type { AgentUrls } from './bridge.js';
import { kimiUsageLimits } from './transcripts.js';

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
  instructionsFile: string | null;
  urls: AgentUrls;
};
/* sessionId: known before the program starts, or null when the program names it later in its log. */
export type LaunchSpec = { command: string[]; env: Record<string, string>; sessionId: string | null };

export type TermProgram = {
  kind: 'claude' | 'codex' | 'kimi';
  launch(input: LaunchInput): LaunchSpec;
  /* The plan's limits, for a program that does not write them where the host reads. */
  limits?(home: string): Promise<Limits | null>;
};

const bridgeEnv = (urls: AgentUrls) => ({
  HH_BRIDGE: urls.hookUrl,
  /* hh-attach sends pictures through the bridge, which adds the turn's token; it only needs something to send. */
  HH_ATTACH_URL: urls.attachUrl,
  HH_ATTACH_PASS: 'bridge',
  COLORTERM: 'truecolor',
});

const hook = (event: string) => [{ hooks: [{ type: 'command', command: `hh-hook ${event}` }] }];

export const claudeProgram: TermProgram = {
  kind: 'claude',
  launch({ bin, home, sessionId, model, effort, instructionsFile, urls }) {
    const id = sessionId ?? randomUUID();
    const settings = {
      hooks: { SessionStart: hook('start'), UserPromptSubmit: hook('prompt'), Stop: hook('stop') },
      /* The status line hears the plan's limits; it shows nothing. */
      statusLine: { type: 'command', command: 'hh-hook status' },
    };
    const command = [
      bin,
      '--dangerously-skip-permissions',
      ...(sessionId ? ['--resume', sessionId] : ['--session-id', id]),
      '--strict-mcp-config',
      '--mcp-config',
      JSON.stringify({ mcpServers: { hornhoof: { type: 'http', url: urls.mcpUrl } } }),
      '--settings',
      JSON.stringify(settings),
      ...(instructionsFile ? ['--append-system-prompt-file', instructionsFile] : []),
      ...(model ? ['--model', model] : []),
      ...(effort ? ['--effort', effort] : []),
    ];
    return { command, env: { CLAUDE_CONFIG_DIR: home, ...bridgeEnv(urls) }, sessionId: id };
  },
};

export const codexProgram: TermProgram = {
  kind: 'codex',
  launch({ bin, home, workDir, sessionId, model, effort, urls }) {
    const config = ['-c', `mcp_servers.hornhoof.url=${JSON.stringify(urls.mcpUrl)}`, ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : [])];
    const rest = ['--dangerously-bypass-approvals-and-sandbox', ...config, ...(model ? ['-m', model] : [])];
    /* A resumed session works in the folder it started in, which is the pane's. */
    const command = sessionId ? [bin, 'resume', sessionId, ...rest] : [bin, rest[0]!, '-C', workDir, ...rest.slice(1)];
    return { command, env: { CODEX_HOME: home, ...bridgeEnv(urls) }, sessionId };
  },
};

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
    return { command, env: { KIMI_CODE_HOME: home, KIMI_CODE_TRUST_WORKSPACE: '1', ...thinking, ...bridgeEnv(urls) }, sessionId };
  },
  limits: kimiPlanLimits,
};

/* Hornhoof's hooks in Kimi's settings: the start names the session, the prompt opens a person's turn before Kimi goes on. */
const KIMI_HOOKS = [
  ['SessionStart', 'start'],
  ['UserPromptSubmit', 'prompt'],
] as const;

/* Kimi has no flags for tools or hooks. Its tools come from the agent folder's .kimi-code/mcp.json, through the bridge,
   and its hooks from config.toml in its home, which the person's own settings share: Hornhoof's are added at the end
   once. Settings that list their hooks on one line could take no more, and are left alone. */
export function prepareKimi(home: string, workDir: string, mcpUrl: string): void {
  const dir = join(workDir, '.kimi-code');
  mkdirSync(dir, { recursive: true });
  writePrivate(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { hornhoof: { transport: 'http', url: mcpUrl } } }, null, 2), null);
  const file = join(home, 'config.toml');
  let config = '';
  try {
    config = readFileSync(file, 'utf8');
  } catch {
    /* A home that was never signed in has none yet. */
  }
  const missing = KIMI_HOOKS.filter(([, event]) => !new RegExp(`hh-hook ${event}\\b`).test(config));
  if (!missing.length || /^\s*hooks\s*=/m.test(config)) return;
  const added = missing.map(([name, event]) => `[[hooks]]\nevent = "${name}"\ncommand = "hh-hook ${event}"\n`).join('\n');
  mkdirSync(home, { recursive: true });
  const temp = `${file}.hh-${process.pid}`;
  writeFileSync(temp, `${config}${config && !config.endsWith('\n') ? '\n' : ''}${config ? '\n' : ''}${added}`, { mode: 0o600 });
  renameSync(temp, file);
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

/* Written whole and moved into place, so a program reading it at the same moment sees the old file or the new one. */
function writeJson(file: string, data: unknown): void {
  const temp = `${file}.hh-${process.pid}`;
  writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(temp, file);
}

/* A first run asks for a theme, shows notes, asks to trust the folder and to accept running without approvals. An agent
   cannot answer, so the answers are written first: the theme a first run picks, unless the person chose one. */
export function acceptClaudeDialogs(home: string, workDir: string): void {
  const stateFile = join(home, '.claude.json');
  const state = readJson(stateFile);
  const projects = (state.projects && typeof state.projects === 'object' ? state.projects : {}) as Record<string, Record<string, unknown>>;
  if (state.hasCompletedOnboarding !== true || projects[workDir]?.hasTrustDialogAccepted !== true) {
    writeJson(stateFile, { ...state, hasCompletedOnboarding: true, projects: { ...projects, [workDir]: { ...projects[workDir], hasTrustDialogAccepted: true } } });
  }
  const settingsFile = join(home, 'settings.json');
  const settings = readJson(settingsFile);
  if (settings.skipDangerousModePermissionPrompt !== true || !settings.theme) {
    writeJson(settingsFile, { theme: 'dark', ...settings, skipDangerousModePermissionPrompt: true });
  }
}

/* Claude Code logs a session under its folder, each character that is not a letter or digit made a dash. */
export const claudeTranscript = (home: string, workDir: string, sessionId: string) => join(home, 'projects', workDir.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);

/* The log of a known Codex session, or the newest one Codex started in this folder since the given time. */
export function findRollout(home: string, workDir: string, since: number, sessionId: string | null = null): { file: string; sessionId: string } | null {
  const files: { file: string; mtime: number }[] = [];
  const walk = (dir: string, depth: number) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (depth < 3) walk(path, depth + 1);
      else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) {
        const mtime = statSync(path).mtimeMs;
        if (sessionId ? name.endsWith(`-${sessionId}.jsonl`) : mtime >= since) files.push({ file: path, mtime });
      }
    }
  };
  walk(join(home, 'sessions'), 0);
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
