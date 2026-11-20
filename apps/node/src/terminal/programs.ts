import { readFileSync } from 'node:fs';
import type { Limits } from '@hornhoof/protocol';
import type { JobUser } from '../isolation.js';
import type { AgentUrls } from './bridge.js';

/* What a program in a native terminal is to the host. Each provider's own program, how it launches and where it keeps its
   logs and limits, is that provider's: providers/claude-terminal.ts, codex-terminal.ts, kimi-terminal.ts and
   antigravity-terminal.ts. */

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

/* Shared by the programs: the bridge they reach Hornhoof through, and their hooks into hh-hook. */
export const bridgeEnv = (urls: AgentUrls) => ({
  HH_BRIDGE: urls.hookUrl,
  /* hh-attach sends pictures through the bridge, which adds the turn's token; it only needs something to send. */
  HH_ATTACH_URL: urls.attachUrl,
  HH_ATTACH_PASS: 'bridge',
  COLORTERM: 'truecolor',
});

/* A program that runs a hook command in a shell and gives up on it ends that shell: exec makes the shell the hook, so the hook
   ends with it instead of calling the bridge later as an orphan that no pane holds. */
export const hookCommand = (event: string) => `exec hh-hook ${event}`;
export const hook = (event: string) => [{ hooks: [{ type: 'command', command: hookCommand(event) }] }];

/* A JSON file a program keeps, or nothing when it is missing or not JSON. */
export function readJson(file: string): Record<string, unknown> {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}
