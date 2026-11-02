import { afterEach, describe, expect, it } from 'vitest';
import { SECRET, hasTmux, until, host, tmux, sent, setUp, job } from './terminal-host-helpers.js';

describe.skipIf(!hasTmux)('agents in live terminals', () => {
  afterEach(async () => host?.stop());

  it('lets Hornhoof stop a turn a person typed, and counts it as running until then', async () => {
    await setUp();
    const first = await host.run(job('a9', 'hello'));
    await host.open({ type: 'term.open', termId: 't5', agentKey: 'a9', cols: 80, rows: 24, write: true });
    host.input({ type: 'term.input', termId: 't5', data: 'HANG typed\r' });
    await until(() => sent.some(m => m.type === 'turn.open'));
    host.opened({ type: 'turn.opened', agentKey: 'a9', jobId: 'job-hang', toolToken: 'tok-hang' });
    await until(() => host.typedJobs().includes('job-hang'));
    await host.cancel('job-hang');
    expect(sent.find(m => m.type === 'job.done')).toMatchObject({ type: 'job.done', jobId: 'job-hang', ok: false, error: 'cancelled' });
    expect(host.typedJobs()).toEqual([]);
    expect(await host.run(job('a9', 'next', { sessionId: first.sessionId }))).toMatchObject({ ok: true, result: 'echo: next' });
  }, 30_000);

  it('ends a typed turn it is asked to stop when its terminal is gone', async () => {
    await setUp();
    await host.run(job('a14', 'hello'));
    await host.open({ type: 'term.open', termId: 't8', agentKey: 'a14', cols: 80, rows: 24, write: true });
    host.input({ type: 'term.input', termId: 't8', data: 'HANG typed\r' });
    await until(() => sent.some(m => m.type === 'turn.open'));
    host.opened({ type: 'turn.opened', agentKey: 'a14', jobId: 'job-gone', toolToken: 'tok-gone' });
    await until(() => host.typedJobs().includes('job-gone'));
    tmux.keys = async () => {
      throw new Error('no server running');
    };
    await host.cancel('job-gone');
    expect(sent.find(m => m.type === 'job.done')).toMatchObject({ jobId: 'job-gone', ok: false, error: 'cancelled' });
    expect(host.typedJobs()).toEqual([]);
  }, 30_000);

  it('sends the answer of a typed turn before its end, though the program logs it late', async () => {
    await setUp();
    await host.run(job('a13', 'hello'));
    await host.open({ type: 'term.open', termId: 't7', agentKey: 'a13', cols: 80, rows: 24, write: true });
    host.input({ type: 'term.input', termId: 't7', data: 'LAG typed\r' });
    await until(() => sent.some(m => m.type === 'turn.open'));
    host.opened({ type: 'turn.opened', agentKey: 'a13', jobId: 'job-lag', toolToken: 'tok-lag' });
    await until(() => sent.some(m => m.type === 'job.done'));
    const mine = sent.filter(m => (m.type === 'job.event' || m.type === 'job.done') && m.jobId === 'job-lag').map(m => m.type);
    expect(mine).toEqual(['job.event', 'job.done']);
    expect(sent).toContainEqual({ type: 'job.event', jobId: 'job-lag', seq: 0, event: { kind: 'text', text: 'echo: LAG typed' } });
  });

  it('ends every view when asked, as after the connection to Hornhoof came back', async () => {
    await setUp();
    await host.open({ type: 'term.open', termId: 't6', agentKey: 'a10', cols: 80, rows: 24, write: true });
    await until(() => sent.some(m => m.type === 'term.data' && m.termId === 't6'));
    host.closeViews();
    await until(() => sent.some(m => m.type === 'term.exit' && m.termId === 't6'));
  });

  it('shows people the live screen without secrets, and lets one who may type start a turn', async () => {
    await setUp();
    await host.run(job('a5', 'hello'));
    await host.open({ type: 'term.open', termId: 't1', agentKey: 'a5', cols: 100, rows: 30, write: true });
    const screen = () => sent.flatMap(m => (m.type === 'term.data' && m.termId === 't1' ? [m.data] : [])).join('');
    await until(() => screen().includes('echo: hello'));

    await host.run(job('a5', 'SECRET', { sessionId: (await host.run(job('a5', 'again'))).sessionId }));
    await until(() => screen().includes('the key is'));
    expect(screen()).not.toContain(SECRET);

    host.input({ type: 'term.input', termId: 't1', data: 'typed by Ivan\r' });
    await until(() => sent.some(m => m.type === 'turn.open'));
    expect(sent.find(m => m.type === 'turn.open')).toEqual({ type: 'turn.open', agentKey: 'a5', text: 'typed by Ivan', ref: expect.any(String) });
    host.opened({ type: 'turn.opened', agentKey: 'a5', jobId: 'job-typed', toolToken: 'tok-typed' });
    await until(() => sent.some(m => m.type === 'job.done'));
    expect(sent.find(m => m.type === 'job.done')).toMatchObject({ type: 'job.done', jobId: 'job-typed', ok: true, result: 'echo: typed by Ivan', error: null });
    expect(sent).toContainEqual({ type: 'job.event', jobId: 'job-typed', seq: 0, event: { kind: 'text', text: 'echo: typed by Ivan' } });
  });

  it('keeps a watcher who may not type from typing', async () => {
    await setUp();
    await host.run(job('a6', 'hello'));
    await host.open({ type: 'term.open', termId: 't2', agentKey: 'a6', cols: 80, rows: 24, write: false });
    await until(() => sent.some(m => m.type === 'term.data' && m.termId === 't2'));
    host.input({ type: 'term.input', termId: 't2', data: 'sneaky\r' });
    await new Promise(r => setTimeout(r, 800));
    expect(await host.screen('a6')).not.toContain('sneaky');
    expect(sent.some(m => m.type === 'turn.open')).toBe(false);
  });

  it("sizes the session to a watcher's window when it changes", async () => {
    await setUp();
    await host.open({ type: 'term.open', termId: 't4', agentKey: 'a8', cols: 80, rows: 24, write: true });
    await until(() => sent.some(m => m.type === 'term.data' && m.termId === 't4'));
    await host.resize({ type: 'term.resize', termId: 't4', cols: 132, rows: 40 });
    const size = () => host['opts'].tmux.run(['list-clients', '-F', '#{client_width}x#{client_height}']);
    await until(async () => (await size()).trim() === '132x40');
  });

  const clients = async () => (await tmux.run(['list-clients', '-F', '#{client_width}x#{client_height}'])).trim().split('\n').sort();
  const windowSize = async (key: string) => (await tmux.run(['list-windows', '-t', `=a-${key}`, '-F', '#{window_width}x#{window_height}'])).trim();

  it('keeps a size that came while its view was still opening', async () => {
    /* Hornhoof says the view is ready as it asks the node to open it, so a card that changes the window meanwhile sends
       its size before the view is there. */
    await setUp();
    const opening = host.open({ type: 'term.open', termId: 't60', agentKey: 'a60', cols: 158, rows: 29, write: true });
    await host.resize({ type: 'term.resize', termId: 't60', cols: 158, rows: 13 });
    await opening;
    await until(async () => (await clients()).join() === '158x13');
  });

  it('keeps a size that came before the view had its tmux client', async () => {
    await setUp();
    await host.open({ type: 'term.open', termId: 't61', agentKey: 'a61', cols: 158, rows: 29, write: true });
    await host.resize({ type: 'term.resize', termId: 't61', cols: 158, rows: 13 });
    await until(async () => (await clients()).join() === '158x13');
  });

  it('gives everyone watching one session the size of the smallest window, so no one gets filler dots or a size that jumps', async () => {
    await setUp();
    await host.run(job('a62', 'hello'));
    await host.open({ type: 'term.open', termId: 'big', agentKey: 'a62', cols: 120, rows: 40, write: true });
    await until(() => sent.some(m => m.type === 'term.data' && m.termId === 'big'));
    await host.open({ type: 'term.open', termId: 'small', agentKey: 'a62', cols: 80, rows: 20, write: true });
    await until(async () => (await clients()).join() === '80x20,80x20');
    for (const who of ['big', 'small', 'big', 'small']) {
      const from = sent.length;
      host.input({ type: 'term.input', termId: who, data: 'x' });
      await new Promise(r => setTimeout(r, 400));
      expect(await windowSize('a62')).toBe('80x20');
      const big = sent.slice(from).flatMap(m => (m.type === 'term.data' && m.termId === 'big' ? [m.data] : [])).join('');
      expect(big).not.toContain('·');
    }
    /* The smaller window leaves, and the other gets its own size back; then it follows its window again. */
    host.close({ type: 'term.close', termId: 'small' });
    await until(async () => (await clients()).join() === '120x40');
    await host.resize({ type: 'term.resize', termId: 'big', cols: 100, rows: 30 });
    await until(async () => (await clients()).join() === '100x30');
    expect(await windowSize('a62')).toBe('100x30');
  }, 30_000);

  it('clears the screen of a view whose terminal it makes smaller than its window, so no old lines stay below', async () => {
    await setUp();
    await host.open({ type: 'term.open', termId: 'wide', agentKey: 'a63', cols: 120, rows: 40, write: true });
    await until(() => sent.some(m => m.type === 'term.data' && m.termId === 'wide'));
    const from = sent.length;
    await host.open({ type: 'term.open', termId: 'narrow', agentKey: 'a63', cols: 80, rows: 20, write: true });
    await until(async () => (await clients()).join() === '80x20,80x20');
    await until(() => sent.slice(from).some(m => m.type === 'term.data' && m.termId === 'wide' && m.data.includes('\u001b[H\u001b[J')));
  });

  it('shows a waiting screen for an agent that has not started yet, and ends the view when asked', async () => {
    await setUp();
    await host.open({ type: 'term.open', termId: 't3', agentKey: 'a7', cols: 80, rows: 24, write: false });
    const screen = () => sent.flatMap(m => (m.type === 'term.data' && m.termId === 't3' ? [m.data] : [])).join('');
    await until(() => screen().includes('starts with its next turn'));
    host.close({ type: 'term.close', termId: 't3' });
    await until(() => sent.some(m => m.type === 'term.exit' && m.termId === 't3'));
  });

  it("tells a view while the agent's program is starting, and once it is up", async () => {
    await setUp();
    const states = (termId: string) => sent.flatMap(m => (m.type === 'term.program' && m.termId === termId ? [m.running] : []));
    await host.open({ type: 'term.open', termId: 't40', agentKey: 'a40', cols: 80, rows: 24, write: true });
    await until(() => states('t40').length > 0);
    expect(states('t40')).toEqual([false]);
    const screen = () => sent.flatMap(m => (m.type === 'term.data' && m.termId === 't40' ? [m.data] : [])).join('');
    expect(screen()).not.toContain('Starting');
    await host.run(job('a40', ''));
    await until(() => states('t40').length > 1);
    expect(states('t40')).toEqual([false, true]);
    /* A view opened on a program that runs hears so at once. */
    await host.open({ type: 'term.open', termId: 't41', agentKey: 'a40', cols: 80, rows: 24, write: true });
    await until(() => states('t41').length > 0);
    expect(states('t41')).toEqual([true]);
  });

  it('shows the last screen of a program that ended, which says why, instead of the loader', async () => {
    await setUp();
    const states = () => sent.flatMap(m => (m.type === 'term.program' && m.termId === 't42' ? [m.running] : []));
    await host.open({ type: 'term.open', termId: 't42', agentKey: 'a42', cols: 80, rows: 24, write: true });
    await host.run(job('a42', 'warm up'));
    expect(await host.run(job('a42', 'EXIT'))).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(states()[0]).toBe(false);
    expect(states().at(-1)).toBe(true);
  });

  it('asks Hornhoof to start an agent that does not run when someone who may type opens it', async () => {
    await setUp();
    const starts = (key: string) => sent.filter(m => m.type === 'agent.start' && m.agentKey === key).length;
    await host.open({ type: 'term.open', termId: 't30', agentKey: 'a30', cols: 80, rows: 24, write: true });
    await until(() => starts('a30') > 0);
    expect(starts('a30')).toBe(1);
    /* A watcher who may not type starts nothing, and a running program needs no start. */
    await host.open({ type: 'term.open', termId: 't31', agentKey: 'a31', cols: 80, rows: 24, write: false });
    await host.run(job('a32', 'hello'));
    await host.open({ type: 'term.open', termId: 't32', agentKey: 'a32', cols: 80, rows: 24, write: true });
    await until(() => sent.some(m => m.type === 'term.data' && m.termId === 't32'));
    expect(starts('a31') + starts('a32')).toBe(0);
  });

  it('starts the program for a turn with nothing to type, and the next turn goes on in it', async () => {
    await setUp();
    const start = await host.run(job('a33', ''));
    expect(start).toMatchObject({ ok: true, result: '', error: null });
    /* A new session has no log until something is said in it, so there is nothing to resume yet. */
    expect(start.sessionId).toBeNull();
    expect(await host.screen('a33')).not.toContain('echo:');
    const next = await host.run(job('a33', 'hello', { sessionId: null }));
    expect(next).toMatchObject({ ok: true, result: 'echo: hello' });
    expect((await host.screen('a33')).match(/fake claude new/g)).toHaveLength(1);
  });
});
