import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { idleScreen } from '../src/terminal/program-state.js';
import { real } from './real-screens.js';

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
