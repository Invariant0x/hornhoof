import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperatorNodeMessage } from '@hornhoof/protocol/program-operator';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanups, liveTerminal } from './terminal-host-live-helpers.js';

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

type Live = Awaited<ReturnType<typeof liveTerminal>>;

/* A program on the recorded stand-in, with what its node tells the server kept in sent. */
async function program(options: Parameters<typeof liveTerminal>[2] = {}) {
  const sent: OperatorNodeMessage[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'hh-question-'));
  const clock = { now: 0 };
  const t = await liveTerminal('claude', 'queued', { key: randomUUID(), jobId: randomUUID(), ...options, operator: { dir, now: () => clock.now, connected: () => true, send: frame => { sent.push(frame); return true; } } });
  cleanups.push(async () => { rmSync(dir, { recursive: true, force: true }); });
  return { t, sent, clock };
}

/* What the orchestrator and Operations see of the program, and what came of the keys they gave it after that look. No case
   has to be open for either. */
async function look(t: Live, sent: OperatorNodeMessage[], agentKey: string) {
  const request = randomUUID();
  await t.host.operatorMessage({ type: 'program.view_get', agentKey, request });
  const view = sent.find(f => f.type === 'program.view' && f.request === request);
  if (view?.type !== 'program.view' || !view.snapshot) throw new Error('No view of the program.');
  return view;
}

async function type(t: Live, sent: OperatorNodeMessage[], agentKey: string, snapshot: string, keys: string[]) {
  const action = randomUUID();
  await t.host.operatorMessage({ type: 'program.input_send', agentKey, action, snapshot, keys, text: null, auditReason: 'Continue the program.' });
  return sent.find(f => f.type === 'program.input_result' && f.action === action);
}

it.each([true, false])('shows the permission question the program asks and takes one input for each look (assignment metadata: %s)', async metadata => {
  const { t, sent, clock } = await program(metadata ? { operatorDelivery: { id: randomUUID(), ordinal: 1 } } : {});
  await t.hook('ask', { tool_use_id: 'permission-1', tool_name: 'Bash', tool_input: { command: 'rm -r ./tmp/mine' } });
  t.screen.mockResolvedValue('Permission request for Bash. Remove ./tmp/mine? Yes / No');
  clock.now = 29999; t.host.operatorTick();
  expect(sent.some(f => f.type === 'program.operator_needed' && f.reason === 'question_waiting')).toBe(false);
  clock.now = 30000; t.host.operatorTick(); t.host.operatorTick();
  const needed = sent.filter(f => f.type === 'program.operator_needed' && f.reason === 'question_waiting');
  expect(needed).toHaveLength(1);
  const fact = needed[0]!;
  if (fact.type !== 'program.operator_needed') throw new Error('Question evidence is missing.');
  expect(sent).toContainEqual(expect.objectContaining({ type: 'program.question', phase: 'asked', question: expect.objectContaining({ id: fact.questionId, kind: 'permission', tool: 'Bash', text: expect.stringContaining('./tmp/mine') }) }));
  const view = await look(t, sent, fact.agentKey);
  expect(view).toMatchObject({ result: 'ok', jobId: fact.jobId, instance: fact.instance, state: 'working', question: { id: fact.questionId, kind: 'permission', tool: 'Bash' } });
  expect(view.cells).toContain('Remove ./tmp/mine?');
  t.keys.mockClear();
  expect(await type(t, sent, fact.agentKey, view.snapshot!, ['Enter'])).toMatchObject({ result: 'applied', reason: null, question: { id: fact.questionId } });
  expect(t.keys).toHaveBeenCalledTimes(1);
  await t.hook('tooldone', { tool_use_id: 'permission-1', tool_name: 'Bash' });
  expect(await type(t, sent, fact.agentKey, view.snapshot!, ['Enter'])).toMatchObject({ result: 'refused', reason: 'snapshot_stale' });
  expect(t.keys).toHaveBeenCalledTimes(1);
  expect(sent).toContainEqual(expect.objectContaining({ type: 'program.question', phase: 'cleared', question: expect.objectContaining({ id: fact.questionId }) }));
});

it('shows a program between turns to whoever looks, at rest and on no turn', async () => {
  const { t, sent } = await program();
  const key = t.host['agents'].keys().next().value as string;
  const during = await look(t, sent, key);
  t.finish();
  expect(await t.on(t.running)).toMatchObject({ ok: true });
  expect(await look(t, sent, key)).toMatchObject({ result: 'ok', jobId: null, instance: during.instance, state: 'idle', question: null, input: 'empty' });
});
