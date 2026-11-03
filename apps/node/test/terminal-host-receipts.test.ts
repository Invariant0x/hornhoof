import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { NodeMessage } from '@hornhoof/protocol';
import { RESTART_AFTER_MS } from '@hornhoof/protocol/map';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalHost } from '../src/terminal/host.js';
import { jobDone } from '../src/runner.js';
import { claudeTranscript } from '../src/terminal/programs.js';
import { restartRefusal } from '../src/terminal/program-restart.js';
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
  const run = () => {
    initial = true;
    return host.run({ ...makeJob('receipt', 'HANG', { jobId: 'job-receipt', workDir, sessionId: SESSION }), home }).then(result => {
      sent.push(jobDone('job-receipt', result, []));
      host.completed('job-receipt');
      return result;
    });
  };
  const running = run();
  const drain = () => host['drain'](host['agents'].get('receipt')!);
  const finish = () => {
    if (kind === 'codex') record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn', last_agent_message: 'Done.' } });
    else if (kind === 'claude') record({ type: 'system', subtype: 'turn_duration', durationMs: 1 });
    else record({ type: 'turn.ended', reason: 'completed' });
    drain();
  };
  cleanups.push(async () => { alive.mockResolvedValue(false); finish(); await running; await host.stop(); rmSync(home, { recursive: true, force: true }); });
  await until(() => host['agents'].get('receipt')?.took === true);
  keys.mockClear();
  const expire = () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 15_001);
    drain(); drain();
  };
  const unheard = () => sent.filter(m => m.type === 'agent.unheard');
  return { host, running, run, sent, keys, alive, record, drain, finish, expire, unheard, input: () => input };
}

async function atTypedWork(kind: 'claude' | 'codex', mode: Mode) {
  const c = await atWork(kind, mode);
  c.finish(); await c.running;
  const prompt = kind === 'claude' ? c.host['hook']('receipt', 'prompt', { prompt: 'A typed question.' }) : Promise.resolve();
  if (kind === 'codex') {
    c.record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'typed' } });
    c.record(userMessage('A typed question.', 'typed'));
    c.drain();
  }
  await until(() => c.sent.some(m => m.type === 'turn.open'));
  c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'typed', toolToken: 'token' });
  await prompt;
  const end = async () => {
    if (kind === 'claude') await c.host['hook']('receipt', 'stop', { last_assistant_message: 'Typed answer.' });
    else {
      c.record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'typed', last_agent_message: 'Typed answer.' } });
      c.drain();
    }
  };
  return { ...c, end };
}

describe('program receipts for live words', () => {
  afterEach(async () => {
    vi.spyOn(Date, 'now').mockRestore();
    for (const cleanup of cleanups.splice(0)) await cleanup();
    vi.restoreAllMocks();
  });

  it('keeps statusLine from refreshing signs of life or postponing a restart', async () => {
    const c = await atWork('claude', 'queued');
    const a = c.host['agents'].get('receipt')!;
    const signAt = a.signAt;
    const now = signAt + RESTART_AFTER_MS.claude! + 1000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await c.host['hook']('receipt', 'status', { context_window: { used_percentage: 25 } });
    const observed = c.host['observeProgram']('job-receipt');
    await c.host['reportProgram'](a, observed.watch, observed.look);
    expect(c.sent.filter(m => m.type === 'job.program').at(-1)).toMatchObject({ signAt, state: 'thinking' });
    expect(a.contextUsed).toBe(0.25);
    expect(restartRefusal({ jobId: 'job-receipt', kind: 'claude', state: 'thinking', calls: 0, question: false, signAt: a.signAt, sessionId: a.sessionId, restarted: false }, 'job-receipt', now)).toBeNull();
  });

  it.each(['clear', 'logout'])('keeps Claude up after an idle %s and delivers the next live words once', async reason => {
    const c = await atWork('claude', 'queued');
    c.finish(); await c.running;
    await c.host['hook']('receipt', 'end', { reason });
    expect(c.host['agents'].get('receipt')?.up).toBe(true);
    await c.host['hook']('receipt', 'start', { session_id: SESSION, source: 'clear' });
    const next = c.run();
    await until(() => c.host['agents'].get('receipt')?.busy === true);
    c.keys.mockClear();
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    expect(c.keys.mock.calls.filter(([, key]) => key === 'Enter')).toHaveLength(1);
    expect(c.unheard()).toEqual([]);
    c.record(claudeQueue('remove', TEXT, { reason: 'absorbed_mid_turn' }));
    c.finish(); await next;
    c.expire();
    expect(c.unheard()).toEqual([]);
  });

  it('does not report live words unheard from the program display flag', async () => {
    const c = await atWork('claude', 'queued');
    c.host['programIs'](c.host['agents'].get('receipt')!, false);
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    expect(c.unheard()).toEqual([]);
    c.record(claudeQueue('remove', TEXT, { reason: 'absorbed_mid_turn' }));
  });

  it('ends a running Claude turn as stopped by a person on clear', async () => {
    const c = await atWork('claude', 'queued');
    await c.host['hook']('receipt', 'end', { reason: 'clear' });
    expect(await c.running).toMatchObject({ ok: false, error: 'cancelled' });
    expect((await c.running).failure).toBeUndefined();
    expect(c.host['agents'].get('receipt')?.up).toBe(true);
    expect(c.keys.mock.calls.flat()).not.toContain('Escape');
  });

  it('ends Claude as crashed when prompt_input_exit accompanies a process exit', async () => {
    const c = await atWork('claude', 'queued');
    c.alive.mockResolvedValue(false);
    await c.host['hook']('receipt', 'end', { reason: 'prompt_input_exit' });
    expect(await c.running).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'crash', retryable: true } });
    expect(c.host['agents'].get('receipt')?.up).toBe(false);
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

  it.each([false, true])('takes a delayed Claude absorption receipt after Stop, typed: %s', async typed => {
    const c = typed ? await atTypedWork('claude', 'queued') : await atWork('claude', 'queued');
    const jobId = typed ? 'typed' : 'job-receipt';
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    await c.host['hook']('receipt', 'stop', { last_assistant_message: '' });
    await until(() => c.host['agents'].get('receipt')!.finishing.size > 0);
    c.record(claudeQueue('remove', TEXT, { reason: 'absorbed_mid_turn' }));
    c.drain(); c.expire();
    await until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === jobId));
    expect(c.unheard()).toEqual([]);
    expect(c.sent.filter(m => m.type === 'job.done' && m.jobId === jobId)).toHaveLength(1);
  });

  it('reads the old Claude absorption receipt before expiry while a human turn runs', async () => {
    const c = await atWork('claude', 'queued');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    await c.host['hook']('receipt', 'stop', { last_assistant_message: '' });
    await until(() => c.host['agents'].get('receipt')!.finishing.size > 0);
    const prompt = c.host['hook']('receipt', 'prompt', { prompt: 'A separate question.' });
    await until(() => c.sent.some(m => m.type === 'turn.open'));
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'token' });
    await prompt; await c.running;
    c.record(claudeQueue('remove', TEXT, { reason: 'absorbed_mid_turn' }));
    c.expire();
    expect(c.unheard()).toEqual([]);
  });

  it.each(['Words for the human turn.', TEXT])('takes a delayed Claude receipt once, leaving later words: %s', async text => {
    const c = await atWork('claude', 'queued');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    await c.host['hook']('receipt', 'stop', { last_assistant_message: '' });
    const prompt = c.host['hook']('receipt', 'prompt', { prompt: 'A separate question.' });
    await until(() => c.sent.some(m => m.type === 'turn.open'));
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'token' });
    await prompt;
    expect(await c.host.say('receipt', text)).toBe(true);
    c.record({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn' });
    c.drain();
    await c.host['hook']('receipt', 'stop', { last_assistant_message: '' });
    c.expire();
    await until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'human'));
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'human', text }]);
  });

  it('opens Claude dequeued words from the log as a typed turn and hears its second Stop', async () => {
    const c = await atWork('claude', 'queued');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.finish();
    c.record(claudeQueue('dequeue', TEXT));
    c.record({ type: 'user', message: { role: 'user', content: TEXT } });
    c.drain();
    await c.running;
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
    c.finish();
    c.record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'next' } });
    c.record(userMessage(TEXT, 'next')); c.drain();
    await c.running;
    await until(() => c.sent.some(m => m.type === 'turn.open'));
    c.expire();
    expect(c.sent).toContainEqual(expect.objectContaining({ type: 'turn.open', text: TEXT }));
    expect(c.unheard()).toEqual([]);
  });

  it('opens held words after a typed Codex turn ended, with their old job', async () => {
    const c = await atTypedWork('codex', 'silent');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    await c.end();
    await until(() => c.host['agents'].get('receipt')!.finishing.size > 0);
    c.record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'next' } });
    c.record(userMessage(TEXT, 'next'));
    c.record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'next', last_agent_message: 'Queued answer.' } });
    c.drain();
    await until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'typed'));
    const next = c.sent.filter(m => m.type === 'turn.open')[1];
    expect(next).toMatchObject({ text: TEXT, queuedFrom: 'typed' });
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'next', toolToken: 'next-token', ref: next?.ref });
    await until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'next'));
    expect(c.sent.filter(m => m.type === 'job.done' && m.jobId === 'next')).toEqual([
      expect.objectContaining({ ok: true, result: 'Queued answer.' }),
    ]);
    c.expire();
    expect(c.unheard()).toEqual([]);
  });

  it.each(['claude', 'codex'] as const)('keeps one successful completion when typed %s exits during the hold', async kind => {
    const c = await atTypedWork(kind, kind === 'claude' ? 'queued' : 'silent');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    await c.end();
    await until(() => {
      const a = c.host['agents'].get('receipt')!;
      return a.finishing.size > 0 && !a.settling;
    });
    c.alive.mockResolvedValue(false);
    await c.host['look'](c.host['agents'].get('receipt')!);
    await until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'typed' && m.ok));
    expect(c.sent.filter(m => m.type === 'job.done' && m.jobId === 'typed')).toEqual([
      expect.objectContaining({ ok: true, result: 'Typed answer.', error: null }),
    ]);
    expect(c.host['agents'].get('receipt')!.up).toBe(false);
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'typed', text: TEXT }]);
  });

  it.each(['claude', 'codex'] as const)('keeps one crash completion when typed %s exits before its end record', async kind => {
    const c = await atTypedWork(kind, kind === 'claude' ? 'queued' : 'silent');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.alive.mockResolvedValue(false);
    await c.host['look'](c.host['agents'].get('receipt')!);
    await c.end(); c.expire();
    expect(c.sent.filter(m => m.type === 'job.done' && m.jobId === 'typed')).toEqual([
      expect.objectContaining({ ok: false, error: 'agent_failed', failure: { kind: 'crash', retryable: true, text: 'The program exited during the turn.' } }),
    ]);
  });

  it.each(['claude', 'codex'] as const)('keeps the successful completion when typed %s exits after the hold', async kind => {
    const c = await atTypedWork(kind, kind === 'claude' ? 'queued' : 'silent');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    await c.end(); c.expire();
    await until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'typed'));
    c.alive.mockResolvedValue(false);
    await c.host['look'](c.host['agents'].get('receipt')!);
    expect(c.sent.filter(m => m.type === 'job.done' && m.jobId === 'typed')).toEqual([
      expect.objectContaining({ ok: true, result: 'Typed answer.', error: null }),
    ]);
    expect(c.host['agents'].get('receipt')!.up).toBe(false);
  });

  it.each(['claude', 'codex', 'kimi'] as const)('reports %s waiting words once after 15 seconds without a next turn', async kind => {
    const c = await atWork(kind, kind === 'codex' ? 'silent' : 'queued');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.finish();
    await new Promise(r => setTimeout(r, 50));
    expect(c.sent.filter(m => m.type === 'job.done')).toEqual([]);
    expect(c.unheard()).toEqual([]);
    c.expire();
    await c.running;
    c.drain(); c.drain();
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: TEXT }]);
    expect(c.sent.filter(m => m.type === 'job.done' || m.type === 'agent.unheard').map(m => m.type)).toEqual(['job.done', 'agent.unheard']);
  });

  it.each(['claude', 'codex'] as const)('opens %s queued words before completing the old job', async kind => {
    const c = await atWork(kind, kind === 'claude' ? 'queued' : 'silent');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    if (kind === 'claude') await c.host['hook']('receipt', 'stop', { last_assistant_message: '' });
    else c.finish();
    await new Promise(r => setTimeout(r, 300));
    if (kind === 'claude') {
      c.record(claudeQueue('dequeue', TEXT));
      c.record({ type: 'user', message: { content: TEXT } });
    } else {
      c.record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'next' } });
      c.record(userMessage(TEXT, 'next'));
    }
    c.drain(); await c.running;
    expect(c.sent.filter(m => m.type === 'turn.open' || m.type === 'job.done').map(m => m.type)).toEqual(['turn.open', 'job.done']);
    expect(c.sent.find(m => m.type === 'turn.open')).toMatchObject({ text: TEXT, queuedFrom: 'job-receipt' });
    c.expire();
    expect(c.unheard()).toEqual([]);
  });

  it('completes a Claude job at Stop when there are no queued words', async () => {
    const c = await atWork('claude', 'queued');
    await c.host['hook']('receipt', 'stop', { last_assistant_message: '' });
    await c.running;
    expect(c.sent.filter(m => m.type === 'job.done')).toHaveLength(1);
  });

  it.each([
    ['claude', false], ['claude', true], ['codex', false], ['codex', true],
  ] as const)('completes the old %s job before opening unrelated human words during the hold, typed: %s', async (kind, typed) => {
    const mode = kind === 'claude' ? 'queued' : 'silent';
    const c = typed ? await atTypedWork(kind, mode) : await atWork(kind, mode);
    const jobId = typed ? 'typed' : 'job-receipt';
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    if (kind === 'claude') await c.host['hook']('receipt', 'stop', { last_assistant_message: '' });
    else {
      c.record({ type: 'event_msg', payload: { type: 'task_complete', turn_id: typed ? 'typed' : 'turn', last_agent_message: '' } });
      c.drain();
    }
    await until(() => c.host['agents'].get('receipt')!.finishing.size > 0);
    const at = c.sent.length;
    const prompt = kind === 'claude' ? c.host['hook']('receipt', 'prompt', { prompt: 'A separate question.' }) : Promise.resolve();
    if (kind === 'codex') {
      c.record({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'human' } });
      c.record(userMessage('A separate question.', 'human')); c.drain();
    }
    await until(() => c.sent.slice(at).some(m => m.type === 'turn.open'));
    const order = c.sent.slice(at).filter(m => m.type === 'job.done' || m.type === 'turn.open').map(m => m.type);
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'token' });
    await prompt;
    await c.host['hook']('receipt', 'stop', { last_assistant_message: 'Human answer.' });
    await until(() => c.sent.some(m => m.type === 'job.done' && m.jobId === 'human'));
    c.expire();
    await c.running;
    expect(order).toEqual(['job.done', 'turn.open']);
    expect(c.sent.slice(at).find(m => m.type === 'turn.open')).toMatchObject({ text: 'A separate question.' });
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId, text: TEXT }]);
    expect(c.sent.filter(m => m.type === 'job.done' && m.jobId === 'human')).toEqual([
      expect.objectContaining({ ok: true, result: 'Human answer.' }),
    ]);
  });

  it('keeps a typed Claude answer with its job when human words precede the last log lines', async () => {
    const c = await atTypedWork('claude', 'queued');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    await c.end();
    const prompt = c.host['hook']('receipt', 'prompt', { prompt: 'A separate question.' });
    await new Promise(r => setTimeout(r, 30));
    c.record({ type: 'assistant', message: { content: [{ type: 'text', text: 'Typed answer.' }] } });
    c.drain();
    await until(() => c.sent.filter(m => m.type === 'turn.open').length === 2);
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'human', toolToken: 'human-token' });
    await prompt;
    expect(c.sent).toContainEqual({ type: 'job.event', jobId: 'typed', seq: 0, event: { kind: 'text', text: 'Typed answer.' } });
    expect(c.sent.filter(m => m.type === 'job.event' && m.jobId === 'human')).toEqual([]);
    c.expire();
  });

  it('reports queued words on shutdown while the old job still waits to complete', async () => {
    const c = await atWork('claude', 'queued');
    expect(await c.host.say('receipt', TEXT)).toBe(true);
    c.finish();
    await until(() => c.host['agents'].get('receipt')!.finishing.size > 0);
    c.alive.mockResolvedValue(false);
    await c.host.stop();
    expect(c.unheard()).toEqual([{ type: 'agent.unheard', agentKey: 'receipt', jobId: 'job-receipt', text: TEXT }]);
    await c.running;
  });

  it('bounds the Kimi Stop wait when its wire end is missing', async () => {
    const c = await atWork('kimi', 'taken');
    c.record({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'Answer.' } } });
    const started = Date.now();
    await c.host['hook']('receipt', 'stop', {});
    expect(await c.running).toMatchObject({ ok: true, result: 'Answer.' });
    expect(Date.now() - started).toBeLessThan(4500);
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
