import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { OperatorNodeMessage } from '@hornhoof/protocol/program-operator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasTmux, home, host, job, setUp, tmux, until } from './terminal-host-helpers.js';

describe.skipIf(!hasTmux)('operator questions from the program', () => {
  afterEach(async () => { vi.restoreAllMocks(); await host?.stop(); });

  it.each([true, false])('binds a permission capability to its current event (assignment metadata: %s)', async metadata => {
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
      const request = randomUUID();
      await host.operatorMessage({ type: 'program.screen_get', ...incident, request });
      const screen = sent.find(f => f.type === 'program.screen' && f.request === request);
      expect(screen).toMatchObject({ keysAllowed: true, state: 'awaiting_input' });
      if (screen?.type !== 'program.screen') throw new Error('Screen is missing.');
      const press = vi.spyOn(tmux, 'keys').mockResolvedValue();
      const input = { ...incident, generation: screen.generation, snapshot: screen.snapshot!, action: randomUUID(), key: 'Enter' as const };
      await host.operatorMessage({ type: 'program.key_prepare', ...input });
      const prepared = sent.find(f => f.type === 'program.key_prepared' && f.action === input.action);
      expect(prepared).toMatchObject({ result: 'ok' });
      if (prepared?.type !== 'program.key_prepared') throw new Error('Key preparation is missing.');
      const command = { type: 'program.key_send' as const, ...input, lease: prepared.lease! };
      await host.operatorMessage(command);
      expect(sent.at(-1)).toMatchObject({ type: 'program.key_result', result: 'applied' });
      expect(press).toHaveBeenCalledTimes(1);
      await host['hook'](key, 'tooldone', { tool_use_id: 'permission-1', tool_name: 'Bash' });
      await host.operatorMessage({ ...command, action: randomUUID() });
      expect(sent.at(-1)).toMatchObject({ type: 'program.key_result', result: 'refused' });
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
      for (const keyPress of decision === 'denied' ? ['Down', 'Enter'] as const : ['Enter'] as const) {
        const request = randomUUID();
        await host.operatorMessage({ type: 'program.screen_get', ...incident, request });
        const screen = sent.find(f => f.type === 'program.screen' && f.request === request);
        expect(screen).toMatchObject({ keysAllowed: true });
        if (screen?.type !== 'program.screen') throw new Error('No current screen.');
        const input = { ...incident, snapshot: screen.snapshot!, generation: screen.generation, action: randomUUID(), key: keyPress };
        await host.operatorMessage({ type: 'program.key_prepare', ...input });
        const prepared = sent.find(f => f.type === 'program.key_prepared' && f.action === input.action);
        if (prepared?.type !== 'program.key_prepared' || !prepared.lease) throw new Error('Key preparation refused.');
        await host.operatorMessage({ type: 'program.key_send', ...input, lease: prepared.lease });
        expect(sent).toContainEqual(expect.objectContaining({ type: 'program.key_result', action: input.action, result: 'applied' }));
        if (keyPress === 'Down') { await until(async () => (await tmux.screen(`a-${key}`)).includes('> No')); now += 1001; }
      }
      expect(await running).toMatchObject({ ok: true, result: `echo: Permission ${decision}.` });
      expect(sent).toContainEqual(expect.objectContaining({ type: 'program.question', phase: 'cleared', question: expect.objectContaining({ id: needed.questionId }) }));
    } finally { abort.abort(); await running; }
  });
});
