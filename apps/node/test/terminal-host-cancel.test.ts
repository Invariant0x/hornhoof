import { afterEach, describe, expect, it, vi } from 'vitest';
import { atTypedWork, atWork, cleanups } from './terminal-host-receipts-helpers.js';

/* How often the node pressed Escape in the agent's program so far. */
const escapes = (keys: { mock: { calls: unknown[][] } }) => keys.mock.calls.filter(call => call.slice(1).includes('Escape')).length;

describe('Hornhoof calls off a turn the node holds', () => {
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['claude', 'codex'] as const)('stops %s as on Escape once and ends a turn Hornhoof gave as stopped, though its program never says the turn ended', async kind => {
    const c = await atWork(kind, kind === 'codex' ? 'silent' : 'queued');
    let ended = false;
    void c.running.then(() => { ended = true; });
    await c.on(c.host.cancel('job-receipt'));
    /* No end signal comes: the turn ends from the call alone, in a few looks of virtual time. */
    await c.pass(100);
    expect(escapes(c.keys)).toBe(1);
    expect(ended).toBe(true);
    expect(await c.running).toMatchObject({ ok: false, error: 'cancelled' });
    /* Hornhoof asks again for a job a node still lists, and the program says its turn ended after all. */
    await c.on(c.host.cancel('job-receipt'));
    c.finish();
    await c.pass(100);
    expect(escapes(c.keys)).toBe(1);
    expect(c.sent.filter(m => m.type === 'job.done' && m.jobId === 'job-receipt')).toHaveLength(1);
  });

  it('still ends a turn a person typed as stopped, once, after one Escape', async () => {
    const c = await atTypedWork('claude', 'queued');
    const before = escapes(c.keys);
    await c.on(c.host.cancel('typed'));
    expect(c.sent.filter(m => m.type === 'job.done' && m.jobId === 'typed')).toEqual([expect.objectContaining({ ok: false, result: 'Stopped.', error: 'cancelled' })]);
    await c.on(c.host.cancel('typed'));
    await c.on(c.end());
    await c.pass(100);
    expect(escapes(c.keys) - before).toBe(1);
    expect(c.sent.filter(m => m.type === 'job.done' && m.jobId === 'typed')).toHaveLength(1);
  });

  it('does nothing for a job it does not hold', async () => {
    const c = await atWork('claude', 'queued');
    await c.on(c.host.cancel('another-job'));
    await c.pass(100);
    expect(escapes(c.keys)).toBe(0);
    expect(c.sent.filter(m => m.type === 'job.done')).toEqual([]);
  });
});
