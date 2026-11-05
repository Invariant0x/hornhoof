import type { CheckQueueReply } from '@hornhoof/protocol';
import type { OperatorServerMessage, ProgramNodeMessage, ProgramServerMessage } from '@hornhoof/protocol/program-operator';
import { CheckClient } from './check-client.js';
import { configureCheckCommands, installCheckCommand } from './check-command-runner.js';
import { setCheckClient, withCheckSlot } from './check-queue.js';
import type { JobUser } from './isolation.js';
import type { RunInput } from './runner.js';
import type { TerminalHost } from './terminal/host.js';
import type { runTests, TestsDone } from './tests.js';

export function startCheckClient(dir: string, terminal: { user?: JobUser | null } | undefined, transport: () => ((frame: ProgramNodeMessage) => boolean) | null): CheckClient {
  const checks = new CheckClient(frame => transport()?.(frame) ?? false);
  setCheckClient(checks); configureCheckCommands(terminal?.user ?? null); installCheckCommand(dir);
  return checks;
}

export function stopChecks(checks: CheckClient, parts: ReadonlyMap<string, { stop: AbortController }>): void {
  checks.online(false);
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
    return await withCheckSlot(signal => { started(); return runPart(message, { ...options, signal }); }, { signal: options.signal, label: `Run part ${message.partId}`, onPosition: waiting });
  } catch (error) {
    return { type: 'tests.done', partId: message.partId, ok: false, exitCode: null, error: options.signal?.aborted ? 'cancelled' : 'failed', commit: null, log: error instanceof Error ? error.message : String(error) };
  }
}

export function checkGuidance(input: RunInput): RunInput {
  const guidance = 'Run every heavy local check through hh-check -- COMMAND, including tests, coverage, mutation checks and builds in any project or language. Keep preparation and cleanup in that command. The common machine queue shows your waiting position. Use run_tests or run_work for remote work.';
  return { ...input, guidance: [input.guidance, guidance].filter(Boolean).join('\n\n') };
}
