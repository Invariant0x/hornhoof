import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bridge } from '../src/terminal/bridge.js';
import { fromAgent } from '../src/terminal/peer.js';
import { hookClock } from './hook-test-clock.js';
import { procFixture } from './terminal-proc-fixture.js';
import { eventually } from '../../../test-support/eventually.mjs';
const HOOK = fileURLToPath(new URL('../hh-hook.cjs', import.meta.url));
const CLOCK = fileURLToPath(new URL('./fakes/hook-clock.cjs', import.meta.url));
const close: (() => void)[] = [];
afterEach(() => {
  close.splice(0).forEach(fn => fn());
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('owner check outlasting the hook client deadline', () => {
  it('finishes hh-hook stop once after its one wait ran out and the client exited', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let checks = 0;let turn = 'first';const ended: string[] = [];
    let release!: () => void;
    const busy = new Promise<void>(resolve => release = resolve);
    let checking = 0;
    const fixture = procFixture('agent-1');
    const owns = fromAgent(async () => {
      checking++;
      await busy;
      checks++;
      return [process.pid];
    }, fixture.proc);
    const bridge = new Bridge('http://127.0.0.1:9', (_key, event) => {
      if (event === 'stop') { ended.push(turn);turn = 'next'; }
    }, owns, { proc: fixture.proc, capture: fixture.capture });
    const handling: Promise<void>[] = [];
    const handle = bridge['handle'].bind(bridge);
    bridge['handle'] = (...args) => {
      const done = handle(...args);
      handling.push(done);
      return done;
    };
    await bridge.start();close.push(() => bridge.stop());
    let caller = process.pid;
    fixture.listen(bridge, () => process.pid, () => caller);
    /* Force the table refresh race: an asynchronous read may see the truncated file before its replacement is written. */
    bridge['server']!.on('connection', () => writeFileSync(join(fixture.proc, 'net', 'tcp'), ''));
    const dir = mkdtempSync(join(tmpdir(), 'hh-retry-'));
    const args = [HOOK, 'stop', '{}'];
    const child = spawn('node', ['-r', CLOCK, ...args], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], cwd: dir, env: { PATH: process.env.PATH, HOME: dir, HH_BRIDGE: bridge.agent('agent-1').hookUrl } });
    if (!child.stdin || !child.stdout || !child.stderr) throw new Error('Hook pipe streams unavailable');
    caller = child.pid!;
    close.push(() => void child.kill('SIGKILL'));child.stdout.resume();child.stderr.resume();
    child.stdin.end();
    const clock = hookClock(child);
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    close.push(release);
    /* The client sends its stop once and waits fifty seconds in all: it times out and exits before the ownership lookup
       finishes, and sends nothing again, as a new connection would start the check over. */
    await eventually(() => checking === 1 || child.exitCode !== null);
    expect(checking).toBe(1);
    await clock.advance(50_000);
    /* A client that sent again would start a second check before it could exit. */
    await eventually(() => child.exitCode !== null || checking > 1);
    expect(checking).toBe(1);
    await exited;
    expect(child.exitCode).toBe(0);
    expect(ended).toEqual([]);
    release();
    await Promise.all(handling);
    expect(checks).toBe(1);
    expect(ended).toEqual(['first']);
    expect(turn).toBe('next');
  });
});
