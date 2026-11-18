import { describe, expect, it } from 'vitest';
import { checkCapacity, CheckQueueRequest, CheckQueueReply } from '../src/check-queue.js';
import { parseNodeMessage, parseServerMessage } from '../src/index.js';

describe('check admission measured CPU budget', () => {
  it.each([[10, 0, 2], [10, 6, 1], [10, 40, 1], [1, 0, 1], [20, 0, 4]])('admits %i CPUs at load %i as %i checks', (cpus, load, expected) => {
    expect(checkCapacity(cpus, load)).toBe(expected);
  });
  it('rejects forged identities and impossible queue positions at the boundary', () => {
    expect(CheckQueueRequest.safeParse({ type: 'check.acquire', id: '../other', label: 'check' }).success).toBe(false);
    expect(CheckQueueReply.safeParse({ type: 'check.state', id: '10000000-0000-4000-8000-000000000001', state: 'queued', position: 0 }).success).toBe(false);
  });
  it('carries queue requests and position replies through the node connection parser', () => {
    const request = { type: 'check.acquire', id: '10000000-0000-4000-8000-000000000001', label: 'checks' };
    const reply = { type: 'check.state', id: request.id, state: 'queued', position: 2 };
    expect(parseNodeMessage(JSON.stringify(request))).toEqual(request);
    expect(parseServerMessage(JSON.stringify(reply))).toEqual(reply);
  });
  it('carries optional check snapshots outside the machine load and tolerates older or invalid reports', () => {
    const load = { cpus: 1, load: 0, memFree: 1, memTotal: 2, tests: 0, jobs: 0 };
    const checkLeases = { sequence: 1, ids: ['10000000-0000-4000-8000-000000000001'] };
    const hello = { type: 'hello', version: '0.34.0', loggedIn: true, running: [], load, checkLeases };
    const reporting = { type: 'load', ...load };
    expect(parseNodeMessage(JSON.stringify(hello))).toMatchObject({ load, checkLeases });
    expect(parseNodeMessage(JSON.stringify({ ...reporting, checkLeases }))).toEqual({ ...reporting, checkLeases });
    expect(parseNodeMessage(JSON.stringify(reporting))).toEqual(reporting);
    expect(parseNodeMessage(JSON.stringify({ ...reporting, checkLeases: { ...checkLeases, ids: ['invalid'] } }))).toEqual(reporting);
  });
});
