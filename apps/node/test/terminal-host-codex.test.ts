import { afterEach, describe, expect, it } from 'vitest';
import { hasTmux, until, host, sent, setUp, job, codexJob, done, ack, typeTurn } from './terminal-host-helpers.js';

describe.skipIf(!hasTmux)('agents in live terminals', () => {
  afterEach(async () => host?.stop());

  it('runs a turn in Codex and opens a turn for what a person typed in it', async () => {
    await setUp();
    const first = await host.run(codexJob('c1', 'hello'));
    expect(first).toMatchObject({ ok: true, result: 'echo: hello' });
    await typeTurn('c1', 'v1', 'typed in codex', 'job-codex');
    expect(sent.find(m => m.type === 'turn.open')).toEqual({ type: 'turn.open', agentKey: 'c1', text: 'typed in codex', ref: expect.any(String) });
    await until(() => Boolean(done('job-codex')));
    expect(done('job-codex')).toMatchObject({ ok: true, result: 'echo: typed in codex', sessionId: first.sessionId });
    expect(sent).toContainEqual({ type: 'job.event', jobId: 'job-codex', seq: 0, event: { kind: 'text', text: 'echo: typed in codex' } });
  });

  it('ends a Codex turn as stopped when a person stops it', async () => {
    await setUp();
    const first = await host.run(codexJob('c2', 'hello'));
    const started = Date.now();
    expect(await host.run(codexJob('c2', 'ABORT', { sessionId: first.sessionId }))).toMatchObject({ ok: false, error: 'cancelled' });
    expect(Date.now() - started).toBeLessThan(5000);
  }, 30_000);

  it("does not take the last turn's stop logged late for the end of the next turn", async () => {
    await setUp();
    const first = await host.run(codexJob('c3', 'LATE one'));
    expect(first).toMatchObject({ ok: true, result: 'echo: LATE one' });
    expect(await host.run(codexJob('c3', 'two', { sessionId: first.sessionId }))).toMatchObject({ ok: true, result: 'echo: two' });
  }, 30_000);

  it('goes on in the cleared session when Hornhoof asks for the session it was cleared from', async () => {
    await setUp();
    const first = await host.run(job('b10', 'hello'));
    await host.open({ type: 'term.open', termId: 'u8', agentKey: 'b10', cols: 80, rows: 24, write: true });
    host.input({ type: 'term.input', termId: 'u8', data: 'CLEAR\r' });
    await new Promise(r => setTimeout(r, 500));
    const next = await host.run(job('b10', 'after clear', { sessionId: first.sessionId }));
    expect(next).toMatchObject({ ok: true, result: 'echo: after clear' });
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(await host.screen('b10')).not.toContain('resumed');
  }, 30_000);

  it('keeps two turns typed into Codex apart while Hornhoof has not answered yet', async () => {
    await setUp();
    await host.run(codexJob('c4', 'hello'));
    await host.open({ type: 'term.open', termId: 'v2', agentKey: 'c4', cols: 80, rows: 24, write: true });
    host.input({ type: 'term.input', termId: 'v2', data: 'first typed\r' });
    await until(() => sent.filter(m => m.type === 'turn.open').length === 1);
    await until(async () => (await host.screen('c4')).includes('echo: first typed'));
    host.input({ type: 'term.input', termId: 'v2', data: 'second typed\r' });
    await until(() => sent.filter(m => m.type === 'turn.open').length === 2);
    await until(async () => (await host.screen('c4')).includes('echo: second typed'));
    ack('c4', 'job-1', 0);
    ack('c4', 'job-2', 1);
    expect(done('job-1')).toMatchObject({ ok: true, result: 'echo: first typed' });
    expect(done('job-2')).toMatchObject({ ok: true, result: 'echo: second typed' });
    expect(sent).toContainEqual({ type: 'job.event', jobId: 'job-2', seq: 0, event: { kind: 'text', text: 'echo: second typed' } });
    expect(sent.filter(m => m.type === 'job.event' && m.jobId === 'job-1')).toHaveLength(1);
  });
});
