import { dirname, join } from 'node:path';
import { ownFs, type AgentFs } from '../agent-fs.js';
import { bridgeEnv, type TermProgram } from '../terminal/programs.js';
import { agyPlanLimits } from './antigravity.js';

/* Antigravity CLI in a native terminal: how it launches, the files it reads first and where it logs. */

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

/* agy keeps each conversation's transcript under its HOME; a hook cannot choose another file. */
export function agyTranscript(home: string, sessionId: string): string | null {
  return /^[\w-]+$/.test(sessionId) ? join(home, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript_full.jsonl') : null;
}
