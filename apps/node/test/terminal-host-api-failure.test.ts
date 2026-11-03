import { appendFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIGNED_OUT } from '../src/providers/codex.js';
import { findRollout } from '../src/terminal/programs.js';
import failures from './fixtures/terminal-api-failures.json';
import { hasTmux, host, tmux, setUp, codexJob, kimiJob, done, typeTurn, until } from './terminal-host-helpers.js';

const job = (program: string, prompt: string, sessionId: string | null = null) =>
  program === 'codex' ? { ...codexJob('api', prompt, { sessionId }), signedOut: SIGNED_OUT } : kimiJob('api', prompt, { sessionId });

describe.skipIf(!hasTmux)('Codex and Kimi turns ended by API errors', () => {
  afterEach(async () => { vi.restoreAllMocks(); await host?.stop(); });

  it.each(failures)('fails a Hornhoof $program turn on $prompt and keeps the program for the next turn', async ({ program, prompt, reason, error }) => {
    await setUp();
    const first = await host.run(job(program, 'hello'));
    const pid = await tmux.programPid('a-api');
    expect(pid).not.toBeNull();
    const kill = vi.spyOn(tmux, 'kill');
    const started = Date.now();
    const result = await host.run(job(program, prompt, first.sessionId));
    expect(result).toMatchObject({ ok: false, error, result: '', sessionId: first.sessionId });
    expect(result.output.endsWith(reason)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(kill).not.toHaveBeenCalled();
    expect(await tmux.programPid('a-api')).toBe(pid);
    expect(await host.run(job(program, 'next', first.sessionId))).toMatchObject({ ok: true, result: 'echo: next', sessionId: first.sessionId });
    expect(await tmux.programPid('a-api')).toBe(pid);
  });

  it.each(failures)('fails a typed $program turn on $prompt and keeps the program for the next turn', async ({ program, prompt, reason, error }) => {
    await setUp();
    const first = await host.run(job(program, 'hello'));
    const pid = await tmux.programPid('a-api');
    expect(pid).not.toBeNull();
    const kill = vi.spyOn(tmux, 'kill');
    const started = Date.now();
    await typeTurn('api', 'api-view', prompt, 'job-api');
    await until(() => Boolean(done('job-api')));
    expect(done('job-api')).toMatchObject({ ok: false, error, result: '', tail: reason, sessionId: first.sessionId });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(host.typedJobs()).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
    expect(await tmux.programPid('a-api')).toBe(pid);
    expect(await host.run(job(program, 'next', first.sessionId))).toMatchObject({ ok: true, result: 'echo: next', sessionId: first.sessionId });
    expect(await tmux.programPid('a-api')).toBe(pid);
  });

  it('keeps a usage-limit reason in the last 1500 characters after a long screen', async () => {
    await setUp();
    const reason = failures.find(f => f.prompt === 'APIFAIL_LIMIT')!.reason;
    const result = await host.run(job('codex', 'APIFAIL_LIMIT LONG'));
    expect(result.output.length).toBeGreaterThan(1500);
    expect(result.output.slice(-1500)).toContain(reason);
    expect(result.output.endsWith(reason)).toBe(true);
    expect(result).toMatchObject({ ok: false, error: 'agent_failed', result: '' });
  });

  it("skips the last Codex turn's failure logged before the next prompt goes in", async () => {
    await setUp();
    const firstJob = job('codex', 'hello');
    const first = await host.run(firstJob);
    const rollout = findRollout(firstJob.home, firstJob.input.workDir, 0, first.sessionId)!;
    const paste = tmux.paste.bind(tmux);
    vi.spyOn(tmux, 'paste').mockImplementationOnce(async (name, text) => {
      appendFileSync(rollout.file, JSON.stringify(failures[0]!.line) + '\n');
      /* The observer reads the late end while the next prompt has not gone in. */
      await new Promise(r => setTimeout(r, 300));
      await paste(name, text);
    });
    expect(await host.run(job('codex', 'next', first.sessionId))).toMatchObject({ ok: true, result: 'echo: next', sessionId: first.sessionId });
  });
});
