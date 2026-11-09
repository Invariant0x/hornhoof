import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NodeMessage } from '@hornhoof/protocol';
import { RESTART_AFTER_MS } from '@hornhoof/protocol/map';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inputOf } from '../src/terminal/input.js';
import { agyProgram } from '../src/terminal/programs.js';
import { codexJob, hasTmux, home, host, job, kimiJob, sent, setUp, tmux, until } from './terminal-host-helpers.js';

/* A program that starts anew takes its input with it: at a new level, in a new session, or in recovery. Whatever someone left
   there goes to Hornhoof first, and the old program stays until Hornhoof says it has it. Fake programs, no live CLI. */
const FAKE_AGY = fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url));
const agyJob = (key: string, prompt: string, more: Parameters<typeof job>[2] = {}) => ({ ...job(key, prompt, more), program: agyProgram, bin: FAKE_AGY, home: join(home, '.agy') });
const PROGRAMS = { claude: job, codex: codexJob, kimi: kimiJob, antigravity: agyJob };
const KINDS = Object.keys(PROGRAMS) as (keyof typeof PROGRAMS)[];
const RECOVERED = KINDS.filter(kind => RESTART_AFTER_MS[kind] !== null);
type Kind = (typeof KINDS)[number];
type Left = Extract<NodeMessage, { type: 'agent.input_left' }>;

const WORDS = 'Words a person left';
const lefts = () => sent.filter((m): m is Left => m.type === 'agent.input_left');
const refs = () => new Set(lefts().map(left => left.ref));
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const realLaunch: typeof tmux.launch = (name, spec) => Object.getPrototypeOf(tmux).launch.call(tmux, name, spec);
const kept = (key: string) => host.inputKept({ type: 'agent.input_kept', agentKey: key, ref: lefts()[0]!.ref });

async function atWork(kind: Kind, more: Parameters<typeof setUp>[0] = {}) {
  await setUp({ plugins: [], cols: 120, rows: 40, readyMs: 5000, lookMs: 100, toolsMs: 5000, enterWaitMs: 300, typingQuietMs: 50, keptWaitMs: 1000, ...more });
  const key = randomUUID();
  const termId = `view-${key}`;
  const run = (prompt: string, effort: string, sessionId: string | null = null, timeoutMs = 20_000) => {
    const jobId = randomUUID();
    return { jobId, running: host.run(PROGRAMS[kind](key, prompt, { jobId, sessionId, effort, timeoutMs })) };
  };
  const line = async () => inputOf(kind, await tmux.screen(host['agents'].get(key)!.name, 0, true));
  const open = () => host.open({ type: 'term.open', termId, agentKey: key, cols: 120, rows: 40, write: true });
  const type = async (data: string) => {
    host.input({ type: 'term.input', termId, data });
    await until(async () => (await line()) === data);
    await sleep(80);
  };
  return { key, termId, run, line, open, type };
}

/* A first turn at one level, and words a person then left in its input. */
async function wordsLeft(kind: Kind, more: Parameters<typeof setUp>[0] = {}, words = WORDS) {
  const c = await atWork(kind, more);
  const first = await c.run('First assignment.', 'high').running;
  expect(first).toMatchObject({ ok: true });
  await c.open();
  await c.type(words);
  return { ...c, sessionId: first.sessionId ?? null, launch: vi.spyOn(tmux, 'launch'), paste: vi.spyOn(tmux, 'paste'), keys: vi.spyOn(tmux, 'keys') };
}

describe.skipIf(!hasTmux)('words left in the input of a program that starts anew for the next turn', () => {
  afterEach(async () => { vi.restoreAllMocks(); await host?.stop(); });

  const nextTurns = [
    ['a new level', 'medium', (sessionId: string | null) => sessionId],
    ['a new session', 'high', () => null],
  ] as const;

  describe.each(nextTurns)('at %s', (_what, effort, session) => {
    it.each(KINDS)('%s: go to Hornhoof first, and the old program stays until Hornhoof has them', async kind => {
      const c = await wordsLeft(kind);
      /* A program that starts anew may press Escape on its own screen, agy does for a panel; the old one gets none. */
      let keysBefore: unknown[] = [];
      c.launch.mockImplementation(async (name, spec) => {
        keysBefore = c.keys.mock.calls.flat();
        return realLaunch(name, spec);
      });
      const second = c.run('Second assignment.', effort, session(c.sessionId));
      await until(() => lefts().length > 0);
      expect(lefts()[0]).toMatchObject({ agentKey: c.key, jobId: second.jobId, text: WORDS, typed: true });
      await sleep(150);
      expect(c.launch).not.toHaveBeenCalled();
      expect(await c.line()).toBe(WORDS);
      kept(c.key);
      expect(await second.running).toMatchObject({ ok: true });
      expect(c.launch).toHaveBeenCalledTimes(1);
      expect(refs().size).toBe(1);
      expect(keysBefore).not.toContain('Escape');
      expect(c.paste.mock.calls.map(call => call[1])).toEqual(['Second assignment.']);
      // The new program redraws its input as it takes the assignment, and a screen read in that moment finds no input line.
      await until(async () => { const now = await c.line(); return now !== null && !now.includes(WORDS); });
    });
  });

  it.each(KINDS)('%s: an answer that comes late is still heard, for the same words told again', async kind => {
    const c = await wordsLeft(kind, { keptWaitMs: 150 });
    const second = c.run('Second assignment.', 'medium', c.sessionId);
    await until(() => lefts().length >= 2);
    expect(refs().size).toBe(1);
    expect(c.launch).not.toHaveBeenCalled();
    expect(await c.line()).toBe(WORDS);
    kept(c.key);
    expect(await second.running).toMatchObject({ ok: true });
    expect(c.launch).toHaveBeenCalledTimes(1);
  });

  it.each(KINDS)('%s: with no answer the turn ends saying so, and a repeat of it keeps them and goes on', async kind => {
    const c = await wordsLeft(kind, { keptWaitMs: 150, readyMs: 2500 });
    const second = c.run('Second assignment.', 'medium', c.sessionId);
    expect(await second.running).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'unknown', text: expect.stringContaining('could not keep') } });
    expect(c.launch).not.toHaveBeenCalled();
    expect(await c.line()).toBe(WORDS);
    const told = lefts().length;
    const again = c.run('Second assignment.', 'medium', c.sessionId);
    await until(() => lefts().length > told);
    host.inputKept({ type: 'agent.input_kept', agentKey: c.key, ref: lefts().at(-1)!.ref });
    expect(await again.running).toMatchObject({ ok: true });
    expect(c.launch).toHaveBeenCalledTimes(1);
  });

  it.each(KINDS)('%s: what a person sends meanwhile gets its answer from the old program, which only then goes', async kind => {
    const c = await wordsLeft(kind, { typingQuietMs: 60_000, readyMs: 8000, enterWaitMs: 1000 }, 'SLOW WORK words');
    const a = host['agents'].get(c.key)!;
    const busyAtLaunch: boolean[] = [];
    c.launch.mockImplementation(async (name, spec) => {
      busyAtLaunch.push(Boolean(a.busy));
      return realLaunch(name, spec);
    });
    const second = c.run('Second assignment.', 'medium', c.sessionId);
    await until(() => a.turn?.jobId === second.jobId);
    await sleep(300);
    expect(c.launch).not.toHaveBeenCalled();
    host.input({ type: 'term.input', termId: c.termId, data: '\r', pressedIn: second.jobId });
    expect(await second.running).toMatchObject({ ok: true });
    expect(busyAtLaunch).toEqual([false]);
    expect(lefts()).toEqual([]);
    expect(c.paste.mock.calls.map(call => call[1])).toEqual(['Second assignment.']);
    /* The turn ended on what the assignment did, and no turn of a person came of it. */
    await sleep(300);
    expect(sent.filter(m => m.type === 'turn.open')).toEqual([]);
    expect(a.busy).toBe(false);
  });

  it('waits while a person still writes, and keeps what they wrote by then', async () => {
    const c = await wordsLeft('claude', { typingQuietMs: 1000, readyMs: 5000 });
    const second = c.run('Second assignment.', 'medium', c.sessionId);
    await sleep(300);
    expect(lefts()).toEqual([]);
    expect(c.launch).not.toHaveBeenCalled();
    await until(() => lefts().length > 0, 3000);
    kept(c.key);
    expect(await second.running).toMatchObject({ ok: true });
  });

  it.each(KINDS)('%s: tells of nothing when the input holds nothing', async kind => {
    const c = await atWork(kind);
    const first = await c.run('First assignment.', 'high').running;
    const launch = vi.spyOn(tmux, 'launch');
    expect(await c.run('Second assignment.', 'medium', first.sessionId ?? null).running).toMatchObject({ ok: true });
    expect(lefts()).toEqual([]);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('does not start anew a program that asks a person, and leaves its question and input alone', async () => {
    const c = await wordsLeft('claude');
    Object.assign(host['agents'].get(c.key)!, { busy: true, question: { name: 'Permission', at: Date.now(), asking: true } });
    expect(await c.run('Second assignment.', 'medium', c.sessionId, 200).running).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'unknown', text: expect.stringContaining('asking a person') } });
    expect(c.launch).not.toHaveBeenCalled();
    expect(lefts()).toEqual([]);
    expect(c.keys).not.toHaveBeenCalled();
    expect(await c.line()).toBe(WORDS);
  });

  it('counts no question left behind by a program done with its turn', async () => {
    const c = await wordsLeft('claude');
    Object.assign(host['agents'].get(c.key)!, { busy: false, question: { name: 'Permission', at: Date.now(), asking: true } });
    const second = c.run('Second assignment.', 'medium', c.sessionId);
    await until(() => lefts().length > 0);
    kept(c.key);
    expect(await second.running).toMatchObject({ ok: true });
    expect(c.launch).toHaveBeenCalledTimes(1);
  });

  it('asks nothing of a program that is gone', async () => {
    const c = await wordsLeft('claude');
    await tmux.kill(host['agents'].get(c.key)!.name);
    expect(await c.run('Second assignment.', 'medium', c.sessionId).running).toMatchObject({ ok: true });
    expect(lefts()).toEqual([]);
  });
});

describe.skipIf(!hasTmux)('words left in the input of a silent program that recovery starts anew', () => {
  afterEach(async () => { vi.restoreAllMocks(); await host?.stop(); });

  /* A turn whose program stopped talking, with words a person typed meanwhile, and the time that lets it restart. */
  async function silent(kind: Kind, more: Parameters<typeof setUp>[0] = {}) {
    const c = await atWork(kind, more);
    const jobId = randomUUID();
    const running = host.run(PROGRAMS[kind](c.key, 'HANG', { jobId, timeoutMs: 60_000 }));
    await until(() => sent.some(m => m.type === 'job.program' && m.jobId === jobId));
    await c.open();
    await c.type(WORDS);
    const launch = vi.spyOn(tmux, 'launch');
    const now = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => now() + RESTART_AFTER_MS[kind as 'codex']! + 1000);
    return { ...c, jobId, running, launch };
  }

  it.each(RECOVERED)('%s: go to Hornhoof first, and the program stays until Hornhoof has them', async kind => {
    const c = await silent(kind, { lookMs: 50 });
    const restarted = host.restart(c.key, c.jobId, 'Continue.');
    await until(() => lefts().length > 0);
    expect(lefts()[0]).toMatchObject({ agentKey: c.key, jobId: c.jobId, text: WORDS, typed: true });
    await sleep(150);
    expect(c.launch).not.toHaveBeenCalled();
    kept(c.key);
    expect(await restarted).toEqual({ ok: true, reason: null });
    expect(c.launch).toHaveBeenCalledTimes(1);
  });

  it.each(RECOVERED)('%s: refuses with the words in place when Hornhoof does not answer, and may try again', async kind => {
    const c = await silent(kind, { lookMs: 50, keptWaitMs: 150 });
    expect(await host.restart(c.key, c.jobId, 'Continue.')).toEqual({ ok: false, reason: expect.stringContaining('could not keep') });
    expect(c.launch).not.toHaveBeenCalled();
    expect(await c.line()).toBe(WORDS);
    const told = lefts().length;
    const again = host.restart(c.key, c.jobId, 'Continue.');
    await until(() => lefts().length > told);
    expect(refs().size).toBe(1);
    kept(c.key);
    expect(await again).toEqual({ ok: true, reason: null });
    expect(c.launch).toHaveBeenCalledTimes(1);
  });
});
