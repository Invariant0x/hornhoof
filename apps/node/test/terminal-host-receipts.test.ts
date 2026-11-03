import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { NodeMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalHost } from '../src/terminal/host.js';
import { claudeTranscript } from '../src/terminal/programs.js';
import { Tmux } from '../src/terminal/tmux.js';
import { claudeQueue, kimiSteer, userMessage } from './fakes/word-receipts.mjs';
import { codexJob, job, kimiJob, until } from './terminal-host-helpers.js';

const SESSION = 'c3b66b04-872b-4fbe-a3a4-058a026ef20a';
const HOOK = fileURLToPath(new URL('../hh-hook.cjs', import.meta.url));
const runHook = promisify(execFile);
const TEXT = 'From Hornhoof:\n\nKeep these exact words.';
const cleanups: (() => Promise<void>)[] = [];
type Kind = 'claude' | 'codex' | 'kimi';
type Mode = 'taken' | 'queued' | 'silent' | 'lost' | 'hook' | 'bridge';

async function atWork(kind: Kind, mode: Mode) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hh-receipts-')));
  const workDir = join(home, 'work');
  const file = kind === 'claude' ? claudeTranscript(home, workDir, SESSION)
    : kind === 'codex' ? join(home, 'sessions/2026/11/03', `rollout-${SESSION}.jsonl`)
    : join(home, 'sessions/work', SESSION, 'agents/main/wire.jsonl');
  const record = (line: object) => appendFileSync(file, JSON.stringify(line) + '\n');
  const sent: NodeMessage[] = [];
  const tmux = new Tmux({ env: { HOME: home } });
  let input = '';
  let initial = true;
  const screen = () => kind === 'claude' ? `❯ ${input}\n` : kind === 'codex' ? `OpenAI Codex\n› ${input}\n`
    : `Welcome to Kimi Code!\n── input ────────────────────────────────────────────────────────────\n ${input}\n─────────────────────────────────────────────────────────────────────\ncontext: 0% (0/256k)\n`;
  vi.spyOn(tmux, 'scratch').mockReturnValue(home);
  vi.spyOn(tmux, 'launch').mockImplementation(async () => {
    mkdirSync(dirname(file), { recursive: true });
    if (kind === 'codex') record({ type: 'session_meta', payload: { id: SESSION, cwd: workDir } });
    else record({ type: 'metadata' });
    if (kind !== 'codex') await host['hook']('receipt', 'start', { session_id: SESSION });
  });
  const alive = vi.spyOn(tmux, 'alive').mockResolvedValue(true);
  vi.spyOn(tmux, 'stopAll').mockResolvedValue();
  vi.spyOn(tmux, 'exitSnapshot').mockResolvedValue(null);
  vi.spyOn(tmux, 'screen').mockImplementation(async () => screen());
  vi.spyOn(tmux, 'paste').mockImplementation(async (_name, text) => { input += text; });
  const keys = vi.spyOn(tmux, 'keys').mockImplementation(async (_name, ...pressed) => {
    for (const key of pressed) {
      if (key === 'C-u') input = input.slice(0, input.lastIndexOf('\n') + 1);
      if (key === 'BSpace') input = input.slice(0, -1);
      if (key !== 'Enter' && key !== 'C-s') continue;
      if (!input || (!initial && mode === 'lost')) continue;
      const text = input;
      input = '';
      if (initial) {
        initial = false;
        if (kind === 'codex') record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } });
        else await host['hook']('receipt', 'prompt', { prompt: text });
      } else if (kind === 'claude' && mode !== 'silent') {
        if (mode === 'hook') await host['hook']('receipt', 'prompt', { prompt: text });
        else record(claudeQueue('enqueue', text));
      } else if (kind === 'codex' && mode === 'taken') record(userMessage(text));
      else if (kind === 'kimi' && key === 'C-s' && mode !== 'silent') {
        if (mode === 'bridge') {
          await runHook(process.execPath, [HOOK, 'queued', JSON.stringify({ prompt: [{ type: 'text', text }] })], { env: { PATH: process.env.PATH, HH_BRIDGE: host['bridge'].agent('receipt').hookUrl } });
          continue;
        }
        await host['hook']('receipt', 'queued', { prompt: [{ type: 'text', text }] });
        record(kimiSteer('prompt.steered', text));
        if (mode === 'taken') record(kimiSteer('turn.steer', text));
      }
    }
  });
  const host = new TerminalHost({ tmux, hornhoof: 'http://127.0.0.1:9', send: m => sent.push(m), secrets: () => [], pollMs: 5, enterWaitMs: 30, openMs: 30, plugins: [] });
  const makeJob = kind === 'codex' ? codexJob : kind === 'kimi' ? kimiJob : job;
  if (mode === 'bridge') await host.start();
  const running = host.run({ ...makeJob('receipt', 'HANG', { jobId: 'job-receipt', workDir, sessionId: SESSION }), home });
  const drain = () => host['drain'](host['agents'].get('receipt')!);
  const finish = () => {
    if (kind === 'codex') record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn', last_agent_message: 'Done.' } });
    else if (kind === 'claude') record({ type: 'system', subtype: 'turn_duration', durationMs: 1 });
    else record({ type: 'turn.ended', reason: 'completed' });
    drain();
  };
  cleanups.push(async () => { finish(); await running; await host.stop(); rmSync(home, { recursive: true, force: true }); });
  await until(() => host['agents'].get('receipt')?.took === true);
  keys.mockClear();
  const expire = () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 15_001);
    drain(); drain();
  };
  const unheard = () => sent.filter(m => m.type === 'agent.unheard');
  return { host, running, sent, keys, alive, record, drain, finish, expire, unheard, input: () => input };
}

describe('program receipts for live words', () => {
  afterEach(async () => {
    vi.spyOn(Date, 'now').mockRestore();
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
  });

  it.each(['queued', 'hook'] as const)('takes a Claude %s receipt and waits for absorption', async mode => {
    const c = await atWork('claude', mode);
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    expect(c.keys.mock.calls.flat()).toEqual(['a-receipt', 'Enter']);
    if (mode === 'hook') c.record(claudeQueue('enqueue', TEXT));
    c.record(claudeQueue('remove', TEXT, { reason: 'absorbed_mid_turn' }));
    c.drain(); c.finish(); await c.running; c.expire();
    expect(c.unheard()).toEqual([]);
  });

  it('opens Claude dequeued words from the log as a typed turn and hears its second Stop', async () => {
    const c = await atWork('claude', 'queued');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.finish(); await c.running;
    c.record(claudeQueue('dequeue', TEXT));
    c.record({ type: 'user', message: { role: 'user', content: TEXT } });
    c.drain();
    await until(() => c.sent.some(m => m.type === 'turn.open'));
    expect(c.sent.find(m => m.type === 'turn.open')).toMatchObject({ type: 'turn.open', text: TEXT, queuedFrom: 'job-receipt' });
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'second', toolToken: 'token' });
    await c.host['hook']('receipt', 'stop', { last_assistant_message: '' });
    await until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'second'));
    c.expire();
    expect(c.unheard()).toEqual([]);
  });

  it.each(['silent', 'lost'] as const)('retries Claude %s words once, says false and erases input', async mode => {
    const c = await atWork('claude', mode);
    expect(await c.host.say('receipt', TEXT)).toBe(false);
    expect(c.keys.mock.calls.filter(([, key]) => key === 'Enter')).toHaveLength(2);
    expect(c.input()).toBe('');
    c.finish(); await c.running; c.expire();
    expect(c.unheard()).toEqual([]);
  });

  it('takes a Codex UserMessage only in the running turn', async () => {
    const c = await atWork('codex', 'taken');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.finish(); await c.running; c.expire();
    expect(c.keys.mock.calls.filter(([, key]) => key === 'Enter')).toHaveLength(1);
    expect(c.unheard()).toEqual([]);
  });

  it('keeps silent Codex words held until its own next turn takes them', async () => {
    const c = await atWork('codex', 'silent');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    expect(c.keys.mock.calls.filter(([, key]) => key === 'Enter')).toHaveLength(2);
    c.finish(); await c.running;
    c.record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'next' } });
    c.record(userMessage(TEXT, 'next')); c.drain();
    await until(() => c.sent.some(m => m.type === 'turn.open'));
    c.expire();
    expect(c.sent).toContainEqual(expect.objectContaining({ type: 'turn.open', text: TEXT }));
    expect(c.unheard()).toEqual([]);
  });

  it.each(['codex', 'kimi'] as const)('reports %s waiting words once after 15 seconds without a next turn', async kind => {
    const c = await atWork(kind, kind === 'codex' ? 'silent' : 'queued');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.finish(); await c.running;
    expect(c.unheard()).toEqual([]);
    c.expire();
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: TEXT }]);
  });

  it('sends Kimi Ctrl-S and accepts its queued hook then turn.steer', async () => {
    const c = await atWork('kimi', 'taken');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    expect(c.keys.mock.calls.flat()).toEqual(['a-receipt', 'C-s']);
    c.finish(); await c.running; c.expire();
    expect(c.unheard()).toEqual([]);
  });

  it('receives hh-hook queued through the bridge without a wire receipt', async () => {
    const c = await atWork('kimi', 'bridge');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    expect(c.keys.mock.calls.flat()).toEqual(['a-receipt', 'C-s']);
    c.record(kimiSteer('turn.steer', TEXT));
    c.finish(); await c.running; c.expire();
    expect(c.unheard()).toEqual([]);
  });

  it('reports waiting words when the program is gone', async () => {
    const c = await atWork('codex', 'silent');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.alive.mockResolvedValue(false);
    await c.running;
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: TEXT }]);
  });

  it('keeps the old failure when Claude dequeues the next turn in the same log read', async () => {
    const c = await atWork('claude', 'queued');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.record({ type: 'assistant', isApiErrorMessage: true, error: 'server_error', message: { content: [{ type: 'text', text: 'API Error: Overloaded' }] } });
    c.record({ type: 'system', subtype: 'turn_duration' });
    c.record(claudeQueue('dequeue', TEXT));
    c.record({ type: 'user', message: { content: TEXT } });
    c.drain();
    expect(c.sent).toContainEqual(expect.objectContaining({ type: 'turn.open', queuedFrom: 'job-receipt' }));
    expect(await c.running).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'overloaded' } });
    await until(() => c.sent.some(m => m.type === 'turn.open'));
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'second', toolToken: 'token' });
    await c.host['hook']('receipt', 'stop', { last_assistant_message: '' });
    await until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'second'));
  });
});
