import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { atEmptyPrompt, inputOf } from '../src/terminal/input.js';

const screen = (name: string) => readFileSync(new URL(`./fixtures/${name}-screen.txt`, import.meta.url), 'utf8');

describe('the input shown by a terminal program', () => {
  it('reads the last Claude input above the status lines', () => {
    expect(inputOf('claude', screen('claude-busy'))).toBe('');
    expect(inputOf('claude', screen('claude-busy').replace('❯ \n', '❯ abc\n'))).toBe('abc');
  });

  it('treats the dim Claude suggestion as an empty input', () => {
    expect(inputOf('claude', screen('claude-idle'))).toBe('');
  });

  it('treats the dim Codex placeholder as empty while the turn runs', () => {
    expect(inputOf('codex', screen('codex-busy'))).toBe('');
  });

  it('keeps typed text even when it matches the Codex placeholder', () => {
    expect(inputOf('codex', screen('codex-typed'))).toBe('Ask Codex to do anything');
  });

  it('ignores a dim Codex history marker when its current input is missing', () => {
    expect(inputOf('codex', 'OpenAI Codex\n\x1b[1;2m›\x1b[0m Earlier user message\nWorking.')).toBeNull();
  });

  it('reads blank lines between the Kimi input rule and its closing rule as empty', () => {
    expect(inputOf('kimi', screen('kimi-empty'))).toBe('');
  });

  it('reads typed text only from inside the Kimi box', () => {
    expect(inputOf('kimi', screen('kimi-typed'))).toBe('abc');
    expect(inputOf('kimi', screen('kimi-typed').replace(' abc\n ', ' abc\n\n second line'))).toBe('abc\n\n second line');
  });

  it('finds the Kimi box even when its rules are dim', () => {
    expect(inputOf('kimi', screen('kimi-empty').replace(/^(─.*)$/gm, '\x1b[2m$1\x1b[0m'))).toBe('');
  });

  it('reads the latest Kimi box and requires a closing rule', () => {
    expect(inputOf('kimi', screen('kimi-typed') + screen('kimi-empty'))).toBe('');
    expect(inputOf('kimi', '── input ─────\n abc\n')).toBeNull();
  });

  it('keeps the rest of a multiline prompt when its first line is empty', () => {
    expect(inputOf('codex', 'OpenAI Codex\n› \nUse the new schema.\n')).toBe('Use the new schema.');
  });

  it('returns null for a missing input or another program\'s marker', () => {
    expect(inputOf('codex', 'Program is loading.')).toBeNull();
    expect(inputOf('kimi', '❯ \n')).toBeNull();
    expect(inputOf('claude', '› \n')).toBeNull();
    expect(inputOf('antigravity', '❯ \n')).toBeNull();
  });

  it('strips escapes without confusing color values with dim text', () => {
    expect(inputOf('codex', '\x1b[1m›\x1b[0m \x1b[38;2;0;2;0mabc\x1b[0m\n')).toBe('abc');
    expect(inputOf('codex', '› \x1b[2;38;2;0;2;0mSuggestion\x1b[22mabc\x1b[0m\n')).toBe('abc');
  });
});

describe('a terminal program at its prompt with nothing typed', () => {
  it('shows so in Claude Code, Codex and Kimi Code with an empty input, and not with words in it', () => {
    expect(atEmptyPrompt('claude', screen('claude-idle'))).toBe(true);
    expect(atEmptyPrompt('claude', screen('claude-busy').replace('❯ \n', '❯ abc\n'))).toBe(false);
    expect(atEmptyPrompt('codex', screen('codex-busy'))).toBe(true);
    expect(atEmptyPrompt('codex', screen('codex-typed'))).toBe(false);
    expect(atEmptyPrompt('kimi', screen('kimi-empty'))).toBe(true);
    expect(atEmptyPrompt('kimi', screen('kimi-typed'))).toBe(false);
  });

  it("reads Hornhoof's own screen for Antigravity, whose prompt is a bold ›", () => {
    expect(atEmptyPrompt('antigravity', 'agy: done.\n\x1b[1m›\x1b[22m ')).toBe(true);
    expect(atEmptyPrompt('antigravity', 'agy: done.\n\x1b[1m›\x1b[22m go on')).toBe(false);
    expect(atEmptyPrompt('antigravity', '\x1b[1m›\x1b[22m fix the tests\nagy: running the tests')).toBe(false);
  });

  it('is not so on a screen with no prompt yet', () => {
    expect(atEmptyPrompt('claude', 'Loading...')).toBe(false);
    expect(atEmptyPrompt('kimi', 'Loading...')).toBe(false);
  });
});
