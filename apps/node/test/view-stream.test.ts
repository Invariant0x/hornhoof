import { TERM_CHUNK } from '@hornhoof/protocol';
import { describe, expect, it, vi } from 'vitest';
import { readViewHistory, sendTerminalOutput } from '../src/terminal/view-stream.js';

describe('terminal view stream', () => {
  it('sends every output chunk synchronously in transport-sized pieces', () => {
    const send = vi.fn();
    const text = 'x'.repeat(4 * TERM_CHUNK + 17);
    sendTerminalOutput(send, text);
    expect(send.mock.calls.map(([data]) => data)).toEqual([text.slice(0, 2 * TERM_CHUNK), text.slice(2 * TERM_CHUNK, 4 * TERM_CHUNK), text.slice(4 * TERM_CHUNK)]);
  });

  it('sends nothing for empty output', () => {
    const send = vi.fn();
    sendTerminalOutput(send, '');
    expect(send).not.toHaveBeenCalled();
  });

  /* What tmux says for the commands in one line, each of them as the test gives it, told apart by the mark the line has. */
  const saying = (whole: string, saved: string, height: number) => vi.fn(async (args: string[]) => {
    const mark = args[args.indexOf('display-message') + 2];
    return `${whole}${mark}\n${saved}${mark}\n${height}\n`;
  });

  it('reads styled history in one go, without involving output or wheel traffic', async () => {
    const run = saying('\x1b[2mold\x1b[0m\n', '\n', 1);
    const send = vi.fn();
    expect(await readViewHistory({ run }, 'agent')).toBe('\x1b[2mold\x1b[0m');
    sendTerminalOutput(send, 'new');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].slice(0, 7)).toEqual(['capture-pane', '-p', '-e', '-J', '-S', '-5000', '-t']);
    expect(send).toHaveBeenCalledWith('new');
  });

  it('puts what a program left on its normal screen between its history and its alternate screen', async () => {
    const run = saying('old-1\nold-2\nalt-1\nalt-2\n', 'left-1\nleft-2\n\x1b[0m\n\n', 2);
    expect(await readViewHistory({ run }, 'agent')).toBe('old-1\r\nold-2\r\nleft-1\r\nleft-2\r\nalt-1\r\nalt-2');
  });

  it('gives nothing when tmux has nothing to say', async () => {
    expect(await readViewHistory({ run: async () => { throw new Error('no such session'); } }, 'agent')).toBe('');
  });
});
