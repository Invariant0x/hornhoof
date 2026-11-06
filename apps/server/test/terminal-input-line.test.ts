import { afterEach, describe, expect, it, vi } from 'vitest';
import { isTerminalReport } from '@hornhoof/protocol';
import { InputLine } from '../src/modules/terminals/input-rights.js';

const OWNER = { control: true, message: true };
const WRITER = { control: false, message: true };
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

describe('what a program hears of a person who may write nothing', () => {
  it('nothing at all, words or Enter', () => {
    const line = new InputLine();
    expect(line.take('hello', { control: false, message: false })).toBe('message');
    expect(line.take('\r', { control: false, message: false })).toBe('message');
  });
});

describe('the line of a program, as its terminals made it', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('starts empty, where / and ! are refused', () => {
    expect(new InputLine().take('/login', WRITER)).toBe('control');
    expect(new InputLine().take('!ls', WRITER)).toBe('control');
  });

  it('holds words after which / is one more letter', () => {
    const line = new InputLine();
    expect(line.take('a', WRITER)).toBeNull();
    expect(line.take('/b', WRITER)).toBeNull();
  });

  it('is empty again after an Enter, in the frame or after it', () => {
    const line = new InputLine();
    expect(line.take('a\r', WRITER)).toBeNull();
    expect(line.take('/x', WRITER)).toBe('control');
    expect(line.take('\n', WRITER)).toBeNull();
    expect(line.take('b\n/x', WRITER)).toBe('control');
  });

  it('gets shorter as a person erases, and no shorter than empty', () => {
    const line = new InputLine();
    for (const key of ['a', 'b', '\x7f']) expect(line.take(key, WRITER)).toBeNull();
    expect(line.take('/c', WRITER)).toBeNull();
    expect(line.take('\x7f\x7f\x7f\x7f\x7f', WRITER)).toBeNull();
    expect(line.take('/x', WRITER)).toBe('control');
  });

  it('refuses the rest of a command typed key by key, and its Enter lets the next line go', () => {
    const line = new InputLine();
    expect(line.take('/', WRITER)).toBe('control');
    expect(line.take('login', WRITER)).toBe('control');
    expect(line.take('\r', WRITER)).toBeNull();
    expect(line.take('hello', WRITER)).toBeNull();
  });

  it('refuses words that come with that Enter, and takes the line for empty after them', () => {
    const line = new InputLine();
    expect(line.take('/', WRITER)).toBe('control');
    expect(line.take('login\r', WRITER)).toBe('control');
    expect(line.take('/again', WRITER)).toBe('control');
  });

  it('does not take a whole line of command with its Enter for one to go on with', () => {
    const line = new InputLine();
    expect(line.take('/login\r', WRITER)).toBe('control');
    expect(line.take('hello', WRITER)).toBeNull();
  });

  it('takes an owner over a command that was refused', () => {
    const line = new InputLine();
    expect(line.take('/', WRITER)).toBe('control');
    expect(line.take('x', OWNER)).toBeNull();
    expect(line.take('/y', WRITER)).toBeNull();
  });

  it('counts what an owner wrote, pasted or erased', () => {
    const line = new InputLine();
    expect(line.take(paste('ab'), OWNER)).toBeNull();
    expect(line.take('/c', WRITER)).toBeNull();
    const erased = new InputLine();
    erased.take('a', OWNER);
    erased.take('\x7f', OWNER);
    expect(erased.take('/c', WRITER)).toBe('control');
  });

  it('takes the line for empty after a key of an owner that steers', () => {
    const line = new InputLine();
    line.take('words', OWNER);
    line.take('\x15', OWNER);
    expect(line.take('/x', WRITER)).toBe('control');
  });

  it('lets an owner start a command, and then the rest of that line goes for anyone', () => {
    const line = new InputLine();
    expect(line.take('/x', OWNER)).toBeNull();
    expect(line.take('y', WRITER)).toBeNull();
  });

  it('holds what it knows for 30 seconds of quiet and no longer', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const line = new InputLine();
    expect(line.take('a', WRITER)).toBeNull();
    now.mockReturnValue(1_029_999);
    expect(line.take('/b', WRITER)).toBeNull();
    now.mockReturnValue(1_060_000);
    expect(line.take('/c', WRITER)).toBe('control');
  });

  it('is empty when Hornhoof says so', () => {
    const line = new InputLine();
    line.take('a', WRITER);
    line.empty();
    expect(line.take('/b', WRITER)).toBe('control');
  });

  it('takes spaces before / and ! for an empty line, as a program may trim them', () => {
    expect(new InputLine().take(' /login', WRITER)).toBe('control');
    expect(new InputLine().take('\u00a0!ls', WRITER)).toBe('control');
    const line = new InputLine();
    expect(line.take('  ', WRITER)).toBeNull();
    expect(line.take('/x', WRITER)).toBe('control');
    expect(new InputLine().take(' a/b', WRITER)).toBeNull();
    const typed = new InputLine();
    expect(typed.take(' /', WRITER)).toBe('control');
    expect(typed.take('login', WRITER)).toBe('control');
  });

  describe('takes the line for empty when an erase may have taken more than it can count', () => {
    const typed = (line: InputLine, keys: string[], rights = WRITER) => { for (const key of keys) line.take(key, rights); };

    it.each<[string, string[]]>([
      ['a letter and its accent', ['e', '\u0301']],
      ['a family of people', ['\u{1F468}', '\u200d', '\u{1F469}']],
      ['a flag', ['\u{1F1FA}', '\u{1F1F8}']],
      ['a hand and its skin tone', ['\u{1F44D}', '\u{1F3FB}']],
      ['a heart in color', ['\u2764', '\ufe0f']],
      ['a digit on a key', ['1', '\ufe0f', '\u20e3']],
      ['a Hangul syllable of its parts', ['\u1112', '\u1161']],
      ['a Thai letter and its vowel', ['\u0e01', '\u0e33']],
      ['a number sign before its digit', ['\u0600', '1']],
    ])('after %s, typed key by key', (_what, keys) => {
      for (const command of ['/x\r', '!id\r']) {
        const line = new InputLine();
        typed(line, keys);
        expect(line.take('\x7f', WRITER)).toBeNull();
        expect(line.take(command, WRITER)).toBe('control');
      }
    });

    it('with the erase and the command in one frame', () => {
      expect(new InputLine().take('e\u0301\x7f/x\r', WRITER)).toBe('control');
      expect(new InputLine().take('e\u0301\x7f!id\r', WRITER)).toBe('control');
    });

    it('after what an owner typed the same way', () => {
      const line = new InputLine();
      typed(line, ['e', '\u0301'], OWNER);
      expect(line.take('\x7f', WRITER)).toBeNull();
      expect(line.take('/x\r', WRITER)).toBe('control');
    });

    it('after an owner erased a command in one frame', () => {
      const line = new InputLine();
      line.take('/\x7f', OWNER);
      expect(line.take('/x\r', WRITER)).toBe('control');
    });

    it('after a paste, which a program may hold and erase as one', () => {
      for (const rights of [WRITER, OWNER]) {
        const line = new InputLine();
        line.take(paste('a long text\nof two lines'), rights);
        expect(line.take('\x7f', WRITER)).toBeNull();
        expect(line.take('/x\r', WRITER)).toBe('control');
      }
    });

    it('after several keys in a frame, which a program may take for a paste', () => {
      const line = new InputLine();
      line.take('hello', WRITER);
      expect(line.take('\x7f', WRITER)).toBeNull();
      expect(line.take('/x\r', WRITER)).toBe('control');
    });

    it('after Ctrl+Backspace, which a program may take for a whole word', () => {
      const line = new InputLine();
      typed(line, ['a', 'b']);
      expect(line.take('\b', WRITER)).toBeNull();
      expect(line.take('/x\r', WRITER)).toBe('control');
    });

    it('and still takes the words typed after it for words', () => {
      const line = new InputLine();
      typed(line, ['e', '\u0301', '\x7f', 'a']);
      expect(line.take('/x', WRITER)).toBeNull();
    });

    it('and knows each key again once that line has ended', () => {
      const line = new InputLine();
      typed(line, ['e', '\u0301', '\r', 'a', 'b', '\x7f']);
      expect(line.take('/x', WRITER)).toBeNull();
    });
  });

  it.each<[string, string]>([
    ['a zero width space', '\u200b'],
    ['a joiner', '\u2060'],
    ['a byte order mark', '\ufeff'],
    ['a soft hyphen', '\u00ad'],
    ['a direction mark', '\u200e'],
    ['an accent with no letter', '\u0301'],
    ['a private character', '\ue000'],
  ])('does not let %s start a line, as a program may leave it out', (_what, mark) => {
    expect(new InputLine().take(`${mark}/x\r`, WRITER)).toBe('control');
    expect(new InputLine().take(`${mark}!id\r`, WRITER)).toBe('control');
    const line = new InputLine();
    expect(line.take(mark, WRITER)).toBeNull();
    expect(line.take('/x\r', WRITER)).toBe('control');
  });

  it.each<[string, string[]]>([
    ['Russian', ['\u043f', '\u0440', '\u0438']],
    ['Chinese', ['\u4e2d', '\u6587', '\u5b57']],
    ['a Hangul syllable made whole', ['\uac00', '\ub098', '\ub2e4']],
    ['one picture each', ['\u{1F44D}', '\u{1F600}', '\u{1F680}']],
    ['Latin letters with their accent built in', ['\u00e9', '\u00e8', '\u00ea']],
  ])('counts %s typed key by key and erased one at a time', (_what, keys) => {
    const line = new InputLine();
    for (const key of keys) expect(line.take(key, WRITER)).toBeNull();
    expect(line.take('\x7f', WRITER)).toBeNull();
    expect(line.take('!', WRITER)).toBeNull();
    const emptied = new InputLine();
    for (const key of keys) emptied.take(key, WRITER);
    [...keys].forEach(() => emptied.take('\x7f', WRITER));
    expect(emptied.take('!', WRITER)).toBe('control');
  });

  it('knows the 8-bit form of what starts a steering sequence', () => {
    expect(new InputLine().take('\u009b1;2A', WRITER)).toBe('control');
    expect(new InputLine().take(paste('\u009bA'), WRITER)).toBe('control');
    expect(new InputLine().take('\u0085', WRITER)).toBe('control');
  });

  it('lets no steering key into a paste, but its lines and letters of any alphabet go', () => {
    const line = new InputLine();
    expect(line.take(paste('один\nдва'), WRITER)).toBeNull();
    expect(line.take(paste(`a\x7fb`), WRITER)).toBe('control');
    expect(line.take(paste('a\tb'), WRITER)).toBe('control');
  });
});

describe('what a terminal itself answers, and no person typed', () => {
  it.each([
    ['focus in', '\x1b[I'],
    ['focus out', '\x1b[O'],
    ['device attributes', '\x1b[?1;2c'],
    ['secondary attributes', '\x1b[>0;276;0c'],
    ['cursor position', '\x1b[12;3R'],
    ['a mouse click', '\x1b[<0;10;20M'],
  ])('%s', (_what, data) => {
    expect(isTerminalReport(data)).toBe(true);
  });

  it.each([
    ['an arrow', '\x1b[A'],
    ['Escape', '\x1b'],
    ['words after a report', '\x1b[Ihello'],
    ['a report after words', 'hello\x1b[I'],
    ['a function key', '\x1b[15~'],
  ])('is no %s', (_what, data) => {
    expect(isTerminalReport(data)).toBe(false);
  });
});
