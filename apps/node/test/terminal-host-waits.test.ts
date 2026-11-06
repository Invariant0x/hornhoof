import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIGNED_OUT as AGY_SIGNED_OUT } from '../src/providers/antigravity.js';
import type { RunResult } from '../src/runner.js';
import type { TermJob } from '../src/terminal/host.js';
import { acceptedReports, cancelTurn } from './terminal-test-clock.js';
import { agyProgram } from '../src/terminal/programs.js';
import { hasTmux, home, host, sent, setUp, job, codexJob, kimiJob, tmux, until, endsLost, pastLostEndWindows } from './terminal-host-helpers.js';

/* Quiet screens cannot end turns. Only the program, a person stopping it, or its exit can do so. */
const STILL_WAITING = 'still waiting';
const FAKE_AGY = fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url));

const within = (run: Promise<RunResult>, ms: number) => Promise.race([run, new Promise<typeof STILL_WAITING>(r => setTimeout(() => r(STILL_WAITING), ms))]);
const agyJob = (key: string, prompt: string, more: Partial<TermJob['input']> = {}) => ({ ...job(key, prompt, more), program: agyProgram, bin: FAKE_AGY, home: join(home, 'agy', key), signedOut: AGY_SIGNED_OUT });
const jobs = { claude: job, codex: codexJob, kimi: kimiJob, antigravity: agyJob };
const pidOf = (key: string) => tmux.programPid(`a-${key}`);
const reports = (jobId: string) => acceptedReports(sent, jobId);
const states = (jobId: string) => reports(jobId).map(m => m.state);

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

describe.skipIf(!hasTmux)('turns end only on an explicit signal', () => {
  afterEach(async () => { vi.restoreAllMocks(); await host?.stop(); });

  it.each(['claude', 'antigravity'] as const)('keeps %s open when both end channels are lost, with its program and session untouched, until a person stops it', async kind => {
    await setUp({ lookMs: 50, reportMs: 100 });
    const key = `lost-${kind}`;
    const first = await host.run(jobs[kind](key, 'first'));
    expect(first).toMatchObject({ ok: true });
    const pid = await pidOf(key);
    endsLost();
    const touched = touches();
    const stop = new AbortController();
    const turn = jobs[kind](key, 'hello', { sessionId: first.sessionId, jobId: `job-${key}`, signal: stop.signal });
    const run = host.run(turn);
    const answer = kind === 'claude' ? 'echo: hello' : 'FINISHED';
    await until(() => turn.events.some(e => e.kind === 'text' && e.text.includes(answer)));
    await until(() => states(`job-${key}`).length > 0);
    const sessionId = host['agents'].get(key)!.sessionId;
    const before = states(`job-${key}`).length;
    const clock = pastLostEndWindows();
    await until(() => states(`job-${key}`).length > before);
    expect(await within(run, 400)).toBe(STILL_WAITING);
    expect(states(`job-${key}`)).not.toContain('idle');
    expect(states(`job-${key}`).at(-1)).toBe('thinking');
    untouched(touched);
    expect(await pidOf(key)).toBe(pid);
    expect(host['agents'].get(key)!.sessionId).toBe(sessionId);
    clock.mockRestore();
    expect(await cancelTurn(tmux, stop, run)).toMatchObject({ ok: false, error: 'cancelled', sessionId });
    expect(await pidOf(key)).toBe(pid);
  });

  it.each(['claude', 'codex'] as const)('keeps %s open when it never answers at an empty prompt until a person stops it', async kind => {
    await setUp({ lookMs: 50, reportMs: 100 });
    const key = `wait-${kind}`;
    const stop = new AbortController();
    const run = host.run(jobs[kind](key, 'HANG here', { jobId: `job-${key}`, signal: stop.signal }));
    await until(() => states(`job-${key}`).length > 0);
    const pid = await pidOf(key);
    const touched = touches();
    const clock = pastLostEndWindows();
    expect(await within(run, 400)).toBe(STILL_WAITING);
    expect(new Set(states(`job-${key}`))).toEqual(new Set(['thinking']));
    expect(touched()).toEqual({ keys: [], killed: 0 });
    expect(await pidOf(key)).toBe(pid);
    clock.mockRestore();
    expect(await cancelTurn(tmux, stop, run)).toMatchObject({ ok: false, error: 'cancelled' });
  });

  it('keeps Claude Code thinking with its current spinner beyond three former lost-end windows and ends on its Stop hook', async () => {
    await setUp({ lookMs: 50, reportMs: 100 });
    const stopHook = vi.spyOn(host as unknown as { hook: typeof host['hook'] }, 'hook');
    const run = host.run(job('spinner', 'SPINNER here', { jobId: 'job-spinner' }));
    await until(async () => (await host.screen('spinner')).includes('Recombobulating'));
    await until(() => states('job-spinner').length > 0);
    const clock = pastLostEndWindows();
    expect(await within(run, 400)).toBe(STILL_WAITING);
    expect(new Set(states('job-spinner'))).toEqual(new Set(['thinking']));
    expect(states('job-spinner').length).toBeGreaterThanOrEqual(3);
    expect(stopHook.mock.calls.some(([, event]) => event === 'stop')).toBe(false);
    clock.mockRestore();
    expect(await run).toMatchObject({ ok: true, result: 'echo: SPINNER here' });
    expect(stopHook.mock.calls.some(([, event]) => event === 'stop')).toBe(true);
  });

  /* Kimi Code's screen does not tell that it works, and its log does: a turn it said it took and never said ended runs on,
     for Hornhoof's watch to see. */
  it('of Kimi Code, whose log says the turn runs, stays open though its prompt shows empty', async () => {
    await setUp({ lookMs: 50, reportMs: 100 });
    const stop = new AbortController();
    const run = host.run(kimiJob('wait-kimi', 'HANG here', { jobId: 'job-wait-kimi', signal: stop.signal }));
    await until(() => states('job-wait-kimi').includes('thinking'));
    const before = states('job-wait-kimi').length;
    const clock = pastLostEndWindows();
    await until(() => states('job-wait-kimi').length >= before + 3);
    expect(await within(run, 400)).toBe(STILL_WAITING);
    clock.mockRestore();
    expect(new Set(states('job-wait-kimi'))).toEqual(new Set(['thinking']));
    expect(await cancelTurn(tmux, stop, run)).toMatchObject({ ok: false, error: 'cancelled' });
  });

  /* agy's stream can break off mid-turn, as with a 503 from its backend, while agy works on and never says the turn
     ended. The node tells no lie about it: no wait for what to type, no end, and the screen's time stands with the
     screen. Hornhoof's alarm on a program that stood still takes the turn from there. */
  it('of Antigravity whose output broke off mid-tool stays open, and tells the tool with a screen that stood still', async () => {
    await setUp({ lookMs: 100, reportMs: 400 });
    const stop = new AbortController();
    const run = host.run(agyJob('cut-agy', 'CUT here', { jobId: 'job-cut', signal: stop.signal }));
    await until(() => states('job-cut').includes('tool'));
    const before = reports('job-cut').filter(m => m.state === 'tool').length;
    const clock = pastLostEndWindows();
    await until(() => reports('job-cut').filter(m => m.state === 'tool').length >= before + 3);
    expect(await within(run, 400)).toBe(STILL_WAITING);
    clock.mockRestore();
    const told = reports('job-cut');
    expect(told.map(m => m.state)).not.toContain('idle');
    expect(told.at(-1)).toMatchObject({ state: 'tool', tool: 'run_command' });
    const tool = told.filter(m => m.state === 'tool');
    expect(tool.length).toBeGreaterThanOrEqual(3);
    expect(new Set(tool.map(m => m.screenAt)).size).toBe(1);
    expect(await cancelTurn(tmux, stop, run)).toMatchObject({ ok: false, error: 'cancelled' });
  });

  it.each([
    ['claude', 'echo: TICK here'],
    ['codex', 'echo: TICK here'],
    ['antigravity', 'FINISHED'],
  ] as const)('of %s at work, its screen moving and its log quiet, ends only when its program says so', async (kind, answer) => {
    await setUp({ lookMs: 100 });
    expect(await within(host.run(jobs[kind](`tick-${kind}`, 'TICK here', { jobId: `job-tick-${kind}` })), 15_000)).toMatchObject({ ok: true, result: expect.stringContaining(answer) });
    expect(states(`job-tick-${kind}`)).toContain('thinking');
  });
});
