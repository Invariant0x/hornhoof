import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasTmux, until, host, tmux, sent, home, setUp, job, codexJob, kimiJob, done, ack, typeTurn } from './terminal-host-helpers.js';

describe.skipIf(!hasTmux)('agents in live terminals', () => {
  afterEach(async () => host?.stop());

  it('ends a turn as stopped when a person stops it with Escape in the terminal', async () => {
    await setUp();
    const first = await host.run(job('b1', 'warm up'));
    const started = Date.now();
    expect(await host.run(job('b1', 'INTERRUPT', { sessionId: first.sessionId }))).toMatchObject({ ok: false, error: 'cancelled' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await host.run(job('b1', 'next', { sessionId: first.sessionId }))).toMatchObject({ ok: true, result: 'echo: next' });
  }, 30_000);

  it('ends a typed turn as stopped when a person stops it with Escape', async () => {
    await setUp();
    await host.run(job('b2', 'hello'));
    await typeTurn('b2', 'u1', 'INTERRUPT typed', 'job-int');
    await until(() => Boolean(done('job-int')));
    expect(done('job-int')).toMatchObject({ ok: false, error: 'cancelled' });
    expect(host.typedJobs()).toEqual([]);
  });

  it('fails a typed turn whose program ended, and takes the next turn', async () => {
    await setUp();
    const first = await host.run(job('b3', 'hello'));
    await typeTurn('b3', 'u2', 'HANG typed', 'job-dead');
    process.kill((await host['opts'].tmux.programPid('a-b3'))!, 'SIGKILL');
    await until(() => Boolean(done('job-dead')));
    expect(done('job-dead')).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(host.typedJobs()).toEqual([]);
    expect(await host.run(job('b3', 'next', { sessionId: first.sessionId }))).toMatchObject({ ok: true, result: 'echo: next' });
  }, 30_000);

  it("takes Hornhoof's late answer for a typed turn that still runs", async () => {
    await setUp({ openMs: 300 });
    await host.run(job('b5', 'hello'));
    await host.open({ type: 'term.open', termId: 'u4', agentKey: 'b5', cols: 80, rows: 24, write: true });
    host.input({ type: 'term.input', termId: 'u4', data: 'HANG late\r' });
    await until(() => sent.some(m => m.type === 'turn.open'));
    await new Promise(r => setTimeout(r, 600));
    ack('b5', 'job-late');
    expect(host.typedJobs()).toEqual(['job-late']);
  });

  it('reports a typed turn that was over before Hornhoof opened it, once Hornhoof does', async () => {
    await setUp({ openMs: 300 });
    await host.run(job('b6', 'hello'));
    await host.open({ type: 'term.open', termId: 'u5', agentKey: 'b6', cols: 80, rows: 24, write: true });
    host.input({ type: 'term.input', termId: 'u5', data: 'quick\r' });
    await until(async () => (await host.screen('b6')).includes('echo: quick'));
    await new Promise(r => setTimeout(r, 300));
    ack('b6', 'job-over');
    expect(done('job-over')).toMatchObject({ ok: true, result: 'echo: quick' });
    const mine = sent.filter(m => (m.type === 'job.event' || m.type === 'job.done') && m.jobId === 'job-over').map(m => m.type);
    expect(mine).toEqual(['job.event', 'job.done']);
    expect(host.typedJobs()).toEqual([]);
  });

  it('shows nothing to a view Hornhoof closed while it was opening', async () => {
    await setUp();
    const opening = host.open({ type: 'term.open', termId: 'u6', agentKey: 'b7', cols: 80, rows: 24, write: true });
    host.close({ type: 'term.close', termId: 'u6' });
    await opening;
    await new Promise(r => setTimeout(r, 300));
    expect((await host['opts'].tmux.run(['list-clients'])).trim()).toBe('');
    expect(sent.some(m => m.type === 'term.data' && m.termId === 'u6')).toBe(false);
  });

  it("runs Hornhoof's turns for one agent one after another", async () => {
    await setUp();
    const [one, two] = await Promise.all([host.run(job('b8', 'one')), host.run(job('b8', 'two'))]);
    expect(one).toMatchObject({ ok: true, result: 'echo: one' });
    expect(two).toMatchObject({ ok: true, result: 'echo: two' });
  }, 30_000);

  it('follows the new session when a person clears the conversation', async () => {
    await setUp();
    const first = await host.run(job('b9', 'hello'));
    await host.open({ type: 'term.open', termId: 'u7', agentKey: 'b9', cols: 80, rows: 24, write: true });
    host.input({ type: 'term.input', termId: 'u7', data: 'CLEAR\r' });
    await new Promise(r => setTimeout(r, 500));
    host.input({ type: 'term.input', termId: 'u7', data: 'after clear\r' });
    await until(() => sent.some(m => m.type === 'turn.open'));
    host.opened({ type: 'turn.opened', agentKey: 'b9', jobId: 'job-clear', toolToken: 'tok-clear' });
    await until(() => Boolean(done('job-clear')));
    expect(done('job-clear')).toMatchObject({ ok: true, result: 'echo: after clear' });
    expect((done('job-clear') as { sessionId: string }).sessionId).not.toBe(first.sessionId);
    expect(sent).toContainEqual({ type: 'job.event', jobId: 'job-clear', seq: 0, event: { kind: 'text', text: 'echo: after clear' } });
  });

  it("tells Hornhoof how full each agent's context is, once it moved by a percent or more", async () => {
    await setUp();
    await host.run(job('x1', 'one'));
    await host.run(job('x1', 'two'));
    await host.run(codexJob('x2', 'hello'));
    mkdirSync(join(home, 'kimi', 'x3'), { recursive: true });
    writeFileSync(join(home, 'kimi', 'x3', 'config.toml'), 'default_model = "k"\n\n[models."k"]\nmax_context_size = 1048576\n');
    await host.run(kimiJob('x3', 'hello'));
    /* A person picked a smaller model in Kimi with /model. */
    writeFileSync(join(home, 'kimi', 'x3', 'config.toml'), 'default_model = "k"\n\n[models."k"]\nmax_context_size = 1048576\n\n[models."small"]\nmax_context_size = 524288\n', { flag: 'a' });
    await host.run(kimiJob('x3', 'SWITCH'));
    expect(sent.filter(m => m.type === 'agent.context')).toEqual([
      { type: 'agent.context', agentKey: 'x1', used: 0.25 },
      { type: 'agent.context', agentKey: 'x2', used: 0.5 },
      { type: 'agent.context', agentKey: 'x3', used: 0.25 },
      { type: 'agent.context', agentKey: 'x3', used: 0.5 },
    ]);
  });

  /* The host answers a turn as soon as it reads the end in the program's log, and Hornhoof's next turn can begin before
     the program's stop hook of that same end arrives. These two deliver that hook at a chosen point of the next turn. */
  it("gives the next turn its own answer when the last turn's stop arrives while the next program starts", async () => {
    await setUp();
    const first = await host.run(kimiJob('late1', 'hello'));
    const launch = tmux.launch.bind(tmux);
    vi.spyOn(tmux, 'launch').mockImplementation((...args) => {
      void host['hook']('late1', 'stop', { session_id: first.sessionId });
      return launch(...args);
    });
    const next = await host.run(kimiJob('late1', 'next'));
    expect(next).toMatchObject({ ok: true, result: 'echo: next' });
    expect(next.sessionId).not.toBe(first.sessionId);
  });

  it("stays in the next turn's session when the last turn's stop arrives after the next prompt went in", async () => {
    await setUp();
    const first = await host.run(kimiJob('late2', 'hello'));
    const stopping = new AbortController();
    const running = host.run(kimiJob('late2', 'HANG', { signal: stopping.signal }));
    await until(async () => (await host.screen('late2')).includes('waiting: HANG'));
    await host['hook']('late2', 'stop', { session_id: first.sessionId });
    const agent = host['agents'].get('late2')!;
    expect(agent.sessionId).not.toBe(first.sessionId);
    expect(agent.turn?.ending).toBeUndefined();
    stopping.abort();
    expect(await running).toMatchObject({ ok: false, error: 'cancelled' });
  });
});
