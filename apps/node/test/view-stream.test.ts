import { TERM_CHUNK } from '@hornhoof/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { intoHistory, openSequence, rowsGone, sendTerminalOutput, ViewHistory } from '../src/terminal/view-stream.js';

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

  /* A pane as tmux tells of it: history rows, its limit, width, height, whether on its alternate screen, the cursor's row and column. */
  const pane = (size: number, { limit = 50000, width = 80, height = 24, alternate = 0 } = {}) => `${size} ${limit} ${width} ${height} ${alternate} 3 7\n`;
  /* What tmux says for the commands in one line, told apart by the mark in the line. */
  const says = (...parts: string[]) => (args: string[]) => {
    const mark = args.includes(';') ? args[args.indexOf(';') + 3]! : '';
    return parts.map((part, at) => (at === parts.length - 1 ? part : `${part}${mark}\n`)).join('');
  };
  const SYNC = 300;
  /* A view's history with what tmux says next, one answer a command, and what it gave and repainted. */
  const viewHistory = (...answers: ((args: string[]) => string | Promise<string>)[]) => {
    const run = vi.fn(async (args: string[]) => (answers.shift() ?? says(pane(0)))(args));
    const given: string[] = [];
    const repaint = vi.fn(async () => {});
    return { run, given, repaint, history: new ViewHistory({ run }, 'agent', text => { given.push(text); }, repaint) };
  };
  const lines = (given: string[]) => given.flatMap(text => [...text.matchAll(/\x1b\[1;1H(?!\x1b\[2K)([\s\S]*?)\n\x1b\[r/g)].flatMap(block => block[1]!.split('\x1b[0m\r\n').slice(0, -1)));

  describe('intoHistory', () => {
    it('pushes each line off two rows, whatever a terminal\'s height, and puts the cursor and its style back', () => {
      expect(intoHistory(['one', 'two'])).toBe('\x1b7\x1b[0m\x1b[1;2r\x1b[1;1H\x1b[2K\x1b[2;1H\x1b[2K\x1b[1;1Hone\x1b[0m\r\ntwo\x1b[0m\r\n\n\x1b[r\x1b8');
    });

    it('says nothing without lines', () => {
      expect(intoHistory([])).toBe('');
    });

    it('draws the rows it wiped and puts the cursor back where the program has it', () => {
      expect(intoHistory(['one'], { rows: 'top\nsecond\n', row: 3, col: 7 })).toBe('\x1b7\x1b[0m\x1b[1;2r\x1b[1;1H\x1b[2K\x1b[2;1H\x1b[2K\x1b[1;1Hone\x1b[0m\r\n\n\x1b[r\x1b[1;1Htop\x1b[0m\x1b[2;1Hsecond\x1b[0m\x1b8\x1b[4;8H');
    });
  });

  describe('openSequence', () => {
    it.each([
      ['plain words', ''],
      ['words\x1b', '\x1b'],
      ['words\x1b[', '\x1b['],
      ['words\x1b[38;5', '\x1b[38;5'],
      ['words\x1b[38;5;1m', ''],
      ['\x1b[1mwords\x1b[0m more', ''],
      ['\x1b(', '\x1b('],
      ['\x1b(B', ''],
      ['\x1b]0;a title', '\x1b]0;a title'],
      ['\x1b]0;a title\x1b', '\x1b]0;a title\x1b'],
      ['\x1b]0;a title\x07', ''],
      ['\x1b]0;a title\x1b\\', ''],
      ['\x1b7', ''],
    ])('in %j leaves %j open', (stream, open) => {
      expect(openSequence(stream)).toBe(open);
    });
  });

  describe('rowsGone', () => {
    const was = (size: number, width = 80, height = 24) => ({ size, limit: 1000, width, height });
    it.each([
      ['takes what grew', was(10), was(25), 15],
      ['takes nothing when nothing moved', was(10), was(10), 0],
      ['takes nothing at a new width, whose rows are others', was(10), was(25, 40), 0],
      ['takes nothing when a history was cleared', was(500), was(3), 0],
      ['takes nothing when rows went back on a taller screen', was(500), was(490), 0],
      ['counts what tmux dropped at the limit of a history', was(1000), was(901), 1],
      ['counts what came before tmux dropped', was(950), was(910), 60],
      ['leaves to a terminal what it loses by getting lower', was(10), was(14, 80, 20), 0],
      ['counts what scrolled while a terminal got lower', was(10), was(16, 80, 20), 2],
      ['counts what scrolled while a terminal got taller', was(10), was(16, 80, 30), 6],
    ])('%s', (_name, before, now, rows) => {
      expect(rowsGone(before, now)).toBe(rows);
    });
  });

  describe('ViewHistory', () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
    afterEach(() => { vi.useRealTimers(); });

    it('reads a pane at one moment when a view opens, and gives its history and what its normal screen keeps', async () => {
      const { history, run, given } = viewHistory(says('\x1b[2mold\x1b[0m\nolder\n', 'left\n\x1b[0m\n\n', pane(2)));
      await history.open();
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]![0].slice(0, 9)).toEqual(['capture-pane', '-p', '-e', '-J', '-S', '-5000', '-E', '-1', '-t']);
      expect(lines(given)).toEqual(['\x1b[2mold\x1b[0m', 'older', 'left']);
    });

    /* With an empty history, tmux answers a range above the screen with the screen's first row. */
    it('gives nothing of a pane without history', async () => {
      const { history, given } = viewHistory(says('first row on the screen\n', '\n', pane(0)));
      await history.open();
      expect(given.join('')).toBe('');
    });

    it('gives nothing when tmux has nothing to say', async () => {
      const { history, given, run } = viewHistory(() => { throw new Error('no such session'); });
      await history.open();
      expect(run).toHaveBeenCalledTimes(1);
      expect(given.join('')).toBe('');
    });

    it('gives the rows that left the screen once, with the screen\'s first rows, and has the screen drawn after them', async () => {
      const { history, run, given, repaint } = viewHistory(
        says('', '', pane(5)),
        says(pane(7)),
        says('\n', 'top\nsecond\n', 'new-1\nnew-2\n', pane(7)),
      );
      await history.open();
      history.saw('anything');
      await vi.advanceTimersByTimeAsync(SYNC);
      expect(run.mock.calls[2]![0].join(' ')).toContain('-S -2 -E -1');
      expect(lines(given)).toEqual(['new-1', 'new-2']);
      expect(given.join('')).toContain('\x1b[1;1Htop\x1b[0m\x1b[2;1Hsecond\x1b[0m\x1b8\x1b[4;8H');
      expect(repaint).toHaveBeenCalledTimes(1);
    });

    it('has one tick for all the output it comes in, and one after what came while it read', async () => {
      const { history, run, repaint } = viewHistory(says('', '', pane(5)), says(pane(5)), says(pane(5)));
      await history.open();
      history.saw('one');
      history.saw('two');
      await vi.advanceTimersByTimeAsync(SYNC - 1);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(SYNC);
      expect(run).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(10 * SYNC);
      expect(run).toHaveBeenCalledTimes(3);
      expect(repaint).not.toHaveBeenCalled();
    });

    it('reads again when the history moved during the read, for the rows it wants are others then', async () => {
      const { history, given } = viewHistory(
        says('', '', pane(5)),
        says(pane(6)),
        says('\n', '\n', 'second-of-them\n', pane(7)),
        says(pane(7)),
        says('\n', '\n', 'first-of-them\nsecond-of-them\n', pane(7)),
      );
      await history.open();
      history.saw('anything');
      await vi.advanceTimersByTimeAsync(SYNC);
      expect(lines(given)).toEqual(['first-of-them', 'second-of-them']);
    });

    it('tries at the next tick when the history moves at every read', async () => {
      const { history, given } = viewHistory(
        says('', '', pane(5)),
        says(pane(6)), says('\n', '\n', 'x\n', pane(7)),
        says(pane(8)), says('\n', '\n', 'x\n', pane(9)),
        says(pane(10)), says('\n', '\n', 'x\n', pane(11)),
        says(pane(6)), says('\n', '\n', 'only\n', pane(6)),
      );
      await history.open();
      history.saw('anything');
      await vi.advanceTimersByTimeAsync(SYNC);
      expect(given.join('')).toBe('');
      await vi.advanceTimersByTimeAsync(SYNC);
      expect(lines(given)).toEqual(['only']);
    });

    it('waits for the stream to end a sequence, for its lines not to go into it', async () => {
      const { history, given, run } = viewHistory(says('', '', pane(5)), says(pane(6)), says('\n', '\n', 'whole\n', pane(6)));
      await history.open();
      history.saw('words\x1b[38;5');
      await vi.advanceTimersByTimeAsync(SYNC);
      expect(run).toHaveBeenCalledTimes(1);
      history.saw(';1m');
      await vi.advanceTimersByTimeAsync(SYNC);
      expect(lines(given)).toEqual(['whole']);
    });

    it('gives nothing of a read when a sequence opened in the stream during it', async () => {
      const seen = viewHistory(says('', '', pane(5)), says(pane(6)), args => {
        seen.history.saw('\x1b[38');
        return says('\n', '\n', 'held\n', pane(6))(args);
      }, says(pane(6)), says('\n', '\n', 'whole\n', pane(6)));
      await seen.history.open();
      seen.history.saw('anything');
      await vi.advanceTimersByTimeAsync(SYNC);
      expect(seen.given.join('')).toBe('');
      seen.history.saw('m');
      await vi.advanceTimersByTimeAsync(SYNC);
      expect(lines(seen.given)).toEqual(['whole']);
    });

    it('starts over at a new width without giving what its rows became', async () => {
      const { history, given, repaint } = viewHistory(says('', '', pane(5)), says(pane(30, { width: 40 })), says(pane(32, { width: 40 })), says('\n', '\n', 'after\n', pane(32, { width: 40 })));
      await history.open();
      history.saw('anything');
      await vi.advanceTimersByTimeAsync(SYNC);
      expect(repaint).not.toHaveBeenCalled();
      history.saw('anything');
      await vi.advanceTimersByTimeAsync(SYNC);
      expect(lines(given)).toEqual(['after']);
    });

    it('gives what a normal screen keeps when the program goes to another, and no line of it again when it comes back', async () => {
      const { history, given, repaint } = viewHistory(
        says('', '', pane(5)),
        says(pane(5, { alternate: 1 })),
        says('kept-1\nkept-2\n\n', '\n', pane(5, { alternate: 1 })),
        says(pane(5)),
        says(pane(8)),
        says('\n', '\n', 'kept-1\nkept-2\nnew\n', pane(8)),
      );
      await history.open();
      history.saw('anything');
      await vi.advanceTimersByTimeAsync(SYNC);
      expect(lines(given)).toEqual(['kept-1', 'kept-2']);
      expect(repaint).toHaveBeenCalledTimes(1);
      history.saw('anything');
      await vi.advanceTimersByTimeAsync(2 * SYNC);
      history.saw('anything');
      await vi.advanceTimersByTimeAsync(SYNC);
      expect(lines(given)).toEqual(['kept-1', 'kept-2', 'new']);
      expect(repaint).toHaveBeenCalledTimes(2);
    });

    it('gives a line that only looks like one it gave before when the program left it other rows', async () => {
      const { history, given } = viewHistory(
        says('', 'kept-1\nkept-2\n\n', pane(5, { alternate: 1 })),
        says(pane(5)),
        says(pane(7)),
        says('\n', '\n', 'cleared\nkept-1\n', pane(7)),
      );
      await history.open();
      history.saw('anything');
      await vi.advanceTimersByTimeAsync(SYNC);
      history.saw('anything');
      await vi.advanceTimersByTimeAsync(2 * SYNC);
      expect(lines(given)).toEqual(['kept-1', 'kept-2', 'cleared', 'kept-1']);
    });

    it('reads nothing more once stopped', async () => {
      const { history, run } = viewHistory(says('', '', pane(5)));
      await history.open();
      history.saw('anything');
      history.stop();
      history.saw('more');
      await vi.advanceTimersByTimeAsync(10 * SYNC);
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('gives nothing of a read that ends after it stopped', async () => {
      let answer = () => {};
      const held = new Promise<string>(done => { answer = () => done(pane(6)); });
      const { history, run, given, repaint } = viewHistory(says('', '', pane(5)), () => held);
      await history.open();
      history.saw('anything');
      await vi.advanceTimersByTimeAsync(SYNC);
      history.stop();
      answer();
      await vi.advanceTimersByTimeAsync(SYNC);
      expect(run).toHaveBeenCalledTimes(2);
      expect(given.join('')).toBe('');
      expect(repaint).not.toHaveBeenCalled();
    });

    it('survives a tmux that fails while it reads', async () => {
      const { history, given } = viewHistory(says('', '', pane(5)), () => { throw new Error('no such session'); }, says(pane(6)), says('\n', '\n', 'later\n', pane(6)));
      await history.open();
      history.saw('anything');
      await vi.advanceTimersByTimeAsync(SYNC);
      history.saw('anything');
      await vi.advanceTimersByTimeAsync(SYNC);
      expect(lines(given)).toEqual(['later']);
    });
  });
});
