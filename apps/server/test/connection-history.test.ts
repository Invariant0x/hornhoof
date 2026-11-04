import type { ConnectionEnd, NodeReconnect } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { connectionHistory, type ConnectionRow } from '../src/modules/nodes/connection-history.js';

const NOW = new Date('2026-11-04T20:00:00Z');
const ago = (minutes: number, seconds = 0) => new Date(NOW.getTime() - minutes * 60_000 - seconds * 1000);

/* A node's connection that ended that long ago. */
const ended = (nodeId: string, connected: Date, disconnected: Date, cause: ConnectionEnd = 'network', over: Partial<ConnectionRow> = {}): ConnectionRow => ({
  nodeId,
  subscriptionId: null,
  connectedAt: connected,
  disconnectedAt: disconnected,
  cause,
  closeCode: 1006,
  closeReason: null,
  error: null,
  report: null,
  ...over,
});
const open = (nodeId: string, connected: Date): ConnectionRow => ({ nodeId, subscriptionId: null, connectedAt: connected, disconnectedAt: null, cause: null, closeCode: null, closeReason: null, error: null, report: null });
const report = (over: Partial<NodeReconnect> = {}): NodeReconnect => ({
  disconnectedAt: ago(10).toISOString(),
  reconnectedAt: ago(9).toISOString(),
  offlineMs: 60_000,
  attempts: 2,
  cause: 'watchdog_timeout',
  closeCode: null,
  closeReason: null,
  errorCode: null,
  error: null,
  dnsFailed: false,
  watchdogTimedOut: true,
  clockJumpMs: null,
  networkChanged: false,
  ...over,
});

/* One drop of a node: connected, cut that long ago, back after so many seconds. */
const drop = (nodeId: string, minutes: number, away: number, cause: ConnectionEnd = 'network', over: Partial<ConnectionRow> = {}) => [
  ended(nodeId, ago(minutes, 1), ago(minutes), cause, over),
  open(nodeId, new Date(ago(minutes).getTime() + away * 1000)),
];

describe('what the history of a machine says', () => {
  it('says nothing went wrong when nothing did', () => {
    expect(connectionHistory([], NOW)).toEqual({ summary: { drops: 0, averageMs: null, cause: null }, events: [] });
    expect(connectionHistory([open('a', ago(5))], NOW)).toEqual({ summary: { drops: 0, averageMs: null, cause: null }, events: [] });
  });

  it('counts the drops of the last day, how long they lasted on average and the most frequent cause', () => {
    const rows = [
      ...drop('a', 300, 20, 'network'),
      ...drop('a', 200, 40, 'network'),
      ...drop('a', 100, 90, 'missed_pongs'),
      /* A day and a minute ago: outside of the day, and in the list. */
      ...drop('a', 24 * 60 + 1, 500, 'server_stopped'),
    ];
    const { summary, events } = connectionHistory(rows, NOW);
    expect(summary).toEqual({ drops: 3, averageMs: 50_000, cause: 'network' });
    expect(events).toHaveLength(4);
  });

  it('counts a drop of exactly a day ago and takes the newer of two equally frequent causes', () => {
    const rows = [...drop('a', 24 * 60, 10, 'server_stopped'), ...drop('a', 100, 10, 'network')];
    expect(connectionHistory(rows, NOW).summary).toMatchObject({ drops: 2, cause: 'network' });
  });

  it('reads the drops of the nodes of one machine within a minute as one, which ends when the last of them is back', () => {
    const rows = [
      ...drop('a', 50, 30),
      ended('b', ago(100), ago(49, 30), 'missed_pongs', { closeCode: 1006 }),
      open('b', ago(48, 30)),
      /* Exactly a minute after the first: the same drop. */
      ended('c', ago(100), ago(49), 'network'),
      open('c', ago(48, 40)),
      /* A second later than that: another. */
      ended('d', ago(100), ago(48, 59), 'node_closed'),
      open('d', new Date(ago(48, 59).getTime() + 10_000)),
    ];
    const { summary, events } = connectionHistory(rows, NOW);
    expect(summary.drops).toBe(2);
    expect(events.map(e => [e.at, e.back, e.offlineMs, e.cause, e.drops.map(d => d.nodeId)])).toEqual([
      [ago(48, 59), new Date(ago(48, 59).getTime() + 10_000), 10_000, 'node_closed', ['d']],
      [ago(50), ago(48, 30), 90_000, 'network', ['a', 'b', 'c']],
    ]);
    expect(events[1]!.drops[1]).toMatchObject({ nodeId: 'b', cause: 'missed_pongs', at: ago(49, 30), back: ago(48, 30), offlineMs: 60_000 });
  });

  it('keeps a drop open while one of its nodes is away, and leaves it out of the average', () => {
    const rows = [...drop('a', 50, 30), ended('b', ago(100), ago(50)), ...drop('a', 10, 10)];
    const { summary, events } = connectionHistory(rows, NOW);
    expect(summary).toMatchObject({ drops: 2, averageMs: 10_000 });
    expect(events[1]).toMatchObject({ back: null, offlineMs: null });
    expect(events[1]!.drops.map(d => [d.nodeId, d.back])).toEqual([['a', new Date(ago(50).getTime() + 30_000)], ['b', null]]);
  });

  it('has no average while no drop has ended', () => {
    expect(connectionHistory([ended('a', ago(100), ago(50))], NOW).summary).toEqual({ drops: 1, averageMs: null, cause: 'network' });
  });

  it('finds the end of a connection in the next one of the same node, whatever the order and the other nodes', () => {
    const rows = [open('b', ago(5)), open('a', ago(7)), ended('a', ago(30), ago(9)), ended('a', ago(50), ago(40)), ended('a', ago(60), ago(55)), ended('b', ago(30), ago(6))];
    const backs = connectionHistory(rows, NOW).events.flatMap(e => e.drops.map(d => [d.nodeId, d.at, d.back]));
    expect(backs).toEqual([
      ['b', ago(6), ago(5)],
      ['a', ago(9), ago(7)],
      ['a', ago(40), ago(30)],
      ['a', ago(55), ago(50)],
    ]);
  });

  it('takes what the node measured when it is longer than what the server saw', () => {
    const rows = [...drop('a', 50, 0, 'replaced', { report: report({ offlineMs: 45_000 }) }), ...drop('a', 20, 30, 'network', { report: report({ offlineMs: 5000 }) })];
    const { summary, events } = connectionHistory(rows, NOW);
    expect(events.map(e => e.offlineMs)).toEqual([30_000, 45_000]);
    expect(summary.averageMs).toBe(37_500);
  });

  it('does not take what the node measured for a drop it has not come back from', () => {
    expect(connectionHistory([ended('a', ago(100), ago(50), 'network', { report: report() })], NOW).events[0]).toMatchObject({ back: null, offlineMs: null });
  });

  it('gives what the node saw as the reason when the server only saw its new connection', () => {
    const rows = [
      ...drop('a', 50, 0, 'replaced', { report: report({ cause: 'dns_error' }) }),
      ...drop('a', 40, 0, 'replaced', { report: report({ cause: 'dns_error' }) }),
      ...drop('a', 30, 0, 'replaced'),
      ...drop('a', 20, 5, 'missed_pongs', { report: report({ cause: 'watchdog_timeout' }) }),
    ];
    const { summary, events } = connectionHistory(rows, NOW);
    expect(events.map(e => e.cause)).toEqual(['missed_pongs', 'replaced', 'dns_error', 'dns_error']);
    expect(summary.cause).toBe('dns_error');
  });

  it('shows both sides of a drop together', () => {
    const said = report({ cause: 'socket_error', errorCode: 'ECONNRESET', error: 'read ECONNRESET', attempts: 3, networkChanged: true, clockJumpMs: 4000 });
    const rows = [...drop('a', 50, 30, 'socket_error', { closeCode: 1002, closeReason: 'Bad frame', error: 'Invalid WebSocket frame', subscriptionId: 'plan-1', report: said })];
    expect(connectionHistory(rows, NOW).events[0]!.drops).toEqual([{
      nodeId: 'a',
      subscriptionId: 'plan-1',
      at: ago(50),
      back: new Date(ago(50).getTime() + 30_000),
      offlineMs: 60_000,
      cause: 'socket_error',
      closeCode: 1002,
      closeReason: 'Bad frame',
      error: 'Invalid WebSocket frame',
      report: said,
    }]);
  });

  it('counts no node taken off a machine in Hornhoof as a drop', () => {
    const rows = [ended('a', ago(100), ago(50), 'disconnected', { closeCode: 4001 }), ...drop('b', 50, 30)];
    const { summary, events } = connectionHistory(rows, NOW);
    expect(summary).toEqual({ drops: 1, averageMs: 30_000, cause: 'network' });
    expect(events.flatMap(e => e.drops.map(d => d.nodeId))).toEqual(['b']);
  });

  it('lists the newest fifty, and counts in its summary those of the day it does not list', () => {
    const rows = Array.from({ length: 60 }, (_, i) => drop('a', 5 + i * 2, 1)).flat();
    const { summary, events } = connectionHistory(rows, NOW);
    expect(summary.drops).toBe(60);
    expect(events).toHaveLength(50);
    expect(events[0]!.at).toEqual(ago(5));
    expect(events[49]!.at).toEqual(ago(5 + 49 * 2));
  });
});
