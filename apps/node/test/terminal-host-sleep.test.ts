import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
