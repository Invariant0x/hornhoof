import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIGNED_OUT } from '../src/providers/antigravity.js';
import type { TermJob } from '../src/terminal/host.js';
import { agyProgram } from '../src/terminal/programs.js';
import { hasTmux, host, home, setUp, job, tmux, until } from './terminal-host-helpers.js';

const FAKE = fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url));
const agyJob = (key: string, prompt: string, env: Record<string, string> = {}, more: Partial<TermJob['input']> = {}) => ({
  ...job(key, prompt, { env: { FAKE_LOG: join(home, `agy-tools-${key}.log`), ...env }, ...more }), program: agyProgram, bin: FAKE, home: join(home, 'agy', key), signedOut: SIGNED_OUT,
}) satisfies TermJob;
const records = (key: string) => readFileSync(join(home, `agy-tools-${key}.log`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const turns = (key: string) => records(key).filter(r => 'turn' in r);

/* agy 1.4.12 loads the MCP servers of its folder in the background once its terminal starts, and a turn gets only the
   tools listed before it began. */
describe.skipIf(!hasTmux)("Antigravity and Hornhoof's tools", () => {
  afterEach(async () => {
    await host?.stop();
    vi.restoreAllMocks();
  });

  it("types Hornhoof's prompt only once agy has listed Hornhoof's tools, so its first turn has them", async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 5000 });
    expect(await host.run(agyJob('slow', 'hello', { FAKE_MCP_LIST_MS: '2500' }))).toMatchObject({ ok: true, result: 'FINISHED' });
    expect(turns('slow')).toEqual([{ turn: 'hello', tools: true }]);
  });

  it("ends the turn with a named reason when agy never gets Hornhoof's tools, and types nothing", async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 1000 });
    const res = await host.run(agyJob('none', 'hello', { FAKE_AGY_NO_TOOLS: '1' }));
    expect(res).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'tools', text: "Antigravity CLI did not get Hornhoof's tools within 1 s of showing its prompt.", retryable: true } });
    expect(turns('none')).toEqual([]);
  });

  it.each([
    ['while agy lists them later', 'later', 1500],
    ['while agy never lists them', 'never', 1500],
    ['as agy shows its prompt', 'shown', 0],
  ])('ends a turn stopped %s as stopped at once, and types nothing', async (_, key, after) => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 10_000 });
    const stop = new AbortController();
    const run = host.run(agyJob(key, 'hello', key === 'later' ? { FAKE_MCP_LIST_MS: '6000' } : { FAKE_AGY_NO_TOOLS: '1' }, { signal: stop.signal }));
    await until(async () => (await host.screen(key)).includes('? for shortcuts'));
    await new Promise(r => setTimeout(r, after));
    stop.abort();
    const stopped = Date.now();
    expect(await run).toMatchObject({ ok: false, error: 'cancelled' });
    expect(Date.now() - stopped).toBeLessThan(1500);
    expect(turns(key)).toEqual([]);
  });

  it("starts agy anew for Hornhoof's turn when the agy running for a person never listed Hornhoof's tools", async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 1000 });
    expect(await host.run(agyJob('person', '', { FAKE_AGY_NO_TOOLS: '1' }))).toMatchObject({ ok: true, sessionId: null });
    const pid = await tmux.programPid('a-person');
    const res = await host.run(agyJob('person', 'hello', { FAKE_AGY_NO_TOOLS: '1' }));
    expect(res).toMatchObject({ ok: false, failure: { kind: 'tools' } });
    expect(await tmux.programPid('a-person')).not.toBe(pid);
    expect(turns('person')).toEqual([]);
  });

  it('goes on in the agy that listed its tools, without starting it again', async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 5000 });
    const first = await host.run(agyJob('again', 'hello'));
    expect(first).toMatchObject({ ok: true, result: 'FINISHED' });
    const pid = await tmux.programPid('a-again');
    expect(await host.run(agyJob('again', 'Also say BANANA.', {}, { sessionId: first.sessionId }))).toMatchObject({ ok: true, result: 'BANANA' });
    expect(await tmux.programPid('a-again')).toBe(pid);
    expect(turns('again')).toEqual([{ turn: 'hello', tools: true }, { turn: 'Also say BANANA.', tools: true }]);
  });

  it('waits for the tools of the agy it starts, not those an agy before it listed', async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 1000 });
    expect(await host.run(agyJob('anew', 'hello'))).toMatchObject({ ok: true, result: 'FINISHED' });
    /* Another launch starts agy anew, and this agy never lists them. */
    expect(await host.run(agyJob('anew', 'hello', { FAKE_AGY_NO_TOOLS: '1' }))).toMatchObject({ ok: false, failure: { kind: 'tools' } });
    expect(turns('anew')).toEqual([{ turn: 'hello', tools: true }]);
  });

  it("counts no tools the agy before lists as Hornhoof's turn starts the next one in its place", async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 1000 });
    expect(await host.run(agyJob('replaced', 'hello'))).toMatchObject({ ok: true, result: 'FINISHED' });
    /* The agy before lists its tools once more just as the next one starts in its place, and that one never lists them. */
    const next = agyJob('replaced', 'hello', { FAKE_AGY_NO_TOOLS: '1' });
    const url = JSON.parse(readFileSync(join(next.input.workDir, '.agents', 'mcp_config.json'), 'utf8')).mcpServers.hornhoof.serverUrl;
    const launch = tmux.launch.bind(tmux);
    vi.spyOn(tmux, 'launch').mockImplementation(async (name, how) => {
      await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      return launch(name, how);
    });
    expect(await host.run(next)).toMatchObject({ ok: false, failure: { kind: 'tools' } });
    expect(turns('replaced')).toEqual([{ turn: 'hello', tools: true }]);
  });

  it("keeps the agy a person's window started, whether or not it listed Hornhoof's tools", async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 1000 });
    expect(await host.run(agyJob('window', '', { FAKE_AGY_NO_TOOLS: '1' }))).toMatchObject({ ok: true, sessionId: null });
    const pid = await tmux.programPid('a-window');
    expect(await host.run(agyJob('window', '', { FAKE_AGY_NO_TOOLS: '1' }))).toMatchObject({ ok: true, sessionId: null });
    expect(await tmux.programPid('a-window')).toBe(pid);
  });

  it("lets the agy a person's window started list Hornhoof's tools while that start lasts, so Hornhoof's turn goes on in it", async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 5000 });
    expect(await host.run(agyJob('opened', '', { FAKE_MCP_LIST_MS: '1500' }))).toMatchObject({ ok: true, sessionId: null });
    const pid = await tmux.programPid('a-opened');
    expect(await host.run(agyJob('opened', 'hello', { FAKE_MCP_LIST_MS: '1500' }))).toMatchObject({ ok: true, result: 'FINISHED' });
    expect(await tmux.programPid('a-opened')).toBe(pid);
    expect(turns('opened')).toEqual([{ turn: 'hello', tools: true }]);
  });

  it("lets the agy a person's window starts anew list its own tools, not count those an agy before it listed", async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 8000 });
    expect(await host.run(agyJob('reopened', 'hello'))).toMatchObject({ ok: true, result: 'FINISHED' });
    /* Another launch starts agy anew for the window, and this agy lists its tools only later. */
    const start = Date.now();
    expect(await host.run(agyJob('reopened', '', { FAKE_MCP_LIST_MS: '3000' }))).toMatchObject({ ok: true, sessionId: null });
    expect(Date.now() - start).toBeGreaterThanOrEqual(3000);
  });

  it("types a turn without Hornhoof's tools at once", async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 1000 });
    expect(await host.run(agyJob('bare', 'hello', { FAKE_AGY_NO_TOOLS: '1' }, { tools: undefined }))).toMatchObject({ ok: true, result: 'FINISHED' });
    expect(turns('bare')).toEqual([{ turn: 'hello', tools: false }]);
  });
});
