import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentEvent, NodeMessage, ServerMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCREEN_SIGNED_OUT } from '../src/providers/kimi.js';
import { isRecord } from '../src/providers/events.js';
import { runJob, type ProviderAdapter } from '../src/runner.js';
import { rememberSession } from '../src/state.js';
import { TerminalHost } from '../src/terminal/host.js';
import { codexProgram, kimiProgram } from '../src/terminal/programs.js';
import { Tmux } from '../src/terminal/tmux.js';

const JOB = '00000000-0000-4000-8000-000000000074';
const AGENT = '00000000-0000-4000-8000-000000000075';
const SESSION = 'synthetic-phase-session';
const CANARY = 'synthetic-phase-secret-0123456789';
const fixtures: { host: TerminalHost; root: string }[] = [];

async function advance(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 25) await vi.advanceTimersByTimeAsync(Math.min(25, ms - elapsed));
}

function fixture(screen: string, kind: 'kimi' | 'codex' = 'kimi') {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval'] });
  vi.setSystemTime(Date.UTC(2026, 10, 1));
  const root = mkdtempSync(join(tmpdir(), 'hh-phase-'));
  const home = join(root, 'home');
  const workDir = join(root, 'work', 'agents', AGENT);
  const wire = kind === 'kimi' ? join(home, 'sessions', 'fixture-workspace', SESSION, 'agents', 'main', 'wire.jsonl') : join(home, 'sessions', '2026', '11', '01', `rollout-fixture-${SESSION}.jsonl`);
  mkdirSync(dirname(wire), { recursive: true });
  mkdirSync(workDir, { recursive: true });
  writeFileSync(wire, kind === 'kimi' ? '' : JSON.stringify({ type: 'session_meta', payload: { id: SESSION, cwd: workDir } }) + '\n');
  rememberSession(root, SESSION, workDir);
  const pane = { dead: false, queryFails: false, screen, paste: 0, enter: 0 };
  const tmux = new Tmux({ socket: 'isolated-phase-run-stub', env: { PATH: 'fixture-only' } });
  vi.spyOn(tmux, 'run').mockImplementation(async (args: string[]) => {
    if (args[0] === 'display-message' && args.includes('#{pane_dead}')) {
      if (pane.queryFails) throw new Error(CANARY);
      return pane.dead ? '1\n' : '0\n';
    }
    if (args[0] === 'capture-pane') return pane.screen;
    if (args[0] === 'paste-buffer') pane.paste++;
    if (args[0] === 'send-keys' && args.includes('Enter')) pane.enter++;
    return '';
  });
  const events: AgentEvent[] = [];
  const messages: NodeMessage[] = [];
  const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: m => messages.push(m), secrets: () => [CANARY], readyMs: 2000, pollMs: 25, enterWaitMs: 100, toolsMs: 100 });
  fixtures.push({ host, root });
  const adapter = (jobId: string): ProviderAdapter => ({
    install: async () => {}, loggedIn: async () => true, login: async () => {}, secrets: async () => [CANARY],
    run: input => {
      const job = { jobId, key: AGENT, program: kind === 'kimi' ? kimiProgram : codexProgram, bin: '/fixture/program', home, signedOut: SCREEN_SIGNED_OUT, input };
      return host.run(job);
    },
  });
  const job: Extract<ServerMessage, { type: 'job.run' }> = {
    type: 'job.run', jobId: JOB, subscriptionId: 'synthetic', provider: kind, prompt: 'synthetic prompt', sessionId: SESSION, model: null, timeoutMs: 60_000, secret: null, instructions: null, toolToken: null, workspace: { key: AGENT, repo: null },
  };
  const run = (over: Partial<typeof job> = {}) => {
    const message = { ...job, ...over };
    return runJob(adapter(message.jobId), message, root, { untimed: true, onEvent: e => events.push(e) });
  };
  const appendWire = (value: unknown) => appendFileSync(wire, `${JSON.stringify(value)}\n`);
  return { root, home, host, pane, job, events, messages, wire, run, appendWire };
}

function snapshots(root: string): unknown[] {
  const directory = join(root, 'terminal-phase');
  return existsSync(directory) ? readdirSync(directory).filter(file => file.endsWith('.json')).sort().map(file => JSON.parse(readFileSync(join(directory, file), 'utf8')) as unknown) : [];
}

async function acceptWire(test: ReturnType<typeof fixture>): Promise<void> {
  for (let tick = 0; tick < 100 && test.pane.enter === 0; tick++) await advance(25);
  expect(test.pane.enter).toBe(1);
  test.appendWire({ type: 'turn.prompt', prompt: CANARY });
  test.appendWire({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'WIRE_PROBE_READ' } } });
  const read = () => test.events.some(e => e.kind === 'text' && e.text === 'WIRE_PROBE_READ');
  for (let tick = 0; tick < 100 && !read(); tick++) await advance(25);
  expect(read()).toBe(true);
  expect(test.pane.enter).toBe(1);
}

afterEach(async () => {
  for (const { host, root } of fixtures.splice(0)) {
    await host.stop();
    rmSync(root, { recursive: true, force: true });
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('durable current terminal attempt', () => {
  it('has a readable correlated READY failure before the runner completes the job', async () => {
    const test = fixture('still loading without a READY footer');
    const pending = test.run();
    await advance(2300);
    const done = await pending;
    expect(done).toMatchObject({ jobId: JOB, ok: false, error: 'agent_failed' });
    expect(test.pane).toMatchObject({ dead: false, paste: 0, enter: 0 });
    const records = snapshots(test.root);
    expect(records.length).toBeGreaterThan(0);
    expect(records.at(-1)).toMatchObject({ trace: 'hh-terminal-phase-v1', jobId: JOB, agentKey: AGENT, phase: 'ready', finish: 'ready_deadline', counts: { paste: 0, enter: 0 }, pane: { queryOk: true, paneDead: false } });
    expect(done.tail).toContain('hh-terminal-phase-v1');
  });

  it('records the separate accept deadline and preserves the single paste and twenty Enter presses', async () => {
    const test = fixture('context: 42%');
    const pending = test.run();
    await advance(3500);
    const done = await pending;
    expect(done).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(done.tail).toContain("The program did not take Hornhoof's prompt within 2 s.");
    expect(test.pane).toMatchObject({ dead: false, paste: 1, enter: 20 });
    expect(snapshots(test.root).at(-1)).toMatchObject({ phase: 'accept', finish: 'accept_deadline', counts: { paste: 1, enter: 20 }, waits: { ready: { result: 'matched', budgetMs: 2000 }, accept: { result: 'deadline', budgetMs: 2000 } } });
  });

  it('records a done-loop wire failure and its metadata without the raw wire or secret message', async () => {
    const test = fixture('context: 42%');
    const pending = test.run();
    await acceptWire(test);
    test.appendWire({ type: 'turn.ended', reason: 'failed', error: { message: CANARY, cause: { stack: CANARY } } });
    await advance(200);
    const done = await pending;
    expect(done).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(test.pane).toMatchObject({ dead: false, paste: 1, enter: 1 });
    const records = snapshots(test.root);
    expect(records.at(-1)).toMatchObject({ phase: 'done', finish: 'wire_failed', ack: 'wire.turn.prompt', counts: { paste: 1, enter: 1 }, wire: { source: 'kimi_wire', recordType: 'turn.ended', pathHash: expect.stringMatching(/^[0-9a-f]{64}$/), cursorBefore: null, cursorAfter: null, cursorReason: 'not_exposed', nativeTurnHash: null } });
    expect(JSON.stringify(records)).not.toContain(CANARY);
    expect(JSON.stringify(records)).not.toContain(test.home);
    expect(done.tail + JSON.stringify(test.events)).not.toContain(CANARY);
  });

  it('distinguishes an observed dead pane after accept from a failed pane query', async () => {
    const test = fixture('context: 42%');
    const pending = test.run();
    await acceptWire(test);
    test.pane.dead = true;
    await advance(100);
    expect(await pending).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(snapshots(test.root).at(-1)).toMatchObject({ phase: 'done', finish: 'pane_dead', pane: { queryOk: true, paneDead: true, status: null, signal: null } });
  });

  it('keeps paneDead unknown when the READY query throws an error containing a secret', async () => {
    const test = fixture('still loading');
    test.pane.queryFails = true;
    const pending = test.run();
    await advance(100);
    expect(await pending).toMatchObject({ ok: false, error: 'agent_failed' });
    const records = snapshots(test.root);
    expect(records.at(-1)).toMatchObject({ phase: 'ready', finish: 'ready_query_failed', pane: { queryOk: false, paneDead: null, queryError: 'query_failed', status: null, signal: null } });
    expect(JSON.stringify(records)).not.toContain(CANARY);
  });

  it('records a failed done-loop query without claiming a physical pane exit', async () => {
    const test = fixture('context: 42%');
    const pending = test.run();
    await acceptWire(test);
    test.pane.queryFails = true;
    await advance(100);
    expect(await pending).toMatchObject({ ok: false, error: 'agent_failed' });
    expect(snapshots(test.root).at(-1)).toMatchObject({ phase: 'done', finish: 'pane_query_failed', pane: { queryOk: false, paneDead: null, queryError: 'query_failed' } });
  });

  it('persists a typed attempt without a guessed job, then binds its exact acknowledged ref', async () => {
    const test = fixture('OpenAI Codex\n›', 'codex');
    const starting = test.run({ prompt: '' });
    await advance(800);
    expect(await starting).toMatchObject({ ok: true });
    test.appendWire({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ text: 'synthetic typed prompt' }] } } });
    test.appendWire({ type: 'event_msg', payload: { type: 'task_started' } });
    for (let tick = 0; tick < 50 && !test.messages.some(m => m.type === 'turn.open'); tick++) await advance(25);
    const opened = test.messages.find(m => m.type === 'turn.open');
    if (!opened || opened.type !== 'turn.open' || !opened.ref) throw new Error('Expected a typed turn ref.');
    const before = snapshots(test.root).filter(record => isRecord(record) && record.origin === 'typed');
    expect(before).toContainEqual(expect.objectContaining({ origin: 'typed', jobId: null, phase: 'done', finish: null, gaps: expect.objectContaining({ jobId: 'not_bound' }) }));
    test.appendWire({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'synthetic typed result' } });
    await advance(50);
    const typedJob = '00000000-0000-4000-8000-000000000076';
    test.host.opened({ type: 'turn.opened', agentKey: AGENT, ref: opened.ref, jobId: typedJob, toolToken: CANARY });
    const after = snapshots(test.root).filter(record => isRecord(record) && record.origin === 'typed');
    expect(after).toContainEqual(expect.objectContaining({ jobId: typedJob, phase: 'done', event: 'bind', finish: 'wire_completed', outcome: 'ok' }));
    expect(test.messages).toContainEqual(expect.objectContaining({ type: 'job.done', jobId: typedJob, ok: true, result: 'synthetic typed result' }));
    expect(JSON.stringify(after)).not.toContain(CANARY);
    expect(test.pane).toMatchObject({ paste: 0, enter: 0 });
  });
});
