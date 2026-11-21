import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { inLane, type Limits } from '@hornhoof/protocol';
import { ownFs, type AgentFs } from '../agent-fs.js';
import { CRED_FILES } from '../credentials.js';
import { bridgeEnv, hook, hookCommand, readJson, type TermProgram } from '../terminal/programs.js';
import { claudeUsageLimits } from '../terminal/transcripts.js';
import { CLAUDE_UNSIGNED } from './claude-attribution.js';
import { readPrivate } from './process.js';
import { claudeMcpStart } from './mcp-start.js';
import { CLAUDE_NO_AUTO_UPDATE } from './session-updates.js';

/* Claude Code in a native terminal: how it launches, the files it reads first, where it logs and its plan's limits. */

/* Claude Code draws on an alternate screen by default, of which tmux keeps no history, and scrolls it itself: a person's
   view of the session would have nothing to scroll back to. On the main screen what scrolls off stays in the pane's
   history, and the view gets it. Claude Code's variable wins over its setting and over CLAUDE_CODE_NO_FLICKER. */
const CLAUDE_MAIN_SCREEN = { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1' } as const;

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

/* Claude Code gives a hook ten minutes, but its prompt hook thirty seconds and its session end hooks a second and a half
   unless they ask for more (code.claude.com/docs/en/hooks, "Common fields"): each asks for a minute, in seconds. */
const HOOK_S = 60;
const claudeHook = (event: string) => hook(event, HOOK_S);

export const claudeProgram: TermProgram = {
  kind: 'claude',
  launch({ bin, home, workDir, sessionId, model, effort, compactWindow, instructionsFile, urls }) {
    const id = sessionId ?? randomUUID();
    const settings = {
      ...CLAUDE_UNSIGNED,
      /* After compacting its conversation, Claude Code adds what hh-hook compact prints, which sends it back to its tools. */
      hooks: { SessionStart: [...claudeHook('start'), { matcher: 'compact', ...claudeHook('compact')[0]! }], UserPromptSubmit: claudeHook('prompt'), Stop: claudeHook('stop'), StopFailure: claudeHook('stop'), PreToolUse: claudeHook('tool'), PostToolUse: claudeHook('tooldone'), PostToolUseFailure: claudeHook('toolfail'), PermissionRequest: claudeHook('ask'), SessionEnd: claudeHook('end') },
      /* The status line hears the plan's limits; it shows nothing. */
      statusLine: { type: 'command', command: hookCommand('status') },
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
    return { command, env: { CLAUDE_CONFIG_DIR: home, ...CLAUDE_NO_AUTO_UPDATE, ...CLAUDE_MAIN_SCREEN, ...claudeMcpStart(), ...bridgeEnv(urls, { '*': HOOK_S * 1000 }), ...compact, ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}) }, sessionId: id };
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
