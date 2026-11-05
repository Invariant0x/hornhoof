import { randomUUID } from 'node:crypto';
import { TERM_CHUNK } from '@hornhoof/protocol';
import type { Tmux } from './tmux.js';

const VIEW_HISTORY_LINES = 5000;

const linesOf = (text: string): string[] => text.replace(/\n$/, '').split('\n');

/* What a program left on its normal screen, without the empty rows below it. Without another screen there is nothing. */
const savedRows = (text: string): string[] => {
  const rows = linesOf(text);
  while (rows.length && !rows.at(-1)!.replace(/\x1b\[[0-9;]*m/g, '').trim()) rows.pop();
  return rows;
};

/* One styled snapshot when a view opens, read at one moment. Later output belongs to the attach stream, not to wheel traffic.
   A program on its alternate screen left a screen of lines that are in neither its history nor that screen: they go between
   the two. Lines end as a terminal moves on them, and the last ends at once: the screen fills the rows the attached client
   draws over. */
export async function readViewHistory(tmux: Pick<Tmux, 'run'>, name: string): Promise<string> {
  const mark = `hh-${randomUUID()}`;
  const capture = (...more: string[]) => ['capture-pane', '-p', '-e', '-J', ...more, '-t', name];
  const said = await tmux.run([
    ...capture('-S', String(-VIEW_HISTORY_LINES)), ';', 'display-message', '-p', mark, ';',
    ...capture('-a', '-q'), ';', 'display-message', '-p', mark, ';',
    'display-message', '-p', '-t', name, '#{pane_height}',
  ]).catch(() => '');
  const [whole = '', saved = '', height = '0'] = said.split(`${mark}\n`);
  const lines = linesOf(whole);
  lines.splice(lines.length - Number(height), 0, ...savedRows(saved));
  return lines.join('\r\n');
}

/* Forward a view's output at once, in the same pieces the transport already accepts. */
export function sendTerminalOutput(send: (data: string) => void, text: string): void {
  for (let offset = 0; offset < text.length; offset += 2 * TERM_CHUNK) send(text.slice(offset, offset + 2 * TERM_CHUNK));
}
