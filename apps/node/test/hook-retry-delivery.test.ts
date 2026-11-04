import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bridge } from '../src/terminal/bridge.js';
import { fromAgent } from '../src/terminal/peer.js';
import { procFixture } from './terminal-proc-fixture.js';
const HOOK = fileURLToPath(new URL('../hh-hook.cjs', import.meta.url));
const CLOCK = fileURLToPath(new URL('./fakes/hook-clock.cjs', import.meta.url));
const close: (() => void)[] = [];
afterEach(() => close.splice(0).forEach(fn => fn()));

describe('owner check outlasting the hook client deadline', () => {
  it('finishes hh-hook stop once after timeouts and client exit', async () => {
    let checks = 0;let turn = 'first';const ended: string[] = [];
    const fixture = procFixture('agent-1');
    const owns = fromAgent(async () => {
      await new Promise(resolve => setTimeout(resolve, 350));checks++;
      return [process.pid];
    }, fixture.proc);
    const bridge = new Bridge('http://127.0.0.1:9', (_key, event) => {
      if (event === 'stop') { ended.push(turn);turn = 'next'; }
    }, owns, { proc: fixture.proc });
    await bridge.start();close.push(() => bridge.stop());
    let caller = process.pid;
    fixture.listen(bridge, () => process.pid, () => caller);
    const dir = mkdtempSync(join(tmpdir(), 'hh-retry-'));
    const args = [HOOK, 'stop', '{}'];
    const child = spawn('node', ['-r', CLOCK, ...args], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, HH_BRIDGE: bridge.agent('agent-1').hookUrl } });
    caller = child.pid!;
    close.push(() => void child.kill('SIGKILL'));child.stdout.resume();child.stderr.resume();
    child.stdin.end();
    /* Each attempt gets 150 ms; ownership takes 350 ms. */
    await vi.waitFor(() => expect(checks).toBe(3), { timeout: 4000 });
    expect(ended).toEqual(['first']);
    expect(turn).toBe('next');
  });
});
