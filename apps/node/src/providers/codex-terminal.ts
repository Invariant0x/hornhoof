import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { bridgeEnv, type TermProgram } from '../terminal/programs.js';
import { projectDocArgs } from './codex.js';
import { CODEX_MCP_START } from './mcp-start.js';
import { CODEX_NO_AUTO_UPDATE } from './session-updates.js';

/* Codex in a native terminal: how it launches and how its session logs are found. */

/* Codex draws on an alternate screen by default, of which tmux keeps no history: on the main screen what scrolls off stays
   in the pane's history, and a person's view of the session gets it. */
const CODEX_MAIN_SCREEN = '--no-alt-screen';

/* With 90% of its plan used, Codex asks after a turn whether to switch to a cheaper model. Nobody is there to answer. Words typed into
   that question are lost and Enter answers it with the first choice, so the agent gets another model and the turn waits for nothing. */
const CODEX_NO_MODEL_QUESTION = ['-c', 'notice.hide_rate_limit_model_nudge=true'];

const CODEX_SECRET_ENV = 'HH_MCP_SECRET';

const CODEX_HOOKS = { Stop: 'stop', Interrupt: 'interrupt', PreToolUse: 'tool', PostToolUse: 'tooldone', SessionEnd: 'end' };
/* Codex gives a hook ten minutes, but its interrupt and session end hooks one second, three at most when they ask
   (codex-rs/hooks/src/engine/discovery.rs, normalize_command_hook): those ask for the three, in seconds. */
const SHORT_HOOKS = new Set(['Interrupt', 'SessionEnd']);
const CODEX_HOOK_LIMITS = { '*': 600_000, interrupt: 3_000, end: 3_000 };

export const codexProgram: TermProgram = {
  kind: 'codex',
  launch({ bin, home, workDir, sessionId, model, effort, instructionsBytes, urls }) {
    /* Codex sends the agent's secret from its environment as a bearer token, to the address that carries none. */
    const config = ['-c', `mcp_servers.hornhoof.url=${JSON.stringify(urls.mcpAddress)}`, '-c', `mcp_servers.hornhoof.bearer_token_env_var="${CODEX_SECRET_ENV}"`, ...CODEX_MCP_START, ...projectDocArgs(instructionsBytes), ...CODEX_NO_AUTO_UPDATE, ...CODEX_NO_MODEL_QUESTION, ...(effort ? ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`] : [])];
    const hooks = Object.entries(CODEX_HOOKS).flatMap(([name, event]) => ['-c', `hooks.${name}=[{hooks=[{type="command",command="hh-hook ${event}"${SHORT_HOOKS.has(name) ? ',timeout=3' : ''}}]}]`]);
    const rest = ['--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', CODEX_MAIN_SCREEN, ...hooks, ...config, ...(model ? ['-m', model] : [])];
    /* A resumed session works in the folder it started in, which is the pane's. */
    const command = sessionId ? [bin, 'resume', sessionId, ...rest] : [bin, rest[0]!, '-C', workDir, ...rest.slice(1)];
    return { command, env: { CODEX_HOME: home, [CODEX_SECRET_ENV]: urls.secret, ...bridgeEnv(urls, CODEX_HOOK_LIMITS) }, sessionId };
  },
};

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
