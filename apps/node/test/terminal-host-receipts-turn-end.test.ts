import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeQueue, kimiSteer, userMessage } from './fakes/word-receipts.mjs';
import { atTypedWork, atWork, cleanups, TEXT } from './terminal-host-receipts-helpers.js';

describe('program receipts for live words', () => {
  afterEach(async () => {
    vi.spyOn(Date, 'now').mockRestore();
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['claude', 'codex'] as const)('keeps one crash completion when typed %s exits before its end record', async kind => {
    const c = await atTypedWork(kind, kind === 'claude' ? 'queued' : 'silent');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.alive.mockResolvedValue(false);
    await c.on(c.host['look'](c.host['agents'].get('receipt')!));
    await c.on(c.end()); c.expire();
    expect(c.sent.filter(m => m.type === 'job.done' && m.jobId === 'typed')).toEqual([
      expect.objectContaining({ ok: false, error: 'agent_failed', failure: { kind: 'crash', retryable: true, text: 'The program exited during the turn.' } }),
    ]);
  });

  it.each(['claude', 'codex'] as const)('keeps the successful completion when typed %s exits after its end', async kind => {
    const c = await atTypedWork(kind, kind === 'claude' ? 'queued' : 'silent');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    await c.on(c.end()); c.expire();
    await c.until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'typed'));
    c.alive.mockResolvedValue(false);
    await c.on(c.host['look'](c.host['agents'].get('receipt')!));
    expect(c.sent.filter(m => m.type === 'job.done' && m.jobId === 'typed')).toEqual([
      expect.objectContaining({ ok: true, result: 'Typed answer.', error: null }),
    ]);
    expect(c.host['agents'].get('receipt')!.up).toBe(false);
  });

  it.each(['claude', 'codex', 'kimi'] as const)('returns unconsumed %s words after 15 seconds without a next turn', async kind => {
    const c = await atWork(kind, kind === 'codex' ? 'silent' : 'queued');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.finish();
    await c.until(() => c.sent.some(m => m.type === 'job.done'));
    expect(c.sent.find(m => m.type === 'job.done')).toHaveProperty('wordsWaiting', true);
    expect(c.unheard()).toEqual([]);
    c.expire();
    await c.on(c.running);
    c.drain(); c.drain();
    const expected = [{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: TEXT }];
    expect(c.unheard()).toEqual(expected);
  });

  it.each(['claude', 'codex'] as const)('completes the old %s job before opening queued words 300 ms later', async kind => {
    const c = await atWork(kind, kind === 'claude' ? 'queued' : 'silent');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    if (kind === 'claude') await c.on(c.host['hook']('receipt', 'stop', { last_assistant_message: '' }));
    else c.finish();
    await c.pass(300);
    expect(c.sent.filter(m => m.type === 'job.done')).toEqual([expect.objectContaining({ wordsWaiting: true })]);
    if (kind === 'claude') {
      c.record(claudeQueue('dequeue', TEXT));
      c.record({ type: 'user', message: { content: TEXT } });
    } else {
      c.record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'next' } });
      c.record(userMessage(TEXT, 'next'));
    }
    c.drain(); await c.on(c.running);
    expect(c.sent.filter(m => m.type === 'turn.open' || m.type === 'job.done').map(m => m.type)).toEqual(['job.done', 'turn.open']);
    expect(c.sent.find(m => m.type === 'turn.open')).toMatchObject({ text: TEXT, queuedFrom: 'job-receipt' });
    c.expire();
    expect(c.unheard()).toEqual([]);
  });

  it.each(['claude', 'codex'] as const)('completes a %s job without the flag when there are no queued words', async kind => {
    const c = await atWork(kind, 'queued');
    if (kind === 'claude') await c.on(c.host['hook']('receipt', 'stop', { last_assistant_message: '' }));
    else c.finish();
    await c.on(c.running);
    expect(c.sent.filter(m => m.type === 'job.done')).toHaveLength(1);
    expect(c.sent.find(m => m.type === 'job.done')).not.toHaveProperty('wordsWaiting');
  });

  it.each([
    ['claude', false], ['claude', true], ['codex', false], ['codex', true],
  ] as const)('opens unrelated human words right after %s Stop without queuedFrom or a word wait, typed: %s', async (kind, typed) => {
    const mode = kind === 'claude' ? 'queued' : 'silent';
    const c = typed ? await atTypedWork(kind, mode) : await atWork(kind, mode);
    const jobId = typed ? 'typed' : 'job-receipt';
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    const at = c.sent.length;
    if (kind === 'claude') await c.on(c.host['hook']('receipt', 'stop', { last_assistant_message: '' }));
    else {
      c.record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: typed ? 'typed' : 'turn', last_agent_message: '' } });
      c.drain();
    }
    const prompt = kind === 'claude' ? c.host['hook']('receipt', 'prompt', { prompt: 'A separate question.' }) : Promise.resolve();
    if (kind === 'codex') {
      c.record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'human' } });
      c.record(userMessage('A separate question.', 'human')); c.drain();
    }
    await c.until(() => c.sent.slice(at).some(m => m.type === 'turn.open'));
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'token' });
    await c.on(prompt);
    if (kind === 'claude') await c.on(c.host['hook']('receipt', 'stop', { last_assistant_message: 'Human answer.' }));
    else {
      c.record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'human', last_agent_message: 'Human answer.' } });
      c.drain();
    }
    await c.until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'human'));
    c.expire();
    await c.on(c.running);
    expect(c.sent.filter(m => m.type === 'job.done' && m.jobId === jobId)).toHaveLength(1);
    expect(c.sent.slice(at).find(m => m.type === 'turn.open')).toMatchObject({ text: 'A separate question.' });
    expect(c.sent.slice(at).find(m => m.type === 'turn.open')).not.toHaveProperty('queuedFrom');
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId, text: TEXT }]);
    expect(c.sent.filter(m => m.type === 'job.done' && m.jobId === 'human')).toEqual([
      expect.objectContaining({ ok: true, result: 'Human answer.' }),
    ]);
  });

  it('keeps a typed Claude answer with its job when human words precede the last log lines', async () => {
    const c = await atTypedWork('claude', 'queued');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    await c.on(c.end());
    const prompt = c.host['hook']('receipt', 'prompt', { prompt: 'A separate question.' });
    await c.pass(30);
    c.record({ type: 'assistant', message: { content: [{ type: 'text', text: 'Typed answer.' }] } });
    c.drain();
    await c.until(() => c.sent.filter(m => m.type === 'turn.open').length === 2);
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'human-token' });
    await c.on(prompt);
    expect(c.sent).toContainEqual({ type: 'job.event', jobId: 'typed', seq: 0, event: { kind: 'text', text: 'Typed answer.' } });
    expect(c.sent.filter(m => m.type === 'job.event' && m.jobId === 'human')).toEqual([]);
    c.expire();
  });

  it('reports queued words on shutdown after the old job completed', async () => {
    const c = await atWork('claude', 'queued');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.finish();
    await c.until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'job-receipt'));
    c.alive.mockResolvedValue(false);
    await c.on(c.host.stop());
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: TEXT }]);
    await c.on(c.running);
  });

  it('reports and fails an actual Kimi process exit without a hook or wire end', async () => {
    const c = await atWork('kimi', 'taken');
    c.alive.mockResolvedValue(false);
    expect(await c.on(c.running)).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'crash', text: 'The program exited during the turn.' } });
    expect(c.sent).toContainEqual(expect.objectContaining({ type: 'job.program', jobId: 'job-receipt', state: 'gone' }));
    expect(c.sent.filter(m => m.type === 'job.done')).toEqual([expect.objectContaining({ jobId: 'job-receipt', ok: false, error: 'agent_failed' })]);
  });

  it('bounds the Kimi Stop wait when its wire end is missing', async () => {
    const c = await atWork('kimi', 'taken');
    c.record({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'Answer.' } } });
    /* The stop waits SETTLE_MS (3 s) for turn.ended on the wire, then ends the turn with what it read. */
    let stopped = false;
    const stopping = c.host['hook']('receipt', 'stop', {}).then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(2999);
    expect(stopped).toBe(false);
    expect(c.host['agents'].get('receipt')!.turn?.ending).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(await c.on(c.running)).toMatchObject({ ok: true, result: 'Answer.' });
  });

  it('sends Kimi Ctrl-S and accepts its queued hook then turn.steer', async () => {
    const c = await atWork('kimi', 'taken');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    expect(c.keys.mock.calls.flat()).toEqual(['a-receipt', 'C-s']);
    c.finish(); await c.on(c.running); c.expire();
    expect(c.unheard()).toEqual([]);
  });

  it('receives hh-hook queued through the bridge without a wire receipt', async () => {
    const c = await atWork('kimi', 'bridge');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    expect(c.keys.mock.calls.flat()).toEqual(['a-receipt', 'C-s']);
    c.record(kimiSteer('turn.steer', TEXT));
    c.finish(); await c.on(c.running); c.expire();
    expect(c.unheard()).toEqual([]);
  });

  it('reports waiting words when the program is gone', async () => {
    const c = await atWork('codex', 'silent');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.alive.mockResolvedValue(false);
    await c.on(c.running);
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: TEXT }]);
  });

  it('keeps the old failure when Claude dequeues the next turn in the same log read', async () => {
    const c = await atWork('claude', 'queued');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.record({ type: 'assistant', isApiErrorMessage: true, error: 'server_error', message: { content: [{ type: 'text', text: 'API Error: Overloaded' }] } });
    c.record({ type: 'system', subtype: 'turn_duration' });
    c.record(claudeQueue('dequeue', TEXT));
    c.record({ type: 'user', message: { content: TEXT } });
    c.drain();
    expect(c.sent).toContainEqual(expect.objectContaining({ type: 'turn.open', queuedFrom: 'job-receipt' }));
    expect(await c.on(c.running)).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'overloaded' } });
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'second', toolToken: 'token' });
    await c.on(c.host['hook']('receipt', 'stop', { last_assistant_message: '' }));
    await c.until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'second'));
  });
});
