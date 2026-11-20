import { afterEach, expect, it, vi } from 'vitest';
import type { RunResult } from '../src/runner.js';
import { atWork, cleanups } from './terminal-host-receipts-helpers.js';

/* A turn whose program finished while no end of it reached the node: the hook that said the program took Hornhoof's words,
   or the one that said it stopped, was refused on a busy machine, so the node dropped the program's own end as one of
   another turn and the turn stood, its program idle, until someone stopped it by hand. What the program shows tells the
   turn is over: its finished answer at its empty prompt, an answer it did not show before the words went in, two looks in a
   row, with nothing pending. */

afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const answered = (text: string, at: string) => `⏺ ${text}\n\n✻ Worked for 4s · done ${at}\n────────────────────\n❯ \n────────────────────\n`;
/* Longer than two of the node's looks at a running turn, which come every 5 s. */
const LOOKS_MS = 12_000;

function settled(running: Promise<RunResult>) {
  let result: RunResult | undefined;
  void running.then(done => { result = done; });
  return () => result;
}

it("ends a restarted turn whose words' hook was refused, once its program shows its new answer done at an empty prompt", async () => {
  const c = await atWork('claude', 'silent');
  const a = c.host['agents'].get('receipt')!;
  const shown = vi.spyOn(c.tmux, 'screen').mockResolvedValue(answered('What it said before.', '2:30 AM'));
  /* The program came back mid-turn and Hornhoof typed the turn's words again; no hook said the program took them. */
  await c.on(c.host['replayWords'](a, a.turn!, 'Go on.'));
  expect(a.took).toBe(false);
  const result = settled(c.running);
  /* Its own end of the turn reaches the node, which takes it for another turn's. */
  c.finish();
  await c.pass(LOOKS_MS);
  expect(result()).toBeUndefined();
  shown.mockResolvedValue(answered('What it says now.', '2:38 AM'));
  await c.pass(LOOKS_MS);
  expect(result()).toMatchObject({ ok: true, error: null });
});

it('ends a turn no end of which ever came, once its program shows its answer done at an empty prompt two looks in a row', async () => {
  const c = await atWork('claude', 'silent');
  const shown = vi.spyOn(c.tmux, 'screen').mockResolvedValue('⏺ Reading the files.\n\n✻ Thinking… (12s · esc to interrupt)\n────────────────────\n❯ \n────────────────────\n');
  const result = settled(c.running);
  await c.pass(LOOKS_MS);
  expect(result()).toBeUndefined();
  shown.mockResolvedValue(answered('All done.', '2:38 AM'));
  await c.pass(LOOKS_MS);
  expect(result()).toMatchObject({ ok: true, error: null });
});

it('leaves a turn running while its program has a call pending, whatever its screen shows', async () => {
  const c = await atWork('claude', 'silent');
  await c.host['hook']('receipt', 'tool', { tool_use_id: 'call-1', tool_name: 'Bash' });
  vi.spyOn(c.tmux, 'screen').mockResolvedValue(answered('All done.', '2:38 AM'));
  const result = settled(c.running);
  await c.pass(LOOKS_MS * 2);
  expect(result()).toBeUndefined();
});
