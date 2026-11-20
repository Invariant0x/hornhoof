import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunResult } from '../src/runner.js';
import { claudeTook } from '../src/terminal/program-restart.js';
import { atWork, cleanups } from './terminal-host-receipts-helpers.js';

/* Claude Code gives up on a hook as on a status line a newer one overtook: the prompt hook that would say it took Hornhoof's
   words then says nothing, and the node took the program's own end of the turn for another turn's, so the turn stood, its
   program idle, until someone stopped it by hand. Claude's own transcript records the words it took: a new entry of the
   user with exactly those words is the receipt the lost hook would have given. A tool's output, the agent's own text, a
   person's words and an entry from before the words went in are none. */

afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const WORDS = 'Go on.';
const userSaid = (content: unknown) => ({ type: 'user', message: { role: 'user', content } });

function settled(running: Promise<RunResult>) {
  let result: RunResult | undefined;
  void running.then(done => { result = done; });
  return () => result;
}

describe('an entry of Claude that shows it took these words', () => {
  it.each([
    ['the words as its text', userSaid(WORDS), true],
    ['the words with space around them', userSaid(`\n${WORDS} `), true],
    ['the words in text parts', userSaid([{ type: 'text', text: 'Go ' }, { type: 'text', text: 'on.' }]), true],
    ['a note Claude adds of its own', { ...userSaid(WORDS), isMeta: true }, false],
    ['the words said in another role', { type: 'user', message: { role: 'assistant', content: WORDS } }, false],
    ['the words beside a part of another kind', userSaid([{ type: 'text', text: WORDS }, { type: 'image', source: {} }]), false],
    ['no words at all', userSaid([]), false],
    ['an entry with no message', { type: 'user' }, false],
  ])('%s', (_what, line, took) => {
    expect(claudeTook(line, WORDS)).toBe(took);
  });
});

/* The program came back mid-turn and Hornhoof typed the turn's words again; no hook said the program took them. */
async function retyped() {
  const c = await atWork('claude', 'silent');
  const a = c.host['agents'].get('receipt')!;
  await c.on(c.host['replayWords'](a, a.turn!, WORDS));
  expect(a.took).toBe(false);
  return { c, a, result: settled(c.running) };
}

it("ends a turn whose words' hook was lost, once Claude's transcript shows it took those words and ended its turn", async () => {
  const { c, a, result } = await retyped();
  c.record(userSaid(WORDS));
  c.finish();
  await c.pass(1_000);
  expect(a.typing).toBeNull();
  expect(result()).toMatchObject({ ok: true, error: null });
});

it('takes the words from an entry that gives them as a text part', async () => {
  const { c, result } = await retyped();
  c.record(userSaid([{ type: 'text', text: WORDS }]));
  c.finish();
  await c.pass(1_000);
  expect(result()).toMatchObject({ ok: true, error: null });
});

it.each([
  ["a tool's output with the same words", userSaid([{ type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: WORDS }] }])],
  ['a line the agent itself says with the same words', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: WORDS }] } }],
  ["a person's other words", userSaid('Something else.')],
  ['words that only begin the same', userSaid(`${WORDS} And more.`)],
])('leaves the words waiting and the turn running on %s', async (_what, line) => {
  const { c, a, result } = await retyped();
  c.record(line);
  c.finish();
  await c.pass(1_000);
  expect(a.typing).toBe(WORDS);
  expect(a.took).toBe(false);
  expect(result()).toBeUndefined();
});

it('takes no entry from before the words went in as their receipt', async () => {
  const c = await atWork('claude', 'silent');
  const a = c.host['agents'].get('receipt')!;
  /* The same words, said earlier in the conversation, in the log still unread as Hornhoof types them again. */
  c.record(userSaid(WORDS));
  await c.on(c.host['replayWords'](a, a.turn!, WORDS));
  const result = settled(c.running);
  c.finish();
  await c.pass(1_000);
  expect(a.typing).toBe(WORDS);
  expect(result()).toBeUndefined();
});
