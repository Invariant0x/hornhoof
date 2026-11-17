import { constants } from 'node:os';
import { stripEscapes } from './providers/process.js';
import { hideKeyLike, redact } from './redact.js';

export type ProgramExit = { code: number | null; signal: NodeJS.Signals | number | null; at: string };
export type ProgramOutput = ProgramExit & { text: string; complete: boolean };

export const plainOutput = (output: string): string => stripEscapes(output).replace(/\r/g, '');

export const WORDS_MAX = 200;
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/* The last line a program printed that says something, for a person to read why it ended: no terminal escapes or control
   characters, every secret the node knows and whatever looks like a key hidden, then cut to WORDS_MAX characters. None
   when it printed nothing. */
export function lastWords(output: string, secrets: string[] = []): string | null {
  const line = plainOutput(output).replace(CONTROLS, '').split('\n').map(l => l.trim()).filter(Boolean).at(-1);
  if (!line) return null;
  const shown = [...hideKeyLike(redact(line, secrets))];
  return shown.length > WORDS_MAX ? `${shown.slice(0, WORDS_MAX - 1).join('')}…` : shown.join('');
}

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
