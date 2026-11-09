import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { UNHEARD_MS } from '@hornhoof/protocol';
import { claudeQueue, userMessage } from './fakes/word-receipts.mjs';
import { kimiScreen } from './terminal-host-helpers.js';
import { cleanups, liveTerminal, TEXT } from './terminal-host-live-helpers.js';
import { codexPrompt } from './real-screens.js';

describe('reviewed live delivery through program events', () => {
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });

  it.each(['claude', 'kimi'] as const)('erases only the captured %s paste display after missed submission', async kind => {
    const c = await liveTerminal(kind, 'lost');
    c.screen.mockImplementation(async () => kind === 'claude'
      ? `────────\n❯ ${c.input() ? '[Pasted text #1 +3 lines]' : ''}\n────────\n`
      : kimiScreen(c.input()));
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(false);
    expect(c.input()).toBe('');
    expect(c.unheard()).toEqual([]);
    expect(c.launch).toHaveBeenCalledOnce();
  });

  it('erases a held collapsed paste at expiry before the next prompt', async () => {
    const c = await liveTerminal('codex', 'lost');
    c.screen.mockImplementation(async () => `OpenAI Codex\n${codexPrompt(c.input() ? '[Pasted Content 3 lines]' : '')}`);
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.finish(); await c.on(c.running);
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + UNHEARD_MS + 1);
    await c.until(() => c.unheard().length === 1);
    await c.pass(20);
    clock.mockRestore();
    expect(c.input()).toBe('');
    expect(c.launch).toHaveBeenCalledOnce();
  });

  it('erases trimmed words when the post-paste display was unreadable', async () => {
    const c = await liveTerminal('claude', 'lost');
    const screen = c.screen.getMockImplementation()!;
    c.screen.mockImplementationOnce(screen).mockResolvedValueOnce('Redrawing.');
    expect(await c.on(c.host.say('receipt', `  ${TEXT}  `))).toBe(false);
    expect(c.input()).toBe('');
  });

  it.each(['claude', 'kimi'] as const)('returns unconsumed queued %s words once after the idle grace deadline', async kind => {
    const c = await liveTerminal(kind);
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.finish();
    expect(await c.on(c.running)).toMatchObject({ wordsWaiting: true });
    const prompt = c.hook('prompt', { prompt: 'A separate human question.' });
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    const opened = c.sent.find(m => m.type === 'turn.open');
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'human-token', ref: opened?.ref });
    await c.on(prompt);
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + UNHEARD_MS + 1);
    await c.pass(40);
    expect(c.unheard()).toEqual([]);
    c.finish();
    await c.until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'human'));
    await c.until(() => c.unheard().length === 1);
    clock.mockRestore();
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: TEXT }]);
    expect(c.log.mock.calls).toEqual([['Agent receipt (' + kind + '): live words were not delivered: the program did not take the words before the receipt wait ended.']]);
    expect(c.sent.filter(m => m.type === 'agent.words_settled')).toHaveLength(1);
  });

  it('tells the operator what became of live words in a turn a person typed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-typed-receipts-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const c = await liveTerminal('claude', 'queued', { operator: { dir, connected: () => true, send: () => true } });
    const told = vi.spyOn(c.host['operator']!, 'receipt');
    c.finish();
    await c.on(c.running);
    const prompt = c.hook('prompt', { prompt: 'A human question.' });
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    const opened = c.sent.find(m => m.type === 'turn.open');
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'human-token', ref: opened?.ref });
    await c.on(prompt);
    const delivery = { id: randomUUID(), ordinal: 2 };
    expect(await c.on(c.host.say('receipt', TEXT, Infinity, delivery))).toBe(true);
    expect(told).toHaveBeenCalledWith('receipt', delivery, 'queued');
  });

  it('settles once after the job ends, including words absorbed before later queued words', async () => {
    const c = await liveTerminal();
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.record(claudeQueue('remove', TEXT, { reason: 'absorbed_mid_turn' }));
    await c.pass(30);
    expect(c.sent.filter(m => m.type === 'agent.words_settled')).toEqual([]);
    expect(await c.on(c.host.say('receipt', 'Later words.'))).toBe(true);
    c.finish();
    expect(await c.on(c.running)).toMatchObject({ wordsWaiting: true });
    c.record(claudeQueue('remove', 'Later words.', { reason: 'absorbed_mid_turn' }));
    await c.until(() => c.sent.some(m => m.type === 'agent.words_settled'));
    await c.pass(30);
    expect(c.sent.filter(m => m.type === 'agent.words_settled')).toEqual([
      { type: 'agent.words_settled', agentKey: 'receipt', jobId: 'job-receipt' },
    ]);
    expect(c.unheard()).toEqual([]);
  });

  it.each(['claude', 'kimi'] as const)('opens queued %s words through the Bridge before settling their old job', async kind => {
    const c = await liveTerminal(kind);
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.finish(); await c.on(c.running);
    const prompt = c.hook('prompt', { prompt: TEXT });
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    const openAt = c.sent.findIndex(m => m.type === 'turn.open');
    expect(c.sent.slice(0, openAt).filter(m => m.type === 'agent.words_settled')).toEqual([]);
    const opened = c.sent[openAt];
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'queued', toolToken: 'queued-token', ref: opened?.type === 'turn.open' ? opened.ref : undefined });
    await c.on(prompt);
    await c.until(() => c.sent.some(m => m.type === 'agent.words_settled'));
    expect(c.sent.filter(m => m.type === 'agent.words_settled')).toHaveLength(1);
  });

  it.each(['claude', 'kimi'] as const)('refuses an unreadable %s draft without typing', async kind => {
    const c = await liveTerminal(kind);
    const draft = '\nA person is still writing.';
    c.draft(draft);
    c.screen.mockImplementation(async () => kind === 'claude' ? `────────\n❯ ${draft}\n` : `╭─────╮\n│ > ${draft}\n`);
    expect(await c.on(c.host.say('receipt', TEXT, 1000))).toBe(false);
    expect(c.input()).toBe(draft);
    expect(c.paste).not.toHaveBeenCalled();
    expect(c.log.mock.calls).toEqual([['Agent receipt (' + kind + '): live words were not delivered: the input could not be read.']]);
  });

  it('waits for a readable empty input before pasting', async () => {
    const c = await liveTerminal();
    const display = c.screen.getMockImplementation()!;
    const paste = c.paste.getMockImplementation()!;
    let readable = false;
    c.screen.mockImplementationOnce(async () => 'Redrawing.').mockImplementationOnce(async () => 'Redrawing.');
    c.screen.mockImplementation(async (...args) => { readable = true; return display(...args); });
    c.paste.mockImplementation(async (...args) => { if (!readable) throw new Error('The terminal is redrawing.'); await paste(...args); });
    expect(await c.on(c.host.say('receipt', TEXT, 1000))).toBe(true);
    expect(c.submitted).toEqual(['HANG', TEXT]);
    expect(c.log).not.toHaveBeenCalled();
  });

  it('refuses an unreadable input while only the start of its rule is drawn', async () => {
    const c = await liveTerminal();
    c.draft('A draft that has not been painted yet.');
    c.screen.mockResolvedValue('──\n❯ \n');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(false);
    expect(c.input()).toBe('A draft that has not been painted yet.');
    expect(c.paste).not.toHaveBeenCalled();
  });

  it('accepts a plain Claude prompt and returns words it later dismisses', async () => {
    const c = await liveTerminal();
    c.screen.mockResolvedValue('❯ \n');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.record(claudeQueue('remove', TEXT, { reason: 'dismissed' }));
    await c.pass(50);
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: TEXT }]);
  });

  it('refuses an unreadable capture at its input wait deadline', async () => {
    const c = await liveTerminal();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const display = c.screen.getMockImplementation()!;
    c.screen.mockImplementationOnce(async () => { clock.mockReturnValue(now + 50); return 'Redrawing.'; });
    c.screen.mockImplementation(display);
    expect(await c.on(c.host.say('receipt', TEXT, 1000))).toBe(false);
    expect(c.paste).not.toHaveBeenCalled();
  });

  it('refuses a paste that would use the entire remaining budget', async () => {
    const c = await liveTerminal();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    expect(await c.on(c.host.say('receipt', 'A'.repeat(20), 301))).toBe(false);
    expect(c.paste).not.toHaveBeenCalled();
    expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: there is not enough time to paste the words.']]);
  });

  it('logs an unknown receiver and a terminal whose program has not started', async () => {
    const c = await liveTerminal();
    expect(await c.on(c.host.say('missing', TEXT))).toBe(false);
    c.screen.mockRejectedValueOnce(new Error('The terminal has not started.'));
    await c.on(c.host.screen('unstarted')).catch(() => {});
    expect(await c.on(c.host.say('unstarted', TEXT))).toBe(false);
    expect(c.log.mock.calls).toEqual([
      ['Agent missing (unknown): live words were not delivered: no turn is running.'],
      ['Agent unstarted (unknown): live words were not delivered: no turn is running.'],
    ]);
  });

  it('keeps the next turn prompt ahead of live words while its Enter is delayed', async () => {
    const c = await liveTerminal();
    c.finish(); await c.on(c.running);
    const keys = c.keys.getMockImplementation()!;
    c.keys.mockImplementation(async () => {});
    const next = c.run('The next turn prompt.', 'next');
    await c.until(() => c.input() === 'The next turn prompt.');
    try {
      expect(await c.on(c.host.say('receipt', TEXT))).toBe(false);
      expect(c.input()).toBe('The next turn prompt.');
      expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: the program has not taken the turn prompt.']]);
    } finally {
      c.keys.mockImplementation(keys);
      await c.on(c.tmux.keys('a-receipt', 'Enter'));
      c.finish(); await c.on(next);
    }
  });

  it('keeps a human draft when a paste fails before writing any bytes', async () => {
    const c = await liveTerminal();
    c.paste.mockImplementationOnce(async () => { c.draft('A new human draft.'); throw new Error('paste failed'); });
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(false);
    expect(c.input()).toBe('A new human draft.');
    expect(c.keys).not.toHaveBeenCalled();
    expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: could not paste the words.']]);
  });

  it('logs a failed submit and failed input cleanup once without the terminal error text', async () => {
    const c = await liveTerminal();
    c.keys.mockRejectedValue(new Error(TEXT));
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(false);
    expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: could not send the submit key; could not erase the typed input.']]);
  });

  it('sends no cleanup keys when the program exits before live submission', async () => {
    const c = await liveTerminal();
    const paste = c.paste.getMockImplementation()!;
    c.paste.mockImplementationOnce(async (...args) => { await paste(...args); c.alive.mockResolvedValue(false); });
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(false);
    expect(c.keys.mock.calls.flat()).not.toContain('C-u');
    expect(c.keys.mock.calls.flat()).not.toContain('BSpace');
    expect(c.log).toHaveBeenCalledOnce();
  });

  it('reports queued program input while exit diagnostics are still being read', async () => {
    const c = await liveTerminal();
    let release!: (text: string) => void;
    const diagnostics = new Promise<string>(resolve => { release = resolve; });
    let refusal: Promise<boolean> | undefined;
    c.screen.mockClear().mockReturnValue(diagnostics);
    c.alive.mockResolvedValue(false);
    try {
      await c.until(() => c.screen.mock.calls.length > 0);
      refusal = c.host.say('receipt', TEXT);
      /* The refusal comes within 500 ms of the program's time, a timer of the fake clock. */
      expect(await c.on(Promise.race([refusal, new Promise(resolve => setTimeout(() => resolve('blocked'), 500))]))).toBe(false);
      expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: the receiving turn ended.']]);
      c.record(claudeQueue('dequeue', 'A queued question.'));
      c.record({ type: 'user', message: { content: 'A queued question.' } });
      await c.pass(50);
      const opened = c.sent.find(m => m.type === 'turn.open');
      expect(opened).toMatchObject({ text: 'A queued question.' });
      c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: null, toolToken: null, ref: opened?.ref });
    } finally { release('The program exited.'); if (refusal) await c.on(refusal); await c.on(c.running); }
  });

  it('does not acknowledge live words when the turn ends during their paste', async () => {
    const c = await liveTerminal();
    const paste = c.paste.getMockImplementation()!;
    c.paste.mockImplementationOnce(async (...args) => { await paste(...args); c.finish(); });
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(false);
    expect(c.submitted).toEqual(['HANG']);
    expect(c.input()).toBe('');
    expect(c.log).toHaveBeenCalledOnce();
    expect(c.log.mock.calls[0]![0]).toMatch(/receiving turn (changed or )?ended/);
  });

  it('keeps a confirmed queue receipt when the following liveness check fails', async () => {
    const c = await liveTerminal();
    const keys = c.keys.getMockImplementation()!;
    c.keys.mockImplementationOnce(async (...args) => { await keys(...args); c.alive.mockRejectedValueOnce(new Error(TEXT)); });
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    expect(c.unheard()).toEqual([]);
    c.record(claudeQueue('remove', TEXT, { reason: 'dismissed' }));
    await c.pass(50);
    expect(c.unheard()).toHaveLength(1);
  });

  it('keeps a human draft when held input expires at an idle prompt', async () => {
    const c = await liveTerminal('codex', 'lost');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.finish();
    expect(await c.on(c.running)).toMatchObject({ wordsWaiting: true });
    c.draft('A later human draft.');
    c.keys.mockClear();
    const now = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => now() + UNHEARD_MS + 1);
    await c.until(() => c.unheard().length === 1);
    expect(c.input()).toBe('A later human draft.');
    expect(c.keys).not.toHaveBeenCalled();
    expect(c.log.mock.calls).toEqual([['Agent receipt (codex): live words were not delivered: the program did not take the words before the receipt wait ended.']]);
  });

  it('logs a failed held-input cleanup without replacing the program', async () => {
    const c = await liveTerminal('codex', 'lost');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.finish(); await c.on(c.running);
    c.keys.mockRejectedValue(new Error(TEXT));
    const now = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => now() + UNHEARD_MS + 1);
    await c.until(() => c.unheard().length === 1);
    await c.pass(30);
    expect(c.log.mock.calls).toEqual([
      ['Agent receipt (codex): live words were not delivered: the program did not take the words before the receipt wait ended.'],
      ['Agent receipt (codex): could not erase held live input.'],
    ]);
    expect(c.launch).toHaveBeenCalledOnce();
  });

  it('keeps a new held copy when identical words from an older turn expire', async () => {
    const c = await liveTerminal('codex', 'lost');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.finish(); await c.on(c.running);
    c.draft('');
    c.record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'human' } });
    c.record(userMessage('A human question.', 'human'));
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    const opened = c.sent.find(m => m.type === 'turn.open');
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'human-token', ref: opened?.ref });
    const now = Date.now.bind(Date);
    const paste = c.paste.getMockImplementation()!;
    c.paste.mockImplementationOnce(async (...args) => { await paste(...args); vi.spyOn(Date, 'now').mockImplementation(() => now() + UNHEARD_MS + 1); });
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    await c.pass(30);
    expect(c.input()).toBe(TEXT);
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: TEXT }]);
    expect(c.log).toHaveBeenCalledOnce();
    c.record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'human', last_agent_message: 'Done.' } });
    await c.until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'human'));
  });

  it('returns held words on shutdown without trying to erase a closing terminal', async () => {
    const c = await liveTerminal('codex', 'lost');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.keys.mockClear().mockRejectedValue(new Error(TEXT));
    let release!: () => void;
    const closed = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(c.tmux.stopAll).mockImplementation(async () => { await closed; c.alive.mockResolvedValue(false); });
    const stopped = c.host.stop();
    try {
      await c.pass(30);
      expect(c.keys).not.toHaveBeenCalled();
      expect(c.log.mock.calls).toEqual([['Agent receipt (codex): live words were not delivered: the node is stopping.']]);
    } finally { release(); await c.on(stopped); await c.on(c.running); }
  });

  it('keeps a human edit made after a live paste when no receipt arrives', async () => {
    const c = await liveTerminal('claude', 'lost');
    c.keys.mockImplementationOnce(async () => { c.draft('A human replaced the pasted words.'); });
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(false);
    expect(c.input()).toBe('A human replaced the pasted words.');
    expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: the program did not record a receipt after two submit keys.']]);
  });

  it('erases only the exact multiline words still held in Codex input', async () => {
    const c = await liveTerminal('codex', 'lost');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.finish(); await c.on(c.running);
    const now = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => now() + UNHEARD_MS + 1);
    await c.until(() => c.unheard().length === 1);
    await c.pass(30);
    expect(c.input()).toBe('');
  });

  it('removes a dismissed background entry before a contentless absorption', async () => {
    const c = await liveTerminal();
    c.record(claudeQueue('enqueue', '<task-notification>Done.</task-notification>'));
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.record(claudeQueue('remove', '<task-notification>Done.</task-notification>', { reason: 'dismissed' }));
    await c.pass(30);
    expect(c.unheard()).toEqual([]);
    c.record({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn' });
    await c.pass(30);
    await c.on(c.hook('end', { reason: 'clear' }));
    expect(c.unheard()).toEqual([]);
  });

  it('does not erase a partial box whose first line matches Hornhoof words', async () => {
    const c = await liveTerminal('claude', 'lost');
    c.keys.mockImplementationOnce(async () => {
      c.draft('Hornhoof words.\nHuman continuation.');
      c.screen.mockResolvedValue('────────\n❯ Hornhoof words.\nHuman continuation.\n');
    });
    expect(await c.on(c.host.say('receipt', 'Hornhoof words.'))).toBe(false);
    expect(c.input()).toBe('Hornhoof words.\nHuman continuation.');
    expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: the program did not record a receipt after two submit keys.']]);
  });

  it('returns a dismissed live message once without waiting for the program to exit', async () => {
    const c = await liveTerminal();
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.record(claudeQueue('remove', TEXT, { reason: 'dismissed' }));
    await c.pass(50);
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: TEXT }]);
    expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: the program removed the queued words.']]);
    await c.on(c.hook('end', { reason: 'clear' }));
    expect(c.unheard()).toHaveLength(1);
  });

  it.each([false, true])('returns only the oldest matching message across two turns, identical: %s', async identical => {
    const c = await liveTerminal();
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.finish(); await c.on(c.running);
    const prompted = c.hook('prompt', { prompt: 'A human question.' });
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    const opened = c.sent.find(m => m.type === 'turn.open');
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'human-token', ref: opened?.ref });
    await c.on(prompted);
    const next = identical ? TEXT : 'Different words for the human turn.';
    expect(await c.on(c.host.say('receipt', next))).toBe(true);
    c.record(claudeQueue('remove', next, { reason: 'dismissed' }));
    await c.pass(50);
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: identical ? 'job-receipt' : 'human', text: next }]);
    c.finish();
    await c.until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'human'));
    const done = c.sent.find(m => m.type === 'job.done' && m.jobId === 'human');
    expect(done).toMatchObject({ ok: true, error: null });
    if (identical) expect(done).toHaveProperty('wordsWaiting', true);
    else expect(done).not.toHaveProperty('wordsWaiting');
  });

  it('returns dismissed live words after the first human prompt in an empty terminal', async () => {
    const c = await liveTerminal('claude', 'queued', { prompt: '' });
    const prompted = c.hook('prompt', { prompt: 'A first human question.' });
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    const opened = c.sent.find(m => m.type === 'turn.open');
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'human-token', ref: opened?.ref });
    await c.on(prompted);
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.record(claudeQueue('remove', TEXT, { reason: 'dismissed' }));
    await c.pass(50);
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'human', text: TEXT }]);
  });

  it('answers an interrupted first prompt before the server acknowledges its turn', async () => {
    const c = await liveTerminal('claude', 'queued', { prompt: '', openMs: 500 });
    const prompted = c.hook('prompt', { prompt: 'A first question.' });
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    const opened = c.sent.find(m => m.type === 'turn.open');
    await c.on(c.hook('interrupt'));
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'human-token', ref: opened?.ref });
    expect(await c.on(prompted)).toBe('');
    expect(c.sent.find(m => m.type === 'job.done' && m.jobId === 'human')).toMatchObject({ ok: false, error: 'cancelled' });
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(false);
    expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: no turn is running.']]);
  });

  it('keeps the first Codex human turn and returns its unconfirmed input once', async () => {
    const c = await liveTerminal('codex', 'lost', { prompt: '' });
    c.record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'human' } });
    c.record(userMessage('A first question.', 'human'));
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    const opened = c.sent.find(m => m.type === 'turn.open');
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'human-token', ref: opened?.ref });
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'human', last_agent_message: 'Done.' } });
    await c.until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'human'));
    expect(c.sent.find(m => m.type === 'job.done' && m.jobId === 'human')).toHaveProperty('wordsWaiting', true);
    const now = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => now() + UNHEARD_MS + 1);
    await c.until(() => c.unheard().length === 1);
    expect(c.input()).toBe('');
    expect(c.log).toHaveBeenCalledOnce();
  });

  it('ignores a late Kimi queue hook after its turn ended and logs the next refusal', async () => {
    const c = await liveTerminal('kimi');
    c.finish(); await c.on(c.running);
    await c.on(c.hook('queued', { prompt: TEXT }));
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(false);
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
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(false);
    expect(c.input()).toBe('');
    expect(c.log.mock.calls).toEqual([['Agent receipt (kimi): live words were not delivered: the program did not record a receipt after two submit keys.']]);
  });

  it.each([0, 1])('ends the held receipt window at the grace boundary plus %i ms', async after => {
    let finishLimits = () => {};
    const c = await liveTerminal('codex', 'lost', { limits: async () => { finishLimits(); return null; } });
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    const endedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(endedAt);
    finishLimits = () => { clock.mockReturnValue(endedAt + UNHEARD_MS + after); };
    c.finish();
    expect(await c.on(c.running)).not.toHaveProperty('wordsWaiting');
    await c.pass(30);
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: TEXT }]);
    expect(c.log.mock.calls).toEqual([['Agent receipt (codex): live words were not delivered: the program did not take the words before the receipt wait ended.']]);
  });

  it('takes dequeued words during a busy Claude turn without returning them again', async () => {
    const c = await liveTerminal();
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.record(claudeQueue('dequeue', TEXT));
    c.record({ type: 'user', message: { content: TEXT } });
    await c.pass(30);
    expect(await c.on(c.host.say('receipt', 'The following answer.'))).toBe(true);
    c.record({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn' });
    c.finish();
    expect(await c.on(c.running)).not.toHaveProperty('wordsWaiting');
    await c.on(c.hook('end', { reason: 'clear' }));
    expect(c.unheard()).toEqual([]);
    expect(c.sent.filter(m => m.type === 'turn.open')).toEqual([]);
  });

  it('keeps queue handoff separate from background messages and compaction', async () => {
    const c = await liveTerminal();
    for (const text of [TEXT, 'A later answer.']) expect(await c.on(c.host.say('receipt', text))).toBe(true);
    c.finish(); await c.on(c.running);
    c.record(claudeQueue('dequeue', TEXT));
    c.record({ type: 'assistant', message: { content: [{ type: 'text', text: 'A background result.' }] } });
    c.record({ type: 'user', message: { content: TEXT } });
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    const opened = c.sent.find(m => m.type === 'turn.open');
    expect(opened).toMatchObject({ text: TEXT, queuedFrom: 'job-receipt' });
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'queued', toolToken: 'queued-token', ref: opened?.ref });
    c.finish();
    await c.until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'queued'));
    c.record(claudeQueue('enqueue', '<task-notification>Done.</task-notification>'));
    c.record({ type: 'system', subtype: 'compact_boundary' });
    c.record({ type: 'user', isCompactSummary: true, message: { content: 'Earlier context.' } });
    await c.pass(30);
    expect(c.sent.filter(m => m.type === 'turn.open')).toHaveLength(1);
    c.record(claudeQueue('remove', 'A later answer.', { reason: 'dismissed' }));
    await c.pass(30);
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: 'A later answer.' }]);
  });

  it('settles a finished job only after all queued words are taken within the grace period', async () => {
    const c = await liveTerminal();
    for (const text of [TEXT, 'Another answer.']) expect(await c.on(c.host.say('receipt', text))).toBe(true);
    c.finish();
    expect(await c.on(c.running)).toMatchObject({ wordsWaiting: true });
    const now = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => now() + UNHEARD_MS - 1000);
    c.record(claudeQueue('remove', TEXT, { reason: 'absorbed_mid_turn' }));
    await c.pass(30);
    expect(c.sent).not.toContainEqual({ type: 'agent.words_settled', agentKey: 'receipt', jobId: 'job-receipt' });
    c.record({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn' });
    await c.pass(30);
    expect(c.sent).toContainEqual({ type: 'agent.words_settled', agentKey: 'receipt', jobId: 'job-receipt' });
    await c.pass(30);
    expect(c.sent.filter(m => m.type === 'agent.words_settled')).toHaveLength(1);
    expect(c.unheard()).toEqual([]);
  });

  it('waits for a delayed queue receipt before retrying Enter', async () => {
    const c = await liveTerminal('claude', 'silent');
    const keys = c.keys.getMockImplementation()!;
    /* The program records the queue 20 ms after the Enter, on the fake clock. */
    c.keys.mockImplementationOnce(async (...args) => { await keys(...args); setTimeout(() => c.record(claudeQueue('enqueue', TEXT)), 20); });
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    expect(c.keys.mock.calls.filter(([, ...pressed]) => pressed.includes('Enter'))).toHaveLength(1);
    c.record(claudeQueue('remove', TEXT, { reason: 'dismissed' }));
    await c.pass(50);
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
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    expect(c.keys.mock.calls.filter(([, ...pressed]) => pressed.includes('Enter'))).toHaveLength(2);
    c.record(claudeQueue('remove', TEXT, { reason: 'dismissed' }));
    await c.pass(50);
    expect(c.unheard()).toHaveLength(1);
  });

  it('requires a Claude transcript receipt even when its Bridge prompt hook answered', async () => {
    const c = await liveTerminal('claude', 'hook');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(false);
    expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: the program did not record a receipt after two submit keys.']]);
  });

  it.each(['tooldone', 'toolfail'])('keeps tool and permission reports while returning dismissed words after %s', async event => {
    const c = await liveTerminal();
    await c.on(c.hook('tool', { tool_use_id: 'bash', tool_name: 'Bash' }));
    await c.until(() => c.sent.some(m => m.type === 'job.program' && m.state === 'tool' && m.tool === 'Bash'));
    const name = event === 'tooldone' ? 'AskUserQuestion' : 'Permission';
    await c.on(c.hook('ask', { tool_use_id: 'question', ...(event === 'tooldone' ? { tool_name: name } : {}) }));
    await c.until(() => c.sent.some(m => m.type === 'job.program' && m.state === 'asking' && m.tool === name));
    const afterAsk = c.sent.length;
    await c.on(c.hook(event, { tool_use_id: 'question', tool_name: name }));
    await c.until(() => c.sent.slice(afterAsk).some(m => m.type === 'job.program' && m.state === 'tool' && m.tool === 'Bash'));
    await c.on(c.hook(event, { tool_use_id: 'bash', tool_name: 'Bash' }));
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.record(claudeQueue('remove', TEXT, { reason: 'dismissed' }));
    await c.pass(50);
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: TEXT }]);
    expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: the program removed the queued words.']]);
  });

  it.each([1, 3])('delivers %i failed live messages as later turns in the same program', async count => {
    const c = await liveTerminal('claude', 'lost');
    const messages = [TEXT, 'Task #226 is yours.', 'The answer.\nContinue.'].slice(0, count);
    for (const text of messages) expect(await c.on(c.host.say('receipt', text))).toBe(false);
    expect(c.input()).toBe('');
    c.finish(); await c.on(c.running);
    for (const [i, text] of messages.entries()) {
      const jobId = `next-${i}`;
      const next = c.run(text, jobId);
      await c.until(() => c.sent.some(m => m.type === 'job.program' && m.jobId === jobId && m.state === 'thinking'));
      c.finish();
      expect(await c.on(next)).toMatchObject({ ok: true, sessionId: expect.any(String) });
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
    await c.on(prepare(c));
    expect(await c.on(c.host.say('receipt', TEXT, budget))).toBe(false);
    expect(c.log.mock.calls).toEqual([[`Agent receipt (claude): live words were not delivered: ${reason}.`]]);
  });
});
