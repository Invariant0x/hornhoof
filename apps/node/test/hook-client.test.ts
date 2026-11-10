import { afterEach, describe, expect, it, vi } from 'vitest';
import { client } from './hook-test-client.js';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(close => close()));

describe('hh-hook', () => {
  it('retries an interrupted stop with the same call id and its actual pid', async () => {
    const c = await client(n => n < 3 ? 'disconnect' : 'ok', cleanups);
    await vi.waitFor(() => expect(c.calls).toHaveLength(3));
    const ids = c.calls.map(call => call.headers['x-hh-call']);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(ids).size).toBe(1);
    expect(c.calls.map(call => call.headers['x-hh-pid'])).toEqual([String(c.child.pid), String(c.child.pid), String(c.child.pid)]);
    expect(new Set(c.calls.map(call => call.text)).size).toBe(1);
    await c.closed;
    expect(c.child.exitCode).toBe(0);
    expect(c.errors()).toBe('');
  });

  it('retries timed out stops but gives up visibly after three attempts', async () => {
    const c = await client(() => 'timeout', cleanups);
    /* A diagnostic may still be in the pipe when its process exits. */
    c.stderr.pause();
    const resume = c.stderr.resume.bind(c.stderr);
    const held = vi.spyOn(c.stderr, 'resume').mockImplementation(() => c.stderr);
    const drain = () => { held.mockRestore(); resume(); };
    cleanups.push(drain);
    /* Node also resumes pipes after exit; keep that resumption behind the same real I/O gate. */
    c.child.once('exit', () => setImmediate(drain));
    for (let attempt = 1; attempt <= 3; attempt++) {
      await vi.waitFor(() => expect(c.calls).toHaveLength(attempt));
      await c.clock.advance(15_000);
    }
    await c.closed;
    expect(c.child.exitCode).toBe(0);
    expect(c.calls).toHaveLength(3);
    expect(c.errors()).toContain('not confirmed');
    expect(c.errors()).not.toContain('http://');
  });

  /* A busy node may check the caller of a start longer than a short wait: a caller gone by then is refused, and the node
     never hears that its program started. */
  it('waits for a start as long as for a stop and tries it three times', async () => {
    const c = await client(() => 'timeout', cleanups, 'start');
    for (let attempt = 1; attempt <= 3; attempt++) {
      await vi.waitFor(() => expect(c.calls).toHaveLength(attempt));
      await c.clock.advance(14_999);
      expect(c.calls).toHaveLength(attempt);
      await c.clock.advance(1);
    }
    await c.closed;
    expect(c.calls).toHaveLength(3);
    expect(new Set(c.calls.map(call => call.headers['x-hh-call'])).size).toBe(1);
  });

  it('reports an owner refusal without retrying a permanent HTTP error', async () => {
    const c = await client(() => 'forbidden', cleanups);
    await vi.waitFor(() => expect(c.errors()).toContain('403'));
    expect(c.calls).toHaveLength(1);
    expect(c.errors()).toContain('stop');
  });
});
