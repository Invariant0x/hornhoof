import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperatorNodeMessage } from '@hornhoof/protocol/program-operator';
import { expect, it, onTestFinished } from 'vitest';
import { OperatorRuntime } from '../src/terminal/operator-runtime.js';

type Source = { runningTool: boolean; retrying: boolean; wait: { id: string; kind: 'permission' | 'menu' | 'protected' | 'work' | 'unknown' } | null };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'hh-recovery-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const sent: OperatorNodeMessage[] = [];
  const source: Source = { runningTool: false, retrying: false, wait: null };
  const make = () => new OperatorRuntime({ dir, now: () => 0, connected: () => true, send: frame => { sent.push(frame); return true; } }, {
    current: () => ({ agentProgram: true, alive: true, pasted: false, turnStarted: false, active: false, ...source }),
    capture: async () => ({ cols: 80, rows: 24, cells: '' }),
    press: async () => {},
    secrets: () => [],
    recovery: async () => ({ alive: true, input: '', busy: false }),
  });
  const key = randomUUID();
  return { runtime: make(), make, sent, source, key, ready: () => sent.filter(frame => frame.type === 'program.recovery_ready') };
}

const words = () => ({ id: randomUUID(), ordinal: 1 });

/* The case of these words closes the way the server says so: the program operator had no way through. */
async function closeCase(runtime: OperatorRuntime, key: string): Promise<string> {
  const identity = runtime.identity(key)!, id = randomUUID(), capability = randomUUID();
  const frame = { type: 'program.operator_case' as const, ...identity, case: id, capability, remainingMs: 600000, reason: 'assignment_unrecorded' as const };
  await runtime.message({ ...frame, disposition: 'open', revision: 1 });
  await runtime.message({ ...frame, disposition: 'revoke', revision: 2, closedBecause: 'operator_unavailable' });
  return id;
}

/* A program that worked on an earlier turn and goes on, its last turn stopped rather than finished. */
function reused(c: ReturnType<typeof fixture>) {
  c.runtime.begin(c.key, randomUUID(), words(), 'Earlier words.', false);
  c.runtime.launch(c.key, 'attempt'); c.runtime.launch(c.key, 'started');
  c.runtime.started(c.key); c.runtime.activity(c.key);
  c.runtime.intentional(c.key, 'cancelled');
  c.runtime.begin(c.key, randomUUID(), words(), 'New words.', true);
}

it('counts only what the program did since these words, in a session it goes on', async () => {
  const c = fixture();
  reused(c);
  await closeCase(c.runtime, c.key);
  expect(c.runtime.failure(c.key)).toBe('operator_unavailable');
  expect(c.runtime.recovering(c.key)).toBe(true);
});

it('counts a program first seen going on its session the same way', async () => {
  const c = fixture();
  c.runtime.begin(c.key, randomUUID(), words(), 'New words.', true);
  await closeCase(c.runtime, c.key);
  expect(c.runtime.failure(c.key)).toBe('operator_unavailable');
  expect(c.runtime.recovering(c.key)).toBe(true);
});

it('says the owner passed the screen of a program that goes on its session', async () => {
  const c = fixture();
  reused(c);
  const id = await closeCase(c.runtime, c.key);
  c.runtime.ownerInput(c.key);
  c.runtime.recoveryReady(c.key, true);
  expect(c.ready()).toEqual([expect.objectContaining({ case: id, owner: true })]);
});

it('goes on by itself once from a program at its empty prompt', async () => {
  const c = fixture();
  c.runtime.begin(c.key, randomUUID(), words(), 'Words.', false);
  c.runtime.launch(c.key, 'attempt'); c.runtime.launch(c.key, 'started');
  const id = await closeCase(c.runtime, c.key);
  c.runtime.recoveryReady(c.key, true);
  c.runtime.recoveryReady(c.key, true);
  expect(c.ready()).toEqual([expect.objectContaining({ case: id, owner: false })]);
});

it('still says so when the owner presses Enter after it went on by itself', async () => {
  const c = fixture();
  reused(c);
  await closeCase(c.runtime, c.key);
  c.runtime.recoveryReady(c.key, true);
  c.runtime.ownerInput(c.key);
  c.runtime.recoveryReady(c.key, true);
  c.runtime.recoveryReady(c.key, true);
  expect(c.ready().map(frame => frame.type === 'program.recovery_ready' && frame.owner)).toEqual([false, true]);
});

it('says nothing of a program that is not at its empty prompt', async () => {
  const c = fixture();
  reused(c);
  await closeCase(c.runtime, c.key);
  c.runtime.recoveryReady(c.key, false);
  expect(c.ready()).toEqual([]);
});

it.each<[string, Partial<Source>]>([
  ['a protected question', { wait: { id: randomUUID(), kind: 'protected' } }],
  ['a permission question', { wait: { id: randomUUID(), kind: 'permission' } }],
  ['a menu', { wait: { id: randomUUID(), kind: 'menu' } }],
  ['a question about the work', { wait: { id: randomUUID(), kind: 'work' } }],
  ['a tool at work', { runningTool: true }],
  ['a retry of its model', { retrying: true }],
])('does not pass %s, even at what looks like an empty prompt', async (_name, source) => {
  const c = fixture();
  reused(c);
  await closeCase(c.runtime, c.key);
  Object.assign(c.source, source);
  c.runtime.ownerInput(c.key);
  c.runtime.recoveryReady(c.key, true);
  expect(c.ready()).toEqual([]);
});

it.each<[string, (c: ReturnType<typeof fixture>) => void]>([
  ['the program recorded the words', c => c.runtime.receipt(c.key, c.runtime['targets'].get(c.key)!.assignment!, 'queued')],
  ['the program started a turn', c => c.runtime.started(c.key)],
  ['the program did something of its own', c => c.runtime.activity(c.key)],
  ['the program is gone', c => c.runtime.exited(c.key, { code: 1, signal: null })],
])('recovers nothing once %s', async (_name, happened) => {
  const c = fixture();
  reused(c);
  await closeCase(c.runtime, c.key);
  happened(c);
  expect(c.runtime.recovering(c.key)).toBe(false);
  c.runtime.recoveryReady(c.key, true);
  expect(c.ready()).toEqual([]);
});

it('keeps an operator away from a program with work behind it, while its words wait', async () => {
  const c = fixture();
  reused(c);
  const current = c.runtime['current'](c.key);
  expect(current).toMatchObject({ turnStarted: true, active: true });
});

it('does not say it twice after the node starts again', async () => {
  const c = fixture();
  c.runtime.begin(c.key, randomUUID(), words(), 'Words.', false);
  c.runtime.launch(c.key, 'attempt'); c.runtime.launch(c.key, 'started');
  await closeCase(c.runtime, c.key);
  c.runtime.recoveryReady(c.key, true);
  c.make().replay();
  const said = c.ready().map(frame => frame.type === 'program.recovery_ready' ? frame.evidenceId : null);
  expect(new Set(said).size).toBe(1);
});
