import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jobDone } from '../src/runner.js';
import { findKimiWire, findRollout } from '../src/terminal/programs.js';
import retry from './fixtures/kimi-retry.json';
import { hasTmux, host, sent, tmux, home, setUp, job, codexJob, kimiJob, until, typeTurn, done } from './terminal-host-helpers.js';

const jobs = { claude: job, codex: codexJob, kimi: kimiJob };
describe.skipIf(!hasTmux)('turn ends and signs from the program', () => {
  afterEach(async () => { vi.restoreAllMocks(); await host?.stop(); });
  it.each(Object.keys(jobs) as (keyof typeof jobs)[])('%s ends once in either channel order with its answer', async kind => {
    await setUp();
    const first = await host.run(jobs[kind]('dual', 'hello'));
    let nth = 0;
    for (const order of ['HOOKFIRST', 'LOGFIRST']) {
      await typeTurn('dual', 'view', order, `job-${order}`, nth++);
      await until(() => Boolean(done(`job-${order}`)));
      await new Promise(r => setTimeout(r, 250));
      expect(sent.filter(m => m.type === 'job.done' && m.jobId === `job-${order}`)).toEqual([expect.objectContaining({ ok: true, result: `echo: ${order}`, sessionId: first.sessionId })]);
    }
  });
  it.each([false, true])('uses Claude turn_duration when the end hook is lost, failed=%s', async failed => {
    await setUp();
    const hook = host['hook'].bind(host);
    vi.spyOn(host, 'hook').mockImplementation((key, event, data) => event === 'stop' ? Promise.resolve() : hook(key, event, data));
    const result = await host.run(job('lost', failed ? 'APIFAIL_AUTH_REAL' : 'hello'));
    expect(result).toMatchObject(failed ? { ok: false, error: 'not_logged_in', failure: { kind: 'auth' } } : { ok: true, result: 'echo: hello' });
  });
  it('fails a typed Claude auth turn from its failure hook', async () => {
    await setUp(); await host.run(job('auth', 'hello'));
    await typeTurn('auth', 'view', 'APIFAIL_AUTH_REAL', 'typed-auth');
    await until(() => Boolean(done('typed-auth')));
    expect(done('typed-auth')).toMatchObject({ ok: false, error: 'not_logged_in', failure: { kind: 'auth', retryable: false } });
  });
  it.each([['codex', 'APIFAIL_503', 'overloaded'], ['kimi', 'APIFAIL_AUTH', 'auth'], ['claude', 'APIFAIL_REAL', 'network'], ['codex', 'CRASH', 'crash']] as const)('%s carries %s failure to job.done', async (kind, prompt, failure) => {
    await setUp();
    const result = await host.run(jobs[kind]('failure', prompt));
    expect(jobDone('job', result, [])).toMatchObject({ ok: false, failure: { kind: failure } });
  });
  it('shows a Codex hook tool before its only rollout item_completed', async () => {
    await setUp({ lookMs: 50 });
    await host.run(codexJob('tool', 'WORK', { jobId: 'job-tool' }));
    expect(sent).toContainEqual(expect.objectContaining({ type: 'job.program', jobId: 'job-tool', state: 'tool', tool: 'Bash' }));
  });
  it('keeps signs tied to hooks and log lines, and clears Kimi retry at its next step', async () => {
    await setUp({ lookMs: 50, reportMs: 100 });
    const controller = new AbortController();
    const running = host.run(kimiJob('retry', 'HANG', { jobId: 'job-retry', signal: controller.signal }));
    await until(() => sent.some(m => m.type === 'job.program' && m.jobId === 'job-retry'));
    const a = host['agents'].get('retry')!;
    const before = a.signAt;
    await new Promise(r => setTimeout(r, 250));
    expect(a.signAt).toBe(before);
    await host['hook']('retry', 'tool', { tool_call_id: 'c', tool_name: 'Bash' });
    expect(a.signAt).toBeGreaterThan(before);
    await host['hook']('retry', 'tooldone', { tool_call_id: 'c', tool_name: 'Bash' });
    const wire = findKimiWire(a.home, a.sessionId!)!;
    appendFileSync(wire, JSON.stringify(retry) + '\n');
    await until(() => sent.some(m => m.type === 'job.program' && m.state === 'retrying'));
    expect(sent).toContainEqual(expect.objectContaining({ state: 'retrying', signAt: expect.any(Number), retry: { attempt: retry.failedAttempt, max: retry.maxAttempts, nextAt: expect.any(Number) } }));
    appendFileSync(wire, '{"type":"context.append_loop_event","event":{"type":"step.begin"}}\n');
    await until(() => sent.filter(m => m.type === 'job.program').at(-1)?.state === 'thinking');
    controller.abort(); await running;
  });
  it('drops mismatched Codex ends and logs a contradictory second end once', async () => {
    const log = vi.fn(); await setUp({ log });
    const controller = new AbortController();
    const running = host.run(codexJob('ids', 'HANG', { jobId: 'job-ids', signal: controller.signal }));
    await until(() => host['agents'].get('ids')?.took === true);
    const a = host['agents'].get('ids')!;
    await host['hook']('ids', 'stop', { turn_id: 'unrelated', last_assistant_message: 'Wrong' });
    expect(a.busy).toBe(true);
    const rollout = findRollout(a.home, a.workDir, 0, a.sessionId)!;
    const { readFileSync } = await import('node:fs');
    const start = readFileSync(rollout.file, 'utf8').split('\n').filter(Boolean).map(s => JSON.parse(s)).find(s => s.payload?.type === 'task_started');
    await host['hook']('ids', 'stop', { turn_id: start.payload.turn_id, last_assistant_message: 'Right' });
    expect(await running).toMatchObject({ ok: true, result: 'Right' });
    for (let i = 0; i < 2; i++) await host['hook']('ids', 'stop', { turn_id: start.payload.turn_id, hook_event_name: 'StopFailure', error: 'overloaded' });
    expect(log.mock.calls.filter(([text]) => text.includes('disagree'))).toHaveLength(1);
  });
});

describe.skipIf(!hasTmux)('Antigravity turn evidence', () => {
  afterEach(async () => { vi.restoreAllMocks(); await host?.stop(); });
  it('carries the AGY_ERROR retryable flag after a failed tool', async () => {
    const { agyProgram } = await import('../src/terminal/programs.js');
    await setUp();
    const result = await host.run({ ...job('agy-error', 'APIFAIL'), program: agyProgram, home: join(home, 'agy', 'agy-error'), bin: fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url)) });
    expect(result).toMatchObject({ ok: false, failure: { kind: 'overloaded', retryable: false, text: 'The server is overloaded' } });
  });
  it('ends once from a fresh AGY_ERROR when the failed Stop is lost', async () => {
    const { agyProgram } = await import('../src/terminal/programs.js');
    await setUp({ lookMs: 50 });
    await host.run({ ...job('agy-lost-failure', ''), program: agyProgram, home: join(home, 'agy', 'agy-lost-failure'), bin: fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url)) });
    await typeTurn('agy-lost-failure', 'view', 'APIFAIL_NO_STOP', 'job-agy-lost-failure');
    try {
      await until(() => Boolean(done('job-agy-lost-failure')), 2500);
      expect(done('job-agy-lost-failure')).toMatchObject({ ok: false, failure: { kind: 'overloaded', retryable: false, text: 'The server is overloaded' } });
      await host['hook']('agy-lost-failure', 'stop', { error: 'The server is overloaded' });
      expect(sent.filter(m => m.type === 'job.done' && m.jobId === 'job-agy-lost-failure')).toHaveLength(1);
    } finally {
      await host.cancel('job-agy-lost-failure');
    }
  });
  it.each(['Stop', 'lost Stop'])('classifies one fresh failure after the recording rolls over with %s', async channel => {
    const { agyProgram } = await import('../src/terminal/programs.js');
    await setUp({ lookMs: 50 });
    await host.run({ ...job('agy-rollover', '', { env: { FAKE_OLD_AGY_ERROR: '1' } }), program: agyProgram, home: join(home, 'agy', 'agy-rollover'), bin: fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url)) });
    await typeTurn('agy-rollover', 'view', `APIFAIL_ROLLOVER${channel === 'lost Stop' ? '_NO_STOP' : ''}`, 'job-agy-rollover');
    try {
      await until(() => Boolean(done('job-agy-rollover')), 5000);
      expect(tmux.programOutput('a-agy-rollover')).not.toContain('"old":true');
      expect(done('job-agy-rollover')).toMatchObject({ ok: false, failure: { kind: 'overloaded', retryable: false, text: 'The server is overloaded' } });
      await host['hook']('agy-rollover', 'stop', { error: 'The server is overloaded' });
      expect(sent.filter(m => m.type === 'job.done' && m.jobId === 'job-agy-rollover')).toHaveLength(1);
    } finally {
      await host.cancel('job-agy-rollover');
    }
  });
  it('does not reuse an older AGY_ERROR with the same reason', async () => {
    const { agyProgram } = await import('../src/terminal/programs.js');
    await setUp();
    const result = await host.run({ ...job('agy-old-error', 'APIFAIL_NO_DETAIL', { env: { FAKE_OLD_AGY_ERROR: '1' } }), program: agyProgram, home: join(home, 'agy', 'agy-old-error'), bin: fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url)) });
    expect(result).toMatchObject({ ok: false, failure: { kind: 'overloaded', retryable: true, text: 'The server is overloaded' } });
  });
  it('reports a permission request without an id as asking until its tool ends', async () => {
    await setUp({ lookMs: 50 });
    const controller = new AbortController();
    const running = host.run(job('ask', 'HANG', { jobId: 'job-ask', signal: controller.signal }));
    await until(() => host['agents'].get('ask')?.took === true);
    await host['hook']('ask', 'ask', { tool_name: 'Bash' });
    await until(() => sent.some(m => m.type === 'job.program' && m.state === 'asking'), 1000);
    await host['hook']('ask', 'tooldone', { tool_name: 'Bash', tool_use_id: 'p' });
    await until(() => sent.filter(m => m.type === 'job.program').at(-1)?.state === 'thinking');
    controller.abort(); expect(await running).not.toHaveProperty('failure');
  });
});

describe.skipIf(!hasTmux)('turn identity on a typed Codex prompt', () => {
  afterEach(async () => { vi.restoreAllMocks(); await host?.stop(); });
  it('keeps the task_started turn id when UserMessage opens the typed job', async () => {
    await setUp(); await host.run(codexJob('typed-id', 'hello'));
    await typeTurn('typed-id', 'view', 'HANG', 'job-id');
    const a = host['agents'].get('typed-id')!;
    await host['hook']('typed-id', 'stop', { turn_id: 'wrong', last_assistant_message: 'Wrong' });
    await new Promise(r => setTimeout(r, 100));
    expect(done('job-id')).toBeUndefined();
    await host.cancel('job-id');
  });
  it('calls an early program exit a crash', async () => {
    await setUp();
    expect(await host.run(job('startup-crash', 'hello', { env: { FAKE_CRASH_START: 'startup' } }))).toMatchObject({ ok: false, failure: { kind: 'crash' } });
  });
});

describe.skipIf(!hasTmux)('Antigravity end channels', () => {
  afterEach(async () => { vi.restoreAllMocks(); await host?.stop(); });
  it.each(['hook', 'log'])('keeps one answer with %s first', async first => {
    const { agyProgram } = await import('../src/terminal/programs.js');
    await setUp();
    const base = { ...job('agy-dual', ''), program: agyProgram, home: join(home, 'agy', 'agy-dual'), bin: fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url)) };
    await host.run(base);
    if (first === 'hook') {
      const hook = host['hook'].bind(host);
      vi.spyOn(host, 'hook').mockImplementation((key, event, body) => {
        if (event === 'stop') vi.spyOn(host['agents'].get(key)!.tail!, 'read').mockReturnValueOnce([]);
        return hook(key, event, body);
      });
    }
    await typeTurn('agy-dual', 'view', first === 'hook' ? 'LAG' : 'hello', 'job-agy');
    await until(() => Boolean(done('job-agy')));
    await new Promise(r => setTimeout(r, 250));
    expect(sent.filter(m => m.type === 'job.done' && m.jobId === 'job-agy')).toEqual([expect.objectContaining({ ok: true, result: 'FINISHED' })]);
  });
});
