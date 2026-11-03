import { describe, expect, it } from 'vitest';
import { parseNodeMessage } from '../src/index.js';
import { NODE_LOG_BYTES, NODE_LOG_LINES, NodeExit, NodeLog } from '../src/node-exit.js';

const exit = { startedAt: '2026-11-03T17:00:00.000Z', at: '2026-11-03T17:47:00.000Z', kind: 'planned', reason: 'node_update', log: 'Node stopping for an update.' };

describe('node restart evidence on the wire', () => {
  it('accepts graceful stop and restart evidence while keeping legacy hellos valid', () => {
    const hello = { type: 'hello', version: '0.5.0', loggedIn: true, running: [] };
    expect(parseNodeMessage(JSON.stringify(hello))).toEqual(hello);
    expect(parseNodeMessage(JSON.stringify({ ...hello, restart: exit, nodeLog: 'Node started.' }))).toMatchObject({ restart: exit, nodeLog: 'Node started.' });
    expect(parseNodeMessage(JSON.stringify({ type: 'node.stopping', startedAt: exit.startedAt, exit }))).toMatchObject({ type: 'node.stopping', exit });
  });

  it('rejects inconsistent classifications rather than presenting a crash as planned', () => {
    expect(NodeExit.safeParse({ ...exit, reason: 'out_of_memory' }).success).toBe(false);
    expect(NodeExit.safeParse({ ...exit, kind: 'unplanned', reason: 'out_of_memory', at: null }).success).toBe(true);
    expect(NodeExit.safeParse({ kind: 'unknown', reason: 'unknown', startedAt: null, at: null, log: '' }).success).toBe(true);
  });

  it('limits UTF-8 bytes and lines on received node logs', () => {
    expect(NODE_LOG_BYTES).toBe(16384);
    expect(NODE_LOG_LINES).toBe(80);
    expect(NodeLog.safeParse('x'.repeat(16384)).success).toBe(true);
    expect(NodeLog.safeParse('x'.repeat(16385)).success).toBe(false);
    expect(NodeLog.safeParse('界'.repeat(6000)).success).toBe(false);
    expect(NodeLog.safeParse(Array.from({ length: 81 }, () => 'node').join('\n')).success).toBe(false);
    expect(parseNodeMessage(JSON.stringify({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], restart: { ...exit, log: 'x'.repeat(16385) } }))).toBeNull();
  });
});
