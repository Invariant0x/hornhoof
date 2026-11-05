import type { RunKind } from '@hornhoof/protocol';
import { refuse } from '../tasks/engine.js';

type ModeInput = { command?: string; suite?: string; profile?: string; parts?: number };
export type TestRunMode = { mode: 'manual'; command: string; parts: number } | { mode: 'product'; suite?: string; profile?: string };
function manualMode(input: ModeInput & { command: string }): TestRunMode {
  if (input.suite !== undefined || input.profile !== undefined) throw refuse(400, 'test_mode_conflict', 'test_mode_conflict: choose a manual command or product suite/profile.');
  if (!input.command.trim()) throw refuse(400, 'task_invalid', 'A manual run needs a nonempty command.');
  return { mode: 'manual', command: input.command, parts: input.parts ?? 1 };
}
export function testRunMode(input: ModeInput, kind: RunKind): TestRunMode {
  if (input.command !== undefined) return manualMode({ ...input, command: input.command });
  if (kind === 'work' || input.parts !== undefined) throw refuse(400, 'task_invalid', 'Work needs a command; product test parts come from the pinned suite inventory.');
  return { mode: 'product', ...(input.suite === undefined ? {} : { suite: input.suite }), ...(input.profile === undefined ? {} : { profile: input.profile }) };
}
