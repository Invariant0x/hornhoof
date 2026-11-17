import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperatorNodeMessage, OperatorRecoveryState } from '@hornhoof/protocol/program-operator';
import { describe, expect, it, onTestFinished } from 'vitest';
import { OperatorRuntime } from '../src/terminal/operator-runtime.js';

type RecoverySource = Pick<ConstructorParameters<typeof OperatorRuntime>[1], 'current' | 'recovery' | 'facts'>;

function fixture(shown: Partial<RecoverySource> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-runtime-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  let now = 0;
  const sent: OperatorNodeMessage[] = [];
  const runtime = new OperatorRuntime({ dir, now: () => now, connected: () => true, send: frame => { sent.push(frame); return true; } }, { inputLine: () => 'unknown', current: () => ({ runningTool: false, retrying: false, wait: null }), capture: async () => ({ cols: 80, rows: 24, cells: 'Press Enter for a theme.' }), facts: async () => null, paste: async () => {}, press: async () => {}, secrets: () => [], recovery: async () => ({ alive: true, input: '', own: false, busy: false }), ...shown });
  const agentKey = randomUUID(), jobId = randomUUID();
  const assignment = { id: randomUUID(), ordinal: 1 };
  runtime.begin(agentKey, jobId, assignment, 'Words.', false);
  runtime.launch(agentKey, 'attempt'); runtime.launch(agentKey, 'started');
  const identity = runtime.identity(agentKey)!;
  return { runtime, sent, identity, assignment, at: (value: number) => { now = value; } };
}

/* What a release of a hold rests on: the server asks, and takes the node's word over its own database. */
const stateOf = async (c: ReturnType<typeof fixture>, agentKey = c.identity.agentKey) => {
  const request = randomUUID();
  await c.runtime.message({ type: 'program.recovery_state_get', ...c.identity, agentKey, request, case: randomUUID() });
  expect(c.sent.at(-1)).toMatchObject({ type: 'program.recovery_state', request, agentKey, jobId: c.identity.jobId, instance: c.identity.instance });
  return c.sent.at(-1);
};
const program = { runningTool: false, retrying: false, wait: null };

it('says a program is gone when it knows no such agent, or its program ended, and asks nothing of it', async () => {
  const asked: string[] = [];
  const c = fixture({ recovery: async key => { asked.push(key); return { alive: false, input: null, own: false, busy: false }; } });
  expect(await stateOf(c, randomUUID())).toMatchObject({ program: 'gone', current: null, generation: 0, input: 'unknown', wait: null });
  expect(asked).toEqual([]);
  expect(await stateOf(c)).toMatchObject({ program: 'gone', current: null, generation: 0, input: 'unknown', wait: null, busy: false });
  expect(asked).toEqual([c.identity.agentKey]);
});

it.each<[string, Partial<RecoverySource>, Record<string, unknown>]>([
  ['an empty prompt', {}, { input: 'empty', wait: null, runningTool: false, retrying: false, busy: false }],
  ['words in its input', { recovery: async () => ({ alive: true, input: 'a draft', own: false, busy: false }) }, { input: 'words' }],
  ['an input it cannot read', { recovery: async () => ({ alive: true, input: null, own: false, busy: false }) }, { input: 'unknown' }],
  ['a turn it works on', { recovery: async () => ({ alive: true, input: '', own: false, busy: true }) }, { input: 'empty', busy: true }],
  ['a protected question', { current: () => ({ ...program, wait: { id: randomUUID(), kind: 'protected' } }) }, { wait: 'protected' }],
  ['a running tool', { current: () => ({ ...program, runningTool: true }) }, { runningTool: true }],
  ['a retry of its model', { current: () => ({ ...program, retrying: true }) }, { retrying: true }],
  ['nothing it can say of the program', { current: () => null }, { wait: null, runningTool: false, retrying: false }],
])('says what it sees of a program with %s', async (_name, shown, facts) => {
  const c = fixture(shown);
  expect(await stateOf(c)).toMatchObject({ program: 'here', current: c.identity.instance, ...facts });
});

/* program_screen calls a program idle when it works on no turn; the release is told the same, whatever it did since. */
it('counts no work a program did since the words as work it is on, and says which generation of it that is', async () => {
  const c = fixture(), key = c.identity.agentKey;
  c.runtime.typed(key);
  const typed = await stateOf(c) as OperatorRecoveryState;
  expect(typed).toMatchObject({ input: 'empty', busy: false });
  c.runtime.activity(key);
  expect(await stateOf(c)).toMatchObject({ input: 'empty', busy: false, generation: typed.generation + 1 });
});

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

it('counts what a program does for its words only from the moment they go in', () => {
  const c = fixture(), key = c.identity.agentKey;
  c.runtime.activity(key);
  expect(c.runtime.wordsWaiting(key)).toBe(false);
  c.runtime.typed(key);
  expect(c.runtime.wordsWaiting(key)).toBe(true);
  c.runtime.activity(key);
  expect(c.runtime.wordsWaiting(key)).toBe(false);
});

it('returns explicit no_program responses without creating a program for an unknown target', async () => {
  const c = fixture();
  const agentKey = randomUUID(), request = randomUUID(), action = randomUUID();
  await c.runtime.message({ type: 'program.view_get', agentKey, request });
  expect(c.sent.at(-1)).toMatchObject({ type: 'program.view', agentKey, request, result: 'refused', reason: 'no_program', snapshot: null, state: 'gone' });
  await c.runtime.message({ type: 'program.input_send', agentKey, action, snapshot: randomUUID(), keys: ['Enter'], text: null, auditReason: 'Continue the program.' });
  expect(c.sent.at(-1)).toMatchObject({ type: 'program.input_result', agentKey, action, result: 'refused', reason: 'no_program' });
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

it('retains the pre-work case after escalation and reports readiness once by itself and once after owner input', async () => {
  const c = fixture();
  const command = { type: 'program.operator_case' as const, ...c.identity, case: randomUUID(), capability: randomUUID(), remainingMs: 600000, disposition: 'open' as const, revision: 1, reason: 'assignment_unrecorded' as const };
  await c.runtime.message(command);
  await c.runtime.message({ ...command, revision: 2, disposition: 'revoke', closedBecause: 'operator_unavailable' });
  c.runtime.recoveryReady(c.identity.agentKey, true); c.runtime.recoveryReady(c.identity.agentKey, true);
  expect(c.sent.filter(f => f.type === 'program.recovery_ready')).toEqual([expect.objectContaining({ case: command.case, ...c.identity, owner: false })]);
  c.runtime.ownerInput(c.identity.agentKey);
  c.runtime.recoveryReady(c.identity.agentKey, true); c.runtime.recoveryReady(c.identity.agentKey, true);
  expect(c.sent.filter(f => f.type === 'program.recovery_ready').map(f => f.type === 'program.recovery_ready' && f.owner)).toEqual([false, true]);
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

/* Neo's turn b559a00c on 17.11: its assignment (delivery 268) got no receipt, as the node refused the program's hooks, yet
   the program took the live words that came after it (delivery 269) at 01:50:48. The operator's case closed as failed at
   02:06:13, and the turn ended with it although the program worked on. */
const unrecordedCase = (c: ReturnType<typeof fixture>) => ({ type: 'program.operator_case' as const, ...c.identity, case: randomUUID(), capability: randomUUID(), remainingMs: 600000, disposition: 'open' as const, revision: 1, reason: 'assignment_unrecorded' as const });

it('fails no turn by the end of its case once the program took words that came after the assignment', async () => {
  const c = fixture(), key = c.identity.agentKey, opened = unrecordedCase(c);
  await c.runtime.message(opened);
  const live = { id: randomUUID(), ordinal: c.assignment.ordinal + 1 };
  c.runtime.live(key, live, 'Live words.');
  c.runtime.receipt(key, live, 'taken');
  await c.runtime.message({ ...opened, revision: 2, disposition: 'revoke', closedBecause: 'failed' });
  expect([c.runtime.failure(key), c.runtime.failureDetail(key), c.runtime.wordsWaiting(key)]).toEqual([null, null, false]);
  c.at(600000); c.runtime.tick();
  expect(c.runtime.failure(key)).toBeNull();
});

it.each<[string, (c: ReturnType<typeof fixture>) => void]>([
  ['later words it only queued', c => { const live = { id: randomUUID(), ordinal: 2 }; c.runtime.live(c.identity.agentKey, live, 'Live words.'); c.runtime.receipt(c.identity.agentKey, live, 'queued'); }],
  ['later words it did not take', c => { const live = { id: randomUUID(), ordinal: 2 }; c.runtime.live(c.identity.agentKey, live, 'Live words.'); c.runtime.receipt(c.identity.agentKey, live, 'not_taken'); }],
  ['earlier words it took', c => c.runtime.receipt(c.identity.agentKey, { id: randomUUID(), ordinal: 1 }, 'taken')],
])('still fails the turn with its case when the program took nothing after the assignment: %s', async (_name, meanwhile) => {
  const c = fixture(), key = c.identity.agentKey, opened = unrecordedCase(c);
  await c.runtime.message(opened);
  meanwhile(c);
  await c.runtime.message({ ...opened, revision: 2, disposition: 'revoke', closedBecause: 'failed' });
  expect(c.runtime.failure(key)).toBe('failed');
  expect(c.runtime.failureDetail(key)).toBe(`failed; case ${opened.case}`);
});

/* The program ran a long Bash as its assignment came: the screen said working, Hornhoof's words had gone in, and a case of
   words not recorded opened all the same (three of them on the morning of 17.11). A program inside a tool call records
   the words it was given once the call ends. */
describe('the case of assignment words not recorded while the program is inside a tool call', () => {
  const settled = () => new Promise(done => setImmediate(done));
  const working = (tool: { running: boolean }, words: { undelivered: boolean }) => fixture({
    current: () => ({ ...program, runningTool: tool.running }),
    facts: async () => ({ jobId: null, instance: randomUUID(), working: true, tool: tool.running ? 'Bash' : null, question: null, input: 'empty', undelivered: words.undelivered }),
  });
  const unrecorded = (c: ReturnType<typeof fixture>) => c.sent.filter(f => f.type === 'program.operator_needed' && f.reason === 'assignment_unrecorded');
  const lookAt = async (c: ReturnType<typeof fixture>, ms: number) => { c.at(ms); c.runtime.tick(); await settled(); await settled(); };

  it('opens none while a long Bash runs with the words gone in', async () => {
    const c = working({ running: true }, { undelivered: false });
    for (const ms of [60_000, 90_000, 120_000, 300_000, 600_000]) await lookAt(c, ms);
    expect(unrecorded(c)).toEqual([]);
  });

  it('opens one when the words never went in and nothing moved for sixty seconds', async () => {
    const c = working({ running: true }, { undelivered: true });
    await lookAt(c, 59_999);
    expect(unrecorded(c)).toEqual([]);
    await lookAt(c, 60_000);
    expect(unrecorded(c)).toEqual([expect.objectContaining({ deliveryId: c.assignment.id, elapsedMs: 60_000 })]);
  });

  it('opens one once the call ended and the words were still not recorded', async () => {
    const tool = { running: true };
    const c = working(tool, { undelivered: false });
    await lookAt(c, 60_000);
    tool.running = false;
    await lookAt(c, 90_000);
    expect(unrecorded(c)).toEqual([]);
    await lookAt(c, 120_000);
    expect(unrecorded(c)).toEqual([expect.objectContaining({ deliveryId: c.assignment.id, elapsedMs: 120_000 })]);
  });

  it('opens none once the words got recorded after the call', async () => {
    const tool = { running: true };
    const c = working(tool, { undelivered: false });
    await lookAt(c, 60_000);
    tool.running = false;
    c.runtime.receipt(c.identity.agentKey, c.assignment, 'taken');
    await lookAt(c, 120_000);
    expect(unrecorded(c)).toEqual([]);
  });
});
