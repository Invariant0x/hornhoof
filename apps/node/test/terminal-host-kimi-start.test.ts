import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hasTmux, until, host, sent, home, setUp, job, kimiJob, done, typeTurn, withTools } from './terminal-host-helpers.js';

describe.skipIf(!hasTmux)('agents in live terminals', () => {
  afterEach(async () => host?.stop());

  it('fails a Kimi turn that Kimi says failed, and tells a Kimi that is not signed in', async () => {
    await setUp();
    const failed = await host.run(kimiJob('k4', 'FAIL'));
    expect(failed).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(failed.output).toContain('The plan ran out.');
    const out = await host.run(kimiJob('k5', 'hello', { env: { FAKE_SIGNED_OUT: '1' } }));
    expect(out).toMatchObject({ ok: false, error: 'not_logged_in' });
    /* Its sign-in is why, not a prompt that never showed. */
    expect(out.failure?.text).not.toContain('did not show its prompt');
  });

  it('ends the loader of a view whose program could not start, so the person sees why on its screen', async () => {
    await setUp();
    await host.open({ type: 'term.open', termId: 't50', agentKey: 'k6', cols: 80, rows: 24, write: true });
    await until(() => sent.some(m => m.type === 'term.program' && m.termId === 't50'));
    expect(await host.run(kimiJob('k6', 'hello', { env: { FAKE_SIGNED_OUT: '1' } }))).toMatchObject({ ok: false, error: 'not_logged_in' });
    expect(sent.flatMap(m => (m.type === 'term.program' && m.termId === 't50' ? [m.running] : []))).toEqual([false, true]);
  });

  it('starts Kimi for a person at once, and gives their first message its tools once Hornhoof opened their turn', () =>
    withTools(async auths => {
      /* Kimi starts its session, and connects to its tools, only with the first message: there is nothing to wait for. */
      const start = await host.run(kimiJob('k6', '', { env: { FAKE_MCP_LIST_MS: '10' } }));
      expect(start).toMatchObject({ ok: true, sessionId: null });
      expect(auths).toEqual([]);
      await typeTurn('k6', 'w6', 'hello', 'job-k6');
      await until(() => Boolean(done('job-k6')));
      expect(done('job-k6')).toMatchObject({ ok: true, result: 'echo: hello', sessionId: expect.stringMatching(/^session_/) });
      await until(async () => (await host.screen('k6')).includes('tools:'));
      expect(await host.screen('k6')).toContain('tools: ok');
      expect(auths).toEqual(['Bearer tok-job-k6']);
    }));

  it('keeps the turn that resumes Kimi going until Kimi has its tools', () =>
    withTools(async auths => {
      const first = await host.run(kimiJob('k7', 'one'));
      await host.run(kimiJob('k7', 'EXIT', { sessionId: first.sessionId }));
      expect(await host.run(kimiJob('k7', '', { sessionId: first.sessionId, env: { FAKE_MCP_LIST_MS: '700' } }))).toMatchObject({ ok: true, sessionId: first.sessionId });
      await until(async () => (await host.screen('k7')).includes('tools:'));
      expect(await host.screen('k7')).toContain('tools: ok');
      expect(auths).toEqual(['Bearer tok-turn']);
    }));

  it('gives Kimi its instructions and the conversation from before, also when it resumes the session', async () => {
    await setUp();
    await host.run(kimiJob('k8', '', { context: 'Earlier: Ivan said we sell software.' }));
    const agents = () => readFileSync(join(home, 'work', 'k8', 'AGENTS.md'), 'utf8');
    expect(agents()).toContain('Be brief.');
    expect(agents()).toContain('we sell software');
    await typeTurn('k8', 'w8', 'hello', 'job-k8');
    await until(() => Boolean(done('job-k8')));
    const { sessionId } = done('job-k8') as { sessionId: string };
    await host.run(kimiJob('k8', 'EXIT', { sessionId }));
    expect(await host.run(kimiJob('k8', '', { sessionId }))).toMatchObject({ ok: true });
    expect(await host.screen('k8')).toContain(`fake kimi resumed ${sessionId}`);
    expect(agents()).toContain('we sell software');
  });

  it('follows the new session when a person starts one in Kimi', async () => {
    await setUp();
    const first = await host.run(kimiJob('k9', 'hello'));
    await host.open({ type: 'term.open', termId: 'w9', agentKey: 'k9', cols: 80, rows: 24, write: true });
    host.input({ type: 'term.input', termId: 'w9', data: '/new\r' });
    await new Promise(r => setTimeout(r, 500));
    const next = await host.run(kimiJob('k9', 'after new', { sessionId: first.sessionId }));
    expect(next).toMatchObject({ ok: true, result: 'echo: after new' });
    expect(next.sessionId).toMatch(/^session_/);
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(await host.screen('k9')).not.toContain('resumed');
  });

  it('takes an answer without a ref, from a Hornhoof before refs, for the oldest typed turn', async () => {
    await setUp();
    await host.run(job('b11', 'hello'));
    await host.open({ type: 'term.open', termId: 'u9', agentKey: 'b11', cols: 80, rows: 24, write: true });
    host.input({ type: 'term.input', termId: 'u9', data: 'HANG old server\r' });
    await until(() => sent.some(m => m.type === 'turn.open'));
    host.opened({ type: 'turn.opened', agentKey: 'b11', jobId: 'job-old', toolToken: 'tok-old' });
    expect(host.typedJobs()).toEqual(['job-old']);
  });
});
