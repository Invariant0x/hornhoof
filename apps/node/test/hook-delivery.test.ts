import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { eventually } from '../../../test-support/eventually.mjs';
import { Bridge } from '../src/terminal/bridge.js';
import { fromAgent } from '../src/terminal/peer.js';
import { hookClock } from './hook-test-clock.js';
import { procFixture } from './terminal-proc-fixture.js';

const CLOCK = fileURLToPath(new URL('./fakes/hook-clock.cjs', import.meta.url));
const HOOK = fileURLToPath(new URL('../hh-hook.cjs', import.meta.url));
/* Longer than a hook used to wait: how long a busy machine may take to tell whose a call is. */
const BUSY_MS = 3500;

/* The node's bridge on a busy machine. It takes a hook only from the agent's own program, which it finds from the kernel's
   tables as in a node, here a while after the call came: while the caller still waits on its connection, the call is
   found its own; once it gave up and left, there is nothing left to find. The agent's program is this test's child. */
async function busyBridge(caller: () => number) {
  const heard: { event: string; body: unknown }[] = [];
  const checked: boolean[] = [];
  let release!: () => void;
  const busy = new Promise<void>(resolve => release = resolve);
  let checking = false;
  const fixture = procFixture('agent-1');
  const own = fromAgent(async () => [process.pid], fixture.proc);
  const bridge = new Bridge('http://127.0.0.1:9', (_key, event, body) => void heard.push({ event, body }), async (key, peer) => {
    checking = true;
    await busy;
    const ok = await own(key, peer);
    checked.push(ok);
    return ok;
  }, { proc: fixture.proc });
  await bridge.start();
  fixture.listen(bridge, () => process.pid, caller);
  return { bridge, heard, checked, release, checking: () => checking, url: bridge.agent('agent-1').hookUrl };
}

describe('word that a turn ended, on a busy machine', () => {
  const closers: (() => void)[] = [];
  afterEach(() => closers.splice(0).forEach(c => c()));

  it("reaches the node from Claude Code's stop hook though the bridge takes a while to tell whose the call is", async () => {
    let caller = process.pid;
    const b = await busyBridge(() => caller);
    closers.push(() => b.bridge.stop());
    const hook = spawn('node', ['-r', CLOCK, HOOK, 'stop', '{"last_assistant_message":"Done."}'], { env: { PATH: process.env.PATH, HH_BRIDGE: b.url }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    caller = hook.pid!;
    closers.push(() => { b.release(); hook.kill('SIGKILL'); });
    const clock = hookClock(hook);
    const exited = new Promise<void>(resolve => hook.once('exit', () => resolve()));
    await eventually(() => b.checking());
    await clock.advance(BUSY_MS);
    b.release();
    await exited;
    expect(hook.exitCode).toBe(0);
    await eventually(() => b.checked.length === 1);
    expect(b.checked).toEqual([true]);
    expect(b.heard).toEqual([{ event: 'stop', body: { last_assistant_message: 'Done.' } }]);
  }, 20_000);
});
