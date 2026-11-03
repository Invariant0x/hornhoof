import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIGNED_OUT } from '../src/providers/claude.js';
import { hasTmux, host, tmux, setUp, job, done, typeTurn, until } from './terminal-host-helpers.js';

/* The reason is the error's kind and its details, or the API error's text Claude Code puts in last_assistant_message. */
const failures = [
  ['APIFAIL_REAL', 'server_error: API Error: Connection refused (ECONNREFUSED)'],
  ['APIFAIL', 'server_error: Overloaded'],
  ['APIFAIL_MISSING', 'Overloaded'],
  ['APIFAIL_EMPTY', 'Overloaded'],
  ['APIFAIL_KIND', 'server_error: API Error: Overloaded'],
  ['APIFAIL_BARE', 'API Error: Overloaded'],
  ['APIFAIL_NOTHING', 'unknown'],
] as const;

describe.skipIf(!hasTmux)('Claude Code turns ended by StopFailure', () => {
  afterEach(async () => { vi.restoreAllMocks(); await host?.stop(); });

  it.each(failures)('fails a Hornhoof turn on %s and takes the next prompt in the same program', async (prompt, reason) => {
    await setUp();
    const first = await host.run(job('api', 'hello'));
    const pid = await tmux.programPid('a-api');
    expect(pid).not.toBeNull();
    const keys = vi.spyOn(tmux, 'keys');
    const kill = vi.spyOn(tmux, 'kill');
    const started = Date.now();
    const result = await host.run(job('api', prompt, { sessionId: first.sessionId }));
    expect(result).toMatchObject({ ok: false, error: 'agent_failed', result: '', sessionId: first.sessionId });
    expect(result.output.startsWith(`${reason}\n\n`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(keys.mock.calls.flatMap(([, ...keys]) => keys)).toEqual(['Enter']);
    expect(kill).not.toHaveBeenCalled();
    expect(await tmux.programPid('a-api')).toBe(pid);
    expect(await host.run(job('api', 'next', { sessionId: first.sessionId }))).toMatchObject({ ok: true, result: 'echo: next', sessionId: first.sessionId });
    expect(await tmux.programPid('a-api')).toBe(pid);
  });

  it.each(failures)('fails a typed turn on %s and takes the next prompt in the same program', async (prompt, reason) => {
    await setUp();
    const first = await host.run(job('typed-api', 'hello'));
    const pid = await tmux.programPid('a-typed-api');
    expect(pid).not.toBeNull();
    const keys = vi.spyOn(tmux, 'keys');
    const kill = vi.spyOn(tmux, 'kill');
    const started = Date.now();
    await typeTurn('typed-api', 'api-view', prompt, 'job-api');
    await until(() => Boolean(done('job-api')));
    expect(done('job-api')).toMatchObject({ ok: false, error: 'agent_failed', result: '', tail: reason, sessionId: first.sessionId });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(host.typedJobs()).toEqual([]);
    expect(keys).not.toHaveBeenCalled();
    expect(kill).not.toHaveBeenCalled();
    expect(await tmux.programPid('a-typed-api')).toBe(pid);
    expect(await host.run(job('typed-api', 'next', { sessionId: first.sessionId }))).toMatchObject({ ok: true, result: 'echo: next', sessionId: first.sessionId });
    expect(await tmux.programPid('a-typed-api')).toBe(pid);
  });

  it.each([
    ['APIFAIL_AUTH_REAL', 'authentication_failed: API Error: 401 · Please run /login'],
    ['APIFAIL_AUTH', 'authentication_failed: Please run /login'],
    ['APIFAIL_AUTH_MISSING', 'Please run /login'],
  ])('ends a Hornhoof turn as not logged in on %s', async (prompt, reason) => {
    await setUp();
    const result = await host.run({ ...job('auth-api', prompt), signedOut: SIGNED_OUT });
    expect(result).toMatchObject({ ok: false, error: 'not_logged_in', result: '' });
    expect(result.output).toContain(reason);
  });
});
