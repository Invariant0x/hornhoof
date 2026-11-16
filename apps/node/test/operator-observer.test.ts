import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperatorCheck, OperatorEvidence, OperatorQuestion } from '@hornhoof/protocol/program-operator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as storage from '../src/terminal/operator-storage.js';
import { OperatorObserver } from '../src/terminal/operator-observer.js';
import { CheckClient } from '../src/check-client.js';
import { setCheckClient } from '../src/check-queue.js';

const agentKey = '10000000-0000-4000-8000-000000000001';
const jobId = '10000000-0000-4000-8000-000000000002';
const instance = '10000000-0000-4000-8000-000000000003';
const deliveryId = '10000000-0000-4000-8000-000000000004';
const identity = { agentKey, jobId, instance };
const folders: string[] = [];
afterEach(() => { setCheckClient(null); vi.restoreAllMocks(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

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
  it('copies the state at most once when checking many programs and deliveries', () => {
    const c = fixture();
    const id = (index: number) => `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    for (let index = 0; index < 50; index++) {
      const current = { ...identity, instance: index === 0 ? instance : id(index) };
      c.observer.launch(current, 'started');
      for (let ordinal = 1; ordinal <= 6; ordinal++) c.observer.attempt(current, { id: id(100 + index * 6 + ordinal), ordinal }, 'assignment', 'exact words');
    }
    const clone = vi.spyOn(globalThis, 'structuredClone');
    c.at(60000); c.observer.tick();
    expect(clone.mock.calls.length).toBeLessThanOrEqual(1);
    expect(c.alarms()).toHaveLength(300);
  });

  it('does not call authenticated queue waiting missing activity, but detects a lost queue connection', async () => {
    /* A connection lost past its lease, which here has no grace: the queue is lost as the connection drops. */
    const client = new CheckClient(() => true, 0); client.online(true); setCheckClient(client);
    const pending = client.acquire({ agentId: agentKey, jobId });
    const rejected = pending.catch(() => {});
    const c = fixture(); c.attempt(); c.observer.receipt(deliveryId, 'taken');
    c.at(600000); c.observer.tick();
    expect(c.alarms()).toEqual([]);
    client.online(false); await rejected;
    c.observer.tick();
    expect(c.alarms()).toEqual([]);
    c.at(900000); c.observer.tick();
    expect(c.alarms()).toEqual([expect.objectContaining({ reason: 'recorded_no_activity' })]);
  });
  it('does not count queue time against the first-activity clock after a grant', async () => {
    let requestId = '';
    const client = new CheckClient(frame => { requestId = frame.id; return true; });
    client.online(true); setCheckClient(client);
    const pending = client.acquire({ agentId: agentKey, jobId });
    const c = fixture(); c.attempt(); c.observer.receipt(deliveryId, 'taken');
    c.at(600000); c.observer.tick();
    client.receive({ type: 'check.state', id: requestId, state: 'running', position: 0 });
    const lease = await pending;
    try {
      c.at(600001); c.observer.tick(); expect(c.alarms()).toEqual([]);
      c.at(899999); c.observer.tick(); expect(c.alarms()).toEqual([]);
      c.at(900000); c.observer.tick();
      expect(c.alarms()).toEqual([expect.objectContaining({ reason: 'recorded_no_activity' })]);
    } finally { lease.release(); client.stop(); }
  });
  it('credits a completed source without clearing a newer native question', () => {
    const c = fixture(); c.attempt();
    c.observer.receipt(deliveryId, 'taken');
    const question: OperatorQuestion = { id: '10000000-0000-4000-8000-000000000005', kind: 'permission', tool: 'Bash', text: 'Read local files?', callId: 'new' };
    c.observer.question({ ...identity, jobId: '10000000-0000-4000-8000-000000000006' }, question);
    c.observer.sourceActivity(identity, { id: deliveryId, ordinal: 1 });
    c.observer.sourceActivity(identity, { id: deliveryId, ordinal: 1 });
    c.at(300000); c.observer.tick();
    expect(c.alarms()).toEqual([expect.objectContaining({ reason: 'question_waiting', questionId: question.id })]);
    expect(c.sent.filter(f => f.type === 'program.delivery' && f.phase === 'activity')).toHaveLength(1);
  });
  it.each(['agent', 'instance', 'id', 'ordinal'] as const)('rejects completed-source activity with the wrong %s', field => {
    const c = fixture(); c.attempt(); c.observer.receipt(deliveryId, 'taken');
    const actor = { ...identity }, source = { id: deliveryId, ordinal: 1 };
    if (field === 'agent') actor.agentKey = '10000000-0000-4000-8000-000000000007';
    if (field === 'instance') actor.instance = '10000000-0000-4000-8000-000000000007';
    if (field === 'id') source.id = '10000000-0000-4000-8000-000000000007';
    if (field === 'ordinal') source.ordinal = 2;
    c.observer.sourceActivity(actor, source);
    c.at(300000); c.observer.tick();
    expect(c.alarms()).toEqual([expect.objectContaining({ reason: 'recorded_no_activity', deliveryId })]);
    expect(c.sent.filter(f => f.type === 'program.delivery' && f.phase === 'activity')).toEqual([]);
  });
  it('does not reactivate a replaced physical program through delayed source activity', () => {
    const c = fixture(); c.attempt(); c.observer.receipt(deliveryId, 'taken');
    c.observer.exit(identity, { code: null, signal: null }, 'restart');
    c.observer.sourceActivity(identity, { id: deliveryId, ordinal: 1 });
    expect(c.sent.filter(f => f.type === 'program.delivery' && f.phase === 'activity')).toEqual([]);
  });
  it('calls once at thirty seconds of the same authenticated question and does not restart its clock on a repeated observation', () => {
    const c = fixture();
    const question: OperatorQuestion = { id: deliveryId, kind: 'permission', tool: 'Bash', text: 'Remove the agent temporary folder?', callId: 'call-1' };
    c.observer.question(identity, null);
    c.observer.question(identity, question);
    c.at(29999); c.observer.question(identity, question); c.observer.tick();
    expect(c.alarms()).toEqual([]);
    c.at(30000); c.observer.tick(); c.at(60000); c.observer.tick();
    expect(c.alarms()).toEqual([expect.objectContaining({ reason: 'question_waiting', questionId: deliveryId, evidenceKey: deliveryId, elapsedMs: 30000 })]);
    const restored = new OperatorObserver(c.options); restored.replay(); restored.tick();
    const alarmIds = c.alarms().map(fact => fact.evidenceId);
    expect(new Set(alarmIds).size).toBe(1);
  });

  it('cancels the asking clock on an answer or new own event and leaves work decisions to people', () => {
    const c = fixture();
    const question: OperatorQuestion = { id: deliveryId, kind: 'permission', tool: 'Bash', text: 'Remove the agent temporary folder?', callId: null };
    c.observer.question(identity, question);
    c.at(29999); c.observer.question(identity, null); c.at(60000); c.observer.tick();
    c.observer.question(identity, null);
    expect(c.alarms()).toEqual([]);
    c.observer.question(identity, { ...question, id: '10000000-0000-4000-8000-000000000005' });
    c.at(61000); c.observer.activity(identity); c.at(120000); c.observer.tick();
    expect(c.alarms()).toEqual([]);
    c.observer.question(identity, { ...question, id: '10000000-0000-4000-8000-000000000006', kind: 'work', tool: 'AskUserQuestion' });
    c.at(240000); c.observer.tick();
    expect(c.alarms()).toEqual([]);
    expect(c.sent.filter(fact => fact.type === 'program.question' && fact.phase === 'cleared')).toHaveLength(2);
  });

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

function fullOutbox(c: ReturnType<typeof fixture>, spare = 0): OperatorObserver {
  const state = JSON.parse(readFileSync(c.options.file, 'utf8')) as { outbox: OperatorEvidence[] };
  const fact = state.outbox[0]!;
  state.outbox = Array.from({ length: 4096 - spare }, (_, index) => ({ ...fact, evidenceId: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}` }));
  writeFileSync(c.options.file, JSON.stringify(state));
  return new OperatorObserver(c.options);
}

function freeOutbox(observer: OperatorObserver, c: ReturnType<typeof fixture>): void {
  const state = JSON.parse(readFileSync(c.options.file, 'utf8')) as { outbox: OperatorEvidence[] };
  for (const fact of state.outbox.slice(0, 4)) observer.ack(fact.evidenceId);
}

describe('bounded evidence backpressure', () => {
  it('keeps checking after a full outbox and preserves earlier alarms and later queue checks', async () => {
    const c = compoundFixture();
    const current = { ...identity, jobId: nextQuestion.id, instance: nextQuestion.id };
    const queued = { id: '10000000-0000-4000-8000-000000000010', ordinal: 3 };
    c.observer.launch(current, 'started'); c.observer.question(current, nextQuestion);
    c.observer.attempt(current, queued, 'assignment', 'queued words');
    const client = new CheckClient(() => true); client.online(true); setCheckClient(client);
    const pending = client.acquire({ agentId: current.agentKey, jobId: current.jobId });
    const rejected = pending.catch(() => {});
    try {
      const observer = fullOutbox(c, 1), before = disk(c);
      c.at(60000);
      expect(() => observer.tick()).toThrow(/outbox is full/);
      expect(c.alarms()).toEqual([expect.objectContaining({ reason: 'question_waiting', questionId: question.id })]);
      expect(disk(c).instances[current.instance]).toMatchObject({ ordinal: before.instances[current.instance]!.ordinal, question: { alarmed: false } });
      expect(disk(c).deliveries[queued.id]).toMatchObject({ checkAfter: 121000 });
      freeOutbox(observer, c);
      observer.tick();
      expect(c.alarms()).toEqual([
        expect.objectContaining({ reason: 'question_waiting', questionId: question.id }),
        expect.objectContaining({ reason: 'question_waiting', questionId: nextQuestion.id }),
        expect.objectContaining({ reason: 'assignment_unrecorded', deliveryId }),
      ]);
    } finally { client.stop(); await rejected; }
  });

  it.each(['launch', 'attempt', 'receipt', 'finalize', 'alarm', 'activity', 'exit'] as const)('keeps %s retryable without consuming state at capacity', operation => {
    const c = fixture(); c.attempt();
    const observer = fullOutbox(c);
    const delivery = { id: '10000000-0000-4000-8000-000000000009', ordinal: 2 };
    const run = () => {
      if (operation === 'launch') observer.launch(identity, 'failed');
      if (operation === 'attempt') observer.attempt(identity, delivery, 'live', 'never persisted words');
      if (operation === 'receipt') observer.receipt(deliveryId, 'taken');
      if (operation === 'finalize') observer.finalize(deliveryId, 'not_taken');
      if (operation === 'alarm') { c.at(60000); observer.tick(); }
      if (operation === 'activity') observer.activity(identity);
      if (operation === 'exit') observer.exit(identity, { code: 1, signal: null });
    };
    const before = readFileSync(c.options.file, 'utf8');
    expect(run).toThrow(/outbox is full/);
    expect(readFileSync(c.options.file, 'utf8') === before).toBe(true);
    freeOutbox(observer, c);
    const count = c.sent.length;
    run();
    expect(c.sent.length).toBeGreaterThan(count);
    expect(readFileSync(c.options.file, 'utf8')).not.toContain('never persisted words');
    const restored = new OperatorObserver(c.options);
    const expected = c.sent.slice(count).map(fact => fact.evidenceId);
    const replayStart = c.sent.length;
    restored.replay();
    expect(c.sent.slice(replayStart).map(fact => fact.evidenceId)).toEqual(expect.arrayContaining(expected));
  });

  it.each(['activity', 'exit'] as const)('reserves all facts before a multi-fact %s', operation => {
    const c = fixture(); c.attempt();
    c.observer.question(identity, { id: deliveryId, kind: 'permission', tool: 'Bash', text: 'Continue?', callId: null });
    const observer = fullOutbox(c, 1);
    const run = () => operation === 'activity' ? observer.activity(identity) : observer.exit(identity, { code: 1, signal: null });
    const before = readFileSync(c.options.file, 'utf8');
    expect(run).toThrow(/outbox is full/);
    expect(readFileSync(c.options.file, 'utf8') === before).toBe(true);
    freeOutbox(observer, c);
    const count = c.sent.length;
    run();
    const facts = c.sent.slice(count);
    expect(facts).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'program.question', phase: 'cleared' }), expect.objectContaining({ type: 'program.delivery', phase: operation === 'activity' ? 'activity' : 'not_taken' })]));
  });
});

type ObserverDisk = { instances: Record<string, { exited: boolean; active: boolean; ordinal: number; question: { data: OperatorQuestion } | null }>; deliveries: Record<string, { outcome: string; active: boolean }>; outbox: OperatorEvidence[] };
const question: OperatorQuestion = { id: deliveryId, kind: 'permission', tool: 'Bash', text: 'Continue?', callId: null };
const nextQuestion = { ...question, id: '10000000-0000-4000-8000-000000000008' };
const secondDelivery = { id: '10000000-0000-4000-8000-000000000009', ordinal: 2 };
function disk(c: ReturnType<typeof fixture>): ObserverDisk { return JSON.parse(readFileSync(c.options.file, 'utf8')) as ObserverDisk; }
function compoundFixture() {
  const c = fixture(); c.attempt();
  c.observer.attempt(identity, secondDelivery, 'live', 'second delivery words');
  c.observer.question(identity, question);
  return c;
}

describe('atomic durable observer transitions', () => {
  it.each(['exit', 'activity', 'question'] as const)('commits the complete %s snapshot once before publishing any of its facts', operation => {
    const c = compoundFixture(); const snapshots: ObserverDisk[] = [];
    const write = storage.writeOperatorStore;
    vi.spyOn(storage, 'writeOperatorStore').mockImplementation((file, state) => {
      snapshots.push(structuredClone(state) as ObserverDisk);
      write(file, state);
    });
    const sentBefore = c.sent.length;
    if (operation === 'exit') c.observer.exit(identity, { code: 1, signal: null });
    if (operation === 'activity') c.observer.activity(identity);
    if (operation === 'question') c.observer.question(identity, nextQuestion);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual(disk(c));
    const committed = snapshots[0]!;
    const facts = c.sent.slice(sentBefore);
    expect(facts).toEqual(committed.outbox.slice(-facts.length));
    expect(facts[0]).toMatchObject({ type: 'program.question', phase: 'cleared' });
    if (operation === 'exit') {
      expect(committed.instances[instance]!.exited).toBe(true);
      expect(Object.values(committed.deliveries).map(row => row.outcome)).toEqual(['not_taken', 'not_taken']);
      expect(facts.filter(fact => fact.type === 'program.delivery' && fact.phase === 'not_taken')).toHaveLength(2);
    }
    if (operation === 'activity') {
      expect(committed.instances[instance]!.active).toBe(true);
      expect(Object.values(committed.deliveries).every(row => row.active)).toBe(true);
      expect(facts.filter(fact => fact.type === 'program.delivery' && fact.phase === 'activity')).toHaveLength(2);
    }
    if (operation === 'question') {
      expect(committed.instances[instance]!.question?.data.id).toBe(nextQuestion.id);
      expect(facts[1]).toMatchObject({ type: 'program.question', phase: 'asked', question: nextQuestion });
    }
  });

  it.each(['launch', 'attempt', 'receipt', 'finalize', 'alarm', 'activity', 'exit', 'question', 'recovery', 'ack'] as const)('rolls back a failed %s commit without publishing or consuming the pending identity', operation => {
    const c = compoundFixture(); const before = disk(c); const sentBefore = [...c.sent];
    const run = () => {
      if (operation === 'launch') c.observer.launch(identity, 'failed');
      if (operation === 'attempt') c.observer.attempt(identity, { ...secondDelivery, id: nextQuestion.id, ordinal: 3 }, 'live', 'retry these exact words');
      if (operation === 'receipt') c.observer.receipt(deliveryId, 'taken');
      if (operation === 'finalize') c.observer.finalize(deliveryId, 'not_taken');
      if (operation === 'alarm') { c.at(60000); c.observer.tick(); }
      if (operation === 'activity') c.observer.activity(identity);
      if (operation === 'exit') c.observer.exit(identity, { code: 1, signal: null });
      if (operation === 'question') c.observer.question(identity, nextQuestion);
      if (operation === 'recovery') c.observer.recoveryReady(identity, nextQuestion.id, false);
      if (operation === 'ack') c.observer.ack(before.outbox[0]!.evidenceId);
    };
    vi.spyOn(storage, 'writeOperatorStore').mockImplementationOnce(() => { throw new Error('injected durable write failure'); });
    expect(run).toThrow('injected durable write failure');
    expect(c.sent).toEqual(sentBefore);
    expect(disk(c)).toEqual(before);
    c.observer.replay();
    expect(c.sent.slice(sentBefore.length).map(fact => fact.evidenceId)).toEqual(before.outbox.map(fact => fact.evidenceId));
    c.sent.splice(sentBefore.length);
    run();
    const committed = disk(c);
    if (operation === 'ack') expect(committed.outbox.map(fact => fact.evidenceId)).not.toContain(before.outbox[0]!.evidenceId);
    else {
      expect(c.sent.length).toBeGreaterThan(sentBefore.length);
      expect(c.sent[sentBefore.length]!.ordinal).toBe(before.instances[instance]!.ordinal);
    }
    const count = c.sent.length;
    new OperatorObserver(c.options).replay();
    expect(c.sent.slice(count).map(fact => fact.evidenceId)).toEqual(committed.outbox.map(fact => fact.evidenceId));
  });

  it('persists every terminal fact before its transport callback can inspect or acknowledge the exited snapshot', () => {
    const c = compoundFixture(); const observed: ObserverDisk[] = [];
    const observer = new OperatorObserver({ ...c.options, send: fact => { observed.push(disk(c)); c.sent.push(fact); return true; } });
    observer.exit(identity, { code: 1, signal: null });
    for (const state of observed) {
      expect(Object.values(state.deliveries).map(row => row.outcome)).toEqual(['not_taken', 'not_taken']);
      expect(state.outbox.filter(fact => fact.type === 'program.delivery' && fact.phase === 'not_taken')).toHaveLength(2);
    }
    expect(observed.length).toBeGreaterThan(0);
  });
});

it('preserves the native question clock when its confirmed job binds after an early typed-turn request', () => {
  const c = fixture(); c.at(10000);
  c.observer.question(identity, question, 10000);
  c.at(29999); c.observer.tick(); expect(c.alarms()).toEqual([]);
  c.at(30000); c.observer.tick();
  expect(c.alarms()).toEqual([expect.objectContaining({ reason: 'question_waiting', elapsedMs: 30000 })]);
});

it('does not write or flush duplicate activity, observations, or acknowledgements', () => {
  const c = fixture(); c.attempt(); c.observer.receipt(deliveryId, 'taken');
  c.observer.activity(identity); c.observer.recoveryReady(identity, nextQuestion.id, false);
  const acknowledged = c.sent[0]!.evidenceId; c.observer.ack(acknowledged);
  const write = vi.spyOn(storage, 'writeOperatorStore');
  c.observer.activity(identity); c.observer.activity(identity);
  c.observer.launch(identity, 'started'); c.attempt(); c.observer.receipt(deliveryId, 'taken');
  c.observer.finalize(deliveryId, 'not_taken'); c.observer.question(identity, null);
  c.observer.recoveryReady(identity, nextQuestion.id, false); c.observer.ack(acknowledged); c.observer.tick();
  expect(write).not.toHaveBeenCalled();
});

it('prunes only acknowledged settled delivery history and unused exited instances', () => {
  const c = fixture(); c.attempt('live'); c.observer.receipt(deliveryId, 'taken');
  const stored = JSON.parse(readFileSync(c.options.file, 'utf8')) as {
    instances: Record<string, { exited: boolean; instance: string }>;
    deliveries: Record<string, { id: string; at: number; outcome: string; kind: string }>;
  };
  const original = stored.deliveries[deliveryId]!;
  const id = (index: number) => `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  original.at = 0;
  for (let index = 1; index <= 2050; index++) stored.deliveries[id(index)] = { ...original, id: id(index), at: index };
  stored.deliveries[id(1)]!.outcome = 'pending';
  stored.deliveries[id(2)]!.kind = 'assignment';
  stored.instances[id(9)] = { ...stored.instances[instance]!, instance: id(9), exited: true };
  writeFileSync(c.options.file, JSON.stringify(stored));
  const observer = new OperatorObserver(c.options);
  observer.ack(c.sent[0]!.evidenceId);
  const committed = disk(c);
  expect(Object.keys(committed.deliveries)).toHaveLength(2048);
  expect(committed.deliveries[deliveryId]).toBeDefined();
  expect(committed.deliveries[id(1)]).toMatchObject({ outcome: 'pending' });
  expect(committed.deliveries[id(2)]).toBeDefined();
  for (const index of [3, 4, 5]) expect(committed.deliveries[id(index)]).toBeUndefined();
  expect(committed.instances[id(9)]).toBeUndefined();
});

it('retires old physical programs once, cancels their pending deliveries and stops their timers', () => {
  const c = compoundFixture(); c.observer.retire();
  expect(disk(c).instances[instance]!.exited).toBe(true);
  expect(Object.values(disk(c).deliveries).map(row => row.outcome)).toEqual(['cancelled', 'cancelled']);
  const write = vi.spyOn(storage, 'writeOperatorStore'); c.observer.retire(); c.at(600000); c.observer.tick();
  expect(write).not.toHaveBeenCalled(); expect(c.alarms()).toEqual([]);
});

it('keeps a committed multi-fact transition replayable when the transport callback throws', () => {
  const c = compoundFixture();
  const observer = new OperatorObserver({ ...c.options, send: () => { throw new Error('transport unavailable'); } });
  expect(() => observer.exit(identity, { code: 1, signal: null })).toThrow('transport unavailable');
  expect(Object.values(disk(c).deliveries).map(row => row.outcome)).toEqual(['not_taken', 'not_taken']);
  const count = c.sent.length; new OperatorObserver(c.options).replay();
  expect(c.sent.slice(count).map(fact => fact.evidenceId)).toEqual(disk(c).outbox.map(fact => fact.evidenceId));
});

it('requires an assignment receipt or live taken receipt before inheriting a recorded source', () => {
  const c = fixture(); expect(c.observer.recordedSource(deliveryId)).toBe(false);
  c.attempt(); expect(c.observer.recordedSource(deliveryId)).toBe(false);
  c.observer.receipt(deliveryId, 'queued'); expect(c.observer.recordedSource(deliveryId)).toBe(true);
  c.observer.attempt(identity, secondDelivery, 'live', 'live source');
  c.observer.receipt(secondDelivery.id, 'queued'); expect(c.observer.recordedSource(secondDelivery.id)).toBe(false);
  c.observer.receipt(secondDelivery.id, 'taken'); expect(c.observer.recordedSource(secondDelivery.id)).toBe(true);
});


describe('continuation source activity ownership', () => {
  it.each(['before', 'after'] as const)('credits only the linked source on an actual continuation event with receipt %s activity', receipt => {
    const c = fixture(); c.attempt();
    c.observer.attempt(identity, secondDelivery, 'assignment', 'Unrelated old words.');
    c.observer.receipt(secondDelivery.id, 'queued');
    const current = { ...identity, jobId: nextQuestion.id };
    const next = { id: '10000000-0000-4000-8000-000000000010', ordinal: 3 };
    c.observer.attempt(current, next, 'assignment', 'exact words'); c.observer.receipt(next.id, 'queued');
    if (receipt === 'before') c.observer.receipt(deliveryId, 'taken');
    c.observer.activity(current, { id: deliveryId, ordinal: 1 });
    if (receipt === 'after') {
      c.at(60000); c.observer.tick();
      expect(c.alarms()).toContainEqual(expect.objectContaining({ reason: 'assignment_unrecorded', deliveryId }));
      c.observer.receipt(deliveryId, 'taken');
    }
    c.at(360000); c.observer.tick();
    expect(c.alarms().filter(fact => fact.reason === 'recorded_no_activity')).toEqual([expect.objectContaining({ deliveryId: secondDelivery.id })]);
    expect(c.sent.filter(fact => fact.type === 'program.delivery' && fact.phase === 'activity')).toEqual([
      expect.objectContaining({ deliveryId, jobId: identity.jobId }),
      expect.objectContaining({ deliveryId: next.id, jobId: current.jobId }),
    ]);
    expect(disk(c).deliveries[deliveryId]).toMatchObject({ active: true });
    expect(disk(c).deliveries[secondDelivery.id]).toMatchObject({ active: false });
  });

  it.each(['id', 'ordinal', 'agent', 'physical instance'] as const)('does not credit a source with a mismatched %s', mismatch => {
    const c = fixture();
    const sourceIdentity = { ...identity };
    if (mismatch === 'agent') sourceIdentity.agentKey = nextQuestion.id;
    if (mismatch === 'physical instance') sourceIdentity.instance = nextQuestion.id;
    c.observer.attempt(sourceIdentity, { id: deliveryId, ordinal: 1 }, 'assignment', 'exact words');
    c.observer.receipt(deliveryId, 'taken');
    const current = { ...identity, jobId: '10000000-0000-4000-8000-000000000011' };
    c.observer.attempt(current, secondDelivery, 'assignment', 'exact words'); c.observer.receipt(secondDelivery.id, 'taken');
    const source = { id: mismatch === 'id' ? nextQuestion.id : deliveryId, ordinal: mismatch === 'ordinal' ? 99 : 1 };
    c.observer.activity(current, source);
    expect(disk(c).deliveries[deliveryId]).toMatchObject({ active: false });
    expect(disk(c).deliveries[secondDelivery.id]).toMatchObject({ active: true });
    c.at(300000); c.observer.tick();
    expect(c.alarms()).toEqual([expect.objectContaining({ reason: 'recorded_no_activity', deliveryId })]);
  });

  it('reserves both source and current activity facts atomically under outbox backpressure', () => {
    const c = fixture(); c.attempt();
    const current = { ...identity, jobId: nextQuestion.id };
    c.observer.attempt(current, secondDelivery, 'assignment', 'exact words');
    const observer = fullOutbox(c, 1), before = disk(c);
    expect(() => observer.activity(current, { id: deliveryId, ordinal: 1 })).toThrow(/outbox is full/);
    expect(disk(c)).toEqual(before);
    freeOutbox(observer, c);
    const start = c.sent.length; observer.activity(current, { id: deliveryId, ordinal: 1 });
    expect(c.sent.slice(start).filter(fact => fact.type === 'program.delivery' && fact.phase === 'activity')).toHaveLength(2);
    expect(disk(c).deliveries[deliveryId]).toMatchObject({ active: true });
    expect(disk(c).deliveries[secondDelivery.id]).toMatchObject({ active: true });
  });
});

describe('a look at the program before telling of a turn', () => {
  const needed = (c: ReturnType<typeof fixture>) => c.alarms();
  const looking = (check: Promise<OperatorCheck> | OperatorCheck = { input: 'text', screen: { cols: 80, rows: 24, cells: 'The whole screen.' } }) => {
    const c = fixture();
    const look = vi.fn(() => Promise.resolve(check));
    const observer = new OperatorObserver({ ...c.options, look });
    observer.attempt(identity, { id: deliveryId, ordinal: 1 }, 'assignment', 'exact words');
    return { ...c, observer, look };
  };
  /* A turn of the event loop: the look and what follows it are promise steps, all done before it. */
  const settled = () => new Promise(done => setImmediate(done));

  it('looks once, and tells afterwards, with what it saw', async () => {
    const c = looking();
    c.at(59_999); c.observer.tick();
    expect(c.look).not.toHaveBeenCalled();
    c.at(60_000); c.observer.tick(); c.observer.tick();
    expect(c.look).toHaveBeenCalledTimes(1);
    expect(c.look).toHaveBeenCalledWith(identity);
    expect(needed(c)).toEqual([]);
    await settled();
    expect(needed(c)).toEqual([expect.objectContaining({ reason: 'assignment_unrecorded', deliveryId, check: { input: 'text', screen: { cols: 80, rows: 24, cells: 'The whole screen.' } } })]);
    c.observer.tick();
    await settled();
    expect(c.look).toHaveBeenCalledTimes(1);
    expect(needed(c)).toHaveLength(1);
  });

  it('keeps the state of the line on disk and the screen off it, also when told again', async () => {
    const c = looking();
    c.at(60_000); c.observer.tick();
    await settled();
    const stored = readFileSync(c.options.file, 'utf8');
    expect(stored).not.toContain('The whole screen.');
    expect(JSON.parse(stored).outbox.find((fact: OperatorEvidence) => fact.type === 'program.operator_needed').check).toEqual({ input: 'text', screen: null });
    const first = needed(c)[0]!;
    c.observer.replay();
    expect(needed(c)[1]).toMatchObject({ evidenceId: first.evidenceId, check: { input: 'text', screen: null } });
  });

  it('tells of it with the line unknown when the look fails', async () => {
    const c = looking(Promise.reject(new Error('no screen')));
    c.at(60_000); c.observer.tick();
    await settled();
    await settled();
    expect(needed(c)[0]).toMatchObject({ check: { input: 'unknown', screen: null } });
  });

  it.each([
    ['the words got recorded', (c: ReturnType<typeof looking>) => c.observer.receipt(deliveryId, 'queued')],
    ['the delivery was called off', (c: ReturnType<typeof looking>) => c.observer.finalize(deliveryId, 'cancelled')],
    ['the program ended', (c: ReturnType<typeof looking>) => c.observer.exit(identity, { code: 0, signal: null }, 'completed')],
  ])('tells of nothing when %s while it looked', async (_what, meanwhile) => {
    const c = looking();
    c.at(60_000); c.observer.tick();
    meanwhile(c);
    await settled();
    expect(needed(c).filter(frame => frame.reason === 'assignment_unrecorded')).toEqual([]);
  });

  it('looks again when it could not write what it saw', async () => {
    const c = looking();
    c.at(60_000);
    const write = vi.spyOn(storage, 'writeOperatorStore').mockImplementationOnce(() => { throw new Error('disk full'); });
    c.observer.tick();
    await settled();
    expect(needed(c)).toEqual([]);
    write.mockRestore();
    c.observer.tick();
    await settled();
    expect(c.look).toHaveBeenCalledTimes(2);
    expect(needed(c)).toHaveLength(1);
  });

  it('tells of a program it has no way to look at at once', () => {
    const c = fixture();
    c.attempt();
    c.at(60_000); c.observer.tick();
    expect(c.alarms()).toEqual([expect.objectContaining({ reason: 'assignment_unrecorded' })]);
    expect(c.alarms()[0]).not.toHaveProperty('check');
  });
});
