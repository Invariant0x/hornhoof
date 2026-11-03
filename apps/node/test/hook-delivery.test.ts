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
const FAKE_AGY = fileURLToPath(new URL('./fakes/agy', import.meta.url));
/* Longer than a hook used to wait: how long a busy machine may take to tell whose a call is. */
const BUSY_MS = 3500;

/* The node's bridge on a busy machine. It takes a hook only from the agent's own program, which it finds from the kernel's
   tables as in a node, here a while after the call came: while the caller still waits on its connection, the call is
   found its own; once it gave up and left, there is nothing left to find. The agent's program is this test's child. */
async function busyBridge() {
  const heard: { event: string; body: unknown }[] = [];
  const checked: boolean[] = [];
  const own = fromAgent(async () => [process.pid]);
  const bridge = new Bridge('http://127.0.0.1:9', (_key, event, body) => void heard.push({ event, body }), async (key, peer) => {
    await new Promise(r => setTimeout(r, BUSY_MS));
    const ok = await own(key, peer);
    checked.push(ok);
    return ok;
  });
  await bridge.start();
  return { bridge, heard, checked, url: bridge.agent('agent-1').hookUrl };
}

describe.skipIf(!existsSync('/proc/net/tcp'))('word that a turn ended, on a busy machine', () => {
  const closers: (() => void)[] = [];
  afterEach(() => closers.splice(0).forEach(c => c()));

  it("reaches the node from Claude Code's stop hook though the bridge takes a while to tell whose the call is", async () => {
    const b = await busyBridge();
    closers.push(() => b.bridge.stop());
    const hook = spawn('node', [HOOK, 'stop', '{"last_assistant_message":"Done."}'], { env: { PATH: process.env.PATH, HH_BRIDGE: b.url }, stdio: 'ignore' });
    await new Promise(r => hook.on('exit', r));
    await vi.waitFor(() => expect(b.checked).toHaveLength(1), { timeout: BUSY_MS + 2000 });
    expect(b.heard).toEqual([{ event: 'stop', body: { last_assistant_message: 'Done.' } }]);
  }, 20_000);

  it("reaches the node from Hornhoof's screen for Antigravity, once agy answered, though the bridge takes a while", async () => {
    const b = await busyBridge();
    const dir = mkdtempSync(join(tmpdir(), 'hh-agy-'));
    const agy = spawn('node', [AGY, FAKE_AGY], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, HH_BRIDGE: b.url }, stdio: ['pipe', 'ignore', 'ignore'] });
    closers.push(() => b.bridge.stop(), () => void agy.kill('SIGKILL'));
    agy.stdin.write('hello\r');
    /* Its start, the message and the end: each call the bridge looked at. */
    await vi.waitFor(() => expect(b.checked).toHaveLength(3), { timeout: 4 * BUSY_MS + 5000 });
    expect(b.heard.map(h => h.event)).toContain('prompt');
    expect(b.heard).toContainEqual({ event: 'stop', body: { session_id: expect.any(String), last_assistant_message: expect.stringMatching(/^Git rebase/) } });
  }, 30_000);
});
