import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperatorNodeMessage } from '@hornhoof/protocol/program-operator';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalHost, type TermJob } from '../src/terminal/host.js';
import type { LaunchSpec } from '../src/terminal/programs.js';
import { codexProgram } from '../src/providers/codex-terminal.js';
import { TurnWords } from '../src/terminal/program-restart.js';
import { Tmux } from '../src/terminal/tmux.js';

const cleanups: (() => void)[] = [];

function fixture(operator = true) {
  vi.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), 'hh-host-resume-'));
  const workDir = join(home, 'work');
  mkdirSync(workDir);
  const key = randomUUID(), jobId = randomUUID();
  const frames: OperatorNodeMessage[] = [];
  const tmux = new Tmux({ env: { HOME: home }, recordingsDir: join(home, 'recordings') });
  /* The machine names its own Vitest workers, so the program starts with its launch settings alone and tmux is not asked
     which programs run beside it, whatever the environment of the test run. */
  const host = new TerminalHost({
    tmux, hornhoof: 'http://127.0.0.1:9', send: () => {}, secrets: () => [], readyMs: 100, pollMs: 5, cols: 120, rows: 40, env: { VITEST_MAX_WORKERS: '2' },
    ...(operator ? { operator: { dir: join(home, 'operator'), now: () => Date.now(), connected: () => true, send: (frame: OperatorNodeMessage) => { frames.push(frame); return true; } } } : {}),
  });
  cleanups.push(() => { clearInterval(host['operatorTimer']!); rmSync(home, { recursive: true, force: true }); });
  const agent = host['agent'](key);
  Object.assign(agent, {
    home, workDir, program: codexProgram, sessionId: 'known-session', instance: 'old-instance', hash: 'launch-hash',
    oldLogs: new Set(['old-file']), enqueuedWords: ['Held words'], retry: { attempt: 2, max: 3, nextAt: null },
  });
  agent.turn = { jobId, typed: true, seq: 0, toolToken: 'turn-token', words: new TurnWords(), onEvent: () => {} };
  agent.busy = agent.took = true;
  agent.ends.started('old-turn');
  agent.ends.end('done', true, 'old-turn');
  const logDir = join(home, 'sessions', '2026', '11', '06');
  mkdirSync(logDir, { recursive: true });
  const transcript = join(logDir, 'rollout-known-session.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: 'known-session', cwd: workDir } }) + '\n');
  const job: TermJob = {
    key, program: codexProgram, bin: 'codex', home, signedOut: /signed out/,
    operatorDelivery: { id: randomUUID(), ordinal: 1 },
    input: {
      jobId, workDir, prompt: 'Original assignment', sessionId: null, model: null, secret: null,
      instructions: 'Keep the session.', tools: { url: 'http://127.0.0.1:9/mcp', token: 'turn-token' }, timeoutMs: 1000,
      env: { KEEP: 'lasting', OVERRIDE: 'old', HH_ATTACH_URL: 'expired' },
    },
  };
  const spec: LaunchSpec = { command: ['codex', '-C', workDir, '--original-flag'], env: { OVERRIDE: 'launch', HH_BRIDGE: 'original-bridge' }, sessionId: null };
  host['operator']?.begin(key, jobId, job.operatorDelivery, job.input.prompt, false);
  host['operator']?.launch(key, 'attempt');
  host['operator']?.launch(key, 'started');
  frames.length = 0;
  const launch = vi.spyOn(tmux, 'launch').mockResolvedValue(undefined);
  vi.spyOn(tmux, 'alive').mockResolvedValue(true);
  vi.spyOn(tmux, 'screen').mockResolvedValue('OpenAI Codex\n› ');
  return { host, tmux, agent, job, spec, frames, launch, transcript };
}

afterEach(() => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });

describe('resuming a known session after a program restart', () => {
  it.each([true, false])('keeps launch settings and turn identity with operator enabled: %s', async operator => {
    const c = fixture(operator);
    const turn = c.agent.turn;
    const resuming = c.host['resumeSession'](c.agent, c.job, c.spec, c.job.input.jobId!);
    await vi.advanceTimersByTimeAsync(500);
    await resuming;
    expect(c.launch).toHaveBeenCalledTimes(1);
    const [name, launched] = c.launch.mock.calls[0]!;
    expect(name).toBe(c.agent.name);
    expect(launched).toMatchObject({ cwd: c.agent.workDir, command: ['codex', 'resume', 'known-session', '--original-flag'], cols: 120, rows: 40 });
    expect(launched.outputDir).toBe(c.tmux.scratch());
    expect(readFileSync(launched.envFile!, 'utf8')).toBe("KEEP='lasting'\nOVERRIDE='launch'\nHH_BRIDGE='original-bridge'\n");
    expect(c.spec.command).toEqual(['codex', '-C', c.agent.workDir, '--original-flag']);
    expect(c.agent.sessionId).toBe('known-session');
    expect(c.agent.instance).not.toBe('old-instance');
    expect(c.agent.turn).toBe(turn);
    expect(c.agent.turn!.toolToken).toBe('turn-token');
    expect(c.agent.busy).toBe(true);
    expect(c.agent.took).toBe(true);
    expect(c.agent.oldLogs).toBeNull();
    expect(c.agent.up).toBe(true);
    expect(c.agent.retry).toBeNull();
    expect(c.agent.enqueuedWords).toEqual([]);
    expect(c.agent.ends.end('done', true, 'resumed-turn')).toEqual({ accept: true, conflict: false });
    appendFileSync(c.transcript, '{"new":true}\n');
    expect(c.agent.tail!.read()).toEqual(['{"new":true}']);
  });

  it('reports intentional replacement before launch and starts a fresh operator instance', async () => {
    const c = fixture();
    const oldInstance = c.host['operator']!.identity(c.agent.key)!.instance;
    c.launch.mockImplementationOnce(async () => {
      expect(c.frames.map(frame => frame.type)).toEqual(['program.delivery', 'program.launch']);
      expect(c.frames[0]).toMatchObject({ type: 'program.delivery', deliveryId: c.job.operatorDelivery!.id, phase: 'cancelled', instance: oldInstance });
      expect(c.frames.filter(frame => frame.type === 'program.launch').map(frame => frame.phase)).toEqual(['attempt']);
    });
    const resuming = c.host['resumeSession'](c.agent, c.job, c.spec, c.job.input.jobId!);
    await vi.advanceTimersByTimeAsync(500);
    await resuming;
    const launches = c.frames.filter(frame => frame.type === 'program.launch');
    expect(launches.map(frame => frame.phase)).toEqual(['attempt', 'started']);
    expect(launches[0]!.instance).toBe(launches[1]!.instance);
    expect(launches[0]!.instance).not.toBe(oldInstance);
    expect(c.frames.filter(frame => frame.type === 'program.delivery' && frame.instance === launches[0]!.instance)).toEqual([]);
    c.host.operatorTick();
    expect(c.frames.filter(frame => frame.type === 'program.operator_needed')).toEqual([]);
  });

  it('waits for the existing input writer before launching the replacement', async () => {
    const c = fixture();
    let release!: () => void;
    const writing = c.host['operator']!.serial(c.agent.key, () => new Promise<void>(resolve => { release = resolve; }));
    const resuming = c.host['resumeSession'](c.agent, c.job, c.spec, c.job.input.jobId!);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.launch).not.toHaveBeenCalled();
    release();
    await writing;
    await vi.advanceTimersByTimeAsync(500);
    await resuming;
    expect(c.launch).toHaveBeenCalledTimes(1);
  });

  it('leaves pending turn state intact when the replacement never becomes ready', async () => {
    const c = fixture();
    vi.mocked(c.tmux.alive).mockResolvedValue(false);
    const resuming = c.host['resumeSession'](c.agent, c.job, c.spec, c.job.input.jobId!);
    await expect(resuming).rejects.toThrow('The restarted program did not become ready.');
    expect(c.agent.up).toBe(false);
    expect(c.agent.retry).toEqual({ attempt: 2, max: 3, nextAt: null });
    expect(c.agent.enqueuedWords).toEqual(['Held words']);
    expect(c.agent.ends.end('done', true, 'old-turn')).toEqual({ accept: false, conflict: false });
    expect(c.frames.filter(frame => frame.type === 'program.launch').map(frame => frame.phase)).toEqual(['attempt', 'started']);
  });
});
