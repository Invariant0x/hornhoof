import type { Terminal } from '@xterm/xterm';
/* Not yet built: the terminal closes as xterm closes it. */
export function disposeTerminal(term: Terminal): void {
  term.dispose();
}
