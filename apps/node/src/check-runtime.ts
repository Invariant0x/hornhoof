import type { CheckQueueReply } from '@hornhoof/protocol';
import type { OperatorServerMessage, ProgramNodeMessage, ProgramServerMessage } from '@hornhoof/protocol/program-operator';
import { CheckClient } from './check-client.js';
import { configureCheckCommands, installCheckCommand, type CheckCommandGuard } from './check-command-runner.js';
import { setCheckClient, withCheckSlot } from './check-queue.js';
import type { JobUser } from './isolation.js';
import type { TerminalHost } from './terminal/host.js';
import type { runTests, TestsDone } from './tests.js';
import { isAbsolute, join, relative, sep } from 'node:path';
import { classifyAgentCommand, classifyRunWork, localCommandFiles, refusalText, type CommandFiles, type CommandInput } from './command-guard.js';

export function createAgentCommandGuard(dir: string): CheckCommandGuard {
  return async (key, input) => {
    const context = await commandContext(dir, key, input.cwd);
    if (!context) return { allow: false, code: 'command_guard_unavailable', category: 'command_context' };
    return classifyAgentCommand({ ...input, ...context });
  };
}

const inside = (root: string, path: string): boolean => {
  const way = relative(root, path);
  return way !== '..' && !way.startsWith(`..${sep}`) && !isAbsolute(way);
};

/* Bridge has already checked the process owner and current turn; resolve the real agent workspace root here. */
async function commandContext(dir: string, key: string, requestedCwd: string): Promise<Pick<CommandInput, 'cwd' | 'workspaceRoot'> | null> {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(key) || !isAbsolute(requestedCwd)) return null;
  const parent = await localCommandFiles.realpath(join(dir, 'work', 'agents'));
  if (!parent) return null;
  const root = join(parent, key);
  if (await localCommandFiles.lstat(root) !== 'directory') return null;
  if (await localCommandFiles.realpath(root) !== root) return null;
  const cwd = await localCommandFiles.realpath(requestedCwd);
  if (!cwd || !inside(root, cwd)) return null;
  return { cwd, workspaceRoot: root };
}

export function startCheckClient(dir: string, terminal: { user?: JobUser | null } | undefined, transport: () => ((frame: ProgramNodeMessage) => boolean) | null): CheckClient {
  const checks = new CheckClient(frame => transport()?.(frame) ?? false);
  setCheckClient(checks); configureCheckCommands(terminal?.user ?? null, createAgentCommandGuard(dir)); installCheckCommand(dir);
  return checks;
}

export function stopChecks(checks: CheckClient, parts: ReadonlyMap<string, { stop: AbortController }>): void {
  checks.stop();
  for (const part of parts.values()) part.stop.abort(new Error('Machine check lease lost.'));
}

type ProgramControl = OperatorServerMessage | CheckQueueReply;
export const isProgramControl = (frame: ProgramServerMessage): frame is ProgramControl => frame.type.startsWith('program.') || frame.type === 'check.state';
export function applyProgramControl(frame: ProgramControl, checks: CheckClient, host: TerminalHost | null): Promise<void> | void {
  if (frame.type === 'check.state') { checks.receive(frame); return; }
  return host?.operatorMessage(frame);
}

export async function runQueuedPart(message: Parameters<typeof runTests>[0], runPart: typeof runTests, options: Parameters<typeof runTests>[1], waiting: (position: number) => void, started: () => void): Promise<TestsDone> {
  try {
    const refusal = await workCommandRefusal(message, options.dir);
    if (refusal) throw new Error(refusal);
    return await withCheckSlot(signal => { started(); return runPart(message, { ...options, signal }); }, { signal: options.signal, label: `Run part ${message.partId}`, onPosition: waiting });
  } catch (error) {
    return { type: 'tests.done', partId: message.partId, ok: false, exitCode: null, error: options.signal?.aborted ? 'cancelled' : 'failed', commit: null, log: error instanceof Error ? error.message : String(error) };
  }
}

/* No checkout exists at this boundary. Never authorize a script using files left by an older attempt. */
const unpreparedFiles: CommandFiles = { lstat: async () => null, realpath: async () => null, read: async () => null, list: async () => null };
async function workCommandRefusal(message: Parameters<typeof runTests>[0], dir: string): Promise<string | null> {
  if (message.kind !== 'work') return null;
  if (message.environment) return refusalText({ allow: false, code: 'whole_suite_local', category: 'product_tests' });
  const root = join(dir, 'runs', message.partId, message.repo ? 'repo' : 'work');
  const verdict = await classifyRunWork({ command: message.command, cwd: root, workspaceRoot: root }, unpreparedFiles);
  return verdict.allow ? null : refusalText(verdict);
}
