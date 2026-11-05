import type { CheckQueueRequest } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
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

  it('rejects cancelled waiters with the original reason and stops work on a lost connection', async () => {
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
    expect(lease.signal.aborted).toBe(true);
    lease.release();
    await expect(client.acquire()).rejects.toThrow('offline');
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
