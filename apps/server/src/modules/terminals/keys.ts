/* Every way a person's keys may end a line for the program behind tmux. Enter and a line feed, and the key sequences tmux
   turns into one or a program may read as one: CSI u and modifyOtherKeys of any key (Enter and Ctrl+M or Ctrl+J come
   as one of them), and the keypad's Enter. Such a sequence counts as Enter whatever key it names: the person who sent it
   answers for the turn, rather than nobody. */
const ENTER = /[\r\n]|\u001b(?:\[[\d;:]*u|\[27;[\d;:]*~|O[\d;]*M)/;

/* The start of such a sequence at the end of the keys, which the next keys may finish. */
const UNFINISHED = /\u001b(?:\[[\d;:]*|O[\d;]*)?$/;

/* Kept of an unfinished sequence: its start and its last characters, which say as much. */
const KEPT = 64;

/* Whether the keys press Enter, read after the unfinished end of the keys before them, and the end they leave. */
export function readKeys(before: string, data: string): { enter: boolean; rest: string } {
  const keys = before + data;
  const rest = UNFINISHED.exec(keys)?.[0] ?? '';
  return { enter: ENTER.test(keys), rest: rest.length > KEPT ? rest.slice(0, 2) + rest.slice(2 - KEPT) : rest };
}
