/// <reference types="node" />
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  killed: boolean;
  kill: (signal?: NodeJS.Signals) => boolean;
  finish: (code: number | null, signal?: NodeJS.Signals | null) => void;
};

const harness = vi.hoisted(() => {
  const DEFAULT_HOOK_TIMEOUT_MS = 30_000;
  let onSpawn: ((child: FakeChild) => void) | null = null;
  const spawnedWith: { env?: NodeJS.ProcessEnv }[] = [];
  const beforeAllHooks: Array<(args: Record<string, never>, info: { setTimeout: (ms: number) => void; project: { timeout: number; expect: { timeout: number }; use: { actionTimeout: number; navigationTimeout: number } } }) => Promise<unknown>> = [];
  const afterAllHooks: Array<() => Promise<unknown>> = [];
  let activeSlot: { timeout: number; update: () => void } | null = null;

  const setTimeoutHook = (ms: number): void => {
    if (!activeSlot) return;
    activeSlot.timeout = ms;
    activeSlot.update();
  };

  const runBeforeAll = async (): Promise<void> => {
    for (const hook of beforeAllHooks) {
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const slot = {
          timeout: DEFAULT_HOOK_TIMEOUT_MS,
          update: () => {
            if (timer !== undefined) clearTimeout(timer);
            timer = undefined;
            if (slot.timeout > 0) {
              timer = setTimeout(() => reject(new Error(`"beforeAll" hook timeout of ${slot.timeout}ms exceeded.`)), slot.timeout);
            }
          },
        };
        activeSlot = slot;
        slot.update();
        const info = {
          setTimeout: setTimeoutHook,
          project: { timeout: DEFAULT_HOOK_TIMEOUT_MS, expect: { timeout: 0 }, use: { actionTimeout: 0, navigationTimeout: 0 } },
        };
        Promise.resolve(hook({}, info)).then(
          () => {
            if (timer !== undefined) clearTimeout(timer);
            activeSlot = null;
            resolve();
          },
          err => {
            if (timer !== undefined) clearTimeout(timer);
            activeSlot = null;
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
      });
    }
  };

  const runAfterAll = async (): Promise<void> => {
    for (const hook of afterAllHooks) await hook();
  };

  return {
    spawnedWith,
    setOnSpawn: (fn: (child: FakeChild) => void) => {
      onSpawn = fn;
    },
    takeOnSpawn: () => onSpawn,
    beforeAllHooks,
    afterAllHooks,
    setTimeoutHook,
    runBeforeAll,
    runAfterAll,
  };
});

function makeFakeChild(autoStopOnStdinEnd = true): FakeChild {
  const emitter = new EventEmitter() as FakeChild;
  emitter.stdin = new PassThrough();
  emitter.stdout = new PassThrough();
  emitter.stderr = new PassThrough();
  emitter.exitCode = null;
  emitter.killed = false;
  emitter.finish = (code, signal = null) => {
    if (emitter.exitCode !== null || emitter.killed) return;
    if (code !== null) emitter.exitCode = code;
    else emitter.killed = true;
    emitter.emit('exit', code, signal);
  };
  emitter.kill = (signal = 'SIGTERM') => {
    emitter.finish(null, signal);
    return true;
  };
  if (autoStopOnStdinEnd) {
    emitter.stdin.once('finish', () => emitter.finish(0, null));
  }
  return emitter;
}

vi.mock('node:child_process', () => ({
  spawn: (_command: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    harness.spawnedWith.push(options);
    const child = makeFakeChild();
    harness.takeOnSpawn()?.(child);
    return child;
  },
}));

vi.mock('@playwright/test', () => {
  const testFn = Object.assign(() => undefined, {
    describe: Object.assign(() => undefined, { configure: () => undefined }),
    beforeAll: (fn: (typeof harness.beforeAllHooks)[number]) => void harness.beforeAllHooks.push(fn),
    afterAll: (fn: (typeof harness.afterAllHooks)[number]) => void harness.afterAllHooks.push(fn),
    afterEach: () => undefined,
    beforeEach: () => undefined,
    setTimeout: (ms: number) => harness.setTimeoutHook(ms),
  });
  return { expect: () => ({}), test: testFn };
});

import { pageFolder, startServer } from '../e2e/real-server';
import '../e2e/long-feedback-and-reports.spec';

describe('the environment of a real server', () => {
  it('has what the test names beside the public address, over the machine\'s own, and none of it without a name', async () => {
    const boot = JSON.stringify({ origin: 'http://127.0.0.1:4199' }) + '\n';
    harness.setOnSpawn(child => queueMicrotask(() => void child.stdout.write(boot)));
    process.env.HH_WEB_DIST = 'from the machine';
    try {
      const named = await startServer('/* stub */', { cwd: '/tmp', publicUrl: 'http://localhost:4179', invalidBoot: 'Invalid server boot line', env: { HH_WEB_DIST: '/tmp/page' } });
      await named.stop();
      expect(harness.spawnedWith.at(-1)!.env).toMatchObject({ HH_WEB_DIST: '/tmp/page', HH_PUBLIC_URL: 'http://localhost:4179' });

      const unnamed = await startServer('/* stub */', { cwd: '/tmp', publicUrl: 'http://localhost:4180', invalidBoot: 'Invalid server boot line' });
      await unnamed.stop();
      expect(harness.spawnedWith.at(-1)!.env).toMatchObject({ HH_WEB_DIST: 'from the machine', HH_PUBLIC_URL: 'http://localhost:4180' });
    } finally {
      delete process.env.HH_WEB_DIST;
    }
  });
});

describe('the page of a real server', () => {
  it('is a folder with an index.html of its own each time it is asked for', () => {
    const [first, second] = [pageFolder('hh-test-web-'), pageFolder('hh-test-web-')];
    try {
      expect(first).not.toBe(second);
      for (const folder of [first, second]) expect(readFileSync(join(folder, 'index.html'), 'utf8')).toContain('<title>Hornhoof</title>');
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  /* A server names the build of its page at /api/build only with a page of its own; without one it answers 404, which the
     browser logs as a console error and the feedback test counts (#1923). */
  it('is given by long-feedback-and-reports to its server before it starts and removed when the tests end', async () => {
    harness.setOnSpawn(child => queueMicrotask(() => void child.stdout.write(JSON.stringify({ origin: 'http://127.0.0.1:4199' }) + '\n')));
    await harness.runBeforeAll();
    const folder = harness.spawnedWith.at(-1)!.env?.HH_WEB_DIST;
    expect(folder).toBeTruthy();
    expect(readFileSync(join(folder!, 'index.html'), 'utf8')).toContain('<title>Hornhoof</title>');
    await harness.runAfterAll();
    expect(existsSync(folder!)).toBe(false);
  });
});

describe('real server startup in long-feedback-and-reports', () => {
  it('waits past 30 s for the server readiness line in beforeAll without a speed-dependent timeout', async () => {
    vi.useFakeTimers();
    let stubTimer: ReturnType<typeof setTimeout> | undefined;
    let spawned: FakeChild | null = null;
    harness.setOnSpawn(child => {
      spawned = child;
      stubTimer = setTimeout(() => {
        child.stdout.write(
          JSON.stringify({
            origin: 'http://127.0.0.1:4199',
            ceoSession: 'ceo-tok',
            ceoId: 'ceo-1',
            devMemberSession: 'dev-tok',
            opsMemberSession: 'ops-tok',
          }) + '\n',
        );
      }, 45_000);
    });

    try {
      let outcome: 'pending' | 'ready' | Error = 'pending';
      const booting = harness.runBeforeAll().then(
        () => {
          outcome = 'ready';
        },
        (err: unknown) => {
          outcome = err instanceof Error ? err : new Error(String(err));
        },
      );

      await vi.advanceTimersByTimeAsync(35_000);
      expect(outcome).toBe('pending');

      await vi.advanceTimersByTimeAsync(10_000);
      await booting;
      expect(outcome).toBe('ready');

      await harness.runAfterAll();
      await harness.runAfterAll();
      expect(spawned).not.toBeNull();
      expect(spawned!.exitCode).toBe(0);
    } finally {
      if (stubTimer !== undefined) clearTimeout(stubTimer);
      vi.useRealTimers();
    }
  });

  it('rejects immediately on early exit, signal, spawn error, or invalid boot line without waiting', async () => {
    harness.setOnSpawn(child => {
      queueMicrotask(() => {
        child.stderr.write('migration failed');
        child.finish(1, null);
      });
    });
    await expect(startServer('/* stub */', { cwd: '/tmp', publicUrl: 'http://localhost:4179', invalidBoot: 'Invalid server boot line' })).rejects.toThrow(
      /Real server exited early \(1\):[\s\S]*migration failed/,
    );

    harness.setOnSpawn(child => {
      queueMicrotask(() => {
        child.stderr.write('killed by oom');
        child.finish(null, 'SIGKILL');
      });
    });
    await expect(startServer('/* stub */', { cwd: '/tmp', publicUrl: 'http://localhost:4179', invalidBoot: 'Invalid server boot line' })).rejects.toThrow(
      /Real server exited early \(SIGKILL\):[\s\S]*killed by oom/,
    );

    harness.setOnSpawn(child => {
      queueMicrotask(() => {
        child.emit('error', new Error('spawn EAGAIN'));
      });
    });
    await expect(startServer('/* stub */', { cwd: '/tmp', publicUrl: 'http://localhost:4179', invalidBoot: 'Invalid server boot line' })).rejects.toThrow(/spawn EAGAIN/);

    let badChild: FakeChild | null = null;
    harness.setOnSpawn(child => {
      badChild = child;
      queueMicrotask(() => {
        child.stdout.write('not-json-at-all\n');
      });
    });
    await expect(startServer('/* stub */', { cwd: '/tmp', publicUrl: 'http://localhost:4179', invalidBoot: 'Invalid server boot line' })).rejects.toThrow(
      /Invalid server boot line: not-json-at-all/,
    );
    expect(badChild!.exitCode !== null || badChild!.killed).toBe(true);
  });
});
