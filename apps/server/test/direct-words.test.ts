import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { clearlyAnswered } from '../src/modules/tasks/direct-words.js';

/* What a person's words to an agent point at is read from words of any length that anyone who may write to the agent sends:
   reading them must take time in step with their length, or one message stops the server for everyone. */

const question = (number: number, text: string) => ({ taskId: `t${number}`, number, text });
const size = question(7, 'Which size should the banner be?');
const date = question(8, 'Which date do we launch?');

/* How long reading the words takes, in milliseconds. */
function timed(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

describe("what a person's words point at", () => {
  it('reads a message of a hundred thousand blank lines at once, and it points at none', () => {
    const said = `${'\n'.repeat(100_000)}ok`;
    let at: unknown[] = [size];
    expect(timed(() => (at = clearlyAnswered([size, date], said)))).toBeLessThan(1_000);
    expect(at).toEqual([]);
  });

  it('reads a megabyte of quoted lines against long questions at once', () => {
    const long = [1, 2, 3].map(n => question(n, `${'word '.repeat(400)}${n}`));
    let said = '';
    for (let n = 0; said.length < 1_000_000; n++) said += `> line ${n}\n`;
    let at: unknown[] = [long[0]];
    expect(timed(() => (at = clearlyAnswered(long, said)))).toBeLessThan(1_000);
    expect(at).toEqual([]);
  });

  it('takes a quoted line after blank lines and indentation as a quote', () => {
    expect(clearlyAnswered([size, date], '\n\n  > Which size should the banner be?\nTwo metres.')).toEqual([size]);
    expect(clearlyAnswered([size, date], 'Two metres.\n\t> Which size')).toEqual([size]);
  });

  it('takes a lone ">" as no quote, not the line after it', () => {
    expect(clearlyAnswered([size, date], '>\nWhich size\nTwo metres.')).toEqual([]);
  });
});
