import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findKimiWire } from '../src/terminal/programs.js';
import { hasTmux, until, host, sent, home, setUp, kimiJob, done, typeTurn } from './terminal-host-helpers.js';

describe.skipIf(!hasTmux)('agents in live terminals', () => {
  afterEach(async () => host?.stop());

  it('takes live words from the empty input box during a turn', async () => {
    await setUp();
    const first = await host.run(kimiJob('live-kimi', 'warm up'));
    const running = host.run(kimiJob('live-kimi', 'HANG', { sessionId: first.sessionId }));
    await until(async () => (await host.screen('live-kimi')).includes('waiting: HANG'));
    expect(await host.say('live-kimi', 'SLOW Use the new schema.')).toBe(true);
    expect(await running).toMatchObject({ ok: true, result: 'echo: SLOW Use the new schema.' });
  });

  it('runs a turn in Kimi, with the answer and limits, and opens a turn for what a person typed in it', async () => {
    await setUp();
    const first = kimiJob('k1', 'hello');
    const res = await host.run(first);
    expect(res).toMatchObject({ ok: true, result: 'echo: hello', error: null });
    expect(res.sessionId).toMatch(/^session_[0-9a-f-]{36}$/);
    expect(res.limits?.windows[0]).toMatchObject({ name: 'five_hour', utilization: 0.3 });
    expect(first.events).toEqual([{ kind: 'text', text: 'echo: hello' }]);
    await typeTurn('k1', 'w1', 'typed in kimi', 'job-kimi');
    expect(sent.find(m => m.type === 'turn.open')).toEqual({ type: 'turn.open', agentKey: 'k1', text: 'typed in kimi', ref: expect.any(String) });
    await until(() => Boolean(done('job-kimi')));
    expect(done('job-kimi')).toMatchObject({ ok: true, result: 'echo: typed in kimi', sessionId: res.sessionId });
    expect(sent).toContainEqual({ type: 'job.event', jobId: 'job-kimi', seq: 0, event: { kind: 'text', text: 'echo: typed in kimi' } });
  });

  it('goes on in the same Kimi for the next turn, and resumes its session once Kimi ended', async () => {
    await setUp();
    const first = await host.run(kimiJob('k2', 'one'));
    expect(await host.run(kimiJob('k2', 'two', { sessionId: first.sessionId }))).toMatchObject({ ok: true, result: 'echo: two', sessionId: first.sessionId });
    expect((await host.screen('k2')).match(/fake kimi new/g)).toHaveLength(1);
    expect(await host.run(kimiJob('k2', 'EXIT', { sessionId: first.sessionId }))).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(await host.run(kimiJob('k2', 'three', { sessionId: first.sessionId }))).toMatchObject({ ok: true, result: 'echo: three', sessionId: first.sessionId });
    expect(await host.screen('k2')).toContain(`fake kimi resumed ${first.sessionId}`);
  });

  it('stops a Kimi turn with Escape, as Hornhoof calls it off or a person stops it, and takes the next turn', async () => {
    await setUp();
    const first = await host.run(kimiJob('k3', 'warm up'));
    const stop = new AbortController();
    const running = host.run(kimiJob('k3', 'HANG', { sessionId: first.sessionId, signal: stop.signal }));
    setTimeout(() => stop.abort(), 300);
    const started = Date.now();
    expect(await running).toMatchObject({ ok: false, error: 'cancelled' });
    expect(await host.run(kimiJob('k3', 'ABORT', { sessionId: first.sessionId }))).toMatchObject({ ok: false, error: 'cancelled' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await host.run(kimiJob('k3', 'next', { sessionId: first.sessionId }))).toMatchObject({ ok: true, result: 'echo: next' });
    await typeTurn('k3', 'w3', 'HANG typed', 'job-k3');
    /* Hornhoof's acknowledgment can arrive before Kimi accepted the prompt and has a running turn to stop. */
    await until(() => {
      const wire = first.sessionId && findKimiWire(join(home, 'kimi', 'k3'), first.sessionId);
      return Boolean(wire && readFileSync(wire, 'utf8').includes('"text":"HANG typed"'));
    });
    await until(async () => (await host.screen('k3')).includes('waiting: HANG typed'));
    host.input({ type: 'term.input', termId: 'w3', data: '\u001b' });
    await until(() => Boolean(done('job-k3')));
    expect(done('job-k3')).toMatchObject({ ok: false, error: 'cancelled' });
  }, 30_000);

  it("hands on Kimi's whole last message, made of several parts", async () => {
    await setUp();
    expect(await host.run(kimiJob('k6', 'PARTS'))).toMatchObject({ ok: true, result: 'first half. second half.' });
  });

  it('waits for the last Kimi wire part after Stop in Hornhoof and typed turns', async () => {
    await setUp();
    const res = await host.run(kimiJob('late-parts', 'PARTS_HOOKFIRST'));
    expect(res).toMatchObject({ ok: true, result: 'first half. second half.' });
    await typeTurn('late-parts', 'late-view', 'PARTS_HOOKFIRST', 'late-job');
    await until(() => Boolean(done('late-job')));
    expect(done('late-job')).toMatchObject({ ok: true, result: 'first half. second half.' });
    expect(sent.filter(m => m.type === 'job.done' && m.jobId === 'late-job')).toHaveLength(1);
  });

  it("fails a turn whose prompt one of Kimi's own hooks blocked, at once, and takes the next turn", async () => {
    await setUp();
    const started = Date.now();
    expect(await host.run(kimiJob('k7', 'BLOCKED'))).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await host.run(kimiJob('k7', 'next'))).toMatchObject({ ok: true, result: 'echo: next' });
    await typeTurn('k7', 'w7', 'BLOCKED typed', 'job-k7');
    await until(() => Boolean(done('job-k7')));
    expect(done('job-k7')).toMatchObject({ ok: false, error: 'agent_failed' });
  }, 30_000);
});
