import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { userMessage } from './fakes/word-receipts.mjs';
import { atWork, cleanups, SESSION } from './terminal-host-receipts-helpers.js';

/* An agent's program sleeps once its turn is over and nothing waits for it: the program ends, and its pane stays with what
   it printed, for a person to scroll back through. The next turn starts it again in its session, in the same pane. */
async function atWorkThatSleeps(kind: 'claude' | 'codex' | 'kimi') {
  const c = await atWork(kind, kind === 'codex' ? 'silent' : 'queued', { watched: false });
  const launch = vi.mocked(c.tmux.launch);
  const launched = launch.getMockImplementation()!;
  launch.mockImplementation(async (...args) => {
    c.alive.mockResolvedValue(true);
    return launched(...args);
  });
  const stop = vi.spyOn(c.tmux, 'stop').mockImplementation(async () => { c.alive.mockResolvedValue(false); });
  const kill = vi.spyOn(c.tmux, 'kill');
  return { ...c, launch, stop, kill };
}

/* Someone opens the agent's terminal: tmux attaches a client of theirs, which the test plays. */
async function viewOpens(c: Awaited<ReturnType<typeof atWorkThatSleeps>>, write = true) {
  const child = Object.assign(new EventEmitter(), { stdin: { write: () => true }, stdout: new EventEmitter(), kill: () => {} });
  vi.spyOn(c.tmux, 'attach').mockReturnValue(child as never);
  vi.spyOn(c.tmux, 'run').mockResolvedValue('');
  await c.on(c.host.open({ type: 'term.open', termId: 'view', agentKey: 'receipt', cols: 80, rows: 24, write }));
  return { leaves: () => child.emit('exit') };
}

describe('a program that sleeps between turns', () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['claude', 'codex', 'kimi'] as const)('ends %s once its turn is over, keeps its pane, and starts it again there in its session for the next turn', async kind => {
    const c = await atWorkThatSleeps(kind);
    await c.pass(2000);
    expect(c.stop).not.toHaveBeenCalled();
    c.finish();
    await c.on(c.running);
    await c.until(() => c.stop.mock.calls.length > 0);
    expect(c.stop.mock.calls).toEqual([['a-receipt']]);
    expect(c.kill).not.toHaveBeenCalled();
    expect(c.host['agents'].get('receipt')).toMatchObject({ up: false, asleep: true });
    const before = c.launch.mock.calls.length;
    void c.run();
    await c.until(() => c.launch.mock.calls.length > before);
    const [name, launched] = c.launch.mock.calls.at(-1)!;
    expect(name).toBe('a-receipt');
    expect(launched.command.join(' ')).toContain(SESSION);
  });

  /* Seen on a Kimi node on 16.11: the turn after a sleep read the program's log again from its start, took the turns it
     told of for one the program still ran, and waited for that one to end. The program never started again, and every
     later turn of the agent waited too, for hours, until a person stopped each. Kimi logs each turn's words as turn.prompt,
     Codex logs task_started. */
  it.each(['codex', 'kimi'] as const)('starts %s again at once for the turn after its sleep, whatever turns its log tells of', async kind => {
    const c = await atWorkThatSleeps(kind);
    if (kind === 'kimi') c.record({ type: 'turn.prompt', agentId: 'main', input: [{ type: 'text', text: 'HANG' }] });
    c.finish();
    await c.on(c.running);
    await c.until(() => c.stop.mock.calls.length > 0);
    const before = c.launch.mock.calls.length;
    void c.run();
    await c.pass(1000);
    expect(c.launch.mock.calls.length).toBeGreaterThan(before);
  });

  /* So with a program closed for a plan the agent left, when the agent comes back to this node's plan. */
  it('starts codex again at once for a turn after its node closed it for a plan the agent left', async () => {
    const c = await atWorkThatSleeps('codex');
    const has = vi.spyOn(c.tmux, 'has').mockResolvedValue(true);
    c.kill.mockImplementation(async () => { c.alive.mockResolvedValue(false); has.mockResolvedValue(false); });
    void c.host.release('receipt', 'job-receipt');
    c.finish();
    await c.on(c.running);
    await c.until(() => c.kill.mock.calls.length > 0);
    const before = c.launch.mock.calls.length;
    void c.run();
    await c.pass(1000);
    expect(c.launch.mock.calls.length).toBeGreaterThan(before);
  });

  it('gives the turn after its sleep the answer of the program started again in its session', async () => {
    const c = await atWorkThatSleeps('claude');
    c.finish();
    await c.on(c.running);
    await c.until(() => c.stop.mock.calls.length > 0);
    const next = c.run();
    await c.until(() => c.host['agents'].get('receipt')!.busy);
    expect(c.launch).toHaveBeenCalledTimes(2);
    expect(c.host['agents'].get('receipt')).toMatchObject({ up: true, asleep: false });
    c.finish();
    expect(await c.on(next)).toMatchObject({ ok: true, sessionId: SESSION });
  });

  it('keeps a program awake while someone has its terminal open, and lets it sleep once they leave', async () => {
    const c = await atWorkThatSleeps('claude');
    const view = await viewOpens(c);
    c.finish();
    await c.on(c.running);
    await c.pass(5000);
    expect(c.stop).not.toHaveBeenCalled();
    view.leaves();
    await c.until(() => c.stop.mock.calls.length > 0);
  });

  it('keeps a program awake while words someone left sit in its input', async () => {
    const c = await atWorkThatSleeps('claude');
    const view = await viewOpens(c);
    c.finish();
    await c.on(c.running);
    await c.tmux.paste('a-receipt', 'half a thought');
    view.leaves();
    await c.pass(5000);
    expect(c.stop).not.toHaveBeenCalled();
    await c.tmux.keys('a-receipt', 'C-u');
    await c.until(() => c.stop.mock.calls.length > 0);
  });

  it('keeps the program for a turn that came while the one before it ran, and lets it sleep after that one', async () => {
    const c = await atWorkThatSleeps('claude');
    const next = c.run();
    c.finish();
    await c.on(c.running);
    await c.until(() => c.host['agents'].get('receipt')!.took === true);
    await c.pass(2000);
    expect(c.stop).not.toHaveBeenCalled();
    c.finish();
    await c.on(next);
    await c.until(() => c.stop.mock.calls.length > 0);
    expect(c.launch).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('shows the terminal of a program that sleeps as asleep, with what it printed, to one who may type: %s', async write => {
    const c = await atWorkThatSleeps('claude');
    c.finish();
    await c.on(c.running);
    await c.until(() => c.stop.mock.calls.length > 0);
    await viewOpens(c, write);
    expect(c.sent).toContainEqual({ type: 'term.program', termId: 'view', running: false, asleep: true });
    expect(c.sent.some(m => m.type === 'agent.start')).toBe(write);
  });

  it('tells a view of a program that sleeps when the program starts again', async () => {
    const c = await atWorkThatSleeps('claude');
    c.finish();
    await c.on(c.running);
    await c.until(() => c.stop.mock.calls.length > 0);
    await viewOpens(c, false);
    c.sent.length = 0;
    const next = c.run();
    await c.until(() => c.sent.some(m => m.type === 'term.program' && m.running));
    expect(c.sent.filter(m => m.type === 'term.program')).toEqual([
      { type: 'term.program', termId: 'view', running: false },
      { type: 'term.program', termId: 'view', running: true },
    ]);
    await c.until(() => c.host['agents'].get('receipt')!.busy);
    c.finish();
    await c.on(next);
  });
});

/* A program can begin a turn of its own just as the node is about to let it sleep: Codex takes the words it held once its
   turn is over and logs them as a new turn, Kimi Code takes the words it queued and says so through its hook. Seen on a
   Mac on 15.11: the program slept all the same, its node no longer watched it, and the turn it began stood running with
   no word of its program for an hour, the agent's next messages waiting behind it, until a person stopped it. */
describe('a turn a program begins as it is about to sleep', () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const programOf = (c: { sent: { type: string }[] }, jobId: string) =>
    c.sent.filter((m): m is { type: 'job.program'; jobId: string; state: string } => m.type === 'job.program' && (m as { jobId?: string }).jobId === jobId);
  const doneOf = (c: { sent: { type: string }[] }, jobId: string) =>
    c.sent.find((m): m is { type: 'job.done'; jobId: string; ok: boolean } => m.type === 'job.done' && (m as { jobId?: string }).jobId === jobId);

  type AtWork = Awaited<ReturnType<typeof atWorkThatSleeps>>;

  /* The turn the program began stands with no program: its node tells Hornhoof so and ends it, and the next turn starts the
     program again in its session. */
  async function endsGoneAndStartsAgain(c: AtWork): Promise<void> {
    expect(programOf(c, 'typed').at(-1)).toMatchObject({ state: 'gone' });
    expect(doneOf(c, 'typed')).toMatchObject({ ok: false, error: 'agent_failed' });
    const before = c.launch.mock.calls.length;
    const next = c.run();
    await c.until(() => c.launch.mock.calls.length > before);
    await c.until(() => c.host['agents'].get('receipt')!.busy);
    c.finish();
    expect(await c.on(next)).toMatchObject({ ok: true, sessionId: SESSION });
  }

  /* Codex logs a new turn of words it held once its turn is over, right after the node read its log for the last time
     before it lets the program go: as the node reads the program's input, or looks whether it still runs. */
  function heldWordsAtLastLook(c: AtWork, at: 'screen' | 'alive'): void {
    const look = vi.mocked(c.tmux[at]) as unknown as { getMockImplementation(): (...args: unknown[]) => Promise<unknown>; mockImplementation(f: (...args: unknown[]) => Promise<unknown>): void };
    const shows = look.getMockImplementation();
    let held = true;
    look.mockImplementation(async (...args) => {
      if (held && !c.host['agents'].get('receipt')!.turn) {
        held = false;
        c.record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'typed' } });
        c.record(userMessage('Words it held.', 'typed'));
      }
      return shows(...args);
    });
  }

  /* The turn Codex began opens, and its program stays while the turn runs: its node tells what the program does, and the
     turn ends with its answer. gone: how often the node ended the program so far. */
  async function typedTurnGoesOn(c: AtWork, gone: () => number): Promise<void> {
    await c.pass(1000);
    expect(c.sent.filter(m => m.type === 'turn.open')).toHaveLength(1);
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'typed', toolToken: 'token' });
    await c.pass(2000);
    expect(gone()).toBe(0);
    expect(programOf(c, 'typed').at(-1)).toMatchObject({ state: 'thinking' });
    c.record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'typed', last_agent_message: 'Typed answer.' } });
    c.drain();
    await c.pass(500);
    expect(doneOf(c, 'typed')).toMatchObject({ ok: true, result: 'Typed answer.' });
  }

  it('keeps codex up for the turn it logged from words it held while the node looked whether it may sleep', async () => {
    const c = await atWorkThatSleeps('codex');
    heldWordsAtLastLook(c, 'screen');
    c.finish();
    await c.on(c.running);
    await typedTurnGoesOn(c, () => c.stop.mock.calls.length);
    /* Once that turn is over, nothing waits for the program: it sleeps. */
    await c.until(() => c.stop.mock.calls.length > 0);
  });

  it('keeps codex up for the turn it logged from words it held while the node looked whether it may close it for a plan it left', async () => {
    const c = await atWorkThatSleeps('codex');
    const has = vi.spyOn(c.tmux, 'has').mockResolvedValue(true);
    c.kill.mockImplementation(async () => { c.alive.mockResolvedValue(false); has.mockResolvedValue(false); });
    heldWordsAtLastLook(c, 'alive');
    void c.host.release('receipt', 'job-receipt');
    c.finish();
    await c.on(c.running);
    await typedTurnGoesOn(c, () => c.kill.mock.calls.length);
    /* Once that turn is over, the program of the plan the agent left goes. */
    await c.until(() => c.kill.mock.calls.length > 0);
    expect(c.stop).not.toHaveBeenCalled();
  });

  it('ends the turn kimi began from queued words while it went to sleep, so the next turn starts it again', async () => {
    const c = await atWorkThatSleeps('kimi');
    /* Kimi takes the words it queued as tmux ends it. */
    c.stop.mockImplementation(async () => {
      await c.host['hook']('receipt', 'prompt', { prompt: 'Words it queued.' });
      c.alive.mockResolvedValue(false);
    });
    c.finish();
    await c.on(c.running);
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'typed', toolToken: 'token' });
    await c.pass(2000);
    await endsGoneAndStartsAgain(c);
  });

  it.each(['sleep', 'close'] as const)('starts kimi again at once for the next turn when it logged words it took as its node let it %s, with no word from its hook', async end => {
    const c = await atWorkThatSleeps('kimi');
    const ends = end === 'sleep' ? c.stop : c.kill;
    const has = end === 'close' ? vi.spyOn(c.tmux, 'has').mockResolvedValue(true) : null;
    ends.mockImplementation(async () => {
      if (ends.mock.calls.length === 1) c.record({ type: 'turn.prompt', agentId: 'main', input: [{ type: 'text', text: 'Words it queued.' }] });
      c.alive.mockResolvedValue(false);
      has?.mockResolvedValue(false);
    });
    if (end === 'close') void c.host.release('receipt', 'job-receipt');
    c.finish();
    await c.on(c.running);
    await c.until(() => ends.mock.calls.length > 0);
    await c.pass(1000);
    const before = c.launch.mock.calls.length;
    void c.run();
    await c.pass(1000);
    expect(c.launch.mock.calls.length).toBeGreaterThan(before);
  });

  /* Seen on the same Mac: a turn of Kimi opened 16 s after its program went to sleep, and stood with no program as well. */
  it('ends the turn kimi begins once it sleeps, so the next turn starts it again', async () => {
    const c = await atWorkThatSleeps('kimi');
    c.finish();
    await c.on(c.running);
    await c.until(() => c.stop.mock.calls.length > 0);
    const late = c.host['hook']('receipt', 'prompt', { prompt: 'Words it queued.' });
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'typed', toolToken: 'token' });
    await c.on(late);
    await c.pass(2000);
    await endsGoneAndStartsAgain(c);
  });
});
