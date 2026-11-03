import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NodeMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIGNED_OUT as AGY_SIGNED_OUT } from '../src/providers/antigravity.js';
import type { RunResult } from '../src/runner.js';
import type { TermJob } from '../src/terminal/host.js';
import { agyProgram } from '../src/terminal/programs.js';
import { hasTmux, home, host, sent, setUp, job, codexJob, kimiJob, tmux } from './terminal-host-helpers.js';

/* Claude Code and Antigravity say that a turn ended through a hook only, and a hook can be lost on the way. The host sees
   such an end itself: the program waits for what to type, nothing typed and no sign of work, for LOST_MS of Hornhoof's
   turn. The turn then ends with the program's last answer, and the program and its session go on untouched. A program at
   work shows it, so a long thought whose log is quiet keeps its turn. */
const LOST_MS = 1500;
const STILL_WAITING = 'still waiting';
const FAKE_AGY = fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url));
const UNSAID = 'end seen without hook';

const within = (run: Promise<RunResult>, ms: number) => Promise.race([run, new Promise<typeof STILL_WAITING>(r => setTimeout(() => r(STILL_WAITING), ms))]);
const agyJob = (key: string, prompt: string, more: Partial<TermJob['input']> = {}) => ({ ...job(key, prompt, more), program: agyProgram, bin: FAKE_AGY, home: join(home, 'agy', key), signedOut: AGY_SIGNED_OUT });
const jobs = { claude: job, codex: codexJob, kimi: kimiJob, antigravity: agyJob };
const pidOf = (key: string) => tmux.programPid(`a-${key}`);
const states = (jobId: string) => sent.flatMap(m => (m.type === 'job.program' && m.jobId === jobId ? [m.state] : []));

/* The keys the host presses from now on, and whether it ends the program. */
function touches() {
  const keys = vi.spyOn(tmux, 'keys');
  const kill = vi.spyOn(tmux, 'kill');
  return () => ({ keys: keys.mock.calls.flatMap(([, ...k]) => k), killed: kill.mock.calls.length });
}

/* Only the Enter that sent the prompt in reached the program, and nothing ended it. */
function untouched(touched: ReturnType<typeof touches>) {
  expect(touched()).toEqual({ keys: expect.arrayContaining(['Enter']), killed: 0 });
  expect(touched().keys.filter(k => k !== 'Enter')).toEqual([]);
}

/* Word that the program's turn ended never reaches the host, as when the hook that carries it is lost on the way. */
function endsLost(): () => void {
  const h = host as unknown as { hook(key: string, event: string, body: unknown): Promise<string | void> };
  const real = h.hook.bind(host);
  h.hook = async (key, event, body) => (event === 'stop' ? undefined : real(key, event, body));
  return () => void (h.hook = real);
}

describe.skipIf(!hasTmux)('a turn whose end its program never said', () => {
  afterEach(async () => host?.stop());

  it.each([
    ['claude', 'echo: hello', 'echo: next'],
    ['antigravity', 'FINISHED', 'FINISHED'],
  ] as const)('of %s that answered ends with its last answer, and the program and its session go on untouched', async (kind, answer, next) => {
    const logs: string[] = [];
    await setUp({ lostMs: LOST_MS, log: m => logs.push(m) });
    const key = `lost-${kind}`;
    const found = endsLost();
    const touched = touches();
    const run = host.run(jobs[kind](key, 'hello', { jobId: `job-${key}` }));
    await vi.waitFor(async () => expect(await pidOf(key)).not.toBeNull(), { timeout: 10_000 });
    const pid = await pidOf(key);
    const ended = await within(run, 20_000);
    expect(ended).toMatchObject({ ok: true, error: null, result: expect.stringContaining(answer), output: '' });
    if (kind === 'antigravity') expect((ended as RunResult).sessionId).toEqual(expect.any(String));
    expect(logs.filter(l => l.includes(UNSAID))).toEqual([expect.stringMatching(new RegExp(`^Agent ${key} \\(${kind}\\): ${UNSAID}\\.`))]);
    expect(states(`job-${key}`).at(-1)).toBe('idle');
    untouched(touched);
    expect(await pidOf(key)).toBe(pid);
    /* The next turn goes on in the same program and session. */
    found();
    expect(await host.run(jobs[kind](key, 'next', { sessionId: (ended as RunResult).sessionId }))).toMatchObject({ ok: true, result: expect.stringContaining(next) });
    expect(await pidOf(key)).toBe(pid);
  });

  /* #77 ended a program that waited at its prompt in Hornhoof's turn, with TERM and then KILL, and failed the turn. The turn
     now ends as if the program had said so, and the program goes on. */
  it.each(['claude', 'codex'] as const)('of %s that never answered ends with no answer and its screen, and the program goes on untouched', async kind => {
    await setUp({ lostMs: LOST_MS });
    const key = `wait-${kind}`;
    const first = await host.run(jobs[kind](key, 'first'));
    expect(first).toMatchObject({ ok: true });
    const pid = await pidOf(key);
    const touched = touches();
    const ended = await within(host.run(jobs[kind](key, 'HANG here', { sessionId: first.sessionId })), 15_000);
    expect(ended).toMatchObject({ ok: true, error: null, result: '', output: expect.stringContaining('HANG here') });
    untouched(touched);
    expect(await pidOf(key)).toBe(pid);
    expect(await host.run(jobs[kind](key, 'next', { sessionId: (ended as RunResult).sessionId }))).toMatchObject({ ok: true, result: expect.stringContaining('echo: next') });
    expect(await pidOf(key)).toBe(pid);
  });

  /* Kimi Code's screen does not tell that it works, and its log does: a turn it said it took and never said ended runs on,
     for Hornhoof's watch to see. */
  it('of Kimi Code, whose log says the turn runs, stays open though its prompt shows empty', async () => {
    await setUp({ lostMs: LOST_MS });
    const stop = new AbortController();
    const run = host.run(kimiJob('wait-kimi', 'HANG here', { jobId: 'job-wait-kimi', signal: stop.signal }));
    expect(await within(run, 3 * LOST_MS + 2000)).toBe(STILL_WAITING);
    expect(new Set(states('job-wait-kimi'))).toEqual(new Set(['thinking']));
    stop.abort();
    expect(await run).toMatchObject({ ok: false, error: 'cancelled' });
  });

  /* agy's transcript can break off mid-turn while agy works on and never says the turn
     ended. The node tells no lie about it: no wait for what to type, no end, and the screen's time stands with the
     screen. Hornhoof's alarm on a program that stood still takes the turn from there. */
  it('of Antigravity whose output broke off mid-tool stays open, and tells the tool with a screen that stood still', async () => {
    const logs: string[] = [];
    await setUp({ lostMs: LOST_MS, lookMs: 100, reportMs: 400, log: m => logs.push(m) });
    const stop = new AbortController();
    const run = host.run(agyJob('cut-agy', 'CUT here', { jobId: 'job-cut', signal: stop.signal }));
    expect(await within(run, 3 * LOST_MS + 2000)).toBe(STILL_WAITING);
    const told = sent.filter((m): m is Extract<NodeMessage, { type: 'job.program' }> => m.type === 'job.program' && m.jobId === 'job-cut');
    expect(told.map(m => m.state)).not.toContain('idle');
    expect(told.at(-1)).toMatchObject({ state: 'tool', tool: 'run_command' });
    const tool = told.filter(m => m.state === 'tool');
    expect(tool.length).toBeGreaterThanOrEqual(3);
    expect(new Set(tool.map(m => m.screenAt)).size).toBe(1);
    expect(logs.filter(l => l.includes(UNSAID))).toEqual([]);
    stop.abort();
    expect(await run).toMatchObject({ ok: false, error: 'cancelled' });
  });

  it.each([
    ['claude', 'echo: TICK here'],
    ['codex', 'echo: TICK here'],
    ['antigravity', 'FINISHED'],
  ] as const)('of %s at work, its screen moving and its log quiet, is no lost end', async (kind, answer) => {
    const logs: string[] = [];
    await setUp({ lostMs: LOST_MS, log: m => logs.push(m) });
    expect(await within(host.run(jobs[kind](`tick-${kind}`, 'TICK here', { jobId: `job-tick-${kind}` })), 15_000)).toMatchObject({ ok: true, result: expect.stringContaining(answer) });
    expect(logs.filter(l => l.includes(UNSAID))).toEqual([]);
    expect(states(`job-tick-${kind}`)).toContain('thinking');
  });
});
