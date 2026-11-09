import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { ownTerminal } from '../src/providers/antigravity.js';

it("shows agy's terms only on the terminal of the person who runs the install command", () => {
  const tty = Object.assign(new PassThrough(), { isTTY: true });
  expect(ownTerminal(tty, tty)).toBe(true);
  expect(ownTerminal(new PassThrough(), tty)).toBe(false);
  const pipe = new PassThrough();
  expect(ownTerminal(pipe, pipe)).toBe(false);
});
