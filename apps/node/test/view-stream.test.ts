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

  it('reads styled history once without involving output or wheel traffic', async () => {
    const screen = vi.fn(async () => '\x1b[2mold\x1b[0m');
    const send = vi.fn();
    expect(await readViewHistory({ screen }, 'agent')).toBe('\x1b[2mold\x1b[0m');
    sendTerminalOutput(send, 'new');
    expect(screen).toHaveBeenCalledTimes(1);
    expect(screen).toHaveBeenCalledWith('agent', 5000, true);
    expect(send).toHaveBeenCalledWith('new');
  });
});
