import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NodeMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agyProgram } from '../src/terminal/programs.js';
import { ack, done, hasTmux, home, host, job, SECRET, sent, setUp, tmux, typeTurn, until } from './terminal-host-helpers.js';

type Report = Extract<NodeMessage, { type: 'job.program' }>;
const reports = (id: string) => sent.filter((m): m is Report => m.type === 'job.program' && m.jobId === id);
const AGY = fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url));

/* Simulate only the lost Stop; the real program, prompt hook, transcript and tmux observer keep running. */
function loseStop(): void {
  const hook = host['hook'].bind(host);
  vi.spyOn(host as unknown as { hook: typeof hook }, 'hook').mockImplementation((key, event, data) => event === 'stop' ? Promise.resolve() : hook(key, event, data));
}

async function typeWithoutAck(key: string, text: string): Promise<void> {
  await host.open({ type: 'term.open', termId: 'view', agentKey: key, cols: 100, rows: 30, write: true });
  host.input({ type: 'term.input', termId: 'view', data: `${text}\r` });
  await until(() => sent.some(m => m.type === 'turn.open' && m.agentKey === key));
}

describe.skipIf(!hasTmux)('observing turns people type in a terminal', () => {
  afterEach(async () => { vi.restoreAllMocks();await host?.stop(); });

  it.each(['claude', 'antigravity'] as const)('recovers a lost %s Stop with the answer and releases its tools without touching the program', async kind => {
    await setUp({ lostMs: 300, lookMs: 50, reportMs: 100 });
    const key = `typed-${kind}`;
    const start = job(key, '');
    if (kind === 'antigravity') Object.assign(start, { program: agyProgram, bin: AGY, home: join(home, key) });
    expect(await host.run(start)).toMatchObject({ ok: true });
    const pid = await tmux.programPid(`a-${key}`);
    loseStop();
    await typeTurn(key, 'view', 'hello', 'typed-job');
    const keys = vi.spyOn(tmux, 'keys');
    const kill = vi.spyOn(tmux, 'kill');
    await until(() => Boolean(done('typed-job')), 6000);
    expect(done('typed-job')).toMatchObject({ ok: true, error: null, result: expect.stringContaining(kind === 'claude' ? 'echo: hello' : 'FINISHED') });
    expect(reports('typed-job').at(-1)).toMatchObject({ state: 'idle' });
    expect(host.typedJobs()).toEqual([]);
    expect(await tmux.programPid(`a-${key}`)).toBe(pid);
    expect(keys.mock.calls).toEqual([]);
    expect(kill.mock.calls).toEqual([]);
    const url = host['bridge'].agent(key).mcpUrl;
    const tools = await fetch(url, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}' });
    expect(await tools.json()).toMatchObject({ error: { message: expect.stringContaining('No Hornhoof turn') } });
  });

  it('keeps a thinking typed turn open and reports it across several lost-end intervals', async () => {
    await setUp({ lostMs: 200, lookMs: 50, reportMs: 100 });
    await host.run(job('thinking', ''));
    await typeTurn('thinking', 'view', 'TICK here', 'thinking-job');
    await until(() => {
      const latest = reports('thinking-job').at(-1);
      return latest?.state === 'thinking' && Date.now() - latest.since > 600;
    });
    expect(done('thinking-job')).toBeUndefined();
    expect(await tmux.alive('a-thinking')).toBe(true);
    await until(() => Boolean(done('thinking-job')));
    expect(done('thinking-job')).toMatchObject({ ok: true, result: 'echo: TICK here' });
  });

  it('keeps diagnostics until the typed turn receives its confirmed job id', async () => {
    const logs: string[] = [];
    await setUp({ lostMs: 300, lookMs: 50, openMs: 50, log: line => logs.push(line) });
    await host.run(job('late', ''));
    loseStop();
    await typeWithoutAck('late', 'hello');
    await until(() => logs.some(line => line.includes('end seen without hook')), 6000);
    expect(sent.filter(m => m.type === 'job.program')).toEqual([]);
    expect(done('late-job')).toBeUndefined();
    ack('late', 'late-job');
    expect(reports('late-job').at(-1)).toMatchObject({ state: 'idle' });
    expect(done('late-job')).toMatchObject({ ok: true, result: 'echo: hello' });
  });

  it.each([true, false])('reports gone with a masked screen before completion (ack first: %s)', async ackFirst => {
    const remembered: string[] = [];
    await setUp({ lostMs: 10_000, lookMs: 50, openMs: 50, remember: session => remembered.push(session) });
    await host.run(job('gone', ''));
    await typeWithoutAck('gone', `HANG ${SECRET}`);
    if (ackFirst) ack('gone', 'gone-job');
    await until(async () => (await host.screen('gone')).includes('HANG'));
    process.kill((await tmux.programPid('a-gone'))!, 'SIGKILL');
    await until(async () => !(await tmux.alive('a-gone')));
    if (!ackFirst) {
      await until(() => remembered.length > 0);
      expect(reports('gone-job')).toEqual([]);
      ack('gone', 'gone-job');
    }
    await until(() => Boolean(done('gone-job')));
    const gone = reports('gone-job').at(-1)!;
    expect(gone).toMatchObject({ state: 'gone', screen: expect.stringContaining('[hidden]') });
    expect(JSON.stringify(gone)).not.toContain(SECRET);
    expect([{ exitCode: null, signal: 'SIGKILL' }, { exitCode: 137, signal: null }]).toContainEqual({ exitCode: gone.exitCode, signal: gone.signal });
    const events = sent.filter(m => (m.type === 'job.program' || m.type === 'job.done') && m.jobId === 'gone-job');
    expect(events.at(-2)).toMatchObject({ type: 'job.program', state: 'gone' });
    expect(events.at(-1)).toMatchObject({ type: 'job.done', ok: false, error: 'agent_failed' });
  });

  it('reports gone without inventing an exit code when the entire session disappeared', async () => {
    await setUp({ lostMs: 10_000, lookMs: 50 });
    await host.run(job('lost-session', ''));
    await typeTurn('lost-session', 'view', 'HANG here', 'lost-session-job');
    await tmux.kill('a-lost-session');
    await until(() => Boolean(done('lost-session-job')));
    expect(reports('lost-session-job').at(-1)).toMatchObject({ state: 'gone', exitCode: null, signal: null, screen: '' });
    expect(done('lost-session-job')).toMatchObject({ ok: false, error: 'agent_failed' });
  });
});
