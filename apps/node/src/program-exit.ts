import { constants } from 'node:os';
import { stripEscapes } from './providers/process.js';

export type ProgramExit = { code: number | null; signal: NodeJS.Signals | number | null; at: string };

function signalText(signal: ProgramExit['signal']): string {
  if (signal === null) return 'none';
  const number = typeof signal === 'number' ? signal : constants.signals[signal];
  const name = typeof signal === 'string' ? signal : Object.entries(constants.signals).find(([, value]) => value === number)?.[0];
  return `${name?.replace(/^SIG/, '') ?? 'UNKNOWN'} (${number})`;
}

/* Capture and exit information go last, so both survive the job tail and the failure collector's shorter preview. */
export function programEnded(output: string, exit: ProgramExit, complete = true): string {
  const lines = stripEscapes(output).replace(/\r/g, '').trimEnd().split('\n').slice(-50).join('\n');
  const warning = complete ? '' : 'Output capture did not finish before the wait expired.\n';
  const last = `${warning}Program ended: code ${exit.code ?? 'none'}, signal ${signalText(exit.signal)}, at ${exit.at}`;
  return lines ? `${lines}\n${last}` : last;
}
