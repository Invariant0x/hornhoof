import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { OperatorNodeMessage } from '@hornhoof/protocol/program-operator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasTmux, home, host, job, setUp, tmux, until } from './terminal-host-helpers.js';

/* What Operations see of the program, and what came of the keys they gave it after that look. */
async function look(sent: OperatorNodeMessage[], agentKey: string) {
  const request = randomUUID();
  await host.operatorMessage({ type: 'program.view_get', agentKey, request });
  const view = sent.find(f => f.type === 'program.view' && f.request === request);
  if (view?.type !== 'program.view' || !view.snapshot) throw new Error('No view of the program.');
  return view;
}

async function type(sent: OperatorNodeMessage[], agentKey: string, snapshot: string, keys: string[]) {
  const action = randomUUID();
  await host.operatorMessage({ type: 'program.input_send', agentKey, action, snapshot, keys, text: null });
  return sent.find(f => f.type === 'program.input_result' && f.action === action);
}

describe.skipIf(!hasTmux)('operator questions from the program', () => {
  afterEach(async () => { vi.restoreAllMocks(); await host?.stop(); });

  it.each([true, false])('shows the permission question the program asks and takes one input for each look (assignment metadata: %s)', async metadata => {
    const sent: OperatorNodeMessage[] = []; let now = 0;
    const key = randomUUID(), jobId = randomUUID();
    await setUp({ operator: { dir: join(home, `operator-${key}`), now: () => now, connected: () => true, send: frame => { sent.push(frame); return true; } } });
    const abort = new AbortController();
    const running = host.run({ ...job(key, 'HANG', { jobId, signal: abort.signal }), ...(metadata ? { operatorDelivery: { id: randomUUID(), ordinal: 1 } } : {}) });
    try {
      await until(() => host['agents'].get(key)?.took === true);
      await host['hook'](key, 'ask', { tool_use_id: 'permission-1', tool_name: 'Bash', tool_input: { command: 'rm -r ./tmp/mine' } });
      now = 29999; host.operatorTick();
      expect(sent.some(f => f.type === 'program.operator_needed' && f.reason === 'question_waiting')).toBe(false);
      now = 30000; host.operatorTick(); host.operatorTick();
      const facts = sent.filter(f => f.type === 'program.operator_needed' && f.reason === 'question_waiting');
      expect(facts).toHaveLength(1);
      const needed = facts[0]!;
      if (needed.type !== 'program.operator_needed') throw new Error('Question evidence is missing.');
      const question = sent.find(f => f.type === 'program.question' && f.phase === 'asked');
      expect(question).toMatchObject({ question: { id: needed.questionId, kind: 'permission', tool: 'Bash', text: expect.stringContaining('./tmp/mine') } });
      const identity = { agentKey: key, jobId, instance: needed.instance };
      const incident = { ...identity, case: randomUUID(), capability: randomUUID() };
      await host.operatorMessage({ type: 'program.operator_case', ...incident, revision: 1, disposition: 'open', remainingMs: 600000, reason: 'question_waiting', questionId: needed.questionId });
      const view = await look(sent, key);
      expect(view).toMatchObject({ result: 'ok', jobId, instance: needed.instance, question: { id: needed.questionId, kind: 'permission', tool: 'Bash' } });
      const press = vi.spyOn(tmux, 'keys').mockResolvedValue();
      expect(await type(sent, key, view.snapshot!, ['Enter'])).toMatchObject({ result: 'applied', reason: null, question: { id: needed.questionId } });
      expect(press).toHaveBeenCalledTimes(1);
      await host['hook'](key, 'tooldone', { tool_use_id: 'permission-1', tool_name: 'Bash' });
      expect(await type(sent, key, view.snapshot!, ['Enter'])).toMatchObject({ result: 'refused', reason: 'snapshot_stale' });
      expect(press).toHaveBeenCalledTimes(1);
      expect(sent).toContainEqual(expect.objectContaining({ type: 'program.question', phase: 'cleared', question: expect.objectContaining({ id: needed.questionId }) }));
    } finally { abort.abort(); await running; }
  });

  it('keeps work decisions with the person and clears a permission timer on a new tool event', async () => {
    const sent: OperatorNodeMessage[] = []; let now = 0;
    const key = randomUUID();
    await setUp({ operator: { dir: join(home, `operator-${key}`), now: () => now, connected: () => true, send: frame => { sent.push(frame); return true; } } });
    const abort = new AbortController();
    const running = host.run(job(key, 'HANG', { jobId: randomUUID(), signal: abort.signal }));
    try {
      await until(() => host['agents'].get(key)?.took === true);
      await host['hook'](key, 'ask', { tool_name: 'AskUserQuestion', tool_use_id: 'work', tool_input: { questions: [{ question: 'Which design?' }] } });
      now = 60000; host.operatorTick();
      expect(sent.some(f => f.type === 'program.operator_needed')).toBe(false);
      await host['hook'](key, 'ask', { tool_name: 'Bash', tool_use_id: 'permission' });
      now += 29999;
      await host['hook'](key, 'tool', { tool_name: 'Read', tool_use_id: 'next' });
      now += 30000; host.operatorTick();
      expect(sent.some(f => f.type === 'program.operator_needed')).toBe(false);
    } finally { abort.abort(); await running; }
  });

  it.each(['allowed', 'denied'] as const)('answers the native permission menu with %s and the real tmux program continues', async decision => {
    const sent: OperatorNodeMessage[] = []; let now = 0;
    const key = randomUUID(), jobId = randomUUID();
    await setUp({ pollMs: 25, operator: { dir: join(home, `operator-${key}`), now: () => now, connected: () => true, send: frame => { sent.push(frame); return true; } } });
    const abort = new AbortController();
    const running = host.run({ ...job(key, 'PERMISSION_MENU', { jobId, signal: abort.signal }), operatorDelivery: { id: randomUUID(), ordinal: 1 } });
    try {
      await until(() => sent.some(f => f.type === 'program.question' && f.phase === 'asked'));
      now = 30000; host.operatorTick();
      const needed = sent.find(f => f.type === 'program.operator_needed' && f.reason === 'question_waiting');
      if (needed?.type !== 'program.operator_needed') throw new Error('No question case.');
      const incident = { agentKey: key, jobId, instance: needed.instance, case: randomUUID(), capability: randomUUID() };
      await host.operatorMessage({ type: 'program.operator_case', ...incident, disposition: 'open', revision: 1, remainingMs: 600000, reason: 'question_waiting', questionId: needed.questionId });
      for (const keyPress of decision === 'denied' ? ['Down', 'Enter'] : ['Enter']) {
        const view = await look(sent, key);
        expect(await type(sent, key, view.snapshot!, [keyPress])).toMatchObject({ result: 'applied' });
        if (keyPress === 'Down') { await until(async () => (await tmux.screen(`a-${key}`)).includes('> No')); now += 1001; }
      }
      expect(await running).toMatchObject({ ok: true, result: `echo: Permission ${decision}.` });
      expect(sent).toContainEqual(expect.objectContaining({ type: 'program.question', phase: 'cleared', question: expect.objectContaining({ id: needed.questionId }) }));
    } finally { abort.abort(); await running; }
  });
});
