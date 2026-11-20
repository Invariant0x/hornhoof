import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeQueue } from './fakes/word-receipts.mjs';
import { job } from './terminal-host-helpers.js';
import { atWork, cleanups, SESSION } from './terminal-host-receipts-helpers.js';

/* A person writes into the agent's terminal while Hornhoof's next turn comes, and sends their words while that turn waits
   to type its prompt. The program answers them, then the turn's own prompt: the end of that answer ends Hornhoof's turn
   on the node, and the prompt is never taken for words of the person's own. Claude Code 2.1.317 queues what it is given
   while it answers (queue-operation enqueue), and takes it after (dequeue, then the user line and its prompt hook), which
   the node may read in either order. The clock is virtual. */
const PROMPT = 'From Hornhoof: the next message.';
const MINE = 'what about the limits';

async function personWrites() {
  const c = await atWork('claude', 'queued');
  const stdin: string[] = [];
  const child = Object.assign(new EventEmitter(), { stdin: { write: (data: string) => stdin.push(data) }, stdout: new EventEmitter(), kill: () => {} });
  vi.spyOn(c.tmux, 'attach').mockReturnValue(child as never);
  vi.spyOn(c.tmux, 'run').mockResolvedValue('');
  await c.on(c.host.open({ type: 'term.open', termId: 'view', agentKey: 'receipt', cols: 80, rows: 24, write: true }));
  const press = (data: string, pressedIn?: string) => c.host.input({ type: 'term.input', termId: 'view', data, ...(pressedIn ? { pressedIn } : {}) });
  c.finish();
  await c.on(c.running);
  const a = c.host['agents'].get('receipt')!;
  /* Their draft stands in the program's input as the next turn comes. */
  press(MINE);
  await c.tmux.paste('a-receipt', MINE);
  const outcome: { result: Awaited<ReturnType<typeof c.host.run>> | null } = { result: null };
  const turn = c.host.run({ ...job('receipt', PROMPT, { jobId: 'job-2', workDir: c.workDir, sessionId: SESSION, timeoutMs: 3_600_000 }), home: c.home });
  void turn.then(result => { outcome.result = result; });
  await c.until(() => a.promptWaits === true);
  /* They press Enter, and the program takes their words. */
  press('\r', 'job-2');
  await c.tmux.keys('a-receipt', 'C-u');
  await c.on(c.host['hook']('receipt', 'prompt', { prompt: MINE }));
  const enters = () => c.keys.mock.calls.filter(call => call.includes('Enter')).length;
  const ended = async (stop: Record<string, unknown>) => {
    await c.on(c.host['hook']('receipt', 'stop', stop));
    c.record({ type: 'system', subtype: 'turn_duration', durationMs: 1 });
    c.drain();
  };
  /* The program takes the turn's prompt: what it logs, and its prompt hook, in the order asked. */
  const takes = async (order: 'log first' | 'hook first') => {
    let hook: Promise<unknown> = Promise.resolve();
    if (order === 'hook first') hook = c.host['hook']('receipt', 'prompt', { prompt: PROMPT });
    c.record(claudeQueue('dequeue', PROMPT));
    c.record({ type: 'user', message: { role: 'user', content: PROMPT } });
    c.drain();
    if (order === 'log first') hook = c.host['hook']('receipt', 'prompt', { prompt: PROMPT });
    await c.on(hook);
  };
  return { ...c, a, outcome, turn, enters, ended, takes, opens: () => c.sent.filter(m => m.type === 'turn.open') };
}

describe("a person's words sent while Hornhoof's turn waits to type its prompt", () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['log first', 'hook first'] as const)('get their answer before the prompt goes in, and the end of the prompt ends the turn (%s)', async order => {
    const c = await personWrites();
    await c.pass(1_000);
    const before = c.enters();
    await c.ended({ last_assistant_message: 'An answer for the person.' });
    await c.until(() => c.enters() > 0);
    await c.takes(order);
    await c.ended({ last_assistant_message: 'The answer of the turn.' });
    await c.pass(5_000);
    expect(c.outcome.result, 'the end of its prompt ends the turn').toMatchObject({ ok: true, result: 'The answer of the turn.' });
    expect(c.opens(), "the turn's own prompt is no turn of the person").toEqual([]);
    expect(before, 'no prompt goes into a program that answers the person').toBe(0);
  });

  /* Claude logs an entry of the turn's own words while that prompt waits: they came of the person's Enter, not Hornhoof's. */
  it("keep the turn's words waiting when Claude takes the same words of the person's, and the prompt goes in after", async () => {
    const c = await personWrites();
    c.record({ type: 'user', promptSource: 'typed', message: { role: 'user', content: PROMPT } });
    c.drain();
    expect(c.a.typing).toBe(PROMPT);
    expect(c.a.turn?.words.pending()).toEqual([PROMPT]);
    await c.pass(1_000);
    await c.ended({ last_assistant_message: 'An answer for the person.' });
    await c.until(() => c.enters() > 0);
    await c.takes('hook first');
    await c.ended({ last_assistant_message: 'The answer of the turn.' });
    await c.pass(5_000);
    expect(c.outcome.result).toMatchObject({ ok: true, result: 'The answer of the turn.' });
    expect(c.opens()).toEqual([]);
  });

  it('get their answer when they stop it themselves with Esc, and the prompt goes in after', async () => {
    const c = await personWrites();
    await c.pass(1_000);
    const before = c.enters();
    /* Claude Code's own line for it: no Stop hook and no end of a turn come. */
    c.record({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
    c.drain();
    await c.until(() => c.enters() > 0);
    await c.takes('hook first');
    await c.ended({ last_assistant_message: 'The answer of the turn.' });
    await c.pass(5_000);
    expect(c.outcome.result).toMatchObject({ ok: true, result: 'The answer of the turn.' });
    expect(c.opens()).toEqual([]);
    expect(before).toBe(0);
  });
});
