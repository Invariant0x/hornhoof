import { afterEach, describe, expect, it } from 'vitest';
import { SECRET, hasTmux, host, tmux, setUp, job } from './terminal-host-helpers.js';

describe.skipIf(!hasTmux)('agents in live terminals', () => {
  afterEach(async () => host?.stop());

  it('presses Enter until the program takes the prompt, though it takes no keys for a while after it starts', async () => {
    await setUp({ enterWaitMs: 200 });
    const turn = host.run(job('a13', 'hello', { env: { FAKE_SECRET: SECRET, FAKE_DEAF_MS: '2500' } }));
    const late = new Promise(r => setTimeout(() => r('still waiting'), 8000));
    expect(await Promise.race([turn, late])).toMatchObject({ ok: true, result: 'echo: hello' });
  });

  it('ends a turn whose program never takes the prompt, with its screen, instead of waiting forever', async () => {
    await setUp({ enterWaitMs: 200, readyMs: 2000 });
    const turn = host.run(job('a14', 'hello', { env: { FAKE_SECRET: SECRET, FAKE_DEAF_MS: '60000' } }));
    const late = new Promise(r => setTimeout(() => r('still waiting'), 8000));
    const res = await Promise.race([turn, late]);
    expect(res).toMatchObject({ ok: false, error: 'agent_failed' });
    expect((res as { output: string }).output).toContain('did not take');
  });

  it('starts the program anew for the next turn after one it never took, resuming the session', async () => {
    await setUp({ enterWaitMs: 200, readyMs: 2000 });
    const first = await host.run(job('a16', 'hello', { env: { FAKE_SECRET: SECRET, FAKE_DEAF_ONCE_MS: '60000' } }));
    expect(first).toMatchObject({ ok: false, error: 'agent_failed' });
    const next = host.run(job('a16', 'next', { sessionId: first.sessionId, env: { FAKE_SECRET: SECRET, FAKE_DEAF_ONCE_MS: '60000' } }));
    const late = new Promise(r => setTimeout(() => r('still waiting'), 15000));
    expect(await Promise.race([next, late])).toMatchObject({ ok: true, result: 'echo: next' });
  });

  it("keeps the screen of a turn that ended with no answer, which says why, as when the provider refused the work", async () => {
    await setUp();
    const res = await host.run(job('a15', 'MUTE please'));
    expect(res).toMatchObject({ ok: true, result: '' });
    expect(res.output).toContain("This content can't be shown.");
  });

  it('keeps the program running after its turn, however long nobody needs it', async () => {
    await setUp();
    await host.run(job('a6', 'one'));
    await new Promise(r => setTimeout(r, 1000));
    expect(await tmux.alive('a-a6')).toBe(true);
  });

  it('takes the next turn at once after one was stopped, though the program says nothing when stopped', async () => {
    await setUp();
    const first = await host.run(job('a11', 'warm up'));
    const stop = new AbortController();
    const running = host.run(job('a11', 'HANG', { sessionId: first.sessionId, signal: stop.signal }));
    setTimeout(() => stop.abort(), 300);
    expect(await running).toMatchObject({ ok: false, error: 'cancelled' });
    const started = Date.now();
    expect(await host.run(job('a11', 'next', { sessionId: first.sessionId }))).toMatchObject({ ok: true, result: 'echo: next' });
    expect(Date.now() - started).toBeLessThan(5000);
  }, 30_000);
});
