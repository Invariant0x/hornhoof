import { describe, expect, it } from 'vitest';
import { OPERATOR_CELLS_BYTES, OperatorDelivery, OperatorNodeMessage, OperatorServerMessage, PROGRAM_INPUT_KEYS, PROGRAM_INPUT_TEXT, PROGRAM_OPERATOR_ROLE, ProgramKey } from '../src/program-operator.js';

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
      { type: 'program.input_result', agentKey: id, action: id, result: 'unknown', reason: 'action_unknown', jobId: null, instance: null, question: null, text: null, auditReason: '[hidden]' },
    ];
    for (const frame of frames) expect(OperatorNodeMessage.parse(frame)).toEqual(frame);
  });

  it('carries the existing pane and rejects oversized or executable additions', () => {
    const screen = { type: 'program.view', agentKey: id, request: id, result: 'ok', reason: null, jobId: id, instance: id, snapshot: id, state: 'idle', tool: null, question: null, input: 'hornhoof', undelivered: true, cols: 160, rows: 48, cells: 'Press Enter.\nНажмите Enter.' };
    expect(OperatorNodeMessage.parse(screen)).toEqual(screen);
    expect(OperatorNodeMessage.safeParse({ ...screen, cells: 'a'.repeat(65537) }).success).toBe(false);
    expect(OperatorNodeMessage.safeParse({ ...screen, command: 'shell' }).success).toBe(false);
  });

  it('bounds an optional completed-response proof while accepting older node views', () => {
    const view = { type: 'program.view', agentKey: id, request: id, result: 'ok', reason: null, jobId: id, instance: id, snapshot: id, state: 'idle', tool: null, question: null, input: 'empty', undelivered: false, cols: 80, rows: 24, cells: 'response' };
    const completion = 'a'.repeat(64);
    expect(OperatorNodeMessage.parse(view)).toEqual(view);
    expect(OperatorNodeMessage.parse({ ...view, completion })).toEqual({ ...view, completion });
    for (const invalid of ['', 'a'.repeat(65), 'G'.repeat(64), null]) expect(OperatorNodeMessage.safeParse({ ...view, completion: invalid }).success).toBe(false);
  });

  it('takes any key by its tmux name, Ctrl, Alt and Shift too, and nothing that could become a tmux option', () => {
    for (const key of ['Enter', 'Escape', 'Tab', 'BTab', 'BSpace', 'Up', 'PageDown', 'F5', 'F12', 'a', 'Z', '1', 'C-u', 'C-c', 'M-b', 'S-Tab', 'C-M-x']) expect(ProgramKey.parse(key)).toBe(key);
    for (const key of ['-t', 'Enter;kill-server', 'Ctrl+U', 'C-', 'F13', 'hello', '\n', ' Enter', '', ['Enter', 'Tab']]) expect(ProgramKey.safeParse(key).success).toBe(false);
  });

  it('sends text and keys together, bounded, and never nothing', () => {
    const command = { type: 'program.input_send', agentKey: id, action: id, snapshot: id, keys: ['C-u'], text: 'Go on.', auditReason: 'Continue.' };
    expect(OperatorServerMessage.parse(command)).toEqual(command);
    expect(OperatorServerMessage.parse({ ...command, keys: [] })).toMatchObject({ keys: [] });
    expect(OperatorServerMessage.parse({ ...command, text: null })).toMatchObject({ text: null });
    for (const wrong of [{ keys: [], text: null }, { keys: Array(PROGRAM_INPUT_KEYS + 1).fill('Enter') }, { text: 'a'.repeat(PROGRAM_INPUT_TEXT + 1) }, { text: '' }, { auditReason: '' }, { auditReason: 'x'.repeat(1001) }, { keys: ['-t'] }, { case: id }]) {
      expect(OperatorServerMessage.safeParse({ ...command, ...wrong }).success).toBe(false);
    }
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
  describe('what the node saw as it stopped waiting', () => {
    const needed = { type: 'program.operator_needed', ...evidence, reason: 'assignment_unrecorded', deliveryId: id, evidenceKey: id, elapsedMs: 60000, sinceLaunchMs: 60000, exit: null };
    const screen = { cols: 80, rows: 24, cells: 'Screen.' };

    it('is optional, and takes the input line with or without a screen', () => {
      expect(OperatorNodeMessage.safeParse(needed).success).toBe(true);
      expect(OperatorNodeMessage.safeParse({ ...needed, check: { input: 'text', screen } }).success).toBe(true);
      expect(OperatorNodeMessage.safeParse({ ...needed, check: { input: 'unknown', screen: null } }).success).toBe(true);
    });

    it('refuses an unknown input state, the text of the line, a screen over the limit and any other field', () => {
      for (const check of [
        { input: 'full', screen: null },
        { input: 'text', screen: null, text: 'The unsent words.' },
        { input: 'text', screen: { ...screen, cells: 'x'.repeat(OPERATOR_CELLS_BYTES + 1) } },
        { input: 'text', screen: { ...screen, cols: 513 } },
        { input: 'text', screen: { ...screen, snapshot: 'a-snapshot-token-16' } },
        { input: 'text' },
      ]) expect(OperatorNodeMessage.safeParse({ ...needed, check }).success).toBe(false);
    });
  });
});
