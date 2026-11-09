import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { UNHEARD_MS } from '@hornhoof/protocol';
import { claudeQueue, userMessage } from './fakes/word-receipts.mjs';
import { kimiScreen, until } from './terminal-host-helpers.js';
import { cleanups, liveTerminal, TEXT } from './terminal-host-live-helpers.js';
import { codexPrompt } from './real-screens.js';

describe('reviewed live delivery through program events', () => {
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });

  it.each(['claude', 'kimi'] as const)('erases only the captured %s paste display after missed submission', async kind => {
    const c = await liveTerminal(kind, 'lost');
    c.screen.mockImplementation(async () => kind === 'claude'
      ? `────────\n❯ ${c.input() ? '[Pasted text #1 +3 lines]' : ''}\n────────\n`
      : kimiScreen(c.input()));
    expect(await c.host.say('receipt', TEXT)).toBe(false);
    expect(c.input()).toBe('');
    expect(c.unheard()).toEqual([]);
    expect(c.launch).toHaveBeenCalledOnce();
  });

  it('erases a held collapsed paste at expiry before the next prompt', async () => {
    const c = await liveTerminal('codex', 'lost');
    c.screen.mockImplementation(async () => `OpenAI Codex\n${codexPrompt(c.input() ? '[Pasted Content 3 lines]' : '')}`);
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.finish(); await c.running;
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + UNHEARD_MS + 1);
    await until(() => c.unheard().length === 1);
    await new Promise(resolve => setTimeout(resolve, 20));
    clock.mockRestore();
    expect(c.input()).toBe('');
    expect(c.launch).toHaveBeenCalledOnce();
  });

  it('erases trimmed words when the post-paste display was unreadable', async () => {
    const c = await liveTerminal('claude', 'lost');
    const screen = c.screen.getMockImplementation()!;
    c.screen.mockImplementationOnce(screen).mockResolvedValueOnce('Redrawing.');
    expect(await c.host.say('receipt', `  ${TEXT}  `)).toBe(false);
    expect(c.input()).toBe('');
  });

  it.each(['claude', 'kimi'] as const)('returns unconsumed queued %s words once after the idle grace deadline', async kind => {
    const c = await liveTerminal(kind);
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.finish();
    expect(await c.running).toMatchObject({ wordsWaiting: true });
    const prompt = c.hook('prompt', { prompt: 'A separate human question.' });
    await until(() => c.sent.some(m => m.type === 'turn.open'));
    const opened = c.sent.find(m => m.type === 'turn.open');
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'human-token', ref: opened?.ref });
    await prompt;
    const now = Date.now.bind(Date);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + UNHEARD_MS + 1);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(c.unheard()).toEqual([]);
    c.finish();
    await until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'human'));
    await until(() => c.unheard().length === 1);
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
    await c.running;
    const prompt = c.hook('prompt', { prompt: 'A human question.' });
    await until(() => c.sent.some(m => m.type === 'turn.open'));
    const opened = c.sent.find(m => m.type === 'turn.open');
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'human-token', ref: opened?.ref });
    await prompt;
    const delivery = { id: randomUUID(), ordinal: 2 };
    expect(await c.host.say('receipt', TEXT, Infinity, delivery)).toBe(true);
    expect(told).toHaveBeenCalledWith('receipt', delivery, 'queued');
  });

  it('settles once after the job ends, including words absorbed before later queued words', async () => {
    const c = await liveTerminal();
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.record(claudeQueue('remove', TEXT, { reason: 'absorbed_mid_turn' }));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(c.sent.filter(m => m.type === 'agent.words_settled')).toEqual([]);
    expect(await c.host.say('receipt', 'Later words.')).toBe(true);
    c.finish();
    expect(await c.running).toMatchObject({ wordsWaiting: true });
    c.record(claudeQueue('remove', 'Later words.', { reason: 'absorbed_mid_turn' }));
    await until(() => c.sent.some(m => m.type === 'agent.words_settled'));
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(c.sent.filter(m => m.type === 'agent.words_settled')).toEqual([
      { type: 'agent.words_settled', agentKey: 'receipt', jobId: 'job-receipt' },
    ]);
    expect(c.unheard()).toEqual([]);
  });

  it.each(['claude', 'kimi'] as const)('opens queued %s words through the Bridge before settling their old job', async kind => {
    const c = await liveTerminal(kind);
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.finish(); await c.running;
    const prompt = c.hook('prompt', { prompt: TEXT });
    await until(() => c.sent.some(m => m.type === 'turn.open'));
    const openAt = c.sent.findIndex(m => m.type === 'turn.open');
    expect(c.sent.slice(0, openAt).filter(m => m.type === 'agent.words_settled')).toEqual([]);
    const opened = c.sent[openAt];
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'queued', toolToken: 'queued-token', ref: opened?.type === 'turn.open' ? opened.ref : undefined });
    await prompt;
    await until(() => c.sent.some(m => m.type === 'agent.words_settled'));
    expect(c.sent.filter(m => m.type === 'agent.words_settled')).toHaveLength(1);
  });

  it.each(['claude', 'kimi'] as const)('refuses an unreadable %s draft without typing', async kind => {
    const c = await liveTerminal(kind);
    const draft = '\nA person is still writing.';
    c.draft(draft);
    c.screen.mockImplementation(async () => kind === 'claude' ? `────────\n❯ ${draft}\n` : `╭─────╮\n│ > ${draft}\n`);
    expect(await c.host.say('receipt', TEXT, 1000)).toBe(false);
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
    expect(await c.host.say('receipt', TEXT, 1000)).toBe(true);
    expect(c.submitted).toEqual(['HANG', TEXT]);
    expect(c.log).not.toHaveBeenCalled();
  });

  it('refuses an unreadable input while only the start of its rule is drawn', async () => {
    const c = await liveTerminal();
    c.draft('A draft that has not been painted yet.');
    c.screen.mockResolvedValue('──\n❯ \n');
    expect(await c.host.say('receipt', TEXT)).toBe(false);
    expect(c.input()).toBe('A draft that has not been painted yet.');
    expect(c.paste).not.toHaveBeenCalled();
  });

  it('accepts a plain Claude prompt and returns words it later dismisses', async () => {
    const c = await liveTerminal();
    c.screen.mockResolvedValue('❯ \n');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.record(claudeQueue('remove', TEXT, { reason: 'dismissed' }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: TEXT }]);
  });

  it('refuses an unreadable capture at its input wait deadline', async () => {
    const c = await liveTerminal();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const display = c.screen.getMockImplementation()!;
    c.screen.mockImplementationOnce(async () => { clock.mockReturnValue(now + 50); return 'Redrawing.'; });
    c.screen.mockImplementation(display);
    expect(await c.host.say('receipt', TEXT, 1000)).toBe(false);
    expect(c.paste).not.toHaveBeenCalled();
  });

  it('refuses a paste that would use the entire remaining budget', async () => {
    const c = await liveTerminal();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    expect(await c.host.say('receipt', 'A'.repeat(20), 301)).toBe(false);
    expect(c.paste).not.toHaveBeenCalled();
    expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: there is not enough time to paste the words.']]);
  });

  it('logs an unknown receiver and a terminal whose program has not started', async () => {
    const c = await liveTerminal();
    expect(await c.host.say('missing', TEXT)).toBe(false);
    c.screen.mockRejectedValueOnce(new Error('The terminal has not started.'));
    await c.host.screen('unstarted').catch(() => {});
    expect(await c.host.say('unstarted', TEXT)).toBe(false);
    expect(c.log.mock.calls).toEqual([
      ['Agent missing (unknown): live words were not delivered: no turn is running.'],
      ['Agent unstarted (unknown): live words were not delivered: no turn is running.'],
    ]);
  });

  it('keeps the next turn prompt ahead of live words while its Enter is delayed', async () => {
    const c = await liveTerminal();
    c.finish(); await c.running;
    const keys = c.keys.getMockImplementation()!;
    c.keys.mockImplementation(async () => {});
    const next = c.run('The next turn prompt.', 'next');
    await until(() => c.input() === 'The next turn prompt.');
    try {
      expect(await c.host.say('receipt', TEXT)).toBe(false);
      expect(c.input()).toBe('The next turn prompt.');
      expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: the program has not taken the turn prompt.']]);
    } finally {
      c.keys.mockImplementation(keys);
      await c.tmux.keys('a-receipt', 'Enter');
      c.finish(); await next;
    }
  });

  it('keeps a human draft when a paste fails before writing any bytes', async () => {
    const c = await liveTerminal();
    c.paste.mockImplementationOnce(async () => { c.draft('A new human draft.'); throw new Error('paste failed'); });
    expect(await c.host.say('receipt', TEXT)).toBe(false);
    expect(c.input()).toBe('A new human draft.');
    expect(c.keys).not.toHaveBeenCalled();
    expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: could not paste the words.']]);
  });

  it('logs a failed submit and failed input cleanup once without the terminal error text', async () => {
    const c = await liveTerminal();
    c.keys.mockRejectedValue(new Error(TEXT));
    expect(await c.host.say('receipt', TEXT)).toBe(false);
    expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: could not send the submit key; could not erase the typed input.']]);
  });

  it('sends no cleanup keys when the program exits before live submission', async () => {
    const c = await liveTerminal();
    const paste = c.paste.getMockImplementation()!;
    c.paste.mockImplementationOnce(async (...args) => { await paste(...args); c.alive.mockResolvedValue(false); });
    expect(await c.host.say('receipt', TEXT)).toBe(false);
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
      await until(() => c.screen.mock.calls.length > 0);
      refusal = c.host.say('receipt', TEXT);
      expect(await Promise.race([refusal, new Promise(resolve => setTimeout(() => resolve('blocked'), 500))])).toBe(false);
      expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: the receiving turn ended.']]);
      c.record(claudeQueue('dequeue', 'A queued question.'));
      c.record({ type: 'user', message: { content: 'A queued question.' } });
      await new Promise(resolve => setTimeout(resolve, 50));
      const opened = c.sent.find(m => m.type === 'turn.open');
      expect(opened).toMatchObject({ text: 'A queued question.' });
      c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: null, toolToken: null, ref: opened?.ref });
    } finally { release('The program exited.'); await refusal; await c.running; }
  });

  it('does not acknowledge live words when the turn ends during their paste', async () => {
    const c = await liveTerminal();
    const paste = c.paste.getMockImplementation()!;
    c.paste.mockImplementationOnce(async (...args) => { await paste(...args); c.finish(); });
    expect(await c.host.say('receipt', TEXT)).toBe(false);
    expect(c.submitted).toEqual(['HANG']);
    expect(c.input()).toBe('');
    expect(c.log).toHaveBeenCalledOnce();
    expect(c.log.mock.calls[0]![0]).toMatch(/receiving turn (changed or )?ended/);
  });

  it('keeps a confirmed queue receipt when the following liveness check fails', async () => {
    const c = await liveTerminal();
    const keys = c.keys.getMockImplementation()!;
    c.keys.mockImplementationOnce(async (...args) => { await keys(...args); c.alive.mockRejectedValueOnce(new Error(TEXT)); });
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    expect(c.unheard()).toEqual([]);
    c.record(claudeQueue('remove', TEXT, { reason: 'dismissed' }));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(c.unheard()).toHaveLength(1);
  });

  it('keeps a human draft when held input expires at an idle prompt', async () => {
    const c = await liveTerminal('codex', 'lost');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.finish();
    expect(await c.running).toMatchObject({ wordsWaiting: true });
    c.draft('A later human draft.');
    c.keys.mockClear();
    const now = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => now() + UNHEARD_MS + 1);
    await until(() => c.unheard().length === 1);
    expect(c.input()).toBe('A later human draft.');
    expect(c.keys).not.toHaveBeenCalled();
    expect(c.log.mock.calls).toEqual([['Agent receipt (codex): live words were not delivered: the program did not take the words before the receipt wait ended.']]);
  });

  it('logs a failed held-input cleanup without replacing the program', async () => {
    const c = await liveTerminal('codex', 'lost');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.finish(); await c.running;
    c.keys.mockRejectedValue(new Error(TEXT));
    const now = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => now() + UNHEARD_MS + 1);
    await until(() => c.unheard().length === 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(c.log.mock.calls).toEqual([
      ['Agent receipt (codex): live words were not delivered: the program did not take the words before the receipt wait ended.'],
      ['Agent receipt (codex): could not erase held live input.'],
    ]);
    expect(c.launch).toHaveBeenCalledOnce();
  });

  it('keeps a new held copy when identical words from an older turn expire', async () => {
    const c = await liveTerminal('codex', 'lost');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.finish(); await c.running;
    c.draft('');
    c.record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'human' } });
    c.record(userMessage('A human question.', 'human'));
    await until(() => c.sent.some(m => m.type === 'turn.open'));
    const opened = c.sent.find(m => m.type === 'turn.open');
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'human-token', ref: opened?.ref });
    const now = Date.now.bind(Date);
    const paste = c.paste.getMockImplementation()!;
    c.paste.mockImplementationOnce(async (...args) => { await paste(...args); vi.spyOn(Date, 'now').mockImplementation(() => now() + UNHEARD_MS + 1); });
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(c.input()).toBe(TEXT);
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: TEXT }]);
    expect(c.log).toHaveBeenCalledOnce();
    c.record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'human', last_agent_message: 'Done.' } });
    await until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'human'));
  });

  it('returns held words on shutdown without trying to erase a closing terminal', async () => {
    const c = await liveTerminal('codex', 'lost');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.keys.mockClear().mockRejectedValue(new Error(TEXT));
    let release!: () => void;
    const closed = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(c.tmux.stopAll).mockImplementation(async () => { await closed; c.alive.mockResolvedValue(false); });
    const stopped = c.host.stop();
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(c.keys).not.toHaveBeenCalled();
      expect(c.log.mock.calls).toEqual([['Agent receipt (codex): live words were not delivered: the node is stopping.']]);
    } finally { release(); await stopped; await c.running; }
  });

  it('keeps a human edit made after a live paste when no receipt arrives', async () => {
    const c = await liveTerminal('claude', 'lost');
    c.keys.mockImplementationOnce(async () => { c.draft('A human replaced the pasted words.'); });
    expect(await c.host.say('receipt', TEXT)).toBe(false);
    expect(c.input()).toBe('A human replaced the pasted words.');
    expect(c.log.mock.calls).toEqual([['Agent receipt (claude): live words were not delivered: the program did not record a receipt after two submit keys.']]);
  });
});
