import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent, NodeMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { TerminalHost, type TermJob } from '../src/terminal/host.js';
import { claudeProgram } from '../src/terminal/programs.js';
import { Tmux } from '../src/terminal/tmux.js';

const FAKE = fileURLToPath(new URL('./fakes/fake-term.mjs', import.meta.url));
const SECRET = 'sk-fake-0123456789abcdef';

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
})();

const until = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) if (await check()) return;
  throw new Error('timed out');
};

describe.skipIf(!hasTmux)('agents in live terminals', () => {
  let host: TerminalHost;
  let sent: NodeMessage[];
  const home = mkdtempSync(join(tmpdir(), 'hh-home-'));

  function setUp() {
    sent = [];
    const tmux = new Tmux({ socket: `hh-host-${process.pid}-${Math.random().toString(36).slice(2, 8)}`, env: { PATH: process.env.PATH ?? '', HOME: home } });
    host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: m => sent.push(m), secrets: () => [SECRET], readyMs: 10_000, pollMs: 100 });
    return host.start();
  }
  afterEach(async () => host?.stop());

  const job = (key: string, prompt: string, more: Partial<TermJob['input']> = {}): TermJob & { events: AgentEvent[] } => {
    const events: AgentEvent[] = [];
    return {
      key,
      program: claudeProgram,
      bin: FAKE,
      home,
      signedOut: /not logged in/i,
      events,
      input: { prompt, sessionId: null, model: null, workDir: join(home, 'work', key), secret: null, timeoutMs: 20_000, instructions: 'Be brief.', tools: { url: 'http://x/mcp', token: 'tok-turn' }, onEvent: e => events.push(e), env: { FAKE_SECRET: SECRET }, ...more },
    };
  };

  it('runs a turn in the agent session: pastes the prompt, shows what it does and ends with its answer and limits', async () => {
    await setUp();
    const j = job('a1', 'hello there');
    const res = await host.run(j);
    expect(res).toMatchObject({ ok: true, result: 'echo: hello there', error: null });
    expect(res.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.limits?.windows[0]).toMatchObject({ name: 'five_hour', utilization: 0.4 });
    expect(j.events).toEqual([{ kind: 'text', text: 'echo: hello there' }]);
  });

  it("keeps a turn's answer with its turn when the program logs it after saying the turn ended", async () => {
    await setUp();
    const first = job('a12', 'LAG one');
    const done = await host.run(first);
    expect(done).toMatchObject({ ok: true, result: 'echo: LAG one' });
    expect(first.events).toEqual([{ kind: 'text', text: 'echo: LAG one' }]);
    const second = job('a12', 'two', { sessionId: done.sessionId });
    await host.run(second);
    expect(second.events).toEqual([{ kind: 'text', text: 'echo: two' }]);
  });

  it('goes on in the same live program for the next turn, and resumes the session once the program ended', async () => {
    await setUp();
    const first = await host.run(job('a2', 'one'));
    const second = await host.run(job('a2', 'two', { sessionId: first.sessionId }));
    expect(second).toMatchObject({ ok: true, result: 'echo: two', sessionId: first.sessionId });
    expect((await host.screen('a2')).match(/fake claude new/g)).toHaveLength(1);

    const ended = await host.run(job('a2', 'EXIT', { sessionId: first.sessionId }));
    expect(ended).toMatchObject({ ok: false, error: 'agent_failed' });
    const third = await host.run(job('a2', 'three', { sessionId: first.sessionId }));
    expect(third).toMatchObject({ ok: true, result: 'echo: three' });
    expect(await host.screen('a2')).toContain(`fake claude resumed ${first.sessionId}`);
  });

  it('starts a new session when Hornhoof asks for one', async () => {
    await setUp();
    const first = await host.run(job('a3', 'one'));
    const fresh = await host.run(job('a3', 'two', { sessionId: null }));
    expect(fresh.ok).toBe(true);
    expect(fresh.sessionId).not.toBe(first.sessionId);
  });

  it('stops a turn Hornhoof calls off', async () => {
    await setUp();
    await host.run(job('a4', 'warm up'));
    const stop = new AbortController();
    const running = host.run(job('a4', 'SLOW', { signal: stop.signal }));
    setTimeout(() => stop.abort(), 300);
    expect(await running).toMatchObject({ ok: false, error: 'cancelled' });
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
    expect(sent.find(m => m.type === 'turn.open')).toEqual({ type: 'turn.open', agentKey: 'a5', text: 'typed by Ivan' });
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

  it('shows a waiting screen for an agent that has not started yet, and ends the view when asked', async () => {
    await setUp();
    await host.open({ type: 'term.open', termId: 't3', agentKey: 'a7', cols: 80, rows: 24, write: true });
    const screen = () => sent.flatMap(m => (m.type === 'term.data' && m.termId === 't3' ? [m.data] : [])).join('');
    await until(() => screen().includes('starts with its next turn'));
    host.close({ type: 'term.close', termId: 't3' });
    await until(() => sent.some(m => m.type === 'term.exit' && m.termId === 't3'));
  });
});
