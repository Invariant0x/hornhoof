import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentEvent, ServerMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCREEN_SIGNED_OUT } from '../src/providers/kimi.js';
import { runJob, type ProviderAdapter } from '../src/runner.js';
import { rememberSession } from '../src/state.js';
import { TerminalHost } from '../src/terminal/host.js';
import { kimiProgram } from '../src/terminal/programs.js';
import { Tmux } from '../src/terminal/tmux.js';

const JOB = '00000000-0000-4000-8000-000000000074';
const AGENT = '00000000-0000-4000-8000-000000000075';
const SESSION = 'synthetic-phase-session';
const CANARY = 'synthetic-phase-secret-0123456789';
const fixtures: { host: TerminalHost; root: string }[] = [];

async function advance(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 25) await vi.advanceTimersByTimeAsync(Math.min(25, ms - elapsed));
}

function fixture(screen: string) {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'setInterval'] });
  vi.setSystemTime(Date.UTC(2026, 10, 1));
  const root = mkdtempSync(join(tmpdir(), 'hh-phase-'));
  const home = join(root, 'home');
  const workDir = join(root, 'work', 'agents', AGENT);
  const wire = join(home, 'sessions', 'fixture-workspace', SESSION, 'agents', 'main', 'wire.jsonl');
  mkdirSync(dirname(wire), { recursive: true });
  mkdirSync(workDir, { recursive: true });
  writeFileSync(wire, '');
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
  const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: () => {}, secrets: () => [CANARY], readyMs: 2000, pollMs: 25, enterWaitMs: 100, toolsMs: 100 });
  fixtures.push({ host, root });
  const adapter: ProviderAdapter = {
    install: async () => {}, loggedIn: async () => true, login: async () => {}, secrets: async () => [CANARY],
    run: input => {
      const job = { jobId: JOB, key: AGENT, program: kimiProgram, bin: '/fixture/kimi', home, signedOut: SCREEN_SIGNED_OUT, input };
      return host.run(job);
    },
  };
  const job: Extract<ServerMessage, { type: 'job.run' }> = {
    type: 'job.run', jobId: JOB, subscriptionId: 'synthetic', provider: 'kimi', prompt: 'synthetic prompt', sessionId: SESSION, model: null, timeoutMs: 60_000, secret: null, instructions: null, toolToken: null, workspace: { key: AGENT, repo: null },
  };
  const run = () => runJob(adapter, job, root, { untimed: true, onEvent: e => events.push(e) });
  const appendWire = (value: unknown) => appendFileSync(wire, `${JSON.stringify(value)}\n`);
  return { root, home, host, pane, job, events, wire, run, appendWire };
}

function snapshots(root: string): unknown[] {
  const directory = join(root, 'terminal-phase');
  return existsSync(directory) ? readdirSync(directory).filter(file => file.endsWith('.json')).sort().map(file => JSON.parse(readFileSync(join(directory, file), 'utf8')) as unknown) : [];
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
});
