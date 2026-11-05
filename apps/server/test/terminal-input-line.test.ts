import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputLine, isReport } from '../src/modules/terminals/input-rights.js';

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
    expect(line.take('ab', WRITER)).toBeNull();
    expect(line.take('\x7f', WRITER)).toBeNull();
    expect(line.take('/c', WRITER)).toBeNull();
    expect(line.take('\b\b\b\b\b', WRITER)).toBeNull();
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
    expect(isReport(data)).toBe(true);
  });

  it.each([
    ['an arrow', '\x1b[A'],
    ['Escape', '\x1b'],
    ['words after a report', '\x1b[Ihello'],
    ['a report after words', 'hello\x1b[I'],
    ['a function key', '\x1b[15~'],
  ])('is no %s', (_what, data) => {
    expect(isReport(data)).toBe(false);
  });
});
