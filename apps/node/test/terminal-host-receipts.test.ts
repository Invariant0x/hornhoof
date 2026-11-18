import { appendFileSync } from 'node:fs';
import { UNHEARD_MS } from '@hornhoof/protocol';
import { RESTART_AFTER_MS } from '@hornhoof/protocol/map';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeTranscript } from '../src/providers/claude-terminal.js';
import { restartRefusal, TurnWords } from '../src/terminal/program-restart.js';
import { claudePasted, claudeQueue, userMessage } from './fakes/word-receipts.mjs';
import { atTypedWork, atWork, cleanups, SESSION, TEXT } from './terminal-host-receipts-helpers.js';

describe('program receipts for live words', () => {
  afterEach(async () => {
    vi.spyOn(Date, 'now').mockRestore();
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps statusLine from refreshing signs of life or postponing a restart', async () => {
    const c = await atWork('claude', 'queued');
    const a = c.host['agents'].get('receipt')!;
    const signAt = a.signAt;
    const now = signAt + RESTART_AFTER_MS.claude! + 1000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await c.on(c.host['hook']('receipt', 'status', { context_window: { used_percentage: 25 } }));
    const observed = c.host['observeProgram'](a, 'job-receipt');
    await c.on(c.host['reportProgram'](a, observed.watch, observed.look));
    expect(c.sent.filter(m => m.type === 'job.program').at(-1)).toMatchObject({ signAt, state: 'thinking' });
    expect(a.contextUsed).toBe(0.25);
    expect(restartRefusal({ jobId: 'job-receipt', kind: 'claude', state: 'thinking', calls: 0, question: false, signAt: a.signAt, sessionId: a.sessionId, restarted: false }, 'job-receipt', now)).toBeNull();
  });

  it.each(['clear', 'logout'])('keeps Claude up after an idle %s and delivers the next live words once', async reason => {
    const c = await atWork('claude', 'queued');
    c.finish(); await c.on(c.running);
    await c.on(c.host['hook']('receipt', 'end', { reason }));
    expect(c.host['agents'].get('receipt')?.up).toBe(true);
    await c.on(c.host['hook']('receipt', 'start', { session_id: SESSION, source: 'clear' }));
    const next = c.run();
    await c.until(() => c.host['agents'].get('receipt')?.busy === true);
    c.keys.mockClear();
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    expect(c.keys.mock.calls.filter(([, key]) => key === 'Enter')).toHaveLength(1);
    expect(c.unheard()).toEqual([]);
    c.record(claudeQueue('remove', TEXT, { reason: 'absorbed_mid_turn' }));
    c.finish(); await c.on(next);
    c.expire();
    expect(c.unheard()).toEqual([]);
  });

  it('starts Claude receipts empty after clear and absorbs only the new session words', async () => {
    const c = await atWork('claude', 'queued');
    expect(await c.on(c.host.say('receipt', 'Words A.'))).toBe(true);
    await c.on(c.host['hook']('receipt', 'end', { reason: 'clear' }));
    const session = 'b3b66b04-872b-4fbe-a3a4-058a026ef20a';
    const file = claudeTranscript(c.home, c.workDir, session);
    const record = (line: object) => appendFileSync(file, JSON.stringify(line) + '\n');
    record({ type: 'metadata' });
    await c.on(c.host['hook']('receipt', 'start', { session_id: session, source: 'clear' }));
    await c.until(() => c.sent.some(m => m.type === 'job.done'));
    const prompt = c.host['hook']('receipt', 'prompt', { prompt: 'New session question.' });
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'new-session', toolToken: 'token' });
    await c.on(prompt);
    c.keys.mockImplementation(async () => { record(claudeQueue('enqueue', 'Words B.')); });
    expect(await c.on(c.host.say('receipt', 'Words B.'))).toBe(true);
    record({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn' });
    c.drain();
    await c.on(c.host['hook']('receipt', 'stop', { last_assistant_message: '' }));
    await c.until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'new-session'));
    c.expire();
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: 'Words A.' }]);
  });

  it.each(['clear', 'session change'])('settles old Claude words at %s before absorbing identical new words', async change => {
    const c = await atWork('claude', 'queued');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    const session = 'b3b66b04-872b-4fbe-a3a4-058a026ef20a';
    const file = claudeTranscript(c.home, c.workDir, session);
    const record = (line: object) => appendFileSync(file, JSON.stringify(line) + '\n');
    record({ type: 'metadata' });
    if (change === 'clear') await c.on(c.host['hook']('receipt', 'end', { reason: 'clear' }));
    else await c.on(c.host['hook']('receipt', 'stop', { last_assistant_message: '' }));
    const afterEnd = c.unheard();
    await c.on(c.host['hook']('receipt', 'start', { session_id: session, source: change }));
    const afterChange = c.unheard();
    await c.on(c.running);
    const prompt = c.host['hook']('receipt', 'prompt', { prompt: 'New session question.' });
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'new-session', toolToken: 'token' });
    await c.on(prompt);
    c.keys.mockImplementation(async () => { record(claudeQueue('enqueue', TEXT)); });
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    record(claudeQueue('remove', TEXT, { reason: 'absorbed_mid_turn' }));
    c.drain();
    await c.on(c.host['hook']('receipt', 'stop', { last_assistant_message: '' }));
    await c.until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'new-session'));
    c.expire(); c.drain();
    const unheard = [{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: TEXT }];
    expect(c.unheard()).toEqual(unheard);
    expect(afterChange).toEqual(unheard);
    expect(afterEnd).toEqual(change === 'clear' ? unheard : []);
  });

  it.each(['claude', 'codex'] as const)('expires unconsumed %s words with no watcher, log line or Enter', async kind => {
    const c = await atWork(kind, kind === 'claude' ? 'queued' : 'silent');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.host['unwatch'](c.host['agents'].get('receipt')!);
    c.finish();
    await vi.advanceTimersByTimeAsync(100);
    expect(c.sent.filter(m => m.type === 'job.done')).toEqual([expect.objectContaining({ wordsWaiting: true })]);
    expect(c.unheard()).toEqual([]);
    await vi.advanceTimersByTimeAsync(UNHEARD_MS - 101);
    expect(c.unheard()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const expected = [{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: TEXT }];
    expect(c.unheard()).toEqual(expected);
    await vi.advanceTimersByTimeAsync(UNHEARD_MS);
    expect(c.unheard()).toEqual(expected);
  });

  it('does not report live words unheard from the program display flag', async () => {
    const c = await atWork('claude', 'queued');
    c.host['programIs'](c.host['agents'].get('receipt')!, false);
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    expect(c.unheard()).toEqual([]);
    c.record(claudeQueue('remove', TEXT, { reason: 'absorbed_mid_turn' }));
  });

  it('ends a running Claude turn as stopped by a person on clear', async () => {
    const c = await atWork('claude', 'queued');
    await c.on(c.host['hook']('receipt', 'end', { reason: 'clear' }));
    expect(await c.on(c.running)).toMatchObject({ ok: false, error: 'cancelled' });
    expect((await c.on(c.running)).failure).toBeUndefined();
    expect(c.host['agents'].get('receipt')?.up).toBe(true);
    expect(c.keys.mock.calls.flat()).not.toContain('Escape');
  });

  it('ends Claude as crashed when prompt_input_exit accompanies a process exit', async () => {
    const c = await atWork('claude', 'queued');
    c.alive.mockResolvedValue(false);
    await c.on(c.host['hook']('receipt', 'end', { reason: 'prompt_input_exit' }));
    expect(await c.on(c.running)).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'crash', retryable: true } });
    expect(c.host['agents'].get('receipt')?.up).toBe(false);
  });

  /* Started again in its pane, a program has what its last run printed above its screen. */
  it.each(['claude', 'codex'] as const)('ends %s that exits during a turn as crashed, not signed out by what its last run said above its screen', async kind => {
    const c = await atWork(kind, 'queued');
    const shows = vi.mocked(c.tmux.screen).getMockImplementation()!;
    vi.mocked(c.tmux.screen).mockImplementation(async (name, history = 200, styled) => `${history ? '  ⎿  Not logged in · Please run /login\n' : ''}${await shows(name, history, styled)}`);
    c.alive.mockResolvedValue(false);
    expect(await c.on(c.running)).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'crash', text: 'The program exited during the turn.' } });
  });

  it.each(['queued'] as const)('takes a Claude %s receipt and waits for absorption', async mode => {
    const c = await atWork('claude', mode);
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    expect(c.keys.mock.calls.flat()).toEqual(['a-receipt', 'Enter']);
    c.record(claudeQueue('remove', TEXT, { reason: 'absorbed_mid_turn' }));
    c.drain(); c.finish(); await c.on(c.running); c.expire();
    expect(c.unheard()).toEqual([]);
  });

  it.each([false, true])('takes a delayed Claude absorption receipt after Stop, typed: %s', async typed => {
    const c = typed ? await atTypedWork('claude', 'queued') : await atWork('claude', 'queued');
    const jobId = typed ? 'typed' : 'job-receipt';
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    await c.on(c.host['hook']('receipt', 'stop', { last_assistant_message: '' }));
    await c.until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === jobId));
    c.record(claudeQueue('remove', TEXT, { reason: 'absorbed_mid_turn' }));
    c.drain(); c.expire();
    await c.until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === jobId));
    expect(c.unheard()).toEqual([]);
    expect(c.sent.filter(m => m.type === 'job.done' && m.jobId === jobId)).toHaveLength(1);
  });

  it('reads the old Claude absorption receipt before expiry while a human turn runs', async () => {
    const c = await atWork('claude', 'queued');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    await c.on(c.host['hook']('receipt', 'stop', { last_assistant_message: '' }));
    await c.until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'job-receipt'));
    const prompt = c.host['hook']('receipt', 'prompt', { prompt: 'A separate question.' });
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'token' });
    await c.on(prompt); await c.on(c.running);
    c.record(claudeQueue('remove', TEXT, { reason: 'absorbed_mid_turn' }));
    c.expire();
    expect(c.unheard()).toEqual([]);
  });

  it('reads the whole Claude receipt batch at expiry when a human turn ends first', async () => {
    const c = await atWork('claude', 'queued');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.host['unwatch'](c.host['agents'].get('receipt')!);
    c.finish();
    await vi.advanceTimersByTimeAsync(100);
    await c.running;
    const prompt = c.host['hook']('receipt', 'prompt', { prompt: 'A separate question.' });
    await vi.advanceTimersByTimeAsync(0);
    expect(c.sent.filter(m => m.type === 'turn.open')).toHaveLength(1);
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'token' });
    await prompt;
    c.host['unwatch'](c.host['agents'].get('receipt')!);
    c.record({ type: 'system', subtype: 'turn_duration', durationMs: 1 });
    c.record(claudeQueue('remove', TEXT, { reason: 'absorbed_mid_turn' }));
    await vi.advanceTimersByTimeAsync(UNHEARD_MS - 101);
    expect(c.unheard()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.unheard()).toEqual([]);
    expect(c.sent.filter(m => m.type === 'job.done' && m.jobId === 'human')).toEqual([expect.objectContaining({ ok: true })]);
    await vi.advanceTimersByTimeAsync(UNHEARD_MS);
    expect(c.unheard()).toEqual([]);
  });

  it.each(['Words for the human turn.', TEXT])('takes a delayed Claude receipt once, leaving later words: %s', async text => {
    const c = await atWork('claude', 'queued');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    await c.on(c.host['hook']('receipt', 'stop', { last_assistant_message: '' }));
    const prompt = c.host['hook']('receipt', 'prompt', { prompt: 'A separate question.' });
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'token' });
    await c.on(prompt);
    expect(await c.on(c.host.say('receipt', text))).toBe(true);
    c.record({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn' });
    c.drain();
    await c.on(c.host['hook']('receipt', 'stop', { last_assistant_message: '' }));
    c.expire();
    await c.until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'human'));
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'human', text }]);
  });

  it('opens Claude dequeued words from the log as a typed turn and hears its second Stop', async () => {
    const c = await atWork('claude', 'queued');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.finish();
    c.record(claudeQueue('dequeue', TEXT));
    c.record({ type: 'user', message: { role: 'user', content: TEXT } });
    c.drain();
    await c.on(c.running);
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    expect(c.sent.find(m => m.type === 'turn.open')).toMatchObject({ type: 'turn.open', text: TEXT, queuedFrom: 'job-receipt' });
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'second', toolToken: 'token' });
    await c.on(c.host['hook']('receipt', 'stop', { last_assistant_message: '' }));
    await c.until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'second'));
    c.expire();
    expect(c.unheard()).toEqual([]);
  });

  it('takes Claude words it records as pasted content, and never hands them out again', async () => {
    const c = await atWork('claude', 'pasted');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.record(claudeQueue('remove', claudePasted(TEXT), { reason: 'absorbed_mid_turn' }));
    c.finish(); await c.on(c.running); c.expire();
    expect(c.unheard()).toEqual([]);
    expect(c.sent.find(m => m.type === 'job.done')).not.toMatchObject({ wordsWaiting: true });
  });

  it("matches Claude's paste wrapper only around the words, never tags inside them", () => {
    const quoted = (id: string) => `Pasted by the CEO:\n<pasted_content id="${id}">\nThe same words.\n</pasted_content id="${id}">`;
    const words = new TurnWords();
    words.add(quoted('1'), 'job-receipt');
    expect(words.takeQueued(quoted('2'))).toBeNull();
    expect(words.takeQueued(claudePasted(quoted('2')))).toBeNull();
    expect(words.takeQueued(claudePasted(quoted('1')))).toEqual({ jobId: 'job-receipt', text: quoted('1') });
  });

  it('still matches words that are a whole paste block when the program records them as they are', () => {
    const block = '<pasted_content id="1">\nThe CEO pasted only this.\n</pasted_content id="1">';
    const words = new TurnWords();
    words.add(block, 'job-receipt');
    expect(words.takeQueued(block)).toEqual({ jobId: 'job-receipt', text: block });
  });

  it("opens Claude's own turn on pasted words with their job and Hornhoof's words", async () => {
    const c = await atWork('claude', 'pasted');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.finish();
    c.record(claudeQueue('dequeue', claudePasted(TEXT)));
    c.record({ type: 'user', message: { role: 'user', content: claudePasted(TEXT) } });
    c.drain();
    await c.on(c.running);
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    expect(c.sent.find(m => m.type === 'turn.open')).toMatchObject({ type: 'turn.open', text: TEXT, queuedFrom: 'job-receipt' });
  });

  it.each(['silent', 'lost'] as const)('retries Claude %s words once, says false and erases input', async mode => {
    const c = await atWork('claude', mode);
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(false);
    expect(c.keys.mock.calls.filter(([, key]) => key === 'Enter')).toHaveLength(2);
    expect(c.input()).toBe('');
    c.finish(); await c.on(c.running); c.expire();
    expect(c.unheard()).toEqual([]);
  });

  it('takes a Codex UserMessage only in the running turn', async () => {
    const c = await atWork('codex', 'taken');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.finish(); await c.on(c.running); c.expire();
    expect(c.keys.mock.calls.filter(([, key]) => key === 'Enter')).toHaveLength(1);
    expect(c.unheard()).toEqual([]);
  });

  it('keeps silent Codex words held until its own next turn takes them', async () => {
    const c = await atWork('codex', 'silent');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    expect(c.keys.mock.calls.filter(([, key]) => key === 'Enter')).toHaveLength(2);
    c.finish();
    c.record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'next' } });
    c.record(userMessage(TEXT, 'next')); c.drain();
    await c.on(c.running);
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    c.expire();
    expect(c.sent).toContainEqual(expect.objectContaining({ type: 'turn.open', text: TEXT }));
    expect(c.unheard()).toEqual([]);
  });

  it('opens held words after a typed Codex turn ended, with their old job', async () => {
    const c = await atTypedWork('codex', 'silent');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    await c.on(c.end());
    await c.until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'typed'));
    c.record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'next' } });
    c.record(userMessage(TEXT, 'next'));
    c.record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'next', last_agent_message: 'Queued answer.' } });
    c.drain();
    await c.until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'typed'));
    const next = c.sent.filter(m => m.type === 'turn.open')[1];
    expect(next).toMatchObject({ text: TEXT, queuedFrom: 'typed' });
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'next', toolToken: 'next-token', ref: next?.ref });
    await c.until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'next'));
    expect(c.sent.filter(m => m.type === 'job.done' && m.jobId === 'next')).toEqual([
      expect.objectContaining({ ok: true, result: 'Queued answer.' }),
    ]);
    c.expire();
    expect(c.unheard()).toEqual([]);
  });

  it.each(['claude', 'codex'] as const)('keeps one successful completion when typed %s exits after its end, including while its log settles', async kind => {
    const c = await atTypedWork(kind, kind === 'claude' ? 'queued' : 'silent');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    await c.on(c.end());
    await c.until(() => {
      const a = c.host['agents'].get('receipt')!;
      return Boolean(a.turn?.ending) || c.sent.some(m => m.type === 'job.done' && m.jobId === 'typed');
    });
    c.alive.mockResolvedValue(false);
    await c.on(c.host['look'](c.host['agents'].get('receipt')!));
    await c.until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'typed' && m.ok));
    expect(c.sent.filter(m => m.type === 'job.done' && m.jobId === 'typed')).toEqual([
      expect.objectContaining({ ok: true, result: 'Typed answer.', error: null }),
    ]);
    expect(c.host['agents'].get('receipt')!.up).toBe(false);
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'typed', text: TEXT }]);
  });
});
