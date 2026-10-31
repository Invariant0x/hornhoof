import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentEvent, NodeMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { SCREEN_SIGNED_OUT } from '../src/providers/kimi.js';
import { TerminalHost, type TermJob } from '../src/terminal/host.js';
import { claudeProgram, codexProgram, kimiProgram } from '../src/terminal/programs.js';
import { Tmux } from '../src/terminal/tmux.js';

const FAKE = fileURLToPath(new URL('./fakes/fake-term.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./fakes/fake-codex-term.mjs', import.meta.url));
const FAKE_KIMI = fileURLToPath(new URL('./fakes/fake-kimi-term.mjs', import.meta.url));
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
  let tmux: Tmux;
  let sent: NodeMessage[];
  const home = mkdtempSync(join(tmpdir(), 'hh-home-'));

  function setUp(more: Partial<ConstructorParameters<typeof TerminalHost>[0]> = {}) {
    sent = [];
    tmux = new Tmux({ socket: `hh-host-${process.pid}-${Math.random().toString(36).slice(2, 8)}`, env: { PATH: process.env.PATH ?? '', HOME: home } });
    host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: m => sent.push(m), secrets: () => [SECRET], readyMs: 10_000, pollMs: 100, toolsMs: 300, ...more });
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

  const codexJob = (key: string, prompt: string, more: Partial<TermJob['input']> = {}) => ({ ...job(key, prompt, more), program: codexProgram, bin: FAKE_CODEX });
  /* Kimi keeps its settings in its home, which these tests give each agent of their own. */
  const kimiJob = (key: string, prompt: string, more: Partial<TermJob['input']> = {}) => ({
    ...job(key, prompt, more),
    program: { ...kimiProgram, limits: async () => ({ status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.3, resetsAt: null }] }) },
    bin: FAKE_KIMI,
    home: join(home, 'kimi', key),
    signedOut: SCREEN_SIGNED_OUT,
  });
  const done = (jobId: string) => sent.find(m => m.type === 'job.done' && m.jobId === jobId);
  /* Hornhoof answers the nth turn.open the node sent, naming it by its ref. */
  const ack = (key: string, jobId: string, nth = 0) => {
    const asked = sent.filter((m): m is Extract<NodeMessage, { type: 'turn.open' }> => m.type === 'turn.open' && m.agentKey === key)[nth];
    host.opened({ type: 'turn.opened', agentKey: key, jobId, toolToken: `tok-${jobId}`, ref: asked?.ref });
  };
  /* A person types a line into the agent's terminal, and Hornhoof opens a turn for it. */
  const typeTurn = async (key: string, termId: string, line: string, jobId: string) => {
    await host.open({ type: 'term.open', termId, agentKey: key, cols: 80, rows: 24, write: true });
    host.input({ type: 'term.input', termId, data: `${line}\r` });
    await until(() => sent.some(m => m.type === 'turn.open'));
    ack(key, jobId);
    await until(() => host.typedJobs().includes(jobId) || Boolean(done(jobId)));
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

  it('starts the program again in the same session when the agent was set to think harder', async () => {
    await setUp();
    const first = await host.run(job('a50', 'one', { effort: 'low' }));
    const second = await host.run(job('a50', 'two', { sessionId: first.sessionId, effort: 'max' }));
    expect(second).toMatchObject({ ok: true, result: 'echo: two', sessionId: first.sessionId });
    expect(await host.screen('a50')).toContain(`fake claude resumed ${first.sessionId}`);
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

  it('shows a waiting screen for an agent that has not started yet, and ends the view when asked', async () => {
    await setUp();
    await host.open({ type: 'term.open', termId: 't3', agentKey: 'a7', cols: 80, rows: 24, write: false });
    const screen = () => sent.flatMap(m => (m.type === 'term.data' && m.termId === 't3' ? [m.data] : [])).join('');
    await until(() => screen().includes('starts with its next turn'));
    host.close({ type: 'term.close', termId: 't3' });
    await until(() => sent.some(m => m.type === 'term.exit' && m.termId === 't3'));
  });

  it('asks Hornhoof to start an agent that does not run when someone who may type opens it', async () => {
    await setUp();
    const starts = (key: string) => sent.filter(m => m.type === 'agent.start' && m.agentKey === key).length;
    await host.open({ type: 'term.open', termId: 't30', agentKey: 'a30', cols: 80, rows: 24, write: true });
    const screen = () => sent.flatMap(m => (m.type === 'term.data' && m.termId === 't30' ? [m.data] : [])).join('');
    await until(() => screen().includes('Starting'));
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

  /* A Hornhoof that answers every tool call, and the tokens they came with. */
  async function withTools(test: (auths: string[]) => Promise<void>) {
    const auths: string[] = [];
    const hornhoof = createServer((req, res) => {
      auths.push(req.headers.authorization ?? '');
      req.resume().on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } })));
    });
    await new Promise<void>(r => hornhoof.listen(0, '127.0.0.1', r));
    try {
      await setUp({ hornhoof: `http://127.0.0.1:${(hornhoof.address() as AddressInfo).port}`, toolsMs: 5000 });
      await test(auths);
    } finally {
      hornhoof.close();
    }
  }

  it('keeps the turn that starts a program going until the program has its tools', () =>
    withTools(async auths => {
      /* The program connects to its tools a while after it is ready to take a prompt, as Codex and Claude Code do. */
      expect(await host.run(job('a42', '', { env: { FAKE_SECRET: SECRET, FAKE_MCP_LIST_MS: '700' } }))).toMatchObject({ ok: true });
      await until(async () => (await host.screen('a42')).includes('tools:'));
      expect(await host.screen('a42')).toContain('tools: ok');
      expect(auths).toEqual(['Bearer tok-turn']);
    }));

  it('gives a person who types while their program starts a turn of their own, once the program has its tools', () =>
    withTools(async auths => {
      const starting = host.run(job('a43', '', { env: { FAKE_SECRET: SECRET, FAKE_MCP_LIST_MS: '700' } }));
      await until(async () => (await host.screen('a43')).includes('fake claude new'));
      await host.open({ type: 'term.open', termId: 't43', agentKey: 'a43', cols: 80, rows: 24, write: true });
      host.input({ type: 'term.input', termId: 't43', data: 'hello\r' });
      await until(() => sent.some(m => m.type === 'turn.open' && m.agentKey === 'a43'));
      /* Hornhoof hears of the person's turn only once the start turn's token got the program its tools. */
      expect(auths).toEqual(['Bearer tok-turn']);
      expect(await starting).toMatchObject({ ok: true, sessionId: null });
      ack('a43', 'job-43');
      await until(() => Boolean(done('job-43')));
      expect(done('job-43')).toMatchObject({ ok: true, result: 'echo: hello' });
    }));

  it('gives a person who types into Codex while it starts a turn of their own', async () => {
    await setUp({ toolsMs: 1500 });
    const starting = host.run(codexJob('c43', ''));
    await until(async () => (await host.screen('c43')).includes('›'));
    await host.open({ type: 'term.open', termId: 'v43', agentKey: 'c43', cols: 80, rows: 24, write: true });
    host.input({ type: 'term.input', termId: 'v43', data: 'hello' });
    await new Promise(r => setTimeout(r, 200));
    host.input({ type: 'term.input', termId: 'v43', data: '\r' });
    await until(() => sent.some(m => m.type === 'turn.open' && m.agentKey === 'c43'));
    expect(await starting).toMatchObject({ ok: true });
    ack('c43', 'job-c43');
    await until(() => Boolean(done('job-c43')));
    expect(done('job-c43')).toMatchObject({ ok: true, result: 'echo: hello' });
  });

  it('remembers the session a person started by typing into a program started for them', async () => {
    const remembered: [string, string][] = [];
    await setUp({ remember: (sessionId, workDir) => remembered.push([sessionId, workDir]) });
    await host.run(job('a40', ''));
    await typeTurn('a40', 't40', 'hello', 'job-40');
    await until(() => Boolean(done('job-40')));
    const { sessionId } = done('job-40') as { sessionId: string };
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(remembered).toContainEqual([sessionId, join(home, 'work', 'a40')]);
  });

  it('gives a program started fresh the conversation from before, without counting it as new instructions', async () => {
    await setUp();
    await host.run(job('a41', '', { context: 'Earlier: Ivan said we sell software.' }));
    const file = readFileSync(join(home, 'work', 'a41', '.hh-instructions.md'), 'utf8');
    expect(file).toContain('Be brief.');
    expect(file).toContain('we sell software');
    expect(await host.run(job('a41', 'hello', { sessionId: null }))).toMatchObject({ ok: true, result: 'echo: hello' });
    expect((await host.screen('a41')).match(/fake claude new/g)).toHaveLength(1);
  });

  it('gives a Claude session it resumes the conversation from before that the session was started with', async () => {
    await setUp();
    await host.run(job('a44', '', { context: 'Earlier: Ivan said we sell software.', guidance: 'Your repository is ./shop.' }));
    expect(readFileSync(join(home, 'work', 'a44', '.hh-instructions.md'), 'utf8')).toContain('./shop');
    await typeTurn('a44', 't44', 'hello', 'job-44');
    await until(() => Boolean(done('job-44')));
    const { sessionId } = done('job-44') as { sessionId: string };
    await host.run(job('a44', 'EXIT', { sessionId }));
    /* Hornhoof goes on with the session and sends nothing from before: Claude Code's log has only what was said in it.
       Where the repository is comes fresh with each start, as it can change. */
    expect(await host.run(job('a44', '', { sessionId, guidance: 'Your repository is ./platform.' }))).toMatchObject({ ok: true });
    expect(await host.screen('a44')).toContain(`fake claude resumed ${sessionId}`);
    const told = readFileSync(join(home, 'work', 'a44', '.hh-instructions.md'), 'utf8');
    expect(told).toContain('we sell software');
    expect(told).toContain('./platform');
    expect(told).not.toContain('./shop');
  });

  it('tells Hornhoof of turns typed while the program starts one by one, in order, each after the last one ended', async () => {
    await setUp({ toolsMs: 1500 });
    const starting = host.run(codexJob('c46', ''));
    await until(async () => (await host.screen('c46')).includes('›'));
    await host.open({ type: 'term.open', termId: 'v46', agentKey: 'c46', cols: 80, rows: 24, write: true });
    for (const line of ['first', 'second']) {
      host.input({ type: 'term.input', termId: 'v46', data: line });
      await new Promise(r => setTimeout(r, 200));
      host.input({ type: 'term.input', termId: 'v46', data: '\r' });
      await until(async () => (await host.screen('c46')).includes(`echo: ${line}`));
    }
    await starting;
    const opens = () => sent.flatMap(m => (m.type === 'turn.open' ? [m.text] : []));
    await until(() => opens().length === 1);
    await new Promise(r => setTimeout(r, 300));
    /* Hornhoof takes a typed turn only when none runs: the second waits until the first is answered and over. */
    expect(opens()).toEqual(['first']);
    ack('c46', 'job-46a', 0);
    await until(() => opens().length === 2);
    expect(opens()).toEqual(['first', 'second']);
    const at = (found: (m: NodeMessage) => boolean) => sent.findIndex(found);
    expect(at(m => m.type === 'job.done' && m.jobId === 'job-46a')).toBeLessThan(at(m => m.type === 'turn.open' && m.text === 'second'));
    ack('c46', 'job-46b', 1);
    await until(() => Boolean(done('job-46b')));
    expect(done('job-46b')).toMatchObject({ ok: true, result: 'echo: second' });
  });

  it('starts the program in place of the waiting screen shown after its session was gone', async () => {
    await setUp();
    const first = await host.run(job('a45', 'hello'));
    await tmux.kill('a-a45');
    await host.open({ type: 'term.open', termId: 't45', agentKey: 'a45', cols: 80, rows: 24, write: true });
    expect(sent).toContainEqual({ type: 'agent.start', agentKey: 'a45' });
    expect(await host.run(job('a45', '', { sessionId: first.sessionId }))).toMatchObject({ ok: true, sessionId: first.sessionId });
    expect(await host.screen('a45')).toContain(`fake claude resumed ${first.sessionId}`);
  });

  it('resumes the session for a turn with nothing to type', async () => {
    await setUp();
    const first = await host.run(job('a34', 'one'));
    await host.run(job('a34', 'EXIT', { sessionId: first.sessionId }));
    const start = await host.run(job('a34', '', { sessionId: first.sessionId }));
    expect(start).toMatchObject({ ok: true, sessionId: first.sessionId });
    expect(await host.screen('a34')).toContain(`fake claude resumed ${first.sessionId}`);
  });

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

  it('ends a typed turn that runs too long', async () => {
    await setUp({ typedMs: 1000 });
    await host.run(job('b4', 'hello'));
    await typeTurn('b4', 'u3', 'HANG typed', 'job-long');
    await until(() => Boolean(done('job-long')));
    expect(done('job-long')).toMatchObject({ ok: false, error: 'timeout' });
    expect(host.typedJobs()).toEqual([]);
  });

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
    host.input({ type: 'term.input', termId: 'w3', data: '\u001b' });
    await until(() => Boolean(done('job-k3')));
    expect(done('job-k3')).toMatchObject({ ok: false, error: 'cancelled' });
  }, 30_000);

  it("hands on Kimi's whole last message, made of several parts", async () => {
    await setUp();
    expect(await host.run(kimiJob('k6', 'PARTS'))).toMatchObject({ ok: true, result: 'first half. second half.' });
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

  it('fails a Kimi turn that Kimi says failed, and tells a Kimi that is not signed in', async () => {
    await setUp();
    const failed = await host.run(kimiJob('k4', 'FAIL'));
    expect(failed).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(failed.output).toContain('The plan ran out.');
    expect(await host.run(kimiJob('k5', 'hello', { env: { FAKE_SIGNED_OUT: '1' } }))).toMatchObject({ ok: false, error: 'not_logged_in' });
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

  it('gives Kimi its instructions, the conversation from before and where it works, also when it resumes the session', async () => {
    await setUp();
    await host.run(kimiJob('k8', '', { context: 'Earlier: Ivan said we sell software.', guidance: 'Your repository is ./shop.' }));
    const agents = () => readFileSync(join(home, 'work', 'k8', 'AGENTS.md'), 'utf8');
    expect(agents()).toContain('Be brief.');
    expect(agents()).toContain('we sell software');
    expect(agents()).toContain('./shop');
    await typeTurn('k8', 'w8', 'hello', 'job-k8');
    await until(() => Boolean(done('job-k8')));
    const { sessionId } = done('job-k8') as { sessionId: string };
    await host.run(kimiJob('k8', 'EXIT', { sessionId }));
    expect(await host.run(kimiJob('k8', '', { sessionId, guidance: 'Your repository is ./platform.' }))).toMatchObject({ ok: true });
    expect(await host.screen('k8')).toContain(`fake kimi resumed ${sessionId}`);
    expect(agents()).toContain('we sell software');
    expect(agents()).toContain('./platform');
    expect(agents()).not.toContain('./shop');
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
