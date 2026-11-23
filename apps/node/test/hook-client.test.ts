import { afterEach, describe, expect, it, vi } from 'vitest';
import { eventually } from '../../../test-support/eventually.mjs';
import { client } from './hook-test-client.js';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(close => close()));

describe('hh-hook', () => {
  it.each(['stop', 'start'] as const)('retries an interrupted %s with the same call id and its actual pid', async event => {
    const c = await client(n => n < 3 ? 'disconnect' : 'ok', cleanups, event);
    await eventually(() => c.calls.length === 3);
    const ids = c.calls.map(call => call.headers['x-hh-call']);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(ids).size).toBe(1);
    expect(c.calls.map(call => call.headers['x-hh-pid'])).toEqual([String(c.child.pid), String(c.child.pid), String(c.child.pid)]);
    expect(new Set(c.calls.map(call => call.text)).size).toBe(1);
    await c.closed;
    expect(c.child.exitCode).toBe(0);
    expect(c.errors()).toBe('');
  });

  it('gives up visibly on a timed out stop after its one fifty-second wait without retrying', async () => {
    const c = await client(() => 'timeout', cleanups);
    /* A diagnostic may still be in the pipe when its process exits. */
    c.stderr.pause();
    const resume = c.stderr.resume.bind(c.stderr);
    const held = vi.spyOn(c.stderr, 'resume').mockImplementation(() => c.stderr);
    const drain = () => { held.mockRestore(); resume(); };
    cleanups.push(drain);
    /* Node also resumes pipes after exit; keep that resumption behind the same real I/O gate. */
    c.child.once('exit', () => setImmediate(drain));
    await eventually(() => c.calls.length === 1);
    await c.clock.advance(50_000);
    await c.closed;
    expect(c.child.exitCode).toBe(0);
    expect(c.calls).toHaveLength(1);
    expect(c.errors()).toContain('not confirmed');
    expect(c.errors()).toContain('timeout');
    expect(c.errors()).not.toContain('http://');
  });

  /* A busy node may check the caller of a start longer than a short wait: a caller gone by then is refused, and the node
     never hears that its program started. Once that one wait runs out it stops instead of starting the check over. */
  it('waits fifty seconds for a start without sending again once that wait runs out', async () => {
    const c = await client(() => 'timeout', cleanups, 'start');
    await eventually(() => c.calls.length === 1);
    await c.clock.advance(49_999);
    expect(c.child.exitCode).toBeNull();
    expect(c.calls).toHaveLength(1);
    await c.clock.advance(1);
    await c.closed;
    expect(c.child.exitCode).toBe(0);
    expect(c.calls).toHaveLength(1);
    expect(c.errors()).toContain('not confirmed');
    expect(c.errors()).toContain('timeout');
  });

  it('reports an owner refusal without retrying a permanent HTTP error', async () => {
    const c = await client(() => 'forbidden', cleanups);
    await eventually(() => c.errors().includes('403'));
    expect(c.calls).toHaveLength(1);
    expect(c.errors()).toContain('stop');
  });
});
