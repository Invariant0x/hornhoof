import { constants } from 'node:os';
import { stripEscapes } from './providers/process.js';

export type ProgramExit = { code: number | null; signal: NodeJS.Signals | number | null; at: string };
export type ProgramOutput = ProgramExit & { text: string; complete: boolean };

export const plainOutput = (output: string): string => stripEscapes(output).replace(/\r/g, '');

/* A signal by its name, such as SIGTERM, as Hornhoof keeps it; a number this system has no name for stays a number. */
export function signalName(signal: ProgramExit['signal']): string | null {
  if (typeof signal !== 'number') return signal;
  return Object.entries(constants.signals).find(([, value]) => value === signal)?.[0] ?? String(signal);
}

function signalText(signal: ProgramExit['signal']): string {
  if (signal === null) return 'none';
  const number = typeof signal === 'number' ? signal : constants.signals[signal];
  const name = signalName(signal);
  return `${/^\d+$/.test(name!) ? 'UNKNOWN' : name!.replace(/^SIG/, '')} (${number})`;
}

/* Capture and exit information go last, so both survive the job tail and the failure collector's shorter preview. */
export function programEnded(output: string, exit: ProgramExit, complete = true): string {
  const lines = plainOutput(output).trimEnd().split('\n').slice(-50).join('\n');
  const warning = complete ? '' : 'Output capture did not finish before the wait expired.\n';
  const last = `${warning}Program ended: code ${exit.code ?? 'none'}, signal ${signalText(exit.signal)}, at ${exit.at}`;
  return lines ? `${lines}\n${last}` : last;
}

/* Keep the full capture until jobDone can hide secrets before choosing its last lines. */
export function withProgramExit(output: string, exit: ProgramExit, complete = true) {
  return { output: programEnded(output, exit, complete), programOutput: { text: output, code: exit.code, signal: exit.signal, at: exit.at, complete } };
}
