import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OperatorNodeMessage } from '@hornhoof/protocol/program-operator';
import { SIGNED_OUT } from '../src/providers/antigravity.js';
import { agyProgram } from '../src/terminal/programs.js';
import { afterEach, expect, it, vi } from 'vitest';
import { hasTmux, home, host, job, kimiJob, setUp, tmux, until, sent as terminalFrames } from './terminal-host-helpers.js';

let dir = '';
afterEach(async () => { vi.restoreAllMocks(); await host?.stop(); if (dir) rmSync(dir, { recursive: true, force: true }); });

it.skipIf(!hasTmux).each(['claude', 'kimi', 'antigravity'] as const)('records the actual %s assignment receipt in a real tmux program and never alarms after its own activity', async kind => {
  dir = join(home, `operator-${randomUUID()}`);
  let now = 0;
  const sent: OperatorNodeMessage[] = [];
  await setUp({ readyMs: 2000, pollMs: 25, lookMs: 50, cols: 120, rows: 40, plugins: [], operator: { dir, now: () => now, connected: () => true, send: frame => { sent.push(frame); return true; } } });
  const key = randomUUID(), jobId = randomUUID(), id = randomUUID();
  const base = kind === 'kimi' ? kimiJob(key, 'hello', { agentKey: key, jobId }) : job(key, 'hello', { agentKey: key, jobId });
  const requested = kind === 'antigravity' ? { ...base, program: agyProgram, bin: fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url)), home: join(home, 'agy', key), signedOut: SIGNED_OUT } : base;
  const result = await host.run({ ...requested, operatorDelivery: { id, ordinal: 1 } });
  expect(result, `${result.error}: ${result.failure?.text ?? 'No program failure detail.'}`).toMatchObject({ ok: true });
  expect(sent).toContainEqual(expect.objectContaining({ type: 'program.delivery', deliveryId: id, phase: 'taken' }));
  now = 8 * 3600000;
  host.operatorTick();
  expect(sent.filter(frame => frame.type === 'program.operator_needed' && frame.agentKey === key)).toEqual([]);
});

it.skipIf(!hasTmux)('does not paste a continuation whose original words have already been recorded', async () => {
  dir = join(home, `operator-${randomUUID()}`);
  await setUp({ pollMs: 25, plugins: [], operator: { dir, connected: () => true, send: () => true } });
  const key = randomUUID(), source = { id: randomUUID(), ordinal: 1 };
  const initial = job(key, 'hello', { agentKey: key, jobId: randomUUID() });
  const first = await host.run({ ...initial, operatorDelivery: source });
  expect(first.ok).toBe(true);
  const paste = vi.spyOn(tmux, 'paste');
  const duplicate = await host.run({ ...job(key, 'hello', { agentKey: key, jobId: randomUUID(), sessionId: first.sessionId }), operatorDelivery: { id: randomUUID(), ordinal: 2 }, operatorSourceDelivery: source });
  expect(duplicate).toMatchObject({ ok: false, error: 'cancelled' });
  expect(paste).not.toHaveBeenCalled();
});

it.skipIf(!hasTmux).each(['continuation', 'continuation that the program is slow to call busy', 'continuation just after the owner typed those words', 'typed', 'late typed'] as const)('retains the assignment pane and credits source activity after owner recovery: %s', async mode => {
  const continues = mode.startsWith('continuation');
  const pastes = mode === 'continuation' || mode === 'continuation that the program is slow to call busy' ? 1 : 0;
  const key = randomUUID(), jobId = randomUUID(), source = { id: randomUUID(), ordinal: 1 };
  dir = join(home, `operator-owner-${key}`);
  const setup = join(dir, 'setup-passed'); const frames: OperatorNodeMessage[] = []; let now = 0;
  await setUp({ pollMs: 25, readyMs: 2000, lookMs: 50, cols: 120, rows: 40, plugins: [], ...(mode === 'late typed' ? { openMs: 25 } : {}), operator: { dir, now: () => now, connected: () => true, send: frame => { frames.push(frame); return true; } } });
  const original = 'Owner recovery original words.';
  const base = job(key, original, { agentKey: key, jobId });
  const requested = { ...base, program: agyProgram, bin: fileURLToPath(new URL('./fakes/fake-agy-term.mjs', import.meta.url)), home: join(home, 'agy', key), signedOut: SIGNED_OUT, input: { ...base.input, env: { ...base.input.env, FAKE_AGY_SETUP: setup, FAKE_LOG: join(dir, 'setup-keys.jsonl') } } };
  const paste = vi.spyOn(tmux, 'paste');
  const running = host.run({ ...requested, operatorDelivery: source });
  await until(async () => (await tmux.screen(`a-${key}`)).includes('Choose your color scheme'));
  now = 60000; host.operatorTick();
  await until(() => frames.some(frame => frame.type === 'program.operator_needed' && frame.reason === 'assignment_unrecorded'));
  const needed = frames.find(frame => frame.type === 'program.operator_needed' && frame.reason === 'assignment_unrecorded');
  expect(needed).toBeDefined();
  if (!needed) throw new Error('No assignment operator case evidence.');
  const incident = { agentKey: key, jobId, instance: needed.instance, case: randomUUID(), capability: randomUUID() };
  await host.operatorMessage({ type: 'program.operator_case', ...incident, revision: 1, disposition: 'open', remainingMs: 600000, reason: 'assignment_unrecorded' });
  await host.operatorMessage({ type: 'program.operator_case', ...incident, revision: 2, disposition: 'revoke', remainingMs: 0, reason: 'assignment_unrecorded', closedBecause: 'needs_owner' });
  const stopped = await running;
  expect(stopped).toMatchObject({ ok: false, error: 'agent_failed', failure: { retryable: false } });
  expect(await tmux.alive(`a-${key}`)).toBe(true);
  expect(await tmux.screen(`a-${key}`)).toContain('Choose your color scheme');
  expect(paste.mock.calls.filter(([, text]) => text === original)).toEqual([]);
  const termId = randomUUID();
  await host.open({ type: 'term.open', termId, agentKey: key, cols: 120, rows: 40, write: true });
  try {
    await until(() => terminalFrames.some(frame => frame.type === 'term.data' && frame.termId === termId));
    await until(async () => (await tmux.clients()).some(client => client.session === `a-${key}`));
    host.input({ type: 'term.input', termId, data: '\r' });
    await until(async () => (await tmux.screen(`a-${key}`)).includes('Terms'));
    const setupKeys = () => readFileSync(join(dir, 'setup-keys.jsonl'), 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { setup?: string; key?: string }).filter(entry => entry.setup);
    for (const [data, key] of [['\x1b[B', 'down'], ['\x1b[B', 'down'], ['\r', 'enter']]) {
      const count = setupKeys().length;
      host.input({ type: 'term.input', termId, data: data! });
      await until(() => setupKeys().length > count);
      expect(setupKeys().at(-1)).toMatchObject({ setup: 'terms', key });
    }
    await until(() => existsSync(setup));
    await until(() => frames.some(frame => frame.type === 'program.recovery_ready'));
    const agent = host['agents'].get(key)!;
    await host['look'](agent); await host['look'](agent);
    expect(frames.filter(frame => frame.type === 'program.recovery_ready')).toEqual([expect.objectContaining({ case: incident.case, jobId })]);
    const pid = await tmux.programPid(`a-${key}`);
    const continuation = { ...requested, operatorDelivery: { id: randomUUID(), ordinal: 2 }, operatorSourceDelivery: source, input: { ...requested.input, jobId: randomUUID(), sessionId: stopped.sessionId } };
    let sessionId = stopped.sessionId;
    if (continues) {
      /* The program takes the words during the host's look at it, and is busy only once it read where its output stands. */
      if (mode !== 'continuation') {
        const [alive, cursor] = [tmux.alive.bind(tmux), tmux.programCursor.bind(tmux)];
        vi.spyOn(tmux, 'alive').mockImplementation(async name => { await new Promise(done => setTimeout(done, 100)); return alive(name); });
        vi.spyOn(tmux, 'programCursor').mockImplementation(async name => { await new Promise(done => setTimeout(done, 800)); return cursor(name); });
      }
      if (mode === 'continuation just after the owner typed those words') {
        host.input({ type: 'term.input', termId, data: `${original}\r` });
        await until(() => frames.some(frame => frame.type === 'program.delivery' && frame.deliveryId === source.id && frame.phase === 'taken'));
      }
      const result = await host.run(continuation);
      expect(result, `${result.error}: ${result.failure?.text ?? 'No program failure detail.'}`).toMatchObject({ ok: true });
      sessionId = result.sessionId;
    } else {
      host.input({ type: 'term.input', termId, data: `${original}\r` });
      await until(() => terminalFrames.some(frame => frame.type === 'turn.open' && frame.agentKey === key));
      const opened = terminalFrames.find(frame => frame.type === 'turn.open' && frame.agentKey === key);
      if (opened?.type !== 'turn.open') throw new Error('No owner turn.');
      expect(opened.queuedFrom).toBe(jobId);
      if (mode === 'late typed') await until(() => Boolean(host['agents'].get(key)?.unopened.find(turn => turn.ref === opened.ref)?.over));
      const ownerJob = randomUUID();
      host.opened({ type: 'turn.opened', agentKey: key, jobId: ownerJob, toolToken: 'owner-test-token', ref: opened.ref });
      await until(() => terminalFrames.some(frame => frame.type === 'job.done' && frame.jobId === ownerJob));
      const result = terminalFrames.find(frame => frame.type === 'job.done' && frame.jobId === ownerJob);
      expect(result).toMatchObject({ ok: true });
      if (result?.type === 'job.done') sessionId = result.sessionId;
    }
    expect(await tmux.programPid(`a-${key}`)).toBe(pid);
    expect(paste.mock.calls.filter(([, text]) => text === original)).toHaveLength(pastes);
    expect(frames.filter(frame => frame.type === 'program.delivery' && frame.deliveryId === source.id && frame.phase === 'taken')).toHaveLength(1);
    now += 300000; host.operatorTick();
    const activityEvidence = frames.filter(frame => frame.type === 'program.delivery' || frame.type === 'program.launch').map(frame => ({ type: frame.type, jobId: frame.jobId, instance: frame.instance, phase: frame.phase, deliveryId: 'deliveryId' in frame ? frame.deliveryId : null }));
    expect(frames.filter(frame => frame.type === 'program.operator_needed' && frame.reason === 'recorded_no_activity'), JSON.stringify(activityEvidence)).toEqual([]);
    expect(await host.run({ ...continuation, operatorDelivery: { id: randomUUID(), ordinal: 3 }, input: { ...continuation.input, jobId: randomUUID(), sessionId } })).toMatchObject({ ok: false, error: 'cancelled' });
    expect(paste.mock.calls.filter(([, text]) => text === original)).toHaveLength(pastes);
  } finally { host.close({ type: 'term.close', termId }); }
});
