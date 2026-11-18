import { EventEmitter } from 'node:events';
import { UNHEARD_MS } from '@hornhoof/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnWords } from '../src/terminal/program-restart.js';
import { claudePasted, claudeQueue, userMessage } from './fakes/word-receipts.mjs';
import { atWork, cleanups, TEXT } from './terminal-host-receipts-helpers.js';

/* The owner of the plan at the terminal of an agent at work: what reaches the program's input, and their keys. */
async function atTerminal(c: Awaited<ReturnType<typeof atWork>>) {
  const stdin: string[] = [];
  const child = Object.assign(new EventEmitter(), { stdin: { write: (data: string) => stdin.push(data) }, stdout: new EventEmitter(), kill: () => {} });
  const tmux = c.host['opts'].tmux;
  vi.spyOn(tmux, 'attach').mockReturnValue(child as never);
  vi.spyOn(tmux, 'run').mockResolvedValue('');
  await c.on(c.host.open({ type: 'term.open', termId: 'view', agentKey: 'receipt', cols: 80, rows: 24, write: true }));
  const press = (data: string, pressedIn?: string) => c.host.input({ type: 'term.input', termId: 'view', data, ...(pressedIn ? { pressedIn } : {}) });
  return { stdin, press };
}

describe('words the owner typed in a running turn, which the program takes after it', () => {
  afterEach(async () => {
    vi.spyOn(Date, 'now').mockRestore();
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const QUESTION = 'and the limits';
  const taken = (c: Awaited<ReturnType<typeof atWork>>, text: string) => {
    c.record(claudeQueue('dequeue', text));
    c.record({ type: 'user', message: { role: 'user', content: text } });
    c.drain();
  };
  const opens = (c: Awaited<ReturnType<typeof atWork>>) => c.sent.filter(m => m.type === 'turn.open');

  it('hold the next turn and open their own turn, named by the turn they were typed in', async () => {
    const c = await atWork('claude', 'queued');
    const { press, stdin } = await atTerminal(c);
    press(`${QUESTION}\r`, 'job-receipt');
    expect(stdin).toEqual([`${QUESTION}\r`]);
    c.record(claudeQueue('enqueue', QUESTION));
    c.finish();
    await c.on(c.running);
    expect(c.sent.find(m => m.type === 'job.done')).toMatchObject({ wordsWaiting: true });
    taken(c, QUESTION);
    expect(opens(c)).toEqual([expect.objectContaining({ text: QUESTION, queuedFrom: 'job-receipt' })]);
    await c.until(() => (c.host['agents'].get('receipt')!.unopened.length === 1));
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'typed', toolToken: 'token', ref: (opens(c)[0] as { ref: string }).ref });
    expect(c.host["bridge"]["tokens"].get("receipt")).toBe("token");
    c.expire();
    expect(c.unheard()).toEqual([]);
    expect(c.sent).toContainEqual({ type: 'agent.words_settled', agentKey: 'receipt', jobId: 'job-receipt' });
  });

  it('open under the words typed when Claude records them as pasted content', async () => {
    const c = await atWork('claude', 'queued');
    const { press } = await atTerminal(c);
    press('line one\nline two\r', 'job-receipt');
    c.record(claudeQueue('enqueue', claudePasted('line one\nline two')));
    c.finish();
    await c.on(c.running);
    taken(c, claudePasted('line one\nline two'));
    expect(opens(c)).toEqual([expect.objectContaining({ text: 'line one\nline two', queuedFrom: 'job-receipt' })]);
  });

  it('stay in the turn when Claude absorbs them: what comes after has no one behind it', async () => {
    const c = await atWork('claude', 'queued');
    const { press } = await atTerminal(c);
    press(`${QUESTION}\r`, 'job-receipt');
    c.record(claudeQueue('enqueue', QUESTION));
    c.record(claudeQueue('remove', '', { reason: 'absorbed_mid_turn' }));
    c.finish();
    await c.on(c.running);
    expect(c.sent.find(m => m.type === 'job.done')).not.toMatchObject({ wordsWaiting: true });
    taken(c, 'the program asked for this itself');
    expect(opens(c)[0]).not.toHaveProperty('queuedFrom');
  });

  it.each([
    ['its news of background work', '<task-notification>\n<status>completed</status>\n</task-notification>', 0],
    ['words long after the Enter', QUESTION, UNHEARD_MS + 1],
  ])('do not cover %s', async (_, text, later) => {
    const c = await atWork('claude', 'queued');
    const { press } = await atTerminal(c);
    press('yes\r', 'job-receipt');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now + (later as number));
    c.record(claudeQueue('enqueue', text as string));
    c.drain();
    vi.restoreAllMocks();
    c.finish();
    await c.on(c.running);
    expect(c.sent.find(m => m.type === 'job.done')).not.toMatchObject({ wordsWaiting: true });
    taken(c, text as string);
    expect(opens(c)[0]).not.toHaveProperty('queuedFrom');
  });

  it('do not exist for words Claude queued with no Enter behind them', async () => {
    const c = await atWork('claude', 'queued');
    c.record(claudeQueue('enqueue', QUESTION));
    c.finish();
    await c.on(c.running);
    expect(c.sent.find(m => m.type === 'job.done')).not.toMatchObject({ wordsWaiting: true });
  });

  it('are the owner\'s again when they take them back from Claude\'s queue: nothing returns or waits', async () => {
    const c = await atWork('claude', 'queued');
    const { press } = await atTerminal(c);
    press(`${QUESTION}\r`, 'job-receipt');
    c.record(claudeQueue('enqueue', QUESTION));
    c.record(claudeQueue('remove', QUESTION));
    c.finish();
    await c.on(c.running);
    expect(c.sent.find(m => m.type === 'job.done')).not.toMatchObject({ wordsWaiting: true });
    c.expire();
    expect(c.unheard()).toEqual([]);
  });

  it('are never typed again by Hornhoof when the program did not take them in time', async () => {
    const c = await atWork('claude', 'queued');
    const { press } = await atTerminal(c);
    press(`${QUESTION}\r`, 'job-receipt');
    c.record(claudeQueue('enqueue', QUESTION));
    c.finish();
    await c.on(c.running);
    c.expire();
    expect(c.unheard()).toEqual([]);
    expect(c.sent).toContainEqual({ type: 'agent.words_settled', agentKey: 'receipt', jobId: 'job-receipt' });
  });

  it('open their own turn when the program was done with the old one by the time the keys came', async () => {
    const c = await atWork('claude', 'queued');
    const { press } = await atTerminal(c);
    c.finish();
    await c.on(c.running);
    press(`${QUESTION}\r`, 'job-receipt');
    const prompt = c.host['hook']('receipt', 'prompt', { prompt: QUESTION });
    await c.until(() => opens(c).length === 1);
    expect(opens(c)[0]).toMatchObject({ text: QUESTION, queuedFrom: 'job-receipt' });
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'typed', toolToken: 'token', ref: (opens(c)[0] as { ref: string }).ref });
    await c.on(prompt);
  });

  it('do not name the old turn for a prompt that comes long after the Enter', async () => {
    const c = await atWork('claude', 'queued');
    const { press } = await atTerminal(c);
    c.finish();
    await c.on(c.running);
    press('yes\r', 'job-receipt');
    const now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now + UNHEARD_MS + 1);
    const prompt = c.host['hook']('receipt', 'prompt', { prompt: 'the program asked for this itself' });
    await c.until(() => opens(c).length === 1);
    expect(opens(c)[0]).not.toHaveProperty('queuedFrom');
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: null, toolToken: null, ref: (opens(c)[0] as { ref: string }).ref });
    await c.on(prompt);
  });

  it.each(['codex', 'kimi'] as const)('name the old turn for a %s prompt right after that turn, which keeps no queue in its log', async kind => {
    const c = await atWork(kind, 'queued');
    const { press } = await atTerminal(c);
    press(`${QUESTION}\r`, 'job-receipt');
    c.finish();
    await c.on(c.running);
    const prompt = c.host['hook']('receipt', 'prompt', { prompt: QUESTION });
    await c.until(() => opens(c).length === 1);
    expect(opens(c)[0]).toMatchObject({ text: QUESTION, queuedFrom: 'job-receipt' });
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'typed', toolToken: 'token', ref: (opens(c)[0] as { ref: string }).ref });
    await c.on(prompt);
  });

  it.each(['codex', 'kimi'] as const)('do not name the old turn for a %s prompt long after that turn ended', async kind => {
    const c = await atWork(kind, 'queued');
    const { press } = await atTerminal(c);
    press(`${QUESTION}\r`, 'job-receipt');
    c.finish();
    await c.on(c.running);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now + UNHEARD_MS + 1);
    const prompt = c.host['hook']('receipt', 'prompt', { prompt: 'the program asked for this itself' });
    await c.until(() => opens(c).length === 1);
    expect(opens(c)[0]).not.toHaveProperty('queuedFrom');
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: null, toolToken: null, ref: (opens(c)[0] as { ref: string }).ref });
    await c.on(prompt);
  });

  it('name no turn once a new turn began', async () => {
    const c = await atWork('codex', 'queued');
    const { press } = await atTerminal(c);
    press(`${QUESTION}\r`, 'job-receipt');
    expect(c.host['agents'].get('receipt')!.pressed).toMatchObject({ jobId: 'job-receipt', until: null });
    c.host['beginTurn'](c.host['agents'].get('receipt')!);
    expect(c.host['agents'].get('receipt')!.pressed).toBeNull();
  });

  it('name no turn once the program took them into the turn that runs', async () => {
    const c = await atWork('codex', 'queued');
    const { press } = await atTerminal(c);
    press(`${QUESTION}\r`, 'job-receipt');
    c.record(userMessage(QUESTION));
    c.drain();
    expect(c.host['agents'].get('receipt')!.pressed).toBeNull();
    press(`${QUESTION}\r`, 'job-receipt');
    await c.on(c.host['hook']('receipt', 'prompt', { prompt: QUESTION }));
    expect(c.host['agents'].get('receipt')!.pressed).toBeNull();
  });

  it('hold the next turn when Kimi says it queued them', async () => {
    const c = await atWork('kimi', 'queued');
    const { press } = await atTerminal(c);
    press(`${QUESTION}\r`, 'job-receipt');
    await c.on(c.host['hook']('receipt', 'queued', { prompt: [{ type: 'text', text: QUESTION }] }));
    c.finish();
    await c.on(c.running);
    expect(c.sent.find(m => m.type === 'job.done')).toMatchObject({ wordsWaiting: true });
  });

  it('open their own turn when Claude queued them after its turn was over and nothing else runs', async () => {
    const c = await atWork('claude', 'queued');
    const { press } = await atTerminal(c);
    c.finish();
    await c.on(c.running);
    await c.until(() => c.host['agents'].get('receipt')!.turn === null);
    press(`${QUESTION}\r`, 'job-receipt');
    c.record(claudeQueue('enqueue', QUESTION));
    c.drain();
    taken(c, QUESTION);
    expect(opens(c)).toEqual([expect.objectContaining({ text: QUESTION, queuedFrom: 'job-receipt' })]);
  });
});

describe('a letter delivered in the last seconds of a turn, which Claude takes after it', () => {
  afterEach(async () => {
    vi.spyOn(Date, 'now').mockRestore();
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opens its turn when the prompt hook comes between the Stop and the log lines', async () => {
    const c = await atWork('claude', 'pasted');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    await c.on(c.host['hook']('receipt', 'stop', { last_assistant_message: 'Done.' }));
    const prompt = c.host['hook']('receipt', 'prompt', { prompt: claudePasted(TEXT) });
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    expect(c.sent.find(m => m.type === 'turn.open')).toMatchObject({ text: TEXT, queuedFrom: 'job-receipt' });
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'second', toolToken: 'token' });
    await c.on(prompt);
    expect(c.host["bridge"]["tokens"].get("receipt")).toBe("token");
  });

  it('opens its turn though the Stop was refused and the log takes the letter before the end of the turn', async () => {
    const c = await atWork('claude', 'pasted');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.record(claudeQueue('dequeue', claudePasted(TEXT)));
    c.record({ type: 'user', message: { role: 'user', content: claudePasted(TEXT) } });
    c.drain();
    expect(c.sent.some(m => m.type === 'turn.open')).toBe(false);
    c.finish();
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    expect(c.sent.find(m => m.type === 'turn.open')).toMatchObject({ text: TEXT, queuedFrom: 'job-receipt' });
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'second', toolToken: 'token' });
    expect(await c.on(c.running)).toMatchObject({ ok: true });
    expect(c.host['agents'].get('receipt')!.turn?.jobId).toBe('second');
    c.finish();
    await c.until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'second'));
  });

  it('counts words into the turn when they never showed in the queue, and leaves words it does not know alone', async () => {
    const c = await atWork('claude', 'queued');
    const words = new TurnWords();
    words.add('words without a receipt', 'job-receipt');
    c.host['agents'].get('receipt')!.waitingWords.push(words);
    for (const text of ['words nobody typed', 'words without a receipt']) {
      c.record(claudeQueue('dequeue', text));
      c.record({ type: 'user', message: { role: 'user', content: text } });
    }
    c.finish();
    await c.on(c.running);
    expect(words.pending()).toEqual([]);
    expect(c.sent.some(m => m.type === 'turn.open')).toBe(false);
  });

  it('stays in the turn when Claude goes on after taking it', async () => {
    const c = await atWork('claude', 'pasted');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.record(claudeQueue('dequeue', claudePasted(TEXT)));
    c.record({ type: 'user', message: { role: 'user', content: claudePasted(TEXT) } });
    c.record({ type: 'assistant', message: { content: [{ type: 'text', text: 'Taken.' }] } });
    c.finish();
    expect(await c.on(c.running)).toMatchObject({ ok: true, result: 'Taken.' });
    expect(c.sent.some(m => m.type === 'turn.open')).toBe(false);
  });

  it('stays in the turn when a person stops it right after Claude took it', async () => {
    const c = await atWork('claude', 'pasted');
    expect(await c.on(c.host.say('receipt', TEXT))).toBe(true);
    c.record(claudeQueue('dequeue', claudePasted(TEXT)));
    c.record({ type: 'user', message: { role: 'user', content: claudePasted(TEXT) } });
    c.drain();
    await c.on(c.host['hook']('receipt', 'stop', { stopped: true }));
    await c.on(c.running);
    expect(c.sent.some(m => m.type === 'turn.open')).toBe(false);
  });

  it('keeps words of the program\'s own prompt in its running turn', async () => {
    const c = await atWork('claude', 'queued');
    c.record(claudeQueue('dequeue', 'HANG'));
    c.record({ type: 'user', message: { role: 'user', content: 'HANG' } });
    c.drain();
    expect(c.sent.some(m => m.type === 'turn.open')).toBe(false);
  });
});

describe('keys of the owner while their view of the session opens', () => {
  afterEach(async () => {
    vi.spyOn(Date, 'now').mockRestore();
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const slowView = async () => {
    const c = await atWork('claude', 'queued');
    const stdin: string[] = [];
    const child = Object.assign(new EventEmitter(), { stdin: { write: (data: string) => stdin.push(data) }, stdout: new EventEmitter(), kill: () => {} });
    const tmux = c.host['opts'].tmux;
    vi.spyOn(tmux, 'attach').mockReturnValue(child as never);
    vi.spyOn(tmux, 'run').mockResolvedValue('');
    let opened!: () => void;
    const held = new Promise<void>(done => (opened = done));
    vi.spyOn(c.host as unknown as { ensureSession(): Promise<void> }, 'ensureSession').mockImplementation(() => held);
    return { c, stdin, opened, child };
  };

  it('reach the program in order once the view is open', async () => {
    const { c, stdin, opened } = await slowView();
    const open = c.host.open({ type: 'term.open', termId: 'view', agentKey: 'receipt', cols: 80, rows: 24, write: true });
    await c.until(() => c.host['viewSessions']['viewsOpening'].has('view'));
    c.host.input({ type: 'term.input', termId: 'view', data: 'first question' });
    c.host.input({ type: 'term.input', termId: 'view', data: '\r', pressedIn: 'job-receipt' });
    expect(stdin).toEqual([]);
    opened();
    await c.on(open);
    await c.until(() => stdin.length === 2);
    expect(stdin).toEqual(['first question', '\r']);
    expect(c.host['agents'].get('receipt')!.pressed).toMatchObject({ jobId: 'job-receipt' });
    c.host.input({ type: 'term.input', termId: 'view', data: 'next' });
    await c.until(() => stdin.length === 3);
    expect(stdin.at(-1)).toBe('next');
  });

  it('keep their order when more come during the last steps of opening', async () => {
    const { c, stdin, opened } = await slowView();
    let fitted!: () => void;
    const fitting = new Promise<void>(done => (fitted = done));
    const fit = vi.spyOn(c.host['viewSessions'] as unknown as { fit(key: string): Promise<void> }, 'fit').mockImplementation(() => (c.host['viewSessions']['views'].has('view') ? fitting : Promise.resolve()));
    const open = c.host.open({ type: 'term.open', termId: 'view', agentKey: 'receipt', cols: 80, rows: 24, write: true });
    await c.until(() => c.host['viewSessions']['viewsOpening'].has('view'));
    c.host.input({ type: 'term.input', termId: 'view', data: 'first ' });
    opened();
    await c.until(() => c.host['viewSessions']['views'].has('view'));
    c.host.input({ type: 'term.input', termId: 'view', data: 'second' });
    expect(stdin).toEqual([]);
    fitted();
    await c.on(open);
    await c.until(() => stdin.length === 2);
    expect(stdin).toEqual(['first ', 'second']);
    fit.mockRestore();
  });

  it('go nowhere from someone who only watches', async () => {
    const { c, stdin, opened } = await slowView();
    const open = c.host.open({ type: 'term.open', termId: 'view', agentKey: 'receipt', cols: 80, rows: 24, write: false });
    await c.until(() => c.host['viewSessions']['viewsOpening'].has('view'));
    c.host.input({ type: 'term.input', termId: 'view', data: 'not for the program\r', pressedIn: 'job-receipt' });
    opened();
    await c.on(open);
    expect(stdin).toEqual([]);
    expect(c.host['agents'].get('receipt')!.pressed ?? null).toBeNull();
  });

  it('go nowhere once the view closed while it opened, and a view that failed to open keeps none', async () => {
    const { c, stdin, opened } = await slowView();
    const open = c.host.open({ type: 'term.open', termId: 'view', agentKey: 'receipt', cols: 80, rows: 24, write: true });
    await c.until(() => c.host['viewSessions']['viewsOpening'].has('view'));
    c.host.input({ type: 'term.input', termId: 'view', data: 'gone\r' });
    c.host.close({ type: 'term.close', termId: 'view' });
    opened();
    await c.on(open);
    expect(stdin).toEqual([]);
    expect(c.host['viewSessions']['earlyKeys'].size).toBe(0);
  });

  it('are bounded while the view opens', async () => {
    const { c, stdin, opened } = await slowView();
    const open = c.host.open({ type: 'term.open', termId: 'view', agentKey: 'receipt', cols: 80, rows: 24, write: true });
    await c.until(() => c.host['viewSessions']['viewsOpening'].has('view'));
    for (let i = 0; i < 600; i++) c.host.input({ type: 'term.input', termId: 'view', data: 'k' });
    opened();
    await c.on(open);
    await c.until(() => stdin.length === 256);
    expect(stdin).toHaveLength(256);
  });
});
