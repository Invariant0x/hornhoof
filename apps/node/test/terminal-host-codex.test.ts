import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hasTmux, home, until, host, tmux, sent, setUp, job, codexJob, done, ack, typeTurn } from './terminal-host-helpers.js';

describe.skipIf(!hasTmux)('agents in live terminals', () => {
  afterEach(async () => host?.stop());

  it('takes live words while its input shows the dim placeholder', async () => {
    await setUp();
    const first = await host.run(codexJob('live-codex', 'warm up'));
    const running = host.run(codexJob('live-codex', 'HANG', { sessionId: first.sessionId }));
    await until(async () => (await host.screen('live-codex')).includes('HANG'));
    expect(await host.say('live-codex', 'SLOW Use the new schema.')).toBe(true);
    expect(await running).toMatchObject({ ok: true, result: 'echo: SLOW Use the new schema.' });
  });

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

  it.each([['plainly', false], ['the way the server hands them', true]])('gives Codex the next words only once its log ended the last turn, not at its Stop hook, %s', async (_way, operator) => {
    await setUp({ readyMs: 3000, enterWaitMs: 500, ...(operator ? { pollMs: 25, operator: { dir: join(home, `operator-${randomUUID()}`), connected: () => true, send: () => true } } : {}) });
    const key = randomUUID();
    const turn = (words: string, sessionId: string | null = null) => host.run({
      ...codexJob(key, words, { agentKey: key, jobId: randomUUID(), sessionId, timeoutMs: 8000 }),
      ...(operator ? { operatorDelivery: { id: randomUUID(), ordinal: 1 } } : {}),
    });
    const first = await turn('CLOSING one');
    expect(first).toMatchObject({ ok: true, result: 'echo: CLOSING one' });
    expect(await turn('two', first.sessionId)).toMatchObject({ ok: true, result: 'echo: two' });
    const day = join(home, 'sessions', '2026', '10', '30');
    const log = readFileSync(join(day, readdirSync(day).find(name => name.endsWith(`-${first.sessionId}.jsonl`))!), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).payload);
    /* Each turn has its own start, or the words went into the one before and nothing says the program took them. */
    expect(log.filter(line => line.type === 'task_started')).toHaveLength(2);
    expect(log.filter(line => line.type === 'task_complete').map(line => line.last_agent_message)).toEqual(['echo: CLOSING one', 'echo: two']);
  }, 30_000);

  it("starts a new Codex session right after a turn without taking the last session's log for its own", async () => {
    await setUp();
    const first = await host.run(codexJob('c6', 'one'));
    expect(first).toMatchObject({ ok: true, result: 'echo: one' });
    /* Hornhoof asks for a new session at once: the last one's log was written a moment ago, the new one has none yet. */
    const fresh = codexJob('c6', 'two');
    const next = await host.run(fresh);
    expect(next).toMatchObject({ ok: true, result: 'echo: two' });
    expect(next.sessionId).not.toBe(first.sessionId);
    expect(fresh.events).not.toContainEqual({ kind: 'text', text: 'echo: one' });
    /* The program is free for the turn after. */
    const started = Date.now();
    expect(await host.run(codexJob('c6', 'three', { sessionId: next.sessionId }))).toMatchObject({ ok: true, result: 'echo: three' });
    expect(Date.now() - started).toBeLessThan(5000);
  }, 60_000);

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
    await until(() => Boolean(done('job-1') && done('job-2')));
    expect(done('job-1')).toMatchObject({ ok: true, result: 'echo: first typed' });
    expect(done('job-2')).toMatchObject({ ok: true, result: 'echo: second typed' });
    expect(sent).toContainEqual({ type: 'job.event', jobId: 'job-2', seq: 0, event: { kind: 'text', text: 'echo: second typed' } });
    expect(sent.filter(m => m.type === 'job.event' && m.jobId === 'job-1')).toHaveLength(1);
  });

  it('opens a turn for what a person typed into Codex just before it ended, though the host saw it end first', async () => {
    await setUp({ openMs: 100 });
    await host.run(codexJob('c5', 'warm up'));
    await host.open({ type: 'term.open', termId: 'v5', agentKey: 'c5', cols: 80, rows: 24, write: true });
    /* The host read the log and then asks whether the program lives; meanwhile it logs the words and ends. */
    const alive = tmux.alive.bind(tmux);
    let asked!: () => void;
    const asking = new Promise<void>(r => (asked = r));
    tmux.alive = async name => {
      asked();
      await until(async () => !(await alive(name)));
      return false;
    };
    await asking;
    host.input({ type: 'term.input', termId: 'v5', data: 'CRASH\r' });
    await until(() => sent.some(m => m.type === 'turn.open' && m.agentKey === 'c5'));
    ack('c5', 'job-c5');
    await until(() => Boolean(done('job-c5')));
    expect(done('job-c5')).toMatchObject({ ok: false, error: 'agent_failed' });
  });
});
