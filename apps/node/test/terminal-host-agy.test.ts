import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIGNED_OUT } from '../src/providers/antigravity.js';
import type { TermJob } from '../src/terminal/host.js';
import { agyProgram } from '../src/terminal/programs.js';
import { ack, hasTmux, until, host, sent, home, setUp, job, done, tmux, typeTurn, pastLostEndWindows } from './terminal-host-helpers.js';

const FAKE = fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url));
const agyJob = (key: string, prompt: string, more: Partial<TermJob['input']> = {}) => ({
  ...job(key, prompt, more), program: agyProgram, bin: FAKE, home: join(home, 'agy', key), signedOut: SIGNED_OUT,
});
const records = (log: string) => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const opens = () => sent.filter(m => m.type === 'turn.open');
const start = () => setUp({ readyMs: 2000, cols: 120, rows: 40, lookMs: 100 });

// The hooks keep the recorded transcript path, which belongs to another home. Only the computed path has these answers.
describe.skipIf(!hasTmux)("Antigravity's own terminal", () => {
  afterEach(async () => { vi.restoreAllMocks(); await host?.stop(); });

  it('takes a Hornhoof turn through invocation 0, follows its session, and reads the feed and answer from its transcript', async () => {
    await start();
    const log = join(home, 'agy-hooks.log');
    const first = agyJob('g1', 'hello', { model: 'gemini-4-argon', effort: 'high', env: { FAKE_LOG: log } });
    const res = await host.run(first);
    expect(res).toMatchObject({ ok: true, result: 'FINISHED', sessionId: expect.any(String), error: null });
    expect(first.events).toEqual([
      { kind: 'tool', name: 'run_command', input: 'sleep 8; echo slept' },
      { kind: 'tool_result', ok: true, summary: expect.stringContaining('slept') }, { kind: 'text', text: 'FINISHED' },
    ]);
    expect(opens()).toEqual([]);
    await until(() => records(log).some(r => r.hook === 'Stop'));
    const hooks = records(log).filter(r => r.hook);
    expect(hooks.map(r => [r.hook, r.payload.invocationNum])).toEqual([['PreInvocation', 0], ['PreInvocation', 1], ['Stop', undefined]]);
    expect(hooks.every(r => r.stdout === '')).toBe(true);
    expect(hooks[0].payload.conversationId).toBe(res.sessionId);
    const pid = await tmux.programPid('a-g1');
    expect(await host.run(agyJob('g1', 'Also say BANANA.', { sessionId: res.sessionId, model: 'gemini-4-argon', effort: 'high', env: { FAKE_LOG: log } }))).toMatchObject({ ok: true, result: 'BANANA', sessionId: res.sessionId });
    expect(await tmux.programPid('a-g1')).toBe(pid);
    // A changed launch starts agy again in the conversation, with no historical events in this turn.
    const resumed = agyJob('g1', 'Also say BANANA.', { sessionId: res.sessionId, model: 'gemini-4-argon', effort: 'low', env: { FAKE_LOG: log } });
    expect(await host.run(resumed)).toMatchObject({ ok: true, result: 'BANANA', sessionId: res.sessionId });
    expect(resumed.events).toEqual([{ kind: 'text', text: 'BANANA' }]);
    expect(records(log).filter(r => r.argv).at(-1).argv).toContain(res.sessionId);
  });

  it('gives agy the start of long instructions and keeps the whole text in a private file', async () => {
    await start();
    const instructions = Array.from({ length: 300 }, (_, i) => `${i} ${'я'.repeat(60)}`).join('\n');
    const log = join(home, 'agy-instructions.log');
    expect(await host.run(agyJob('instructions', 'hello', { instructions, env: { FAKE_LOG: log } }))).toMatchObject({ ok: true });
    const file = join(home, 'work', 'instructions', '.hh-instructions.md');
    expect(readFileSync(file, 'utf8')).toBe(instructions + '\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(Buffer.byteLength(records(log)[0].agentsMd)).toBeLessThan(23_000);
    expect(records(log)[0].agentsMd).toContain(file);
  });

  it('takes long multiline input whole, like Codex, without printing a prompt-hook notice', async () => {
    await start();
    const log = join(home, 'agy-long.log');
    const text = Array.from({ length: 45 }, (_, i) => `${i} Russian я, quotes " ' and $HOME, \`ls\` and 🙂. `.repeat(3)).join('\n');
    expect(text.length).toBeGreaterThan(4000);
    expect(await host.run(agyJob('long', text, { env: { FAKE_LOG: log } }))).toMatchObject({ ok: true, result: 'FINISHED' });
    expect(records(log).find(r => r.hook === 'PreInvocation').payload.lastUserInput).toBe(text);
    expect(records(log).filter(r => r.hook).every(r => r.stdout === '')).toBe(true);
  });

  it.each(['WORK', 'WORK LAG_TEXT'])('opens a typed turn and its queued turn while settling %s', async prefix => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, lookMs: 100, pollMs: prefix.includes('LAG') ? 500 : 100 });
    expect(await host.run(agyJob('typed', ''))).toMatchObject({ ok: true, sessionId: null });
    await typeTurn('typed', 'wtyped', `${prefix} typed in agy`, 'job-first');
    expect(opens()[0]).toMatchObject({ agentKey: 'typed', text: `${prefix} typed in agy` });
    host.input({ type: 'term.input', termId: 'wtyped', data: 'Also say BANANA. LAG\r' });
    await until(async () => (await host.screen('typed')).includes('(alt+m to send immediately)'));
    await until(() => opens().length === 2);
    ack('typed', 'job-queued', 1);
    await until(() => Boolean(done('job-first') && done('job-queued')));
    expect(done('job-first')).toMatchObject({ ok: true, result: 'FINISHED' });
    expect(done('job-queued')).toMatchObject({ ok: true, result: 'BANANA' });
    expect(sent).toContainEqual({ type: 'job.event', jobId: 'job-queued', seq: 0, event: { kind: 'text', text: 'BANANA' } });
    expect(opens()).toHaveLength(2);
  });

  it('opens a queued message as its own typed turn after a Hornhoof turn', async () => {
    await start();
    const run = host.run(agyJob('queued', 'WORK from Hornhoof'));
    await until(async () => (await host.screen('queued')).includes('esc to cancel'));
    await host.open({ type: 'term.open', termId: 'wqueued', agentKey: 'queued', cols: 120, rows: 40, write: true });
    host.input({ type: 'term.input', termId: 'wqueued', data: 'Also say BANANA.\r' });
    expect(await run).toMatchObject({ ok: true, result: 'FINISHED' });
    await until(() => opens().length === 1);
    ack('queued', 'job-queued');
    await until(() => Boolean(done('job-queued')));
    expect(done('job-queued')).toMatchObject({ ok: true, result: 'BANANA' });
  });

  it.each(['hornhoof', 'typed'] as const)('sees Escape end a %s turn without a stop hook or sending any key itself', async source => {
    await start();
    const log = join(home, `agy-escape-${source}.log`);
    const input = { env: { FAKE_LOG: log, FAKE_OLD_INTERRUPTED: '1' } };
    let running;
    if (source === 'typed') {
      await host.run(agyJob('escape', '', input));
      await typeTurn('escape', 'wescape', 'HANG typed', 'job-escape');
    } else {
      running = host.run(agyJob('escape', 'HANG Hornhoof', input));
      await until(async () => (await host.screen('escape')).includes('esc to cancel'));
      await host.open({ type: 'term.open', termId: 'wescape', agentKey: 'escape', cols: 120, rows: 40, write: true });
    }
    await until(() => records(log).some(r => r.hook === 'PreInvocation'));
    const keys = vi.spyOn(tmux, 'keys');
    host.input({ type: 'term.input', termId: 'wescape', data: '\u001b' });
    if (running) {
      await until(async () => (await host.screen('escape')).includes('Interrupted · What should Antigravity CLI do instead?'));
      expect(await running).toMatchObject({ ok: false, error: 'cancelled' });
    } else {
      await until(() => Boolean(done('job-escape')));
      expect(done('job-escape')).toMatchObject({ ok: false, error: 'cancelled' });
    }
    expect(records(log).filter(r => r.hook === 'Stop')).toEqual([]);
    expect(keys).not.toHaveBeenCalled();
  });

  it('keeps a lost Stop open beyond the former idle timeout until a person stops it', async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, lookMs: 50, reportMs: 100 });
    const stop = new AbortController();
    let ended = false;
    const turn = agyJob('lost', 'NO_STOP', { jobId: 'job-lost', signal: stop.signal });
    const run = host.run(turn);
    void run.then(() => { ended = true; });
    await until(() => turn.events.some(e => e.kind === 'text' && e.text === 'FINISHED'));
    const keys = vi.spyOn(tmux, 'keys');
    const reports = () => sent.filter(m => m.type === 'job.program' && m.jobId === 'job-lost');
    /* The final transcript read updates signAt before the next report publishes it. */
    const afterAnswer = reports().length;
    await until(() => reports().length > afterAnswer);
    const signAt = reports().at(-1)!.signAt;
    expect(Number.isFinite(signAt)).toBe(true);
    await host.open({ type: 'term.open', termId: 'wlost', agentKey: 'lost', cols: 120, rows: 40, write: true });
    host.input({ type: 'term.input', termId: 'wlost', data: 'redraw' });
    const before = reports().length;
    const clock = pastLostEndWindows();
    await until(() => reports().length > before);
    expect(ended).toBe(false);
    expect(reports().at(-1)).toMatchObject({ type: 'job.program', jobId: 'job-lost', state: 'thinking', signAt });
    expect(done('job-lost')).toBeUndefined();
    expect(keys).not.toHaveBeenCalled();
    clock.mockRestore();
    stop.abort();
    expect(await run).toMatchObject({ ok: false, error: 'cancelled' });
  });

  it('drains the transcript when stop arrives before its answer is readable', async () => {
    await start();
    const turn = agyJob('lag', 'LAG');
    expect(await host.run(turn)).toMatchObject({ ok: true, result: 'FINISHED' });
    expect(turn.events.at(-1)).toEqual({ kind: 'text', text: 'FINISHED' });
  });

  it('settles the final answer after intermediate text when stop precedes the last transcript write', async () => {
    await start();
    const turn = agyJob('lag-text', 'LAG_TEXT');
    expect(await host.run(turn)).toMatchObject({ ok: true, result: 'FINISHED' });
    expect(turn.events.filter(e => e.kind === 'text')).toEqual([{ kind: 'text', text: 'Checking the command.' }, { kind: 'text', text: 'FINISHED' }]);
  });

  it('keeps an older interruption in the screen history from cancelling a later turn', async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, lookMs: 100 });
    expect(await host.run(agyJob('old-interruption', 'WORK', { env: { FAKE_OLD_INTERRUPTED: '1' } }))).toMatchObject({ ok: true, result: 'FINISHED' });
  });

  it('fails a stop with an error and leaves agy ready for the next turn', async () => {
    await start();
    const failed = await host.run(agyJob('fail', 'FAIL'));
    expect(failed).toMatchObject({ ok: false, error: 'agent_failed', output: expect.stringContaining('invalid model selection') });
    expect(await host.run(agyJob('fail', 'next', { sessionId: failed.sessionId }))).toMatchObject({ ok: true, result: 'FINISHED' });
  });
});
