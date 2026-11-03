import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NodeMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agyProgram } from '../src/terminal/programs.js';
import { ack, done, hasTmux, home, host, job, SECRET, sent, setUp, tmux, typeTurn, until, endsLost, pastLostEndWindows } from './terminal-host-helpers.js';

type Report = Extract<NodeMessage, { type: 'job.program' }>;
const reports = (id: string) => sent.filter((m): m is Report => m.type === 'job.program' && m.jobId === id);
const AGY = fileURLToPath(new URL('./fakes/agy', import.meta.url));

async function typeWithoutAck(key: string, text: string): Promise<void> {
  await host.open({ type: 'term.open', termId: 'view', agentKey: key, cols: 100, rows: 30, write: true });
  host.input({ type: 'term.input', termId: 'view', data: `${text}\r` });
  await until(() => sent.some(m => m.type === 'turn.open' && m.agentKey === key));
}

describe.skipIf(!hasTmux)('observing turns people type in a terminal', () => {
  afterEach(async () => { vi.restoreAllMocks(); await host?.stop(); });

  it.each(['claude', 'antigravity'] as const)('keeps lost %s end channels open until a person cancels it, without touching the program', async kind => {
    await setUp({ lookMs: 50, reportMs: 100 });
    const key = `typed-${kind}`;
    const start = job(key, '');
    if (kind === 'antigravity') Object.assign(start, { program: agyProgram, bin: AGY, home: join(home, key) });
    expect(await host.run(start)).toMatchObject({ ok: true });
    const pid = await tmux.programPid(`a-${key}`);
    endsLost();
    await typeTurn(key, 'view', 'hello', 'typed-job');
    const keys = vi.spyOn(tmux, 'keys');
    const kill = vi.spyOn(tmux, 'kill');
    const answer = kind === 'claude' ? 'echo: hello' : 'Git rebase';
    await until(async () => (await host.screen(key)).includes(answer));
    await until(() => reports('typed-job').length > 0);
    const clock = pastLostEndWindows();
    await new Promise(r => setTimeout(r, 400));
    expect(done('typed-job')).toBeUndefined();
    expect(new Set(reports('typed-job').map(m => m.state))).toEqual(new Set(['thinking']));
    expect(host.typedJobs()).toEqual(['typed-job']);
    expect(await tmux.programPid(`a-${key}`)).toBe(pid);
    expect(keys.mock.calls).toEqual([]);
    expect(kill.mock.calls).toEqual([]);
    clock.mockRestore();
    await host.cancel('typed-job');
    expect(done('typed-job')).toMatchObject({ ok: false, error: 'cancelled' });
    expect(host.typedJobs()).toEqual([]);
    expect(await tmux.programPid(`a-${key}`)).toBe(pid);
    const url = host['bridge'].agent(key).mcpUrl;
    const tools = await fetch(url, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}' });
    expect(await tools.json()).toMatchObject({ error: { message: expect.stringContaining('No Hornhoof turn') } });
  });

  it('keeps a typed Claude turn with the current spinner thinking beyond three former lost-end windows until its Stop hook', async () => {
    await setUp({ lookMs: 50, reportMs: 100 });
    await host.run(job('thinking', ''));
    const stopHook = vi.spyOn(host as unknown as { hook: typeof host['hook'] }, 'hook');
    await typeTurn('thinking', 'view', 'SPINNER here', 'thinking-job');
    await until(async () => (await host.screen('thinking')).includes('Recombobulating'));
    await until(() => reports('thinking-job').length > 0);
    const clock = pastLostEndWindows();
    await new Promise(r => setTimeout(r, 400));
    expect(done('thinking-job')).toBeUndefined();
    expect(new Set(reports('thinking-job').map(m => m.state))).toEqual(new Set(['thinking']));
    expect(reports('thinking-job').length).toBeGreaterThanOrEqual(3);
    expect(await tmux.alive('a-thinking')).toBe(true);
    expect(stopHook.mock.calls.some(([, event]) => event === 'stop')).toBe(false);
    clock.mockRestore();
    await until(() => Boolean(done('thinking-job')));
    expect(done('thinking-job')).toMatchObject({ ok: true, result: 'echo: SPINNER here' });
    expect(stopHook.mock.calls.some(([, event]) => event === 'stop')).toBe(true);
  });

  it('keeps an unconfirmed typed turn open when both end channels are lost, then reports it under its confirmed job id', async () => {
    await setUp({ lookMs: 50, openMs: 50 });
    await host.run(job('late', ''));
    endsLost();
    await typeWithoutAck('late', 'hello');
    await until(async () => (await host.screen('late')).includes('echo: hello'));
    const clock = pastLostEndWindows();
    await new Promise(r => setTimeout(r, 400));
    expect(sent.filter(m => m.type === 'job.program')).toEqual([]);
    expect(done('late-job')).toBeUndefined();
    ack('late', 'late-job');
    expect(reports('late-job').at(-1)).toMatchObject({ state: 'thinking' });
    expect(done('late-job')).toBeUndefined();
    clock.mockRestore();
    await host.cancel('late-job');
    expect(done('late-job')).toMatchObject({ ok: false, error: 'cancelled' });
  });

  it.each([true, false])('reports gone with a masked screen before completion (ack first: %s)', async ackFirst => {
    const remembered: string[] = [];
    await setUp({ lookMs: 50, openMs: 50, remember: session => remembered.push(session) });
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
    await setUp({ lookMs: 50 });
    await host.run(job('lost-session', ''));
    await typeTurn('lost-session', 'view', 'HANG here', 'lost-session-job');
    await tmux.kill('a-lost-session');
    await until(() => Boolean(done('lost-session-job')));
    expect(reports('lost-session-job').at(-1)).toMatchObject({ state: 'gone', exitCode: null, signal: null, screen: '' });
    expect(done('lost-session-job')).toMatchObject({ ok: false, error: 'agent_failed' });
  });
});
