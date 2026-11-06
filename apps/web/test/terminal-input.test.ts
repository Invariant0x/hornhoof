import { describe, expect, it } from 'vitest';
import { TerminalInput } from '../src/ui/terminal-input';

const owner = { control: true, message: true };
const messenger = { control: false, message: true };
const watcher = { control: false, message: false };

describe('input a person may send to a program', () => {
  it('lets the subscription owner control the program and send messages', () => {
    const input = new TerminalInput();
    for (const data of ['/login', '\r', '!rm', '\r', '\x03', '\x1b', '\x1b[A', '\t']) expect(input.take(data, owner)).toEqual({ data });
  });

  it('lets someone with message access type ordinary text, paste it and press Enter', () => {
    const input = new TerminalInput();
    expect(input.take('ordinary /text !words', messenger)).toEqual({ data: 'ordinary /text !words' });
    expect(input.take('\r', messenger)).toEqual({ data: '\r' });
    expect(input.take('first\nsecond\r', messenger)).toEqual({ data: 'first\nsecond\r' });
  });

  it.each(['\x03', '\x1b', '\x1b[A', '\t', '/login', '!rm'])('refuses control input %j to someone who may only write messages', data => {
    const input = new TerminalInput();
    expect(input.take(data, messenger)).toEqual({ data: '', denied: 'control' });
  });

  it('refuses the rest of a command that arrives in separate keyboard frames', () => {
    const input = new TerminalInput();
    expect(input.take('/', messenger)).toEqual({ data: '', denied: 'control' });
    expect(input.take('l', messenger)).toEqual({ data: '', denied: 'control' });
    expect(input.take('ogin', messenger)).toEqual({ data: '', denied: 'control' });
    expect(input.take('\r', messenger)).toEqual({ data: '\r' });
    expect(input.take('hello', messenger)).toEqual({ data: 'hello' });
  });

  it('does not let a paste or a line erased with Backspace bypass the leading command check', () => {
    const input = new TerminalInput();
    expect(input.take('x', messenger)).toEqual({ data: 'x' });
    expect(input.take('\x7f', messenger)).toEqual({ data: '\x7f' });
    expect(input.take('/login\r', messenger)).toEqual({ data: '', denied: 'control' });
    expect(input.take('!rm -rf /', messenger)).toEqual({ data: '', denied: 'control' });
  });

  it('checks a command again after each Enter, including a paste with several lines', () => {
    const input = new TerminalInput();
    expect(input.take('hello\r/login', messenger)).toEqual({ data: '', denied: 'control' });
    expect(input.take('hello\r', messenger)).toEqual({ data: 'hello\r' });
    expect(input.take('/again', messenger)).toEqual({ data: '', denied: 'control' });
  });

  it('accepts bracketed ordinary paste but not a command or control keys hidden in it', () => {
    const input = new TerminalInput();
    const ordinary = '\x1b[200~ordinary /text !words\r\x1b[201~';
    expect(input.take(ordinary, messenger)).toEqual({ data: ordinary });
    expect(input.take('\x1b[200~/login\x1b[201~', messenger)).toEqual({ data: '', denied: 'control' });
    expect(input.take('\x1b[200~text\x03more\x1b[201~', messenger)).toEqual({ data: '', denied: 'control' });
  });

  it('refuses all input when the person may only watch', () => {
    const input = new TerminalInput();
    expect(input.take('hello', watcher)).toEqual({ data: '', denied: 'message' });
    expect(input.take('\r', watcher)).toEqual({ data: '', denied: 'message' });
    expect(input.take('\x03', watcher)).toEqual({ data: '', denied: 'message' });
  });
});
