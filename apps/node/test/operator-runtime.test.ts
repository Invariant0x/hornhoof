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
  runtime.begin(agentKey, jobId, { id: randomUUID(), ordinal: 1 }, 'Words.', false);
  runtime.launch(agentKey, 'attempt'); runtime.launch(agentKey, 'started');
  const identity = runtime.identity(agentKey)!;
  return { runtime, sent, identity, at: (value: number) => { now = value; } };
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
  await c.runtime.message({ type: 'program.key_send', ...command, snapshot: randomUUID(), generation: 0, action: randomUUID(), key: 'Enter' });
  expect(c.sent.at(-1)).toMatchObject({ type: 'program.key_result', result: 'refused', reason: 'no_program' });
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
