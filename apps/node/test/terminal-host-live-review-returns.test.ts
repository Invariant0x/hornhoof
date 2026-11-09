import { afterEach, describe, expect, it, vi } from 'vitest';
import { UNHEARD_MS } from '@hornhoof/protocol';
import { claudeQueue, userMessage } from './fakes/word-receipts.mjs';
import { until } from './terminal-host-helpers.js';
import { cleanups, liveTerminal, TEXT } from './terminal-host-live-helpers.js';

describe('reviewed live delivery through program events', () => {
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });

  it('erases only the exact multiline words still held in Codex input', async () => {
    const c = await liveTerminal('codex', 'lost');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.finish(); await c.running;
    const now = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => now() + UNHEARD_MS + 1);
    await until(() => c.unheard().length === 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(c.input()).toBe('');
  });

  it('removes a dismissed background entry before a contentless absorption', async () => {
    const c = await liveTerminal();
    c.record(claudeQueue('enqueue', '<task-notification>Done.</task-notification>'));
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.record(claudeQueue('remove', '<task-notification>Done.</task-notification>', { reason: 'dismissed' }));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(c.unheard()).toEqual([]);
    c.record({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn' });
    await new Promise(resolve => setTimeout(resolve, 30));
    await c.hook('end', { reason: 'clear' });
    expect(c.unheard()).toEqual([]);
  });

  it('does not erase a partial box whose first line matches Hornhoof words', async () => {
    const c = await liveTerminal('claude', 'lost');
    c.keys.mockImplementationOnce(async () => {
      c.draft('Hornhoof words.\nHuman continuation.');
      c.screen.mockResolvedValue('────────\n❯ Hornhoof words.\nHuman continuation.\n');
    });
    expect(await c.host.say('receipt', 'Hornhoof words.')).toBe(false);
    expect(c.input()).toBe('Hornhoof words.\nHuman continuation.');
    expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: the program did not record a receipt after two submit keys.']]);
  });

  it('returns a dismissed live message once without waiting for the program to exit', async () => {
    const c = await liveTerminal();
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.record(claudeQueue('remove', TEXT, { reason: 'dismissed' }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: TEXT }]);
    expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: the program removed the queued words.']]);
    await c.hook('end', { reason: 'clear' });
    expect(c.unheard()).toHaveLength(1);
  });

  it.each([false, true])('returns only the oldest matching message across two turns, identical: %s', async identical => {
    const c = await liveTerminal();
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.finish(); await c.running;
    const prompted = c.hook('prompt', { prompt: 'A human question.' });
    await until(() => c.sent.some(m => m.type === 'turn.open'));
    const opened = c.sent.find(m => m.type === 'turn.open');
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'human-token', ref: opened?.ref });
    await prompted;
    const next = identical ? TEXT : 'Different words for the human turn.';
    expect(await c.host.say('receipt', next)).toBe(true);
    c.record(claudeQueue('remove', next, { reason: 'dismissed' }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: identical ? 'job-receipt' : 'human', text: next }]);
    c.finish();
    await until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'human'));
    const done = c.sent.find(m => m.type === 'job.done' && m.jobId === 'human');
    expect(done).toMatchObject({ ok: true, error: null });
    if (identical) expect(done).toHaveProperty('wordsWaiting', true);
    else expect(done).not.toHaveProperty('wordsWaiting');
  });

  it('returns dismissed live words after the first human prompt in an empty terminal', async () => {
    const c = await liveTerminal('claude', 'queued', { prompt: '' });
    const prompted = c.hook('prompt', { prompt: 'A first human question.' });
    await until(() => c.sent.some(m => m.type === 'turn.open'));
    const opened = c.sent.find(m => m.type === 'turn.open');
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'human-token', ref: opened?.ref });
    await prompted;
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.record(claudeQueue('remove', TEXT, { reason: 'dismissed' }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'human', text: TEXT }]);
  });

  it('answers an interrupted first prompt before the server acknowledges its turn', async () => {
    const c = await liveTerminal('claude', 'queued', { prompt: '', openMs: 500 });
    const prompted = c.hook('prompt', { prompt: 'A first question.' });
    await until(() => c.sent.some(m => m.type === 'turn.open'));
    const opened = c.sent.find(m => m.type === 'turn.open');
    await c.hook('interrupt');
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'human-token', ref: opened?.ref });
    expect(await prompted).toBe('');
    expect(c.sent.find(m => m.type === 'job.done' && m.jobId === 'human')).toMatchObject({ ok: false, error: 'cancelled' });
    expect(await c.host.say('receipt', TEXT)).toBe(false);
    expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: no turn is running.']]);
  });

  it('keeps the first Codex human turn and returns its unconfirmed input once', async () => {
    const c = await liveTerminal('codex', 'lost', { prompt: '' });
    c.record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'human' } });
    c.record(userMessage('A first question.', 'human'));
    await until(() => c.sent.some(m => m.type === 'turn.open'));
    const opened = c.sent.find(m => m.type === 'turn.open');
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'human-token', ref: opened?.ref });
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'human', last_agent_message: 'Done.' } });
    await until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'human'));
    expect(c.sent.find(m => m.type === 'job.done' && m.jobId === 'human')).toHaveProperty('wordsWaiting', true);
    const now = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => now() + UNHEARD_MS + 1);
    await until(() => c.unheard().length === 1);
    expect(c.input()).toBe('');
    expect(c.log).toHaveBeenCalledOnce();
  });

  it('ignores a late Kimi queue hook after its turn ended and logs the next refusal', async () => {
    const c = await liveTerminal('kimi');
    c.finish(); await c.running;
    await c.hook('queued', { prompt: TEXT });
    expect(await c.host.say('receipt', TEXT)).toBe(false);
    expect(c.unheard()).toEqual([]);
    expect(c.log.mock.calls).toEqual([['Agent receipt (kimi): live words were not delivered: no turn is running.']]);
  });

  it('does not use fallback words when Kimi explicitly reports an empty queued prompt', async () => {
    const c = await liveTerminal('kimi');
    const keys = c.keys.getMockImplementation()!;
    c.keys.mockImplementation(async (name, ...pressed) => {
      if (pressed.includes('C-s')) await c.hook('queued', { prompt: '', input: TEXT });
      else await keys(name, ...pressed);
    });
    expect(await c.host.say('receipt', TEXT)).toBe(false);
    expect(c.input()).toBe('');
    expect(c.log.mock.calls).toEqual([['Agent receipt (kimi): live words were not delivered: the program did not record a receipt after two submit keys.']]);
  });

  it.each([0, 1])('ends the held receipt window at the grace boundary plus %i ms', async after => {
    let finishLimits = () => {};
    const c = await liveTerminal('codex', 'lost', { limits: async () => { finishLimits(); return null; } });
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    const endedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(endedAt);
    finishLimits = () => { clock.mockReturnValue(endedAt + UNHEARD_MS + after); };
    c.finish();
    expect(await c.running).not.toHaveProperty('wordsWaiting');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: TEXT }]);
    expect(c.log.mock.calls).toEqual([['Agent receipt (codex): live words were not delivered: the program did not take the words before the receipt wait ended.']]);
  });

  it('takes dequeued words during a busy Claude turn without returning them again', async () => {
    const c = await liveTerminal();
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.record(claudeQueue('dequeue', TEXT));
    c.record({ type: 'user', message: { content: TEXT } });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(await c.host.say('receipt', 'The following answer.')).toBe(true);
    c.record({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn' });
    c.finish();
    expect(await c.running).not.toHaveProperty('wordsWaiting');
    await c.hook('end', { reason: 'clear' });
    expect(c.unheard()).toEqual([]);
    expect(c.sent.filter(m => m.type === 'turn.open')).toEqual([]);
  });

  it('keeps queue handoff separate from background messages and compaction', async () => {
    const c = await liveTerminal();
    for (const text of [TEXT, 'A later answer.']) expect(await c.host.say('receipt', text)).toBe(true);
    c.finish(); await c.running;
    c.record(claudeQueue('dequeue', TEXT));
    c.record({ type: 'assistant', message: { content: [{ type: 'text', text: 'A background result.' }] } });
    c.record({ type: 'user', message: { content: TEXT } });
    await until(() => c.sent.some(m => m.type === 'turn.open'));
    const opened = c.sent.find(m => m.type === 'turn.open');
    expect(opened).toMatchObject({ text: TEXT, queuedFrom: 'job-receipt' });
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'queued', toolToken: 'queued-token', ref: opened?.ref });
    c.finish();
    await until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'queued'));
    c.record(claudeQueue('enqueue', '<task-notification>Done.</task-notification>'));
    c.record({ type: 'system', subtype: 'compact_boundary' });
    c.record({ type: 'user', isCompactSummary: true, message: { content: 'Earlier context.' } });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(c.sent.filter(m => m.type === 'turn.open')).toHaveLength(1);
    c.record(claudeQueue('remove', 'A later answer.', { reason: 'dismissed' }));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: 'A later answer.' }]);
  });

  it('settles a finished job only after all queued words are taken within the grace period', async () => {
    const c = await liveTerminal();
    for (const text of [TEXT, 'Another answer.']) expect(await c.host.say('receipt', text)).toBe(true);
    c.finish();
    expect(await c.running).toMatchObject({ wordsWaiting: true });
    const now = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => now() + UNHEARD_MS - 1000);
    c.record(claudeQueue('remove', TEXT, { reason: 'absorbed_mid_turn' }));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(c.sent).not.toContainEqual({ type: 'agent.words_settled', agentKey: 'receipt', jobId: 'job-receipt' });
    c.record({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn' });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(c.sent).toContainEqual({ type: 'agent.words_settled', agentKey: 'receipt', jobId: 'job-receipt' });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(c.sent.filter(m => m.type === 'agent.words_settled')).toHaveLength(1);
    expect(c.unheard()).toEqual([]);
  });

  it('waits for a delayed queue receipt before retrying Enter', async () => {
    const c = await liveTerminal('claude', 'silent');
    const keys = c.keys.getMockImplementation()!;
    c.keys.mockImplementationOnce(async (...args) => { await keys(...args); setTimeout(() => c.record(claudeQueue('enqueue', TEXT)), 20); });
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    expect(c.keys.mock.calls.filter(([, ...pressed]) => pressed.includes('Enter'))).toHaveLength(1);
    c.record(claudeQueue('remove', TEXT, { reason: 'dismissed' }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(c.unheard()).toHaveLength(1);
  });

  it('retries Enter when a liveness check reaches the receipt wait deadline', async () => {
    const c = await liveTerminal('claude', 'silent');
    const start = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(start);
    const keys = c.keys.getMockImplementation()!;
    let submitted = false;
    let jumped = false;
    c.keys.mockImplementation(async (...args) => {
      await keys(...args);
      if (!submitted) {
        submitted = true;
        setTimeout(() => { clock.mockReturnValue(start + 50); c.record(claudeQueue('enqueue', TEXT)); }, 1);
      }
    });
    c.alive.mockImplementation(async () => { if (submitted && !jumped) { jumped = true; clock.mockReturnValue(start + 50); } return true; });
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    expect(c.keys.mock.calls.filter(([, ...pressed]) => pressed.includes('Enter'))).toHaveLength(2);
    c.record(claudeQueue('remove', TEXT, { reason: 'dismissed' }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(c.unheard()).toHaveLength(1);
  });

  it('requires a Claude transcript receipt even when its Bridge prompt hook answered', async () => {
    const c = await liveTerminal('claude', 'hook');
    expect(await c.host.say('receipt', TEXT)).toBe(false);
    expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: the program did not record a receipt after two submit keys.']]);
  });

  it.each(['tooldone', 'toolfail'])('keeps tool and permission reports while returning dismissed words after %s', async event => {
    const c = await liveTerminal();
    await c.hook('tool', { tool_use_id: 'bash', tool_name: 'Bash' });
    await until(() => c.sent.some(m => m.type === 'job.program' && m.state === 'tool' && m.tool === 'Bash'));
    const name = event === 'tooldone' ? 'AskUserQuestion' : 'Permission';
    await c.hook('ask', { tool_use_id: 'question', ...(event === 'tooldone' ? { tool_name: name } : {}) });
    await until(() => c.sent.some(m => m.type === 'job.program' && m.state === 'asking' && m.tool === name));
    const afterAsk = c.sent.length;
    await c.hook(event, { tool_use_id: 'question', tool_name: name });
    await until(() => c.sent.slice(afterAsk).some(m => m.type === 'job.program' && m.state === 'tool' && m.tool === 'Bash'));
    await c.hook(event, { tool_use_id: 'bash', tool_name: 'Bash' });
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.record(claudeQueue('remove', TEXT, { reason: 'dismissed' }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: TEXT }]);
    expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: the program removed the queued words.']]);
  });

  it.each([1, 3])('delivers %i failed live messages as later turns in the same program', async count => {
    const c = await liveTerminal('claude', 'lost');
    const messages = [TEXT, 'Task #226 is yours.', 'The answer.\nContinue.'].slice(0, count);
    for (const text of messages) expect(await c.host.say('receipt', text)).toBe(false);
    expect(c.input()).toBe('');
    c.finish(); await c.running;
    for (const [i, text] of messages.entries()) {
      const jobId = `next-${i}`;
      const next = c.run(text, jobId);
      await until(() => c.sent.some(m => m.type === 'job.program' && m.jobId === jobId && m.state === 'thinking'));
      c.finish();
      expect(await next).toMatchObject({ ok: true, sessionId: expect.any(String) });
    }
    expect(c.submitted).toEqual(['HANG', ...messages]);
    expect(c.launch).toHaveBeenCalledOnce();
  });

  it.each([
    ['the delivery deadline passed', 0, async () => {}],
    ['there is not enough time to paste the words', 301, async () => {}],
    ['the input contains unsent words', 1000, async (c: Awaited<ReturnType<typeof liveTerminal>>) => { c.draft('An unsent draft.'); }],
    ['could not read the input', 1000, async (c: Awaited<ReturnType<typeof liveTerminal>>) => { c.screen.mockRejectedValueOnce(new Error(TEXT)); }],
    ['could not check whether the program is running', 1000, async (c: Awaited<ReturnType<typeof liveTerminal>>) => { c.alive.mockRejectedValueOnce(new Error(TEXT)); }],
    ['the program is no longer running', 1000, async (c: Awaited<ReturnType<typeof liveTerminal>>) => { c.alive.mockResolvedValue(false); }],
    ['could not send the submit key', 1000, async (c: Awaited<ReturnType<typeof liveTerminal>>) => { c.keys.mockRejectedValueOnce(new Error(TEXT)); }],
  ] as const)('logs one refusal without message text: %s', async (reason, budget, prepare) => {
    const c = await liveTerminal();
    await prepare(c);
    expect(await c.host.say('receipt', TEXT, budget)).toBe(false);
    expect(c.log.mock.calls).toEqual([[`Agent receipt (claude): live words were not delivered: ${reason}.`]]);
  });
});
