import type { NodeMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPORT_MS } from '../src/terminal/program-state.js';
import { atWork, cleanups, TEXT } from './terminal-host-receipts-helpers.js';

/* Kimi Code 2.6.3 starts turns of its own. Words steered into a running turn end that turn, and Kimi goes on with them in
   a new turn in the same second (prompt.steered, turn.ended, then turn.prompt with trigger notify). A bash job it ran in
   the background wakes it once it ends, in a turn whose origin is that task. The ids and words here are made up. */
const prompt = (text: string, origin: Record<string, unknown>, trigger: string) =>
  ({ type: 'turn.prompt', agentId: 'main', input: [{ type: 'text', text }], origin, trigger });
const WAKE = 'The background task bash-1 completed.';
const ended = { type: 'turn.ended', agentId: 'main', reason: 'completed' };
const said = (text: string) => ({ type: 'context.append_loop_event', agentId: 'main', event: { type: 'content.part', part: { type: 'text', text } } });
const programOf = (sent: NodeMessage[], jobId: string) => sent.filter(m => m.type === 'job.program' && m.jobId === jobId);

describe("Kimi Code's turns of its own", () => {
  afterEach(async () => {
    vi.spyOn(Date, 'now').mockRestore();
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the job's turn, its tool token and its program state through a steer split", async () => {
    const c = await atWork('kimi', 'queued');
    const a = c.host['agents'].get('receipt')!;
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.record({ ...ended, turnId: 0 });
    c.record(prompt(TEXT, { kind: 'user' }, 'notify'));
    c.drain();
    /* Kimi's stop hook tells of the turn it ended at the split. */
    await c.on(c.host['hook']('receipt', 'stop', {}));
    expect(c.sent.filter(m => m.type === 'job.done')).toEqual([]);
    expect(a.turn?.jobId).toBe('job-receipt');
    expect(c.host['bridge']['tokens'].get('receipt')).toBe('tok-turn');
    const before = c.sent.length;
    await c.pass(REPORT_MS + 100);
    expect(programOf(c.sent.slice(before), 'job-receipt').length).toBeGreaterThan(0);
    c.record(said('Built with the new words.'));
    c.finish();
    expect(await c.on(c.running)).toMatchObject({ ok: true, result: 'Built with the new words.' });
    expect(c.host['bridge']['tokens'].get('receipt')).toBeUndefined();
    /* The words went into the turn, which went on with them: none of them is given again. */
    c.expire();
    expect(c.unheard()).toEqual([]);
  });

  /* An older Kimi leaves steered words waiting for a next turn and goes on with nothing: the turn ends as it said. */
  it('ends the turn once Kimi does not go on within the wait after a split, its stop hook or not', async () => {
    const c = await atWork('kimi', 'queued');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.record(said('Stopped short.'));
    c.record({ ...ended, turnId: 0 });
    c.drain();
    let stopped = false;
    const stopping = c.host['hook']('receipt', 'stop', {}).then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(2900);
    expect(c.sent.filter(m => m.type === 'job.done')).toEqual([]);
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    await stopping;
    expect(await c.on(c.running)).toMatchObject({ ok: true, result: 'Stopped short.' });
    expect(c.host['bridge']['tokens'].get('receipt')).toBeUndefined();
  });

  it.each([
    ['with', true],
    ['without', false],
  ])('runs a wake of its own after the job ended %s a prompt hook, with no turn left unbound and silent', async (_, hook) => {
    const c = await atWork('kimi', 'queued');
    const a = c.host['agents'].get('receipt')!;
    c.finish();
    expect(await c.on(c.running)).toMatchObject({ ok: true });
    c.record(prompt(WAKE, { kind: 'task', taskId: 'bash-1', status: 'completed' }, 'notify'));
    c.drain();
    if (hook) void c.host['hook']('receipt', 'prompt', { prompt: [{ type: 'text', text: WAKE }] });
    await c.pass(100);
    /* Hornhoof opens no turn of a person's for words no person typed, and gives such a turn no job. */
    for (const open of c.sent.filter(m => m.type === 'turn.open')) {
      c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: null, toolToken: null, ...(open.ref ? { ref: open.ref } : {}) });
    }
    await c.pass(100);
    expect(a.turn === null || a.turn.jobId !== null).toBe(true);
    expect(c.host['bridge']['tokens'].get('receipt')).toBeUndefined();
    /* Hornhoof's next turn waits for the wake, well within the time it has for that, and tells what the program does. */
    const before = c.sent.length;
    const next = c.run();
    await c.pass(1000);
    expect(a.turn).toBeNull();
    expect(programOf(c.sent.slice(before), 'job-receipt')).toEqual([expect.objectContaining({ state: 'thinking' })]);
    /* Once the wake is over, the next turn's prompt goes in at once. */
    c.record(said('Saw the build pass.'));
    c.record(ended);
    c.drain();
    await c.pass(1000);
    expect(a.turn?.jobId).toBe('job-receipt');
    expect(a.took).toBe(true);
    c.finish();
    expect(await c.on(next)).toMatchObject({ ok: true });
  });
});
