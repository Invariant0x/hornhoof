import { describe, expect, it } from 'vitest';
import { OperatorDelivery, OperatorKey, OperatorNodeMessage, OperatorServerMessage, PROGRAM_OPERATOR_ROLE } from '../src/program-operator.js';

const id = '10000000-0000-4000-8000-000000000001';
const identity = { agentKey: id, jobId: id, instance: id };
const evidence = { ...identity, evidenceId: id, ordinal: 0 };
const delivery = { type: 'program.delivery', ...evidence, deliveryId: id, deliveryOrdinal: 1, kind: 'assignment', phase: 'attempt', elapsedMs: 0, wordsDigest: 'a'.repeat(64) };

describe('bounded program operator protocol', () => {
  it('carries exact-word evidence separately from transport receipts', () => {
    for (const phase of ['attempt', 'queued', 'taken', 'activity', 'not_taken', 'cancelled']) {
      expect(OperatorNodeMessage.parse({ ...delivery, phase })).toEqual({ ...delivery, phase });
    }
    expect(OperatorDelivery.parse({ id, ordinal: 1 })).toEqual({ id, ordinal: 1 });
    expect(PROGRAM_OPERATOR_ROLE).toBe('OPS-PROGRAM');
  });

  it.each([
    { ...delivery, evidenceId: 'not-a-uuid' }, { ...delivery, elapsedMs: -1 }, { ...delivery, ordinal: 0.5 },
    { ...delivery, phase: 'held' }, { ...delivery, wordsDigest: 'short' }, { ...delivery, secret: 'never' },
  ])('rejects malformed or extra delivery evidence: %j', frame => {
    expect(OperatorNodeMessage.safeParse(frame).success).toBe(false);
  });

  it('round trips launch, operator reasons, recovery and execution outcomes', () => {
    const frames = [
      { type: 'program.launch', ...evidence, phase: 'started', elapsedMs: 0 },
      { type: 'program.operator_needed', ...evidence, reason: 'startup_exit', deliveryId: null, evidenceKey: id, elapsedMs: 20, sinceLaunchMs: 20, exit: { code: 0, signal: null } },
      { type: 'program.recovery_ready', ...evidence, case: id },
      { type: 'program.key_result', ...identity, action: id, result: 'unknown', reason: 'action_unknown' },
    ];
    for (const frame of frames) expect(OperatorNodeMessage.parse(frame)).toEqual(frame);
  });

  it('carries the existing pane and rejects oversized or executable additions', () => {
    const screen = { type: 'program.screen', ...identity, request: id, result: 'ok', reason: null, snapshot: id, generation: 1, state: 'pre_work', keysAllowed: true, protected: false, cols: 160, rows: 48, cells: 'Press Enter.\nНажмите Enter.' };
    expect(OperatorNodeMessage.parse(screen)).toEqual(screen);
    expect(OperatorNodeMessage.safeParse({ ...screen, cells: 'a'.repeat(65537) }).success).toBe(false);
    expect(OperatorNodeMessage.safeParse({ ...screen, command: 'shell' }).success).toBe(false);
  });

  it('permits one menu key and forbids Escape, control chords, text and paste', () => {
    for (const key of ['Enter', 'Up', 'Down', 'Left', 'Right', 'Tab']) expect(OperatorKey.parse(key)).toBe(key);
    for (const key of ['Escape', 'C-c', 'C-d', 'Ctrl-C', 'hello', '\n', ['Enter', 'Tab']]) expect(OperatorKey.safeParse(key).success).toBe(false);
    const command = { type: 'program.key_send', ...identity, case: id, capability: id, snapshot: id, generation: 1, action: id, key: 'Enter', lease: id };
    expect(OperatorServerMessage.parse(command)).toEqual(command);
    expect(OperatorServerMessage.safeParse({ ...command, text: 'accept' }).success).toBe(false);
  });

  it('bounds capability lifetimes and revisions and acknowledges individual evidence facts', () => {
    const open = { type: 'program.operator_case', ...identity, case: id, capability: id, disposition: 'open', remainingMs: 600000, revision: 1 };
    expect(OperatorServerMessage.parse(open)).toEqual(open);
    expect(OperatorServerMessage.parse({ ...open, readOnly: true })).toEqual({ ...open, readOnly: true });
    expect(OperatorServerMessage.safeParse({ ...open, remainingMs: 600001 }).success).toBe(false);
    expect(OperatorServerMessage.safeParse({ ...open, revision: -1 }).success).toBe(false);
    expect(OperatorServerMessage.parse({ type: 'program.evidence_ack', evidenceId: id })).toEqual({ type: 'program.evidence_ack', evidenceId: id });
  });

  it('binds a thirty-second asking case and its permission capability to one durable program question', () => {
    const question = { id, kind: 'permission', tool: 'Bash', text: 'Remove the agent temporary folder?', callId: 'call-1' };
    const asked = { type: 'program.question', ...evidence, question, questionOrdinal: 1, phase: 'asked', elapsedMs: 0 };
    expect(OperatorNodeMessage.parse(asked)).toEqual(asked);
    expect(OperatorNodeMessage.parse({ ...asked, phase: 'cleared', elapsedMs: 29999 })).toMatchObject({ phase: 'cleared' });
    const needed = { type: 'program.operator_needed', ...evidence, reason: 'question_waiting', questionId: id, deliveryId: null, evidenceKey: id, elapsedMs: 30000, sinceLaunchMs: 31000, exit: null };
    expect(OperatorNodeMessage.parse(needed)).toEqual(needed);
    expect(OperatorNodeMessage.safeParse({ ...needed, questionId: undefined }).success).toBe(false);
    const capability = { type: 'program.operator_case', ...identity, case: id, capability: id, disposition: 'open', remainingMs: 600000, revision: 1, reason: 'question_waiting', questionId: id };
    expect(OperatorServerMessage.parse(capability)).toEqual(capability);
    expect(OperatorNodeMessage.safeParse({ ...asked, question: { ...question, text: 'a'.repeat(4097) } }).success).toBe(false);
  });
});
