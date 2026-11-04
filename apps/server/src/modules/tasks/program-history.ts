import type { TurnProgram } from '@hornhoof/protocol/map';

type HistoryProgram = Pick<TurnProgram, 'state' | 'tool' | 'since'>;

/* Screen changes and report arrival times update the live view, not the program's historical boundaries. */
export function sameProgram(before: HistoryProgram | null | undefined, after: HistoryProgram): boolean {
  return before?.state === after.state && before.tool === after.tool && before.since === after.since;
}
