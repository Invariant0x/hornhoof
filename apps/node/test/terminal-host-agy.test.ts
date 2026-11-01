import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SIGNED_OUT as AGY_SIGNED_OUT } from '../src/providers/antigravity.js';
import type { TermJob } from '../src/terminal/host.js';
import { agyProgram } from '../src/terminal/programs.js';
import { hasTmux, until, host, sent, home, setUp, job, done, typeTurn } from './terminal-host-helpers.js';

/* agy's print mode, answering with the samples from its docs. */
const FAKE_AGY = fileURLToPath(new URL('./fakes/agy', import.meta.url));
const AGY_NEW = 'c3b66b04-872b-4fbe-a3a4-058a026ef20a';
const AGY_RESUMED = '9ec58bfd-4d67-4f5e-83a5-9d907e9c6b1f';
const AGY_FLAGS = ['--output-format', 'stream-json', '--print-timeout', '0s', '--dangerously-skip-permissions'];

describe.skipIf(!hasTmux)('agents in live terminals', () => {
  afterEach(async () => host?.stop());

  /* Antigravity keeps everything in its home, which these tests give each agent of their own. */
  const agyJob = (key: string, prompt: string, more: Partial<TermJob['input']> = {}) => ({
    ...job(key, prompt, more),
    program: agyProgram,
    bin: FAKE_AGY,
    home: join(home, 'agy', key),
    signedOut: AGY_SIGNED_OUT,
  });
  /* The print runs agy got, as the fake logged them. */
  const agyRuns = (log: string) =>
    readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter((r: { argv?: string[] }) => r.argv?.some(a => a.startsWith('--print=')));

  it("runs a turn in Antigravity's print mode with its tools and instructions, and goes on in its conversation", async () => {
    await setUp();
    const log = join(home, 'agy-g1.log');
    const first = agyJob('g1', 'hello', { env: { FAKE_LOG: log } });
    const res = await host.run(first);
    expect(res).toMatchObject({ ok: true, result: expect.stringMatching(/^Git rebase destructively rewrites/), sessionId: AGY_NEW, error: null });
    expect(first.events).toEqual([{ kind: 'text', text: expect.stringMatching(/^Git rebase/) }]);
    const second = await host.run(agyJob('g1', 'line one\nline two', { sessionId: res.sessionId, env: { FAKE_LOG: log } }));
    expect(second).toMatchObject({ ok: true, result: 'apple', sessionId: AGY_RESUMED });
    const runs = agyRuns(log);
    expect(runs.map((r: { argv: string[] }) => r.argv)).toEqual([
      ['--print=hello', ...AGY_FLAGS],
      ['--print=line one\nline two', ...AGY_FLAGS, '--conversation', AGY_NEW],
    ]);
    expect(runs[0].agyMcp.json).toEqual({ mcpServers: { hornhoof: { serverUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp\//) } } });
    expect(runs[0].agentsMd).toContain('Be brief.');
    expect(runs[0].env).toMatchObject({ HOME: join(home, 'agy', 'g1'), AGY_CLI_DISABLE_AUTO_UPDATE: 'true' });
    /* One program for both turns. */
    expect((await host.screen('g1')).match(/Antigravity CLI/g)).toHaveLength(1);
  });

  it('gives Antigravity the start of instructions it would cut, and the whole text in a file of its folder', async () => {
    await setUp();
    const long = Array.from({ length: 300 }, (_, i) => `${i} ${'я'.repeat(60)}`).join('\n');
    const log = join(home, 'agy-g6.log');
    expect(await host.run(agyJob('g6', 'hello', { instructions: long, env: { FAKE_LOG: log } }))).toMatchObject({ ok: true });
    const file = join(home, 'work', 'g6', '.hh-instructions.md');
    expect(readFileSync(file, 'utf8')).toBe(long + '\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const [run] = agyRuns(log);
    expect(Buffer.byteLength(run.agentsMd)).toBeLessThan(23_000);
    expect(long.startsWith(run.agentsMd.split('\n\n')[0] + '\n')).toBe(true);
    expect(run.agentsMd).toContain(file);
  });

  it("shows Antigravity's steps, and tells one that failed or is not signed in", async () => {
    await setUp();
    const tools = agyJob('g2', 'TOOLS');
    expect(await host.run(tools)).toMatchObject({ ok: true });
    expect(tools.events.slice(0, 2)).toEqual([
      { kind: 'tool', name: expect.any(String), input: 'echo hello_headless_demo' },
      { kind: 'tool_result', ok: true, summary: expect.stringContaining('hello_headless_demo') },
    ]);
    const failed = await host.run(agyJob('g2', 'FAIL'));
    expect(failed).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(failed.output).toContain('invalid model selection');
    expect(await host.run(agyJob('g2', 'next'))).toMatchObject({ ok: true });
    expect(await host.run(agyJob('g3', 'hello', { env: { FAKE_MODE: 'signed_out' } }))).toMatchObject({ ok: false, error: 'not_logged_in' });
  });

  it('starts Antigravity for a person, and opens a turn with its tools for what they type in it', async () => {
    await setUp();
    expect(await host.run(agyJob('g4', ''))).toMatchObject({ ok: true, sessionId: null });
    await typeTurn('g4', 'wg4', 'typed in agy', 'job-g4');
    expect(sent.find(m => m.type === 'turn.open')).toEqual({ type: 'turn.open', agentKey: 'g4', text: 'typed in agy', ref: expect.any(String) });
    await until(() => Boolean(done('job-g4')));
    expect(done('job-g4')).toMatchObject({ ok: true, result: expect.stringMatching(/^Git rebase/), sessionId: AGY_NEW });
    expect(sent).toContainEqual({ type: 'job.event', jobId: 'job-g4', seq: 0, event: { kind: 'text', text: expect.stringMatching(/^Git rebase/) } });
  });

  it('stops an Antigravity turn with Escape, as Hornhoof calls it off or a person stops it, and keeps words for the next turn', async () => {
    await setUp();
    const first = await host.run(agyJob('g5', 'warm up'));
    const stop = new AbortController();
    const running = host.run(agyJob('g5', 'HANG', { sessionId: first.sessionId, signal: stop.signal }));
    await until(async () => (await host.screen('g5')).includes('HANG'));
    /* agy takes nothing while it works: Hornhoof's words wait for the next turn. */
    expect(await host.say('g5', 'one more thing')).toBe(false);
    stop.abort();
    const started = Date.now();
    expect(await running).toMatchObject({ ok: false, error: 'cancelled' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await host.run(agyJob('g5', 'next', { sessionId: first.sessionId }))).toMatchObject({ ok: true, result: 'apple' });
    await typeTurn('g5', 'wg5', 'HANG typed', 'job-g5');
    host.input({ type: 'term.input', termId: 'wg5', data: '\u001b' });
    await until(() => Boolean(done('job-g5')));
    expect(done('job-g5')).toMatchObject({ ok: false, error: 'cancelled' });
    expect(await host.run(agyJob('g5', 'after', { sessionId: first.sessionId }))).toMatchObject({ ok: true, result: 'apple' });
  }, 30_000);
});
