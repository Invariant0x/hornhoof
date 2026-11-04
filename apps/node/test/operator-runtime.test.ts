import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperatorNodeMessage } from '@hornhoof/protocol/program-operator';
import { expect, it, onTestFinished } from 'vitest';
import { OperatorRuntime } from '../src/terminal/operator-runtime.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hh-runtime-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  let now = 0;
  const sent: OperatorNodeMessage[] = [];
  const runtime = new OperatorRuntime({ dir, now: () => now, connected: () => true, send: frame => { sent.push(frame); return true; } }, { current: () => ({ agentProgram: true, alive: true, pasted: false, turnStarted: false, active: false, runningTool: false, retrying: false, wait: null }), capture: async () => ({ cols: 80, rows: 24, cells: 'Press Enter for a theme.' }), press: async () => {}, secrets: () => [] });
  const agentKey = randomUUID(), jobId = randomUUID();
  const assignment = { id: randomUUID(), ordinal: 1 };
  runtime.begin(agentKey, jobId, assignment, 'Words.', false);
  runtime.launch(agentKey, 'attempt'); runtime.launch(agentKey, 'started');
  const identity = runtime.identity(agentKey)!;
  return { runtime, sent, identity, assignment, at: (value: number) => { now = value; } };
}

it('ignores an older revoke and does not move a case deadline on replay', async () => {
  const c = fixture();
  const command = { type: 'program.operator_case' as const, ...c.identity, case: randomUUID(), capability: randomUUID(), remainingMs: 600000, disposition: 'open' as const, revision: 2 };
  await c.runtime.message(command);
  await c.runtime.message({ ...command, revision: 1, disposition: 'revoke' });
  expect(c.runtime.failure(c.identity.agentKey)).toBeNull();
  c.at(100000); await c.runtime.message(command);
  c.at(600000); c.runtime.tick();
  expect(c.runtime.failure(c.identity.agentKey)).toBe('operator_timeout');
});

it('returns explicit no_program responses without creating a program for an unknown target', async () => {
  const c = fixture();
  const command = { ...c.identity, agentKey: randomUUID(), case: randomUUID(), capability: randomUUID() };
  await c.runtime.message({ type: 'program.screen_get', ...command, request: randomUUID() });
  expect(c.sent.at(-1)).toMatchObject({ type: 'program.screen', result: 'refused', reason: 'no_program' });
  await c.runtime.message({ type: 'program.key_send', ...command, snapshot: randomUUID(), generation: 0, action: randomUUID(), key: 'Enter', lease: randomUUID() });
  expect(c.sent.at(-1)).toMatchObject({ type: 'program.key_result', result: 'refused', reason: 'no_program' });
  await c.runtime.message({ type: 'program.key_prepare', ...command, snapshot: randomUUID(), generation: 0, action: randomUUID(), key: 'Enter' });
  expect(c.sent.at(-1)).toMatchObject({ type: 'program.key_prepared', result: 'refused', reason: 'no_program', lease: null });
});

it('inherits recorded source words without treating an unrecorded live attempt as taken', () => {
  const c = fixture(), key = c.identity.agentKey, source = { id: randomUUID(), ordinal: 2 };
  c.runtime.live(key, source, 'Original live words.');
  expect(c.runtime.inheritSource(key, source)).toBe(false);
  c.runtime.receipt(key, source, 'queued');
  expect(c.runtime.inheritSource(key, source)).toBe(false);
  c.runtime.receipt(key, source, 'taken');
  c.runtime.begin(key, randomUUID(), { id: randomUUID(), ordinal: 3 }, 'Original live words.', true);
  expect(c.runtime.inheritSource(key, source)).toBe(true);
  expect(c.runtime.recorded(key)).toBe(true);
  expect(c.sent).toContainEqual(expect.objectContaining({ type: 'program.delivery', phase: 'cancelled', deliveryOrdinal: 3 }));
});

it('uses revisions per case and gives a new job its own fixed case deadline', async () => {
  const c = fixture();
  const previous = { type: 'program.operator_case' as const, ...c.identity, case: randomUUID(), capability: randomUUID(), remainingMs: 10, disposition: 'open' as const, revision: 5 };
  await c.runtime.message(previous);
  await c.runtime.message({ ...previous, revision: 6, disposition: 'revoke' });
  c.at(20);
  const jobId = randomUUID();
  c.runtime.begin(c.identity.agentKey, jobId, { id: randomUUID(), ordinal: 2 }, 'Next words.', true);
  const identity = c.runtime.identity(c.identity.agentKey)!;
  await c.runtime.message({ ...previous, ...identity, case: randomUUID(), revision: 1, remainingMs: 600000 });
  c.at(600019); c.runtime.tick();
  expect(c.runtime.failure(c.identity.agentKey)).toBeNull();
  c.at(600020); c.runtime.tick();
  expect(c.runtime.failure(c.identity.agentKey)).toBe('operator_timeout');
});

it('observes questions in a typed job without inventing an assignment attempt', () => {
  const c = fixture();
  const key = randomUUID(), jobId = randomUUID();
  c.runtime.begin(key, jobId, undefined, '', false);
  c.runtime.launch(key, 'started');
  const question = { id: randomUUID(), kind: 'permission' as const, tool: 'Bash', text: 'Remove my temporary folder?', callId: 'q' };
  c.runtime.question(key, question);
  c.at(29999); c.runtime.tick();
  expect(c.sent.filter(f => f.type === 'program.operator_needed' && f.agentKey === key)).toEqual([]);
  c.at(30000); c.runtime.tick();
  expect(c.sent.filter(f => f.type === 'program.operator_needed' && f.agentKey === key)).toEqual([expect.objectContaining({ reason: 'question_waiting', questionId: question.id, jobId })]);
  expect(c.sent.filter(f => f.type === 'program.delivery' && f.agentKey === key)).toEqual([]);
});

it('stops question timers on cancellation and on process restoration', () => {
  const c = fixture();
  c.runtime.question(c.identity.agentKey, { id: randomUUID(), kind: 'permission', tool: 'Bash', text: 'Allow?', callId: null });
  c.runtime.intentional(c.identity.agentKey, 'cancelled');
  c.at(30000); c.runtime.tick();
  expect(c.sent.some(f => f.type === 'program.operator_needed' && f.reason === 'question_waiting')).toBe(false);
});

it('retains the pre-work case after escalation and reports readiness once only after owner input', async () => {
  const c = fixture();
  const command = { type: 'program.operator_case' as const, ...c.identity, case: randomUUID(), capability: randomUUID(), remainingMs: 600000, disposition: 'open' as const, revision: 1, reason: 'assignment_unrecorded' as const };
  await c.runtime.message(command);
  await c.runtime.message({ ...command, revision: 2, disposition: 'revoke', closedBecause: 'operator_unavailable' });
  c.runtime.recoveryReady(c.identity.agentKey, true);
  expect(c.sent.some(f => f.type === 'program.recovery_ready')).toBe(false);
  c.runtime.ownerInput(c.identity.agentKey);
  c.runtime.recoveryReady(c.identity.agentKey, true); c.runtime.recoveryReady(c.identity.agentKey, true);
  expect(c.sent.filter(f => f.type === 'program.recovery_ready')).toEqual([expect.objectContaining({ case: command.case, ...c.identity })]);
  expect(c.runtime.failureDetail(c.identity.agentKey)).toContain(command.case);
  expect(c.runtime.failureDetail(c.identity.agentKey)).toContain('operator_unavailable');
});

it('binds an early typed-turn question to the new confirmed job without restarting its native clock', () => {
  const c = fixture(), key = c.identity.agentKey, jobId = randomUUID();
  c.runtime.suspend(key);
  c.runtime.activity(key);
  const question = { id: randomUUID(), kind: 'permission' as const, tool: 'Bash', text: 'Read ./tmp/mine?', callId: 'early' };
  c.runtime.question(key, question);
  c.at(30000); c.runtime.tick();
  expect(c.sent.some(f => f.type === 'program.question')).toBe(false);
  c.runtime.begin(key, jobId, undefined, '', true); c.runtime.tick();
  expect(c.sent.filter(f => f.type === 'program.operator_needed' && f.reason === 'question_waiting')).toEqual([expect.objectContaining({ jobId, questionId: question.id, elapsedMs: 30000 })]);
  expect(c.sent.filter(f => f.type === 'program.question')).toEqual([expect.objectContaining({ jobId, question })]);
});

it('uses native completion to give the next assignment its own pre-work state', async () => {
  const c = fixture(), key = c.identity.agentKey;
  c.runtime.started(key); c.runtime.activity(key); c.runtime.intentional(key, 'completed');
  c.runtime.begin(key, randomUUID(), { id: randomUUID(), ordinal: 2 }, 'Next assignment.', true);
  const identity = c.runtime.identity(key)!;
  const incident = { ...identity, case: randomUUID(), capability: randomUUID() };
  await c.runtime.message({ type: 'program.operator_case', ...incident, disposition: 'open', revision: 1, remainingMs: 600000, reason: 'assignment_unrecorded' });
  const request = randomUUID();
  await c.runtime.message({ type: 'program.screen_get', ...incident, request });
  expect(c.sent.find(f => f.type === 'program.screen' && f.request === request)).toMatchObject({ state: 'pre_work', keysAllowed: true });
});

it.each([['bound', false, false], ['pending', true, false], ['late receipt', false, true], ['pending and late receipt', true, true]] as const)('credits exact source activity after continuation binding: %s', (_name, pending, lateReceipt) => {
  const c = fixture(), key = c.identity.agentKey;
  const unrelated = { id: randomUUID(), ordinal: 2 }, current = { id: randomUUID(), ordinal: 3 };
  c.runtime.begin(key, randomUUID(), unrelated, 'Unrelated old words.', true);
  c.runtime.receipt(key, unrelated, 'queued');
  if (!lateReceipt) c.runtime.receipt(key, c.assignment, 'taken');
  if (pending) { c.runtime.suspend(key); c.runtime.activity(key); }
  const source = { ...c.assignment }, jobId = randomUUID();
  c.runtime.begin(key, jobId, current, 'Words.', true, source);
  source.ordinal = 999;
  if (!pending) {
    expect(c.sent.filter(fact => fact.type === 'program.delivery' && fact.phase === 'activity')).toEqual([]);
    c.runtime.activity(key);
  }
  if (lateReceipt) c.runtime.receipt(key, c.assignment, 'taken');
  c.runtime.receipt(key, current, 'taken');
  c.runtime.intentional(key, 'completed'); c.at(300000); c.runtime.tick();
  expect(c.sent.filter(fact => fact.type === 'program.operator_needed' && fact.reason === 'recorded_no_activity')).toEqual([expect.objectContaining({ deliveryId: unrelated.id })]);
  expect(c.sent.filter(fact => fact.type === 'program.delivery' && fact.phase === 'activity')).toEqual([
    expect.objectContaining({ deliveryId: c.assignment.id, jobId: c.identity.jobId }),
    expect.objectContaining({ deliveryId: current.id, jobId }),
  ]);
});

it('does not credit source activity merely from binding, receipt or source inheritance', () => {
  const c = fixture(), key = c.identity.agentKey;
  c.runtime.receipt(key, c.assignment, 'queued');
  c.runtime.begin(key, randomUUID(), { id: randomUUID(), ordinal: 2 }, 'Words.', true, c.assignment);
  expect(c.runtime.inheritSource(key, c.assignment)).toBe(true);
  c.at(300000); c.runtime.tick();
  expect(c.sent.filter(fact => fact.type === 'program.delivery' && fact.phase === 'activity')).toEqual([]);
  expect(c.sent.filter(fact => fact.type === 'program.operator_needed' && fact.reason === 'recorded_no_activity')).toEqual([expect.objectContaining({ deliveryId: c.assignment.id })]);
});

it('retires replaced physical programs without a startup incident or a stale first-activity alarm', () => {
  const c = fixture(), key = c.identity.agentKey;
  c.runtime.receipt(key, c.assignment, 'queued');
  c.runtime.begin(key, randomUUID(), undefined, '', false);
  c.runtime.launch(key, 'attempt'); c.runtime.launch(key, 'started');
  expect(c.runtime.identity(key)?.instance).not.toBe(c.identity.instance);
  c.at(300000); c.runtime.tick();
  expect(c.sent.filter(f => f.type === 'program.delivery' && f.deliveryId === c.assignment.id && f.phase === 'cancelled')).toHaveLength(1);
  expect(c.sent.filter(f => f.type === 'program.operator_needed')).toEqual([]);
});
