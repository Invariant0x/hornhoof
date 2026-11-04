import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperatorEvidence } from '@hornhoof/protocol/program-operator';
import { afterEach, describe, expect, it } from 'vitest';
import { OperatorObserver } from '../src/terminal/operator-observer.js';

const agentKey = '10000000-0000-4000-8000-000000000001';
const jobId = '10000000-0000-4000-8000-000000000002';
const instance = '10000000-0000-4000-8000-000000000003';
const deliveryId = '10000000-0000-4000-8000-000000000004';
const identity = { agentKey, jobId, instance };
const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'hh-operator-'));
  folders.push(folder);
  let now = 1000, online = true;
  const sent: OperatorEvidence[] = [];
  const options = { file: join(folder, 'evidence.json'), now: () => now, connected: () => online, send: (fact: OperatorEvidence) => { sent.push(fact); return true; } };
  const observer = new OperatorObserver(options);
  observer.launch(identity, 'attempt');
  observer.launch(identity, 'started');
  const attempt = (kind: 'assignment' | 'live' = 'assignment') => observer.attempt(identity, { id: deliveryId, ordinal: 1 }, kind, 'exact words');
  const alarms = () => sent.filter(f => f.type === 'program.operator_needed');
  return { observer, options, sent, attempt, alarms, at: (value: number) => { now = value + 1000; }, online: (value: boolean) => { online = value; } };
}

describe('program delivery evidence', () => {
  it('starts the assignment clock at attempt and calls exactly once at 60 seconds without a receipt', () => {
    const c = fixture(); c.attempt();
    c.at(59999); c.observer.tick(); expect(c.alarms()).toEqual([]);
    c.at(60000); c.observer.tick(); c.at(120000); c.observer.tick();
    expect(c.alarms()).toEqual([expect.objectContaining({ reason: 'assignment_unrecorded', deliveryId, elapsedMs: 60000 })]);
  });

  it('disarms assignment alarm on queued receipt, then waits five minutes only for first own activity', () => {
    const c = fixture(); c.attempt(); c.at(100); c.observer.receipt(deliveryId, 'queued');
    c.at(300099); c.observer.tick(); expect(c.alarms()).toEqual([]);
    c.at(300100); c.observer.tick();
    expect(c.alarms()).toEqual([expect.objectContaining({ reason: 'recorded_no_activity' })]);
  });

  it('preserves first own activity even when the word receipt arrives later and never alarms on later silence', () => {
    const c = fixture(); c.attempt(); c.at(10); c.observer.activity(identity);
    c.at(20); c.observer.receipt(deliveryId, 'taken');
    c.at(8 * 3600000); c.observer.tick(); expect(c.alarms()).toEqual([]);
  });

  it('does not count live queued or transport-held words as taken or apply assignment timers to them', () => {
    const c = fixture(); c.attempt('live'); c.observer.receipt(deliveryId, 'queued');
    c.at(600000); c.observer.tick(); expect(c.alarms()).toEqual([]);
    c.observer.finalize(deliveryId, 'not_taken'); c.observer.finalize(deliveryId, 'not_taken');
    expect(c.sent.filter(f => f.type === 'program.delivery' && f.phase === 'not_taken')).toHaveLength(1);
    expect(c.sent.filter(f => f.type === 'program.delivery' && f.phase === 'taken')).toHaveLength(0);
  });

  it('does not generate missing-receipt alarms while disconnected and replays the same durable facts', () => {
    const c = fixture(); c.attempt(); const ids = c.sent.map(f => f.evidenceId);
    c.online(false); c.at(61000); c.observer.tick(); expect(c.alarms()).toEqual([]);
    const restored = new OperatorObserver(c.options); c.online(true); restored.replay();
    expect(c.sent.slice(ids.length).map(f => f.evidenceId)).toEqual(ids);
    restored.tick(); expect(c.alarms()).toHaveLength(1);
    restored.ack(c.alarms()[0]!.evidenceId);
    const again = new OperatorObserver(c.options); const before = c.alarms().length;
    again.tick(); expect(c.alarms()).toHaveLength(before);
  });

  it.each(['cancelled', 'update', 'restart', 'offline', 'completed'] as const)('does not report startup exit for %s', cause => {
    const c = fixture(); c.attempt(); c.at(100);
    c.observer.exit(identity, { code: 0, signal: null }, cause);
    c.at(600000); c.observer.tick(); expect(c.alarms()).toEqual([]);
  });

  it('reports a real early zero-code exit once and ignores exits after first own activity', () => {
    const c = fixture(); c.at(60000);
    c.observer.exit(identity, { code: 0, signal: null }); c.observer.exit(identity, { code: 0, signal: null });
    expect(c.alarms()).toEqual([expect.objectContaining({ reason: 'startup_exit', sinceLaunchMs: 60000, exit: { code: 0, signal: null } })]);
    const d = fixture(); d.observer.activity(identity); d.at(100);
    d.observer.exit(identity, { code: 1, signal: null }); expect(d.alarms()).toEqual([]);
  });

  it('refuses reuse of a delivery identity for different words and never stores their plaintext', () => {
    const c = fixture(); c.attempt();
    expect(() => c.observer.attempt(identity, { id: deliveryId, ordinal: 1 }, 'assignment', 'other words')).toThrow(/delivery/i);
    expect(JSON.stringify(c.sent)).not.toContain('exact words');
  });

  it('retains delivery idempotency after a taken receipt was acknowledged by the server', () => {
    const c = fixture(); c.attempt('live'); c.observer.receipt(deliveryId, 'taken');
    for (const fact of [...c.sent]) c.observer.ack(fact.evidenceId);
    const count = c.sent.length;
    c.at(100); c.attempt('live');
    expect(c.sent).toHaveLength(count);
  });

  it('does not let activity substitute for an exact-word receipt', () => {
    const c = fixture(); c.attempt(); c.observer.activity(identity); c.at(60000); c.observer.tick();
    expect(c.alarms()).toEqual([expect.objectContaining({ reason: 'assignment_unrecorded' })]);
  });
});
