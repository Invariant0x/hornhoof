import type { CheckQueueRequest } from '@hornhoof/protocol';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { CheckClient } from '../src/check-client.js';

describe('node machine check leases', () => {
  it('reports positions, waits for a grant, then retains the lease until release', async () => {
    const requests: CheckQueueRequest[] = [], positions: number[] = [];
    const client = new CheckClient(frame => { requests.push(frame); return true; });
    client.online(true);
    const pending = client.acquire({ label: 'coverage', agentId: '10000000-0000-4000-8000-000000000001', onPosition: p => positions.push(p) });
    const id = requests[0]!.id;
    client.receive({ type: 'check.state', id, state: 'queued', position: 2 });
    expect(positions).toEqual([2]);
    expect(client.waiting('10000000-0000-4000-8000-000000000001')).toBe(true);
    client.receive({ type: 'check.state', id, state: 'running', position: 0 });
    const lease = await pending;
    expect(client.waiting('10000000-0000-4000-8000-000000000001')).toBe(false);
    expect(requests).toHaveLength(1);
    lease.release();
    expect(requests[1]).toEqual({ type: 'check.release', id });
  });

  it('rejects cancelled waiters with the original reason and stops work on a connection lost past a lease', async () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const requests: CheckQueueRequest[] = [];
    const client = new CheckClient(frame => { requests.push(frame); return true; });
    client.online(true);
    const cancel = new AbortController(), reason = { deadline: true };
    const pending = client.acquire({ signal: cancel.signal });
    cancel.abort(reason);
    await expect(pending).rejects.toBe(reason);
    const active = client.acquire();
    const id = requests[2]!.id;
    client.receive({ type: 'check.state', id, state: 'running', position: 0 });
    const lease = await active;
    client.online(false);
    expect(lease.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(lease.signal.aborted).toBe(true);
    lease.release();
    await expect(client.acquire()).rejects.toThrow('offline');
  });

  it('ends every lease at once when the node stops', async () => {
    const requests: CheckQueueRequest[] = [];
    const client = new CheckClient(frame => { requests.push(frame); return true; });
    client.online(true);
    const active = client.acquire();
    client.receive({ type: 'check.state', id: requests[0]!.id, state: 'running', position: 0 });
    const lease = await active;
    const waiting = client.acquire();
    client.stop();
    expect(lease.signal.aborted).toBe(true);
    await expect(waiting).rejects.toThrow('Machine check queue lease was lost.');
  });

  it('rejects an invalid request before sending or retaining it', async () => {
    const requests: CheckQueueRequest[] = [];
    const client = new CheckClient(frame => { requests.push(frame); return false; });
    client.online(true);
    await expect(client.acquire({ label: 'x'.repeat(101) })).rejects.toThrow(/label/);
    expect(requests).toEqual([]);
  });

  it('does not retain a waiter when the transport throws', async () => {
    const client = new CheckClient(() => { throw new Error('transport failed'); });
    client.online(true);
    const agentId = '10000000-0000-4000-8000-000000000003';
    await expect(client.acquire({ agentId })).rejects.toThrow('transport failed');
    expect(client.waiting(agentId)).toBe(false);
  });
});

/* #1060: a connection that drops for a moment takes no lease with it. The node holds its leases for 90 s and claims them
   again once it is back; one that stays away longer loses them, and what runs under them stops. */
describe('node machine check leases across a reconnect', () => {
  const lease = async (client: CheckClient, requests: CheckQueueRequest[]) => {
    const pending = client.acquire({ label: 'part 4' });
    const id = requests.at(-1)!.id;
    client.receive({ type: 'check.state', id, state: 'running', position: 0 });
    return { id, lease: await pending };
  };

  it('keeps a lease through a drop of 10 s and claims it again once back', async () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const requests: CheckQueueRequest[] = [];
    const client = new CheckClient(frame => { requests.push(frame); return true; });
    client.online(true);
    const { id, lease: held } = await lease(client, requests);
    client.online(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(held.signal.aborted).toBe(false);
    client.online(true);
    expect(requests.at(-1)).toEqual({ type: 'check.acquire', id, label: 'part 4', resume: true });
    client.receive({ type: 'check.state', id, state: 'running', position: 0 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(held.signal.aborted).toBe(false);
    held.release();
    expect(requests.at(-1)).toEqual({ type: 'check.release', id });
  });

  it('frees on return a lease released while away', async () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const requests: CheckQueueRequest[] = [];
    const client = new CheckClient(frame => { requests.push(frame); return true; });
    client.online(true);
    const { id, lease: held } = await lease(client, requests);
    client.online(false);
    held.release();
    expect(requests.at(-1)).not.toEqual({ type: 'check.release', id });
    client.online(true);
    expect(requests.at(-1)).toEqual({ type: 'check.release', id });
    expect(requests.filter(r => r.type === 'check.acquire')).toHaveLength(1);
  });

  it('loses a lease, and stops what runs under it, when the node stays away 90 s', async () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const requests: CheckQueueRequest[] = [];
    const client = new CheckClient(frame => { requests.push(frame); return true; });
    client.online(true);
    const { lease: held } = await lease(client, requests);
    const waiting = expect(client.acquire({ label: 'part 2' })).rejects.toThrow('Machine check queue lease was lost.');
    client.online(false);
    await vi.advanceTimersByTimeAsync(89_999);
    expect(held.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(held.signal.aborted).toBe(true);
    expect((held.signal.reason as Error).message).toBe('Machine check queue lease was lost.');
    await waiting;
  });

  it('loses the lease the server ends when the node claims it again', async () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const requests: CheckQueueRequest[] = [];
    const client = new CheckClient(frame => { requests.push(frame); return true; });
    client.online(true);
    const { id, lease: held } = await lease(client, requests);
    client.online(false);
    client.online(true);
    client.receive({ type: 'check.state', id, state: 'ended', position: 0 });
    expect(held.signal.aborted).toBe(true);
  });
});
