import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NodeMessage } from '@hornhoof/protocol';
import type { OperatorNodeMessage } from '@hornhoof/protocol/program-operator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIGNED_OUT } from '../src/providers/antigravity.js';
import { inputOf } from '../src/terminal/input.js';
import { agyProgram } from '../src/terminal/programs.js';
import { codexJob, hasTmux, home, host, job, kimiJob, SECRET, sent, setUp, tmux, until } from './terminal-host-helpers.js';

const FAKE_AGY = fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url));
const agyJob = (key: string, prompt: string, more: Parameters<typeof job>[2] = {}) => ({ ...job(key, prompt, more), program: agyProgram, bin: FAKE_AGY, home: join(home, 'agy', key), signedOut: SIGNED_OUT });
const PROGRAMS = { claude: job, codex: codexJob, kimi: kimiJob, antigravity: agyJob };
const KINDS = Object.keys(PROGRAMS) as (keyof typeof PROGRAMS)[];
type Kind = (typeof KINDS)[number];
type Left = Extract<NodeMessage, { type: 'agent.input_left' }>;

const WORDS = 'Words a person left';
const lefts = () => sent.filter((m): m is Left => m.type === 'agent.input_left');

async function atWork(kind: Kind, more: Parameters<typeof setUp>[0] = {}, operator: { lookMs?: number } = {}) {
  const frames: OperatorNodeMessage[] = [];
  let clock = 1000;
  const dir = mkdtempSync(join(tmpdir(), 'hh-left-input-'));
  await setUp({ plugins: [], cols: 120, rows: 40, readyMs: 5000, lookMs: 100, toolsMs: 5000, enterWaitMs: 300, typingQuietMs: 50, keptWaitMs: 1000, ...more,
    operator: { dir, send: frame => { frames.push(frame); return true; }, connected: () => true, now: () => clock, ...operator } });
  const key = randomUUID();
  let ordinal = 0;
  let sessionId: string | null = null;
  const run = (prompt: string, signal?: AbortSignal) => {
    const jobId = randomUUID(), deliveryId = randomUUID();
    const running = host.run({ ...PROGRAMS[kind](key, prompt, { jobId, sessionId, timeoutMs: 20_000, signal }), operatorDelivery: { id: deliveryId, ordinal: ++ordinal } }).then(result => { sessionId = result.sessionId; return result; });
    return { jobId, deliveryId, running };
  };
  const line = async () => inputOf(kind, await tmux.screen(host['agents'].get(key)!.name, 0, true));
  const open = () => host.open({ type: 'term.open', termId: `view-${key}`, agentKey: key, cols: 120, rows: 40, write: true });
  const type = async (data: string) => {
    host.input({ type: 'term.input', termId: `view-${key}`, data });
    await until(async () => (await line()) === data);
    await new Promise(done => setTimeout(done, 80));
  };
  return { key, dir, run, line, open, type, frames, tick: (ms: number) => { clock += ms; host.operatorTick(); } };
}

describe.skipIf(!hasTmux)('words left unsent in the input of a program, when a new assignment comes', () => {
  afterEach(async () => { vi.restoreAllMocks(); await host?.stop(); });

  it.each(KINDS)('%s: keeps a person\'s words first, clears them without Escape, and types the assignment alone', async kind => {
    const c = await atWork(kind);
    expect(await c.run('First assignment.').running).toMatchObject({ ok: true });
    await c.open();
    await c.type(WORDS);
    const keys = vi.spyOn(tmux, 'keys');
    const paste = vi.spyOn(tmux, 'paste');
    const second = c.run('Second assignment.');
    await until(() => lefts().length > 0);
    expect(lefts()[0]).toMatchObject({ agentKey: c.key, jobId: second.jobId, text: WORDS, typed: true });
    await new Promise(done => setTimeout(done, 150));
    expect(await c.line()).toBe(WORDS);
    expect(paste).not.toHaveBeenCalled();
    host.inputKept({ type: 'agent.input_kept', agentKey: c.key, ref: lefts()[0]!.ref });
    expect(await second.running).toMatchObject({ ok: true });
    expect(paste.mock.calls.map(call => call[1])).toEqual(['Second assignment.']);
    expect(keys.mock.calls.flat()).not.toContain('Escape');
    expect(lefts()).toHaveLength(1);
    await until(async () => (await c.line()) === '');
  });

  it.each(KINDS)('%s: leaves the words where they are while Hornhoof has not said it keeps them', async kind => {
    const c = await atWork(kind);
    expect(await c.run('First assignment.').running).toMatchObject({ ok: true });
    await c.open();
    await c.type(WORDS);
    const paste = vi.spyOn(tmux, 'paste');
    const second = c.run('Second assignment.');
    await until(() => lefts().length > 0);
    await new Promise(done => setTimeout(done, 1400));
    expect(await c.line()).toBe(WORDS);
    expect(paste).not.toHaveBeenCalled();
    await until(() => lefts().length > 1);
    expect(lefts()[1]!.ref).toBe(lefts()[0]!.ref);
    host.inputKept({ type: 'agent.input_kept', agentKey: c.key, ref: lefts()[0]!.ref });
    expect(await second.running).toMatchObject({ ok: true });
    expect(paste.mock.calls.map(call => call[1])).toEqual(['Second assignment.']);
  });

  /* The prompt of a turn the program never took: its Enter is lost, the case about it is revoked, and the turn fails. */
  const notTaken = async (c: Awaited<ReturnType<typeof atWork>>, prompt: string) => {
    const press = tmux.keys.bind(tmux);
    const keys = vi.spyOn(tmux, 'keys').mockImplementation(async (name, ...pressed) => { if (!pressed.includes('Enter')) await press(name, ...pressed); });
    const first = c.run(prompt);
    await until(async () => (await c.line()) === prompt);
    c.tick(60_000);
    const needed = await untilNeeded(c);
    await host.operatorMessage({ type: 'program.operator_case', agentKey: c.key, jobId: first.jobId, instance: needed.instance, case: randomUUID(), capability: 'a-capability-of-the-case-0123456789', disposition: 'revoke', remainingMs: 0, revision: 1, reason: 'assignment_unrecorded', closedBecause: 'operator_unavailable' });
    expect(await first.running).toMatchObject({ ok: false, error: 'agent_failed' });
    keys.mockRestore();
    expect(await c.line()).toBe(prompt);
  };

  const untilNeeded = async (c: Awaited<ReturnType<typeof atWork>>) => {
    await until(() => c.frames.some(frame => frame.type === 'program.operator_needed'));
    return c.frames.find((frame): frame is Extract<OperatorNodeMessage, { type: 'program.operator_needed' }> => frame.type === 'program.operator_needed')!;
  };

  it.each(KINDS)('%s: takes out a prompt Hornhoof repeats itself, tells nobody of it, and the next assignment goes in', async kind => {
    const c = await atWork(kind);
    expect(await c.run('First assignment.').running).toMatchObject({ ok: true });
    await notTaken(c, "Head of development's turn failed.");
    const keys = vi.spyOn(tmux, 'keys');
    const paste = vi.spyOn(tmux, 'paste');
    expect(await c.run('Next assignment.').running).toMatchObject({ ok: true });
    expect(paste.mock.calls.map(call => call[1])).toEqual(['Next assignment.']);
    expect(keys.mock.calls.flat()).not.toContain('Escape');
    expect(lefts()).toEqual([]);
    expect(await c.line()).toBe('');
  });

  it('keeps words a person added to such a prompt, as Hornhoof repeats only its own', async () => {
    const c = await atWork('claude');
    expect(await c.run('First assignment.').running).toMatchObject({ ok: true });
    await notTaken(c, 'A prompt nobody took.');
    await c.open();
    host.input({ type: 'term.input', termId: `view-${c.key}`, data: ' And a word.' });
    await until(async () => (await c.line()) === 'A prompt nobody took. And a word.');
    await new Promise(done => setTimeout(done, 80));
    const next = c.run('Next assignment.');
    await until(() => lefts().length > 0);
    expect(lefts()[0]).toMatchObject({ text: 'A prompt nobody took. And a word.', typed: true });
    host.inputKept({ type: 'agent.input_kept', agentKey: c.key, ref: lefts()[0]!.ref });
    expect(await next.running).toMatchObject({ ok: true });
  });

  it('keeps a prompt of a turn that ended some other way, with nobody named, as Hornhoof does not repeat those', async () => {
    const c = await atWork('claude');
    expect(await c.run('First assignment.').running).toMatchObject({ ok: true });
    const press = tmux.keys.bind(tmux);
    const keys = vi.spyOn(tmux, 'keys').mockImplementation(async (name, ...pressed) => { if (!pressed.includes('Enter')) await press(name, ...pressed); });
    const stop = new AbortController();
    const first = c.run('A prompt of a stopped turn.', stop.signal);
    await until(async () => (await c.line()) === 'A prompt of a stopped turn.');
    stop.abort();
    expect(await first.running).toMatchObject({ ok: false, error: 'cancelled' });
    keys.mockRestore();
    const next = c.run('Next assignment.');
    await until(() => lefts().length > 0);
    expect(lefts()[0]).toMatchObject({ text: 'A prompt of a stopped turn.', typed: false });
    host.inputKept({ type: 'agent.input_kept', agentKey: c.key, ref: lefts()[0]!.ref });
    expect(await next.running).toMatchObject({ ok: true });
  });

  it('waits while a person still writes, and keeps what they wrote by then', async () => {
    const c = await atWork('claude', { typingQuietMs: 1200 });
    expect(await c.run('First assignment.').running).toMatchObject({ ok: true });
    await c.open();
    await c.type(WORDS);
    const next = c.run('Next assignment.');
    await new Promise(done => setTimeout(done, 400));
    expect(lefts()).toEqual([]);
    host.input({ type: 'term.input', termId: `view-${c.key}`, data: ' and more' });
    await until(async () => (await c.line()) === `${WORDS} and more`);
    await new Promise(done => setTimeout(done, 400));
    expect(lefts()).toEqual([]);
    await until(() => lefts().length > 0);
    expect(lefts()[0]).toMatchObject({ text: `${WORDS} and more` });
    host.inputKept({ type: 'agent.input_kept', agentKey: c.key, ref: lefts()[0]!.ref });
    expect(await next.running).toMatchObject({ ok: true });
  });

  it('types nothing into a paste the program folded: its words are not on the screen to keep', async () => {
    const c = await atWork('claude');
    expect(await c.run('First assignment.').running).toMatchObject({ ok: true });
    await c.open();
    await c.type('[Pasted text #1 +40 lines]');
    const paste = vi.spyOn(tmux, 'paste');
    const stop = new AbortController();
    const next = c.run('Next assignment.', stop.signal);
    await new Promise(done => setTimeout(done, 600));
    expect(lefts()).toEqual([]);
    expect(paste).not.toHaveBeenCalled();
    expect(await c.line()).toBe('[Pasted text #1 +40 lines]');
    stop.abort();
    expect(await next.running).toMatchObject({ ok: false, error: 'cancelled' });
  });

  it('never lets a known secret into what it keeps', async () => {
    const c = await atWork('claude');
    expect(await c.run('First assignment.').running).toMatchObject({ ok: true });
    await c.open();
    await c.type(`token ${SECRET} here`);
    const next = c.run('Next assignment.');
    await until(() => lefts().length > 0);
    expect(lefts()[0]!.text).not.toContain(SECRET);
    expect(lefts()[0]!.text).toContain('here');
    host.inputKept({ type: 'agent.input_kept', agentKey: c.key, ref: lefts()[0]!.ref });
    expect(await next.running).toMatchObject({ ok: true });
  });

  it('presses more keys when the cursor stood inside the words, and types nothing if the input stays full', async () => {
    const c = await atWork('claude');
    expect(await c.run('First assignment.').running).toMatchObject({ ok: true });
    await c.open();
    await c.type(WORDS);
    const keys = vi.spyOn(tmux, 'keys').mockResolvedValue();
    const paste = vi.spyOn(tmux, 'paste');
    const stop = new AbortController();
    const next = c.run('Next assignment.', stop.signal);
    await until(() => lefts().length > 0);
    host.inputKept({ type: 'agent.input_kept', agentKey: c.key, ref: lefts()[0]!.ref });
    await until(() => keys.mock.calls.flat().includes('C-k'));
    await new Promise(done => setTimeout(done, 400));
    expect(paste).not.toHaveBeenCalled();
    expect(keys.mock.calls.flat()).not.toContain('Escape');
    stop.abort();
    expect(await next.running).toMatchObject({ ok: false, error: 'cancelled' });
  });
});

type Needed = Extract<OperatorNodeMessage, { type: 'program.operator_needed' }>;
const CASE = { case: randomUUID(), capability: 'a-capability-of-the-case-0123456789', disposition: 'revoke', remainingMs: 0, revision: 1, reason: 'assignment_unrecorded', closedBecause: 'operator_unavailable' } as const;

describe.skipIf(!hasTmux)('a turn whose words did not get recorded within 60 s', () => {
  afterEach(async () => { vi.restoreAllMocks(); await host?.stop(); });

  const needed = (c: Awaited<ReturnType<typeof atWork>>) => c.frames.filter((frame): frame is Needed => frame.type === 'program.operator_needed');
  const swallowEnter = () => {
    const press = tmux.keys.bind(tmux);
    return vi.spyOn(tmux, 'keys').mockImplementation(async (name, ...pressed) => { if (!pressed.includes('Enter')) await press(name, ...pressed); });
  };

  it.each(KINDS)('%s: looks at the screen and the input line first, then tells of it, with both, and only then may the turn end', async kind => {
    const c = await atWork(kind);
    expect(await c.run('First assignment.').running).toMatchObject({ ok: true });
    const prompt = 'A prompt nobody took.';
    swallowEnter();
    const first = c.run(prompt);
    let ended = false;
    void first.running.then(() => { ended = true; });
    await until(async () => (await c.line()) === prompt);
    const run = tmux.run.bind(tmux);
    const order: string[] = [];
    vi.spyOn(tmux, 'run').mockImplementation(async (args, input) => {
      if (args[0] === 'display-message') order.push(`look ${needed(c).length}`);
      return run(args, input);
    });
    c.tick(60_000);
    await until(() => needed(c).length > 0);
    expect(order[0]).toBe('look 0');
    c.tick(1);
    c.tick(1);
    await new Promise(done => setTimeout(done, 200));
    expect(needed(c)).toHaveLength(1);
    expect(needed(c)[0]).toMatchObject({ reason: 'assignment_unrecorded', jobId: first.jobId, deliveryId: first.deliveryId,
      check: { input: 'text', screen: { protected: false, cols: 120, rows: 40, cells: expect.stringContaining(prompt) } } });
    expect(ended).toBe(false);
    await host.operatorMessage({ type: 'program.operator_case', agentKey: c.key, jobId: first.jobId, instance: needed(c)[0]!.instance, ...CASE });
    expect(await first.running).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(needed(c)).toHaveLength(1);
  });

  it.each(KINDS)('%s: says the input line was empty when it was', async kind => {
    const c = await atWork(kind);
    expect(await c.run('First assignment.').running).toMatchObject({ ok: true });
    vi.spyOn(tmux, 'paste').mockResolvedValue();
    const stop = new AbortController();
    const first = c.run('A prompt that never showed.', stop.signal);
    await until(() => c.frames.some(frame => frame.type === 'program.delivery' && frame.deliveryId === first.deliveryId && frame.phase === 'attempt'));
    await new Promise(done => setTimeout(done, 300));
    c.tick(60_000);
    await until(() => needed(c).length > 0);
    expect(needed(c)[0]!.check).toMatchObject({ input: 'empty', screen: { protected: false } });
    stop.abort();
    await first.running;
  });

  it('keeps neither the screen nor the words on disk, and tells again without the screen', async () => {
    const c = await atWork('claude');
    expect(await c.run('First assignment.').running).toMatchObject({ ok: true });
    swallowEnter();
    const stop = new AbortController();
    const first = c.run('Words that stay off the disk.', stop.signal);
    await until(async () => (await c.line()) === 'Words that stay off the disk.');
    c.tick(60_000);
    await until(() => needed(c).length > 0);
    const stored = readFileSync(join(c.dir, 'evidence.json'), 'utf8');
    expect(stored).not.toContain('Words that stay off the disk.');
    expect(JSON.parse(stored).outbox.find((fact: Needed) => fact.type === 'program.operator_needed').check).toEqual({ input: 'text', screen: null });
    const before = c.frames.length;
    host.operatorReplay();
    const again = c.frames.slice(before).filter((frame): frame is Needed => frame.type === 'program.operator_needed');
    expect(again).toEqual([expect.objectContaining({ evidenceId: needed(c)[0]!.evidenceId, check: { input: 'text', screen: null } })]);
    stop.abort();
    await first.running;
  });

  it('tells of it all the same when it cannot look, with the line unknown', async () => {
    const c = await atWork('claude');
    expect(await c.run('First assignment.').running).toMatchObject({ ok: true });
    swallowEnter();
    const stop = new AbortController();
    const first = c.run('A prompt nobody took.', stop.signal);
    await until(async () => (await c.line()) === 'A prompt nobody took.');
    vi.spyOn(tmux, 'run').mockRejectedValue(new Error('tmux is gone'));
    c.tick(60_000);
    await until(() => needed(c).length > 0);
    expect(needed(c)[0]!.check).toEqual({ input: 'unknown', screen: null });
    vi.restoreAllMocks();
    stop.abort();
    await first.running;
  });

  it('does not wait for a look that never ends', async () => {
    const c = await atWork('claude', {}, { lookMs: 100 });
    expect(await c.run('First assignment.').running).toMatchObject({ ok: true });
    swallowEnter();
    const stop = new AbortController();
    const first = c.run('A prompt nobody took.', stop.signal);
    await until(async () => (await c.line()) === 'A prompt nobody took.');
    vi.spyOn(tmux, 'run').mockImplementation(() => new Promise(() => {}));
    c.tick(60_000);
    await until(() => needed(c).length > 0);
    expect(needed(c)[0]!.check).toEqual({ input: 'unknown', screen: null });
    vi.restoreAllMocks();
    stop.abort();
    await first.running;
  });

  it('tells of nothing when the words got recorded while it looked', async () => {
    const c = await atWork('claude');
    expect(await c.run('First assignment.').running).toMatchObject({ ok: true });
    swallowEnter();
    const first = c.run('A prompt nobody took.');
    await until(async () => (await c.line()) === 'A prompt nobody took.');
    const run = tmux.run.bind(tmux);
    let release = () => {};
    const held = new Promise<void>(done => { release = done; });
    vi.spyOn(tmux, 'run').mockImplementation(async (args, input) => {
      if (args[0] === 'display-message') await held;
      return run(args, input);
    });
    c.tick(60_000);
    await new Promise(done => setTimeout(done, 50));
    host['operator']!.receipt(c.key, { id: first.deliveryId, ordinal: 2 }, 'queued');
    release();
    await new Promise(done => setTimeout(done, 100));
    expect(needed(c)).toEqual([]);
    vi.restoreAllMocks();
    await tmux.keys(host['agents'].get(c.key)!.name, 'Enter');
    expect(await first.running).toMatchObject({ ok: true });
  });
});

describe.skipIf(!hasTmux)('words left unsent, on a node with no operator', () => {
  afterEach(async () => { vi.restoreAllMocks(); await host?.stop(); });

  const started = async (kind: Kind, more: Parameters<typeof setUp>[0] = {}) => {
    await setUp({ plugins: [], cols: 120, rows: 40, readyMs: 3000, toolsMs: 5000, typingQuietMs: 50, keptWaitMs: 300, enterWaitMs: 300, ...more });
    const key = randomUUID();
    const first = await host.run(PROGRAMS[kind](key, 'First assignment.', { jobId: randomUUID() }));
    expect(first).toMatchObject({ ok: true });
    await host.open({ type: 'term.open', termId: `view-${key}`, agentKey: key, cols: 120, rows: 40, write: true });
    host.input({ type: 'term.input', termId: `view-${key}`, data: WORDS });
    await until(async () => (await host.screen(key)).includes(WORDS));
    await new Promise(done => setTimeout(done, 80));
    return { key, sessionId: first.sessionId };
  };

  it.each(KINDS)('%s: waits while a person still writes instead of ending the turn, then keeps what they wrote', async kind => {
    const { key, sessionId } = await started(kind, { typingQuietMs: 1000 });
    const paste = vi.spyOn(tmux, 'paste');
    let ended = false;
    const next = host.run(PROGRAMS[kind](key, 'Next assignment.', { jobId: randomUUID(), sessionId })).finally(() => { ended = true; });
    await new Promise(done => setTimeout(done, 300));
    expect(ended).toBe(false);
    expect(lefts()).toEqual([]);
    await until(() => lefts().length > 0, 3000);
    expect(lefts()[0]).toMatchObject({ text: WORDS, typed: true });
    host.inputKept({ type: 'agent.input_kept', agentKey: key, ref: lefts()[0]!.ref });
    expect(await next).toMatchObject({ ok: true });
    expect(paste.mock.calls.map(call => call[1])).toEqual(['Next assignment.']);
  });

  /* What the node hears of a person's words, held from their Enter until the assignment starts to go in, as a busy machine
     can hold it: the program's log, or its prompt hook. */
  type Late = 'log' | 'hook';

  const heardLate = (late?: Late) => {
    let held = false;
    let release = () => {};
    const released = new Promise<void>(done => { release = () => { held = false; done(); }; });
    if (late === 'log') {
      const readLog = host['readLog'].bind(host);
      vi.spyOn(host as unknown as { readLog: typeof readLog }, 'readLog').mockImplementation(a => { if (!held) readLog(a); });
    }
    if (late === 'hook') {
      const hook = host['hook'].bind(host);
      vi.spyOn(host as unknown as { hook: typeof hook }, 'hook').mockImplementation(async (at, event, data) => {
        if (held && event === 'prompt' && JSON.stringify(data).includes(WORDS)) await released;
        return hook(at, event, data);
      });
    }
    return { hold: () => { held = true; }, release };
  };

  const sendsWhileWaiting = async (kind: Kind, late?: Late) => {
    const { key, sessionId } = await started(kind, { typingQuietMs: 60_000, readyMs: 8000, enterWaitMs: 1000 });
    const heard = heardLate(late);
    const pasteWords = tmux.paste.bind(tmux);
    const paste = vi.spyOn(tmux, 'paste');
    const jobId = randomUUID();
    /* A tool call as the program makes it, through the node's bridge, with what the turn has at that moment. */
    const tool = () => fetch(host['bridge'].agent(key).mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'company', arguments: {} } }) }).then(r => r.text());
    let toolAtPaste = '';
    paste.mockImplementation(async (target, text) => {
      heard.release();
      toolAtPaste = await tool();
      return pasteWords(target, text);
    });
    let pastedAtEnd = -1;
    const next = host.run(PROGRAMS[kind](key, 'Next assignment.', { jobId, sessionId })).finally(() => { pastedAtEnd = paste.mock.calls.length; });
    await until(() => host['agents'].get(key)?.turn?.jobId === jobId);
    await new Promise(done => setTimeout(done, 300));
    heard.hold();
    host.input({ type: 'term.input', termId: `view-${key}`, data: '\r', pressedIn: jobId });
    const result = await next;
    /* A turn that failed says why. */
    expect(result.ok ? 'ok' : `${result.error}: ${result.failure?.text ?? ''}`).toBe('ok');
    /* The turn ends with the assignment's answer, not with that of what the person sent. Antigravity's fake answers alike. */
    if (kind !== 'antigravity') expect(result.result).toContain('Next assignment.');
    expect(pastedAtEnd).toBe(1);
    expect(paste.mock.calls.map(call => call[1])).toEqual(['Next assignment.']);
    /* The assignment went in with its turn's tools. Without a turn the same call is refused. */
    expect(toolAtPaste).toContain('"result"');
    expect(toolAtPaste).not.toContain('No Hornhoof turn');
    expect(await tool()).toContain('No Hornhoof turn');
    expect(lefts()).toEqual([]);
    expect(sent.filter(m => m.type === 'turn.open')).toEqual([]);
    const screen = await host.screen(key);
    expect(screen).not.toContain('cut short');
    /* The person's words went in once, and the program answered them once. */
    if (late) expect(screen.split(`echo: ${WORDS}`)).toHaveLength(2);
  };

  it.each(KINDS)('%s: what a person sends while the assignment waits is theirs, and the assignment goes in after it, in the same turn', kind => sendsWhileWaiting(kind));

  /* Kimi Code tells of a prompt twice: by its hook, and then in its log. */
  it('kimi: what a person sends while the assignment waits stays theirs when the log tells of it once the assignment started to go in', () => sendsWhileWaiting('kimi', 'log'));

  it.each(['claude', 'kimi'] as const)('%s: what a person sends while the assignment waits stays theirs when the program tells of it once the assignment started to go in', kind => sendsWhileWaiting(kind, 'hook'));

  it('says a stopped turn was stopped when it stops while waiting for a person to finish', async () => {
    const { key, sessionId } = await started('codex', { typingQuietMs: 60_000, readyMs: 60_000 });
    const stop = new AbortController();
    const paste = vi.spyOn(tmux, 'paste');
    const next = host.run(PROGRAMS.codex(key, 'Next assignment.', { jobId: randomUUID(), sessionId, signal: stop.signal }));
    await new Promise(done => setTimeout(done, 200));
    stop.abort();
    expect(await next).toMatchObject({ ok: false, error: 'cancelled' });
    expect(paste).not.toHaveBeenCalled();
    expect(await host.screen(key)).toContain(WORDS);
  });

  it.each(KINDS)('%s: keeps them before it types', async kind => {
    const { key, sessionId } = await started(kind);
    const paste = vi.spyOn(tmux, 'paste');
    const next = host.run(PROGRAMS[kind](key, 'Next assignment.', { jobId: randomUUID(), sessionId }));
    await until(() => lefts().length > 0);
    host.inputKept({ type: 'agent.input_kept', agentKey: key, ref: lefts()[0]!.ref });
    expect(await next).toMatchObject({ ok: true });
    expect(paste.mock.calls.map(call => call[1])).toEqual(['Next assignment.']);
  });

  it.each(['claude', 'codex'] as const)('%s: ends the turn saying so, and leaves the words, when Hornhoof does not answer', async kind => {
    const { key, sessionId } = await started(kind);
    const paste = vi.spyOn(tmux, 'paste');
    expect(await host.run(PROGRAMS[kind](key, 'Next assignment.', { jobId: randomUUID(), sessionId }))).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'unknown', text: expect.stringContaining('could not keep') } });
    expect(paste).not.toHaveBeenCalled();
    expect(await host.screen(key)).toContain(WORDS);
    /* The wait is over: what the person now sends opens a turn of its own, as it would have. */
    host.input({ type: 'term.input', termId: `view-${key}`, data: '\r' });
    await until(() => sent.some(m => m.type === 'turn.open' && m.text === WORDS));
  });

  it('hears an Enter that was pressed in the turn before its prompt goes in, however late the program tells of it', async () => {
    const { key, sessionId } = await started('claude', { typingQuietMs: 60_000, readyMs: 8000, enterWaitMs: 2000 });
    const hook = host['hook'].bind(host);
    vi.spyOn(host as unknown as { hook: typeof hook }, 'hook').mockImplementation(async (at, event, data) => {
      if (event === 'prompt' && JSON.stringify(data).includes(WORDS)) await new Promise(done => setTimeout(done, 800));
      return hook(at, event, data);
    });
    /* The program clears its input before it tells of what it took. */
    let emptied = false;
    const readInput = host['readInput'].bind(host);
    vi.spyOn(host as unknown as { readInput: typeof readInput }, 'readInput').mockImplementation(async at => (emptied ? '' : readInput(at)));
    const jobId = randomUUID();
    const next = host.run(PROGRAMS.claude(key, 'Next assignment.', { jobId, sessionId }));
    await until(() => host['agents'].get(key)?.turn?.jobId === jobId);
    await new Promise(done => setTimeout(done, 300));
    emptied = true;
    host.input({ type: 'term.input', termId: `view-${key}`, data: '\r', pressedIn: jobId });
    const result = await next;
    expect(result).toMatchObject({ ok: true });
    expect(result.result).toContain('Next assignment.');
    expect(await host.screen(key)).not.toContain('cut short');
  });
});
