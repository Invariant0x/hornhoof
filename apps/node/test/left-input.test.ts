import { describe, expect, it } from 'vitest';
import { eraseKeys, holdsFoldedPaste, isOwnLeft, leftRef, LeftInputs, typesWords } from '../src/terminal/left-input.js';

describe('what a program\'s input holds', () => {
  const own = { text: 'A prompt that is long enough to tell apart from the words of a person.', jobId: 'job', at: 100 };

  it.each([
    ['the prompt itself', own.text, null, true],
    ['the prompt, wrapped by the screen', 'A prompt that is long enough\nto tell apart from the words of a person.', null, true],
    ['a long piece of it, as a screen too small shows it', 'long enough to tell apart from the words of a person.', null, true],
    ['a short piece of it, which anybody may write', 'A prompt', null, false],
    ['what the program shows for a long paste', '[Pasted text #1 +40 lines]', null, true],
    ['that with more words', '[Pasted text #1 +40 lines] and more', null, false],
    ['other words', 'Something else entirely.', null, false],
    ['the prompt, with a key of a person after it', own.text, 101, false],
    ['the prompt, with a key of a person before it', own.text, 99, true],
    ['the prompt, with a key at the same moment', own.text, 100, true],
  ])('takes %s as Hornhoof\'s or not', (_what, input, typedAt, expected) => {
    expect(isOwnLeft(own, typedAt, input)).toBe(expected);
  });

  it('takes nothing as Hornhoof\'s when no prompt of a turn it gave up on is known', () => {
    expect(isOwnLeft(null, null, own.text)).toBe(false);
    expect(isOwnLeft(undefined, undefined, own.text)).toBe(false);
  });

  it.each([
    ['[Pasted text #1 +40 lines]', true],
    ['words [Pasted Content 1024 chars] words', true],
    ['[pasted text]', true],
    ['Pasted text in plain words', false],
    ['[Other text]', false],
  ])('tells %s as a folded paste or not', (input, expected) => {
    expect(holdsFoldedPaste(input)).toBe(expected);
  });

  it.each([
    ['words', true],
    ['\x1b[200~pasted\x1b[201~', true],
    ['\r', false],
    ['\x03', false],
    ['\x1b', false],
    ['\x7f', false],
    ['\x1b[A', false],
    ['\x1bOA', false],
    ['\x1b[<64;10;20M', false],
    ['\x1b[?1;2c', false],
    ['é', true],
  ])('tells whether the keys %j leave words', (data, expected) => {
    expect(typesWords(data)).toBe(expected);
  });

  it('erases each line, and never presses Escape', () => {
    expect(eraseKeys('one')).toEqual(['C-u']);
    expect(eraseKeys('one\ntwo\nthree')).toEqual(['C-u', 'BSpace', 'C-u', 'BSpace', 'C-u']);
  });

  it('names the same words for the same turn alike, however the screen wraps them', () => {
    expect(leftRef('job', 'some words')).toBe(leftRef('job', ' some\nwords '));
    expect(leftRef('job', 'some words')).not.toBe(leftRef('other', 'some words'));
    expect(leftRef('job', 'some words')).not.toBe(leftRef('job', 'other words'));
    expect(leftRef(null, 'some words')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('words Hornhoof is asked to keep', () => {
  const frame = (ref: string) => ({ agentKey: 'a', jobId: null, text: 'words', typed: false, ref });

  it('says it keeps them once Hornhoof answers, and asks only once then', async () => {
    const sent: unknown[] = [];
    const inputs = new LeftInputs(m => sent.push(m), 1000);
    const asked = inputs.keep(frame('one'));
    expect(inputs.isKept('one')).toBe(false);
    inputs.kept('one');
    expect(await asked).toBe(true);
    expect(await inputs.keep(frame('one'))).toBe(true);
    expect(sent).toEqual([{ type: 'agent.input_left', ...frame('one') }]);
  });

  it('says it does not when Hornhoof stays silent, and asks again', async () => {
    const sent: unknown[] = [];
    const inputs = new LeftInputs(m => sent.push(m), 5);
    expect(await inputs.keep(frame('one'))).toBe(false);
    expect(await inputs.keep(frame('one'))).toBe(false);
    expect(sent).toHaveLength(2);
  });

  it('counts an answer that comes late', async () => {
    const inputs = new LeftInputs(() => {}, 5);
    expect(await inputs.keep(frame('one'))).toBe(false);
    inputs.kept('one');
    expect(inputs.isKept('one')).toBe(true);
  });

  it('remembers a bounded number of answers', () => {
    const inputs = new LeftInputs(() => {}, 5);
    for (let i = 0; i < 65; i++) inputs.kept(`ref-${i}`);
    expect(inputs.isKept('ref-0')).toBe(false);
    expect(inputs.isKept('ref-64')).toBe(true);
  });
});
