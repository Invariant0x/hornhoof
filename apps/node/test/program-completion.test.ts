import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { completedAnswer, completionText, idleScreen } from '../src/terminal/program-state.js';
import { codexPrompt, real } from './real-screens.js';

const done = readFileSync(new URL('./fixtures/kimi-completion/done.ansi', import.meta.url), 'utf8');
const samples = JSON.parse(readFileSync(new URL('./fixtures/kimi-completion/status-cases.json', import.meta.url), 'utf8')) as { name: string; output: string; done: boolean }[];

it.each(samples)('uses explicit Kimi completion: $name', sample => {
  expect(idleScreen('kimi', done, sample.output)).toBe(sample.done);
});

it('keeps a Kimi draft and an unknown screen open even with a done status', () => {
  const output = samples[0]!.output;
  expect(idleScreen('kimi', real('kimi-2.5.1-draft'), output)).toBe(false);
  expect(idleScreen('kimi', 'BLOCKED\n> ', output)).toBe(false);
});


it('keeps completed response continuity across toolbar changes but not response changes', () => {
  const output = samples[0]!.output;
  const proof = completionText('kimi', done, output);
  expect(proof).toContain('The review is complete');
  expect(completionText('kimi', done.replace('ctrl+t to manage tasks', 'ctrl+l to clear the screen'), output)).toBe(proof);
  expect(completionText('kimi', done.replace('The review is complete', 'The next response is complete'), output)).not.toBe(proof);
  expect(completionText('kimi', done, '')).toBeNull();
});

it('keeps all response characters and uses the latest Kimi input box in a captured history', () => {
  const output = samples[0]!.output;
  const text = done.trimStart();
  expect(completionText('kimi', text, output)).not.toBe(completionText('kimi', 'C' + text.slice(1), output));
  const history = done + '\nA newer response.\n' + done;
  expect(completionText('kimi', history, output)).not.toBe(completionText('kimi', history.replace('A newer response.', 'A different response.'), output));
});

const claudeDone = (rows: string, width: number) => `${rows}\n\n✻ Worked for 4s · done 2:30 AM\n${'─'.repeat(width)}\n❯ \n${'─'.repeat(width)}\n`;

it('gives the answer Claude Code shows done at its empty prompt in one line, without the rules of the screen width', () => {
  const answer = 'The answer, in two rows. ✻ Worked for 4s · done 2:30 AM';
  expect(completedAnswer('claude', claudeDone('⏺ The answer,\n  in two rows.', 80))).toBe(`⏺ ${answer}`);
  expect(completedAnswer('claude', `\x1b[1m${claudeDone('⏺ The answer, in two rows.', 120)}\x1b[0m`)).toBe(`⏺ ${answer}`);
  /* Only a row wholly of a rule goes: a table's rows are the answer's own. */
  expect(completedAnswer('claude', claudeDone('⏺ Rows │ kept\n├──┼──┤\n  ────', 60))).toBe('⏺ Rows │ kept ├──┼──┤ ✻ Worked for 4s · done 2:30 AM');
});

it('gives no answer of a program at work, holding a draft, or that is not Claude Code or Codex', () => {
  expect(completedAnswer('claude', claudeDone('⏺ Done.', 80).replace('❯ \n', '❯ a draft\n'))).toBeNull();
  expect(completedAnswer('claude', '⏺ Reading.\n\n✻ Thinking… (12s · esc to interrupt)\n────\n❯ \n────\n')).toBeNull();
  expect(completedAnswer('codex', `• Done.\n\nWorked for 4s • 0:04\n${codexPrompt('')}`)).toBe('• Done. Worked for 4s • 0:04');
  expect(completedAnswer('kimi', done)).toBeNull();
  expect(completedAnswer('antigravity', readFileSync(new URL('./fixtures/agy-tui/screen-done.ansi', import.meta.url), 'utf8'))).toBeNull();
});
