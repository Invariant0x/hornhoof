import { existsSync, readFileSync } from 'node:fs';
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
/* What the stub agy wrote of what it did, nothing before it starts. */
const records = (key: string) => {
  const log = join(home, `agy-tools-${key}.log`);
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
};
const turns = (key: string) => records(key).filter(r => 'turn' in r);
/* What agy did with its MCP panel, its tools and its turns, in order; a key typed into the panel shows as panelKey. */
const steps = (key: string) => records(key).filter(r => ['mcpPanel', 'toolsListed', 'panelKey', 'turn'].some(k => k in r));
const OPENED = [{ mcpPanel: 'open' }, { toolsListed: true }, { mcpPanel: 'closed' }];
/* The keys the node sends from now on, each call's joined. */
const keysSent = () => {
  const sent: string[] = [];
  const keys = tmux.keys.bind(tmux);
  vi.spyOn(tmux, 'keys').mockImplementation(async (name, ...k) => {
    sent.push(k.join(' '));
    return keys(name, ...k);
  });
  return sent;
};

/* agy 1.4.12 connects to the MCP servers of its folder only once it takes its first input or opens its /mcp panel, and
   the turn whose input made it connect works without their tools (seen on a-host, #226). */
describe.skipIf(!hasTmux)("Antigravity and Hornhoof's tools", () => {
  afterEach(async () => {
    await host?.stop();
    vi.restoreAllMocks();
  });

  it("opens agy's MCP panel first and types Hornhoof's prompt once agy has listed its tools there and the panel is closed, so its first turn has them", async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 5000 });
    expect(await host.run(agyJob('slow', 'hello', { FAKE_MCP_LIST_MS: '2500' }))).toMatchObject({ ok: true, result: 'FINISHED' });
    expect(steps('slow')).toEqual([...OPENED, { turn: 'hello', tools: true }]);
  });

  it("ends the turn with a named reason when agy lists no tools in its MCP panel, closes the panel and types no prompt", async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 1000 });
    const res = await host.run(agyJob('none', 'hello', { FAKE_AGY_NO_TOOLS: '1' }));
    expect(res).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'tools', text: "Antigravity CLI did not list Hornhoof's tools within 1 s of opening its MCP panel.", retryable: true } });
    await until(() => steps('none').length === 2);
    expect(steps('none')).toEqual([{ mcpPanel: 'open' }, { mcpPanel: 'closed' }]);
  });

  it.each([
    ['its MCP panel stays up', 'stuck', 'FAKE_MCP_PANEL_STAYS'],
    ['its MCP panel leaves words in its input', 'kept-input', 'FAKE_MCP_PANEL_KEEPS_INPUT'],
  ])("ends the turn with a named reason when agy's empty prompt does not come back as %s, and starts agy anew for the next one", async (_, key, how) => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 1000 });
    /* A session agy resumes would go on in the same agy, which has listed its tools. */
    const res = await host.run(agyJob(key, 'hello', { [how]: '1' }, { sessionId: `${key}-session` }));
    expect(res).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'unknown', text: 'Antigravity CLI did not show its empty prompt again within 1 s of closing its MCP panel.', retryable: true } });
    /* Its screen goes with the turn's output. */
    expect(res.output).toContain(how === 'FAKE_MCP_PANEL_STAYS' ? 'Manage MCP servers' : '/mcp');
    const pid = await tmux.programPid(`a-${key}`);
    expect(await host.run(agyJob(key, 'hello', { [how]: '1' }, { sessionId: `${key}-session` }))).toMatchObject({ ok: false, failure: { kind: 'unknown' } });
    expect(await tmux.programPid(`a-${key}`)).not.toBe(pid);
    expect(steps(key).filter(r => 'turn' in r || 'panelKey' in r)).toEqual([]);
  });

  it('starts agy anew for the next turn after it listed no tools, rather than open its panel in it again', async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 1000 });
    const none = () => agyJob('none-again', 'hello', { FAKE_AGY_NO_TOOLS: '1' }, { sessionId: 'none-again-session' });
    expect(await host.run(none())).toMatchObject({ ok: false, failure: { kind: 'tools' } });
    const pid = await tmux.programPid('a-none-again');
    expect(await host.run(none())).toMatchObject({ ok: false, failure: { kind: 'tools' } });
    expect(await tmux.programPid('a-none-again')).not.toBe(pid);
  });

  it.each([
    ['shows nothing typed', 'deaf', { FAKE_AGY_DEAF: '1' }],
    ['shows more words after it', 'more', { FAKE_AGY_SHOWN_AFTER_MCP: ' x' }],
  ])('presses no Enter while agy %s rather than /mcp alone in its input, and says so', async (_, key, env) => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 1000 });
    expect(await host.run(agyJob(key, '', env))).toMatchObject({ ok: true });
    const sent = keysSent();
    const res = await host.run(agyJob(key, 'hello', env));
    expect(res).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'unknown', text: 'Antigravity CLI did not show /mcp in its input within 1 s, so the node did not open its MCP panel.', retryable: true } });
    expect(sent).toEqual(['-l /mcp', 'Escape']);
  });

  it.each([
    ['suggests more after /mcp', 'dim', { FAKE_AGY_SHOWN_AFTER_MCP: '\x1b[2m  Manage MCP servers\x1b[22m' }],
    ['shows a placeholder in its empty input', 'placeholder', { FAKE_AGY_PLACEHOLDER: '1' }],
  ])('opens the panel while agy %s in dim', async (_, key, env) => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 5000 });
    expect(await host.run(agyJob(key, 'hello', env))).toMatchObject({ ok: true, result: 'FINISHED' });
    expect(steps(key)).toEqual([...OPENED, { turn: 'hello', tools: true }]);
  });

  it('ends the turn at once saying so when agy exits as the node types /mcp', async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 5000 });
    const start = Date.now();
    const res = await host.run(agyJob('exits', 'hello', { FAKE_AGY_EXITS_ON_KEY: '1' }));
    expect(res).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'crash', text: "The program exited before it took Hornhoof's prompt.", retryable: true } });
    /* Nothing waits for the screen of a program that is gone. */
    expect(Date.now() - start).toBeLessThan(4000);
    expect(turns('exits')).toEqual([]);
  });

  it('ends the turn saying so when agy loses its terminal while its MCP panel is open', async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 1000 });
    const run = host.run(agyJob('killed', 'hello', { FAKE_MCP_LIST_MS: '60000' }));
    await until(() => records('killed').some(r => r.mcpPanel === 'open'));
    await tmux.kill('a-killed');
    expect(await run).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'crash', text: "The program exited before it took Hornhoof's prompt.", retryable: true } });
    expect(turns('killed')).toEqual([]);
  });

  const opened = (key: string) => () => records(key).some(r => r.mcpPanel === 'open');
  it.each([
    ['while agy lists them later', 'later', { FAKE_MCP_LIST_MS: '6000' }, opened('later'), 1, 1],
    ['while agy never lists them', 'never', { FAKE_AGY_NO_TOOLS: '1' }, opened('never'), 1, 1],
    ['as agy shows its prompt', 'shown', { FAKE_AGY_NO_TOOLS: '1' }, async () => (await host.screen('shown')).includes('? for shortcuts'), 0, 0],
    ['as agy shows /mcp typed', 'typed', { FAKE_AGY_NO_TOOLS: '1' }, async () => (await host.screen('typed')).includes('> /mcp'), 1, 0],
    ['while agy keeps its MCP panel open', 'kept', { FAKE_MCP_PANEL_STAYS: '1' }, () => records('kept').some(r => r.mcpPanel === 'kept'), 1, 1],
  ])('ends a turn stopped %s as stopped at once, types no prompt and leaves no panel it opened', async (_, key, env, when, panels, enters) => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 10_000 });
    const sent = keysSent();
    const stop = new AbortController();
    const run = host.run(agyJob(key, 'hello', env, { signal: stop.signal }));
    await until(when);
    stop.abort();
    const stopped = Date.now();
    expect(await run).toMatchObject({ ok: false, error: 'cancelled' });
    expect(Date.now() - stopped).toBeLessThan(1500);
    expect(turns(key)).toEqual([]);
    expect(sent.filter(k => k === '-l /mcp')).toHaveLength(panels);
    /* The launch presses its own Enter before agy starts. */
    expect(sent.slice(sent.indexOf('-l /mcp') + 1 || sent.length).filter(k => k === 'Enter')).toHaveLength(enters);
    expect(sent.filter(k => k === 'Escape')).toHaveLength(panels);
  });

  it("opens the MCP panel in the agy a person's window started, rather than start it anew", async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 5000 });
    expect(await host.run(agyJob('person', ''))).toMatchObject({ ok: true, sessionId: null });
    const pid = await tmux.programPid('a-person');
    expect(await host.run(agyJob('person', 'hello'))).toMatchObject({ ok: true, result: 'FINISHED' });
    expect(await tmux.programPid('a-person')).toBe(pid);
    expect(steps('person')).toEqual([...OPENED, { turn: 'hello', tools: true }]);
  });

  it("types nothing into words a person left in agy's input, says why, and starts agy anew for the next turn", async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 5000 });
    expect(await host.run(agyJob('draft', ''))).toMatchObject({ ok: true, sessionId: null });
    const pid = await tmux.programPid('a-draft');
    await tmux.keys('a-draft', '-l', 'fix th');
    await until(async () => (await host.screen('draft')).includes('fix th'));
    const sent = keysSent();
    expect(await host.run(agyJob('draft', 'hello'))).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'unknown', text: 'Antigravity CLI did not wait at its empty prompt, so the node did not open its MCP panel.', retryable: true } });
    expect(sent).toEqual([]);
    expect(await host.screen('draft')).toContain('fix th');
    expect(await host.run(agyJob('draft', 'hello'))).toMatchObject({ ok: true, result: 'FINISHED' });
    expect(await tmux.programPid('a-draft')).not.toBe(pid);
    expect(steps('draft')).toEqual([...OPENED, { turn: 'hello', tools: true }]);
  });

  it('goes on in the agy that listed its tools, without starting it again or opening its panel again', async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 5000 });
    const first = await host.run(agyJob('again', 'hello'));
    expect(first).toMatchObject({ ok: true, result: 'FINISHED' });
    const pid = await tmux.programPid('a-again');
    expect(await host.run(agyJob('again', 'Also say BANANA.', {}, { sessionId: first.sessionId }))).toMatchObject({ ok: true, result: 'BANANA' });
    expect(await tmux.programPid('a-again')).toBe(pid);
    expect(steps('again')).toEqual([...OPENED, { turn: 'hello', tools: true }, { turn: 'Also say BANANA.', tools: true }]);
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

  it("keeps the agy a person's window started, waits for no tools there and types nothing into it", async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 5000 });
    const start = Date.now();
    expect(await host.run(agyJob('window', ''))).toMatchObject({ ok: true, sessionId: null });
    const pid = await tmux.programPid('a-window');
    expect(await host.run(agyJob('window', ''))).toMatchObject({ ok: true, sessionId: null });
    expect(await tmux.programPid('a-window')).toBe(pid);
    /* agy lists them only once it takes a message, so a start that waited for them would wait for nothing. */
    expect(Date.now() - start).toBeLessThan(5000);
    expect(steps('window')).toEqual([]);
  });

  it("types a turn without Hornhoof's tools at once, opening no panel", async () => {
    await setUp({ readyMs: 2000, cols: 120, rows: 40, toolsMs: 1000 });
    expect(await host.run(agyJob('bare', 'hello', { FAKE_AGY_NO_TOOLS: '1' }, { tools: undefined }))).toMatchObject({ ok: true, result: 'FINISHED' });
    expect(steps('bare')).toEqual([{ turn: 'hello', tools: false }]);
  });
});
