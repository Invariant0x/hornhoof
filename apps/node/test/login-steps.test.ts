import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NodeMessage } from '@hornhoof/protocol';
import { SIGNIN_ERRORS } from '@hornhoof/protocol/signin';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOGIN_STEPS_FILE, SignInProgress, StepWatch, stepsFile } from '../src/login-steps.js';

/* After the sign-in code, the node tells Hornhoof each step until the plan is ready, and its log keeps when the code came,
   when the plan was ready and how long each step took. A sign-in in the install window runs apart from the node: it
   leaves its steps in a file, which the node reads and passes on. The clock goes only as far as a test moves it. */
const T0 = new Date('2026-11-19T22:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

type Step = Extract<NodeMessage, { type: 'login.step' }>;

function progress() {
  const sent: NodeMessage[] = [];
  const logged: string[] = [];
  const shown = new SignInProgress({ send: m => sent.push(m), log: line => logged.push(line) });
  const steps = () => sent.filter((m): m is Step => m.type === 'login.step');
  return { shown, sent, logged, steps };
}

describe('the steps of a sign-in after its code', () => {
  it("tells Hornhoof each step, and keeps in the node's log when the code came, when the plan was ready and how long each step took", () => {
    const p = progress();
    p.shown.step('checking');
    vi.advanceTimersByTime(40_000);
    p.shown.step('signed_in');
    p.shown.step('models');
    vi.advanceTimersByTime(8_000);
    p.shown.step('limits');
    vi.advanceTimersByTime(4_000);
    p.shown.ended(true);
    expect(p.steps().map(m => m.step)).toEqual(['checking', 'signed_in', 'models', 'limits']);
    expect(p.logged[0]).toBe('Sign-in: checking, 0 s after the code (2026-11-19T22:00:00.000Z).');
    expect(p.logged).toContain('Sign-in: models, 40 s after the code.');
    expect(p.logged.at(-1)).toBe('Sign-in: ready 52 s after the code (2026-11-19T22:00:52.000Z). Steps: checking 40 s, signed_in 0 s, models 8 s, limits 4 s.');
  });

  it('tells Hornhoof why it failed, with the last line through the masks, and starts over at the next code', () => {
    const p = progress();
    p.shown.step('checking');
    vi.advanceTimersByTime(12_000);
    p.shown.failed(SIGNIN_ERRORS.unfinished, 'Google did not take the code: invalid_grant');
    expect(p.steps().at(-1)).toEqual({ type: 'login.step', step: 'failed', error: SIGNIN_ERRORS.unfinished, line: 'Google did not take the code: invalid_grant' });
    expect(p.logged.at(-1)).toBe(`Sign-in: failed 12 s after the code: ${SIGNIN_ERRORS.unfinished} Google did not take the code: invalid_grant`);
    vi.advanceTimersByTime(60_000);
    p.shown.step('checking');
    expect(p.logged.at(-1)).toBe('Sign-in: checking, 0 s after the code (2026-11-19T22:01:12.000Z).');
  });

  it('tells nothing of a sign-in that ended before any step', () => {
    const p = progress();
    p.shown.ended(false);
    p.shown.failed(SIGNIN_ERRORS.stopped, null);
    expect(p.sent).toEqual([]);
    expect(p.logged).toEqual([]);
  });
});

describe('the steps of a sign-in in the install window', () => {
  /* The steps as the file keeps them, without the mark of the sign-in they are of. */
  const lines = (dir: string) => readFileSync(join(dir, LOGIN_STEPS_FILE), 'utf8').trim().split('\n').map(l => { const entry = JSON.parse(l) as Record<string, unknown>; delete entry.run; return entry; });

  it('are left in a file of their own, which a new sign-in starts empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-steps-'));
    writeFileSync(join(dir, LOGIN_STEPS_FILE), '{"step":"models"}\n');
    const file = stepsFile(dir);
    file.step('checking');
    file.step('signed_in');
    expect(lines(dir)).toEqual([{ step: 'checking' }, { step: 'signed_in' }]);
    /* Each line names the sign-in it is of, so the node tells a new one from an old one that was longer. */
    const runs = readFileSync(join(dir, LOGIN_STEPS_FILE), 'utf8').trim().split('\n').map(l => (JSON.parse(l) as { run: string }).run);
    expect(new Set(runs).size).toBe(1);
    expect(runs[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('say why the sign-in failed only once it began, with the last line through the masks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-steps-'));
    const file = stepsFile(dir);
    file.failed(SIGNIN_ERRORS.unfinished, 'Antigravity CLI did not show its sign-in screen.');
    expect(readFileSync(join(dir, LOGIN_STEPS_FILE), 'utf8')).toBe('');
    file.step('checking');
    file.failed(SIGNIN_ERRORS.unfinished, 'Google did not take the code: token sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123');
    const failed = lines(dir).at(-1) as { step: string; error: string; line: string };
    expect(failed).toMatchObject({ step: 'failed', error: SIGNIN_ERRORS.unfinished });
    expect(failed.line).toContain('Google did not take the code');
    expect(failed.line).not.toContain('abcdefghijklmnopqrstuvwxyz0123');
  });

  it('reach Hornhoof through the node in their order, and once signed in the node reads what the plan can do with its own steps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-steps-'));
    /* What an earlier sign-in left goes nowhere. */
    writeFileSync(join(dir, LOGIN_STEPS_FILE), '{"step":"models"}\n');
    const p = progress();
    const signedIn = vi.fn(async (step: (s: 'models' | 'limits') => void) => { step('limits'); step('models'); });
    const watch = new StepWatch({ dir, progress: p.shown, signedIn, everyMs: 1000 });
    watch.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(p.steps()).toEqual([]);
    const file = stepsFile(dir);
    file.step('checking');
    await vi.advanceTimersByTimeAsync(1000);
    expect(p.steps().map(m => m.step)).toEqual(['checking']);
    file.step('setup');
    file.step('signed_in');
    await vi.advanceTimersByTimeAsync(1000);
    expect(signedIn).toHaveBeenCalledTimes(1);
    expect(p.steps().map(m => m.step)).toEqual(['checking', 'setup', 'signed_in', 'limits', 'models']);
    expect(p.logged.at(-1)).toMatch(/^Sign-in: ready 1 s after the code/);
    watch.stop();
  });

  it('pass on a failure with its reason', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-steps-'));
    const p = progress();
    const watch = new StepWatch({ dir, progress: p.shown, signedIn: vi.fn(async () => {}), everyMs: 1000 });
    watch.start();
    const file = stepsFile(dir);
    file.step('checking');
    file.failed(SIGNIN_ERRORS.notTaken, null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(p.steps().map(m => [m.step, m.error ?? null])).toEqual([['checking', null], ['failed', SIGNIN_ERRORS.notTaken]]);
    watch.stop();
  });

  it('take a line torn in the middle of its writing on the next look', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-steps-'));
    const p = progress();
    const watch = new StepWatch({ dir, progress: p.shown, signedIn: vi.fn(async () => {}), everyMs: 1000 });
    watch.start();
    stepsFile(dir);
    appendFileSync(join(dir, LOGIN_STEPS_FILE), '{"step":"che');
    await vi.advanceTimersByTimeAsync(1000);
    expect(p.steps()).toEqual([]);
    appendFileSync(join(dir, LOGIN_STEPS_FILE), 'cking"}\n');
    await vi.advanceTimersByTimeAsync(1000);
    expect(p.steps().map(m => m.step)).toEqual(['checking']);
    watch.stop();
  });
});
