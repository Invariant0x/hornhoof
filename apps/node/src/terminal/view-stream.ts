import { TERM_CHUNK } from '@hornhoof/protocol';
import type { Tmux } from './tmux.js';

/* One styled snapshot when a view opens. Later output belongs to the attach stream, not to wheel traffic. */
export function readViewHistory(tmux: Pick<Tmux, 'screen'>, name: string): Promise<string> {
  return tmux.screen(name, 5000, true);
}

/* Forward a view's output at once, in the same pieces the transport already accepts. */
export function sendTerminalOutput(send: (data: string) => void, text: string): void {
  for (let offset = 0; offset < text.length; offset += 2 * TERM_CHUNK) send(text.slice(offset, offset + 2 * TERM_CHUNK));
}
