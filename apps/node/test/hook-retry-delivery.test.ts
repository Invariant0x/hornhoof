import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bridge } from '../src/terminal/bridge.js';
import { fromAgent } from '../src/terminal/peer.js';
const HOOK = fileURLToPath(new URL('../hh-hook.cjs', import.meta.url));
const AGY = fileURLToPath(new URL('../hh-agy.cjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./fakes/agy', import.meta.url));
const CLOCK = fileURLToPath(new URL('./fakes/hook-clock.cjs', import.meta.url));
const close: (() => void)[] = [];
afterEach(() => close.splice(0).forEach(fn => fn()));

describe.skipIf(!existsSync('/proc/net/tcp'))('owner check outlasting the hook client deadline', () => {
  for (const kind of ['hh-hook', 'hh-agy'] as const) it(`finishes ${kind}'s stop once after timeouts and client exit`, async () => {
    let checks = 0;let turn = 'first';const ended: string[] = [];
    const owns = fromAgent(async () => {
      await new Promise(resolve => setTimeout(resolve, 350));checks++;
      return [process.pid];
    });
    const bridge = new Bridge('http://127.0.0.1:9', (_key, event) => {
      if (event === 'stop') { ended.push(turn);turn = 'next'; }
    }, owns);
    await bridge.start();close.push(() => bridge.stop());
    const dir = mkdtempSync(join(tmpdir(), 'hh-retry-'));
    const args = kind === 'hh-hook' ? [HOOK, 'stop', '{}'] : [AGY, FAKE];
    const child = spawn('node', ['-r', CLOCK, ...args], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, HH_BRIDGE: bridge.agent('agent-1').hookUrl } });
    close.push(() => void child.kill('SIGKILL'));child.stdout.resume();child.stderr.resume();
    if (kind === 'hh-hook') child.stdin.end();else child.stdin.write('hello\r');
    /* The clock gives each attempt150ms; ownership takes350ms. agy also calls start and prompt. */
    await vi.waitFor(() => expect(checks).toBe(kind === 'hh-hook' ? 3 : 5), { timeout: 4000 });
    expect(ended).toEqual(['first']);
    expect(turn).toBe('next');
  });
});
