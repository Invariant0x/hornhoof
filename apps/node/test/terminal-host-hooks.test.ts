import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasTmux, host, job, sent, setUp, tmux, until } from './terminal-host-helpers.js';

/* What a program says through its hooks, each on its own: the turns they end run through a fake program elsewhere. */
const fire = (key: string, event: string, body: unknown = {}) => host['hook'](key, event, body);

async function quiet() {
  await setUp({ plugins: [], cols: 120, rows: 40, readyMs: 5000, lookMs: 100 });
  const key = randomUUID();
  return { key, a: host['agent'](key) };
}

/* A turn its fake program is at work on. */
async function atWork() {
  await setUp({ plugins: [], cols: 120, rows: 40, readyMs: 5000, lookMs: 100 });
  const key = randomUUID();
  const jobId = randomUUID();
  const running = host.run(job(key, 'HANG here', { jobId }));
  const a = host['agents'].get(key)!;
  await until(() => Boolean(a.took));
  return { key, a, running };
}

describe.skipIf(!hasTmux)('what a hook of a program means', () => {
  afterEach(async () => { vi.restoreAllMocks(); await host?.stop(); });

  it('nothing from an agent the host does not know', async () => {
    await quiet();
    await expect(fire('nobody', 'stop')).resolves.toBeUndefined();
  });

  it.each(['nonsense', 'constructor', '__proto__', 'hasOwnProperty'])('nothing as %s, which is a sign of life all the same', async event => {
    const { key, a } = await quiet();
    a.signAt = 0;
    await expect(fire(key, event)).resolves.toBeUndefined();
    expect(a.signAt).toBeGreaterThan(0);
  });

  it('limits and how full the context is as a status, which is no sign of life', async () => {
    const { key, a } = await quiet();
    a.signAt = 0;
    await fire(key, 'status', { rate_limits: { five_hour: { used_percentage: 12, resets_at: 1_790_000_000 } }, context_window: { used_percentage: 40 } });
    expect(a.signAt).toBe(0);
    expect(a.limits).toMatchObject({ status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.12 }] });
    expect(sent).toContainEqual({ type: 'agent.context', agentKey: key, used: 0.4 });
  });

  it('nothing new as a status that says neither, or as a body that is no object', async () => {
    const { key, a } = await quiet();
    a.limits = { status: 'allowed', windows: [] };
    await fire(key, 'status', {});
    await fire(key, 'status', 'words');
    await fire(key, 'status', null);
    expect(a.limits).toEqual({ status: 'allowed', windows: [] });
    expect(sent.filter(m => m.type === 'agent.context')).toEqual([]);
  });

  it('that the program started, under the session it names only if it names sessions', async () => {
    const { key, a } = await quiet();
    const started = vi.fn();
    a.started = { promise: Promise.resolve(), resolve: started, settled: false };
    await fire(key, 'start', { session_id: 'named-by-it' });
    expect(started).toHaveBeenCalledTimes(1);
    expect(a.sessionId).toBeNull();
    await fire(key, 'start');
    expect(a.sessionId).toBeNull();
  });

  it('that the turn stopped when the program cleared its session and stays up', async () => {
    const { key, running } = await atWork();
    await fire(key, 'end', { reason: 'clear' });
    expect(await running).toMatchObject({ ok: false, error: 'cancelled' });
  });

  it('nothing for the turn as an end of another kind while the program stays up', async () => {
    const { key, a, running } = await atWork();
    await fire(key, 'end', { reason: 'other' });
    expect(a.turn).not.toBeNull();
    await fire(key, 'stop', { last_assistant_message: 'Done.' });
    expect(await running).toMatchObject({ ok: true });
  });

  it('that the program crashed when its session is gone during a turn', async () => {
    const { key, a, running } = await atWork();
    vi.spyOn(tmux, 'alive').mockResolvedValue(false);
    await fire(key, 'end', {});
    expect(await running).toMatchObject({ ok: false, failure: { kind: 'crash' } });
    expect(a.up).toBe(false);
  });

  it('a person\'s words when they come while the turn\'s own prompt waits, whatever the turn before took', async () => {
    const { key, a } = await quiet();
    a.promptWaits = true;
    a.took = true;
    await fire(key, 'prompt', { prompt: 'from a person' });
    expect(a).toMatchObject({ personWords: true, busy: true, took: false });
  });

  it('words Claude Code only queued while the turn goes on, which leave the turn as it is', async () => {
    const { key, a, running } = await atWork();
    const before = a.turn;
    await fire(key, 'prompt', { prompt: 'queued meanwhile' });
    expect(a.turn).toBe(before);
    expect(sent.filter(m => m.type === 'turn.open')).toEqual([]);
    await fire(key, 'stop', { last_assistant_message: 'Done.' });
    expect(await running).toMatchObject({ ok: true });
  });
});
