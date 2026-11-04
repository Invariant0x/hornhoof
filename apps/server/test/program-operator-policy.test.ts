import { randomUUID } from 'node:crypto';
import type { OperatorEvidence } from '@hornhoof/protocol/program-operator';
import { expect, it } from 'vitest';
import { qualifyingReasons, liveFailureSignals } from '../src/modules/program-operator/policy.js';

const identity = { agentKey: randomUUID(), jobId: randomUUID(), instance: randomUUID() };
const deliveryId = randomUUID();
const evidence = { ...identity, evidenceId: randomUUID(), ordinal: 0 };
const attempt: OperatorEvidence = { type: 'program.delivery', ...evidence, deliveryId, deliveryOrdinal: 1, kind: 'assignment', phase: 'attempt', elapsedMs: 0, wordsDigest: 'a'.repeat(64) };
const fact = (phase: Extract<OperatorEvidence, { type: 'program.delivery' }>['phase'], elapsedMs: number, ordinal: number): OperatorEvidence => ({ ...attempt, phase, elapsedMs, ordinal, evidenceId: randomUUID() });
const alarm = (reason: 'assignment_unrecorded' | 'recorded_no_activity' | 'startup_exit', elapsedMs: number): Extract<OperatorEvidence, { type: 'program.operator_needed' }> => ({ type: 'program.operator_needed', ...evidence, ordinal: 5, reason, elapsedMs, deliveryId, sinceLaunchMs: elapsedMs, evidenceKey: deliveryId, exit: null });

it('requires a real assignment attempt and the sixty-second boundary rather than a live/held acknowledgement', () => {
  const needed = alarm('assignment_unrecorded', 60000);
  expect(qualifyingReasons([needed])).toEqual([]);
  expect(qualifyingReasons([attempt, alarm('assignment_unrecorded', 59999)])).toEqual([]);
  expect(qualifyingReasons([attempt, needed])).toMatchObject([{ reason: 'assignment_unrecorded', deliveryId }]);
  expect(qualifyingReasons([{ ...attempt, kind: 'live' }, needed])).toEqual([]);
  expect(qualifyingReasons([needed, fact('queued', 10, 1), attempt])).toEqual([]);
});

it('waits five minutes from a word receipt and permanently disarms on the first own event', () => {
  const receipt = fact('taken', 1000, 1);
  expect(qualifyingReasons([attempt, receipt, alarm('recorded_no_activity', 300999)])).toEqual([]);
  const needed = alarm('recorded_no_activity', 301000);
  expect(qualifyingReasons([attempt, receipt, needed])).toMatchObject([{ reason: 'recorded_no_activity' }]);
  expect(qualifyingReasons([attempt, fact('activity', 500, 1), receipt, needed])).toEqual([]);
  expect(qualifyingReasons([attempt, receipt, fact('activity', 1100, 2), alarm('recorded_no_activity', 8 * 3600000)])).toEqual([]);
});

it('requires a launch and a real early exit, including zero and launch failure, before own activity', () => {
  const launch: OperatorEvidence = { type: 'program.launch', ...evidence, phase: 'attempt', elapsedMs: 0 };
  const exit = { ...alarm('startup_exit', 60000), deliveryId: null, evidenceKey: identity.instance, exit: { code: 0, signal: null } };
  expect(qualifyingReasons([exit])).toEqual([]);
  expect(qualifyingReasons([launch, exit])).toMatchObject([{ reason: 'startup_exit' }]);
  expect(qualifyingReasons([launch, { ...exit, sinceLaunchMs: 60001 }])).toEqual([]);
  expect(qualifyingReasons([launch, fact('activity', 1, 1), exit])).toEqual([]);
  expect(qualifyingReasons([launch, { ...exit, exit: null }])).toEqual([]);
});

it('ends a missing-receipt claim on cancelled words and never uses a cancelled delivery for first activity', () => {
  expect(qualifyingReasons([attempt, fact('cancelled', 20, 1), alarm('assignment_unrecorded', 60000)])).toEqual([]);
  expect(qualifyingReasons([attempt, fact('queued', 10, 1), fact('cancelled', 20, 2), alarm('recorded_no_activity', 400000)])).toEqual([]);
});

it('counts consecutive finalized live outcomes in delivery order, across instances, once per streak', () => {
  const delivery = (ordinal: number, outcome: 'pending' | 'taken' | 'not_taken' | 'cancelled') => ({ id: randomUUID(), ordinal, instance: randomUUID(), outcome });
  const first = [delivery(1, 'not_taken'), delivery(2, 'not_taken'), delivery(3, 'not_taken'), delivery(4, 'not_taken'), delivery(5, 'not_taken')];
  expect(liveFailureSignals(first.slice().reverse())).toEqual([first[2]]);
  const reset = [...first, delivery(6, 'taken'), delivery(7, 'not_taken'), delivery(8, 'cancelled'), delivery(9, 'not_taken'), delivery(10, 'not_taken')];
  expect(liveFailureSignals(reset)).toEqual([first[2], reset[9]]);
  expect(liveFailureSignals([first[0]!, delivery(2, 'pending'), ...first.slice(2)])).toEqual([first[4]]);
});

it('recognizes a known failed run after an older unknown delivery and retains its consumed identity on late finalization', () => {
  const deliveries = (['pending', 'not_taken', 'not_taken', 'not_taken'] as const).map((outcome, ordinal) => ({ id: randomUUID(), ordinal: ordinal + 1, instance: randomUUID(), outcome }));
  expect(liveFailureSignals(deliveries)).toEqual([deliveries[3]]);
  const later = [{ ...deliveries[0]!, outcome: 'not_taken' as const }, ...deliveries.slice(1)];
  expect(liveFailureSignals(later, new Set([deliveries[3]!.id]))).toEqual([deliveries[3]]);
  const separated = [...later, { ...deliveries[0]!, id: randomUUID(), ordinal: 5, outcome: 'pending' as const }, ...later.slice(1).map((row, i) => ({ ...row, id: randomUUID(), ordinal: i + 6 }))];
  expect(liveFailureSignals(separated)).toHaveLength(1);
});

it('requires the exact current program question at thirty seconds, excluding work decisions', () => {
  const question = { id: randomUUID(), kind: 'permission' as const, text: 'Remove ./tmp/mine?', tool: 'Bash', callId: 'q' };
  const asked: OperatorEvidence = { type: 'program.question', ...evidence, question, questionOrdinal: 1, phase: 'asked', elapsedMs: 0 };
  const needed: OperatorEvidence = { ...alarm('startup_exit', 30000), reason: 'question_waiting', deliveryId: null, evidenceKey: question.id, questionId: question.id };
  expect(qualifyingReasons([needed])).toEqual([]);
  expect(qualifyingReasons([asked, { ...needed, elapsedMs: 29999 }])).toEqual([]);
  expect(qualifyingReasons([needed, asked])).toEqual([needed]);
  expect(qualifyingReasons([asked, { ...needed, questionId: randomUUID() }])).toEqual([]);
  expect(qualifyingReasons([asked, needed, { ...asked, phase: 'cleared', ordinal: 6 }])).toEqual([]);
  expect(qualifyingReasons([asked, needed, { ...asked, question: { ...question, id: randomUUID() }, questionOrdinal: 2, ordinal: 6 }])).toEqual([]);
  expect(qualifyingReasons([{ ...asked, question: { ...question, kind: 'work', tool: 'AskUserQuestion' } }, needed])).toEqual([]);
  expect(qualifyingReasons([asked, needed, fact('activity', 30001, 6)])).toEqual([]);
});


it('uses the earliest real receipt and deduplicates equivalent alarms for the same instance', () => {
  const needed = alarm('recorded_no_activity', 300010);
  expect(qualifyingReasons([attempt, fact('taken', 1000, 2), fact('queued', 10, 1), needed, { ...needed, evidenceId: randomUUID() }])).toEqual([needed]);
  expect(qualifyingReasons([attempt, { ...alarm('assignment_unrecorded', 60000), evidenceKey: randomUUID() }])).toEqual([]);
  expect(qualifyingReasons([attempt, { ...alarm('assignment_unrecorded', 60000), jobId: randomUUID() }])).toEqual([]);
  expect(qualifyingReasons([attempt, { ...alarm('assignment_unrecorded', 60000), instance: randomUUID() }])).toEqual([]);
});
