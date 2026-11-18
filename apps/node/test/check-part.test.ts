import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { CheckSlotQueue, checkCapacity, type ServerMessage } from '@hornhoof/protocol';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { CheckClient } from '../src/check-client.js';
import { checkCommand } from '../src/check-command.js';
import { setCheckClient, withCheckSlot } from '../src/check-queue.js';
import { runQueuedPart } from '../src/check-runtime.js';
import { runTests } from '../src/tests.js';
import { deferred } from '../../../test-support/deferred.mjs';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn }));
afterEach(() => { spawn.mockReset(); });

const part: Extract<ServerMessage, { type: 'tests.run' }> = {
  type: 'tests.run', partId: '10000000-0000-4000-8000-000000000124', kind: 'work', repo: null,
  branch: null, task: 1380, command: 'printf recorded', part: 2, parts: 2, timeoutMs: 3_600_000,
};

it('runs a nested hh-check in part 124/2 while another request waits on the loaded host', async () => {
  vi.useFakeTimers({ now: new Date('2026-11-18T08:57:23.159Z') });
  const dir = mkdtempSync(join(tmpdir(), 'hh-check-part-'));
  onTestFinished(() => { setCheckClient(null); vi.useRealTimers(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
  let load = 0;
  const queue = new CheckSlotQueue(() => checkCapacity(10, load));
  const releases = new Map<string, () => void>();
  const client = new CheckClient(frame => {
    if (frame.type === 'check.release') { releases.get(frame.id)?.(); return true; }
    void queue.withSlot(() => new Promise<void>(resolve => {
      releases.set(frame.id, resolve);
      client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 });
    }), { onPosition: position => client.receive({ type: 'check.state', id: frame.id, state: 'queued', position }) });
    return true;
  });
  setCheckClient(client); client.online(true);
  const parent = processRecord(), child = processRecord(), partSpawned = deferred();
  spawn.mockImplementationOnce(() => { partSpawned.resolve(); return parent; }).mockImplementationOnce(() => child);
  const independentStarted = deferred(), independentQueued = deferred();
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  onTestFinished(() => { vi.unstubAllGlobals(); });

  const running = runQueuedPart(part, runTests, { dir, hidden: [], user: null }, () => {}, () => {});
  await partSpawned.promise;
  const earlierStarted = deferred(), finishEarlier = deferred();
  const earlier = withCheckSlot(async () => { earlierStarted.resolve(); await finishEarlier.promise; });
  await earlierStarted.promise;
  load = 5; queue.refresh();
  const foreign = withCheckSlot(async () => { independentStarted.resolve(); }, { onPosition: () => independentQueued.resolve() });
  await independentQueued.promise;
  vi.setSystemTime(new Date('2026-11-18T09:23:48.526Z'));
  const env = spawn.mock.calls[0]![2].env as NodeJS.ProcessEnv;
  const nested = checkCommand(['--', 'recorded-check'], env).then(code => ({ code }), error => ({ error: String(error) }));
  child.emit('exit', 7, null);
  expect(await nested).toEqual({ code: 7 });
  expect(spawn.mock.calls[1]).toEqual(['recorded-check', [], expect.objectContaining({ detached: false, env: expect.objectContaining({ HH_CHECK_SLOT: expect.any(String) }) })]);
  expect(fetch).not.toHaveBeenCalled();
  parent.emit('exit', 0, null); parent.emit('close');
  expect((await running).ok).toBe(true);
  finishEarlier.resolve(); await earlier;
  await independentStarted.promise;
  await foreign;
});

function processRecord() {
  return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
}

it.each(['silent', 'active'] as const)('observes part activity through its quiet budget when %s', async activity => {
  vi.useFakeTimers({ now: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'hh-part-silence-'));
  onTestFinished(() => { setCheckClient(null); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
  const client = new CheckClient(frame => {
    if (frame.type === 'check.acquire') queueMicrotask(() => client.receive({ type: 'check.state', id: frame.id, state: 'running', position: 0 }));
    return true;
  });
  setCheckClient(client); client.online(true);
  const parent = processRecord(), partSpawned = deferred(), reports: string[] = [];
  spawn.mockImplementationOnce(() => { partSpawned.resolve(); return parent; });
  const message = { ...part, silenceMs: 60_000 };
  const options = { dir, hidden: [], user: null, onSilent: () => reports.push(message.partId) };
  const running = runQueuedPart(message, runTests, options, () => {}, () => {});
  await partSpawned.promise;
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(i === 0 ? 59_999 : 59_998);
    if (i === 0) expect(reports).toEqual([]);
    if (activity === 'active') parent.stdout.emit('data', Buffer.from('one file finished\n'));
    await vi.advanceTimersByTimeAsync(1);
    if (i === 0) expect(reports).toEqual(activity === 'silent' ? [message.partId] : []);
  }
  parent.emit('exit', 0, null); parent.emit('close');
  expect((await running).ok).toBe(true);
  expect(reports).toEqual(activity === 'silent' ? [message.partId] : []);
  expect(vi.getTimerCount()).toBe(0);
});
