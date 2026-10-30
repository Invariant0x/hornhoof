import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentUrls } from './bridge.js';

export type LaunchInput = {
  bin: string;
  /* Where the program keeps its sign-in, settings and session logs. */
  home: string;
  workDir: string;
  /* The session to go on with, or null for a new one. */
  sessionId: string | null;
  model: string | null;
  instructionsFile: string | null;
  urls: AgentUrls;
};
/* sessionId: known before the program starts, or null when the program names it later in its log. */
export type LaunchSpec = { command: string[]; env: Record<string, string>; sessionId: string | null };

export type TermProgram = {
  kind: 'claude' | 'codex';
  launch(input: LaunchInput): LaunchSpec;
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
  launch({ bin, home, sessionId, model, instructionsFile, urls }) {
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
    ];
    return { command, env: { CLAUDE_CONFIG_DIR: home, ...bridgeEnv(urls) }, sessionId: id };
  },
};

export const codexProgram: TermProgram = {
  kind: 'codex',
  launch({ bin, home, workDir, sessionId, model, urls }) {
    const config = ['-c', `mcp_servers.hornhoof.url=${JSON.stringify(urls.mcpUrl)}`];
    const rest = ['--dangerously-bypass-approvals-and-sandbox', ...config, ...(model ? ['-m', model] : [])];
    /* A resumed session works in the folder it started in, which is the pane's. */
    const command = sessionId ? [bin, 'resume', sessionId, ...rest] : [bin, rest[0]!, '-C', workDir, ...rest.slice(1)];
    return { command, env: { CODEX_HOME: home, ...bridgeEnv(urls) }, sessionId };
  },
};

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
