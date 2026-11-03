import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { hasTmux, host, job, setUp, sent, until } from './terminal-host-helpers.js';
const HOOK = fileURLToPath(new URL('../hh-hook.cjs', import.meta.url));

describe.skipIf(!hasTmux)('hook refusal at the node boundary', () => {
  afterEach(async () => host?.stop());
  it('logs a known hook refusal and sends an agent diagnostic, without taking the turn as answered', async () => {
    const logs: string[] = [];await setUp({ proc: '/proc', log: line => logs.push(line) });
    const stop = new AbortController();
    const run = job('hook-owner', 'HANG', { signal: stop.signal });
    const running = host.run(run);
    try {
    await until(async () => (await host.screen('hook-owner')).includes('HANG'));
    const url = host['bridge'].agent('hook-owner').hookUrl;
    const child = spawn('node', [HOOK, 'stop', '{}'], { env: { PATH: process.env.PATH, HH_BRIDGE: url }, stdio: 'ignore' });
    await new Promise<void>(resolve => child.once('exit', () => resolve()));
    expect(logs.join('\n')).toContain('Hook stop rejected: owner check failed');
    expect(sent).toContainEqual({ type: 'agent.hook_rejected', agentKey: 'hook-owner', event: 'stop', reason: 'owner check failed' });
    expect(run.events).toEqual([]);
    } finally { stop.abort();await running; }
  });
});
