import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bridge } from '../src/terminal/bridge.js';
import { fromAgent } from '../src/terminal/peer.js';

type Rejection = { key: string | null; event: string; reason: string };
const close: (() => void)[] = [];
afterEach(() => { close.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); });
const post = (url: string, id = 'one-call', pid = String(process.pid)) => fetch(url + '/stop', { method: 'POST', headers: { 'x-hh-call': id, 'x-hh-pid': pid }, body: '{"last_assistant_message":"Done."}' });

async function opened(onHook: ConstructorParameters<typeof Bridge>[1], owns: ConstructorParameters<typeof Bridge>[2] = null) {
  const rejected: Rejection[] = [];
  const bridge = new Bridge('http://127.0.0.1:9', onHook, owns, { rejected: (key, event, reason) => rejected.push({ key, event, reason }) });
  await bridge.start();close.push(() => bridge.stop());
  return { bridge, url: bridge.agent('agent-1').hookUrl, rejected };
}

describe('hook delivery through the bridge', () => {
  it.skipIf(!existsSync('/proc/net/tcp'))('accepts a legacy caller without a pid and denies malformed pid hints', async () => {
    let calls = 0;
    const b = await opened(() => { calls++; }, fromAgent(async () => [process.pid]));
    expect((await fetch(b.url + '/stop', { method: 'POST', body: '{}' })).status).toBe(200);
    for (const pid of ['zero', '0', '-1', '1.5', '99999999999']) expect((await post(b.url, 'invalid-pid', pid)).status).toBe(403);
    expect(calls).toBe(1);
  });

  it('does not apply the same stop again after the next turn starts', async () => {
    let turn = 'first';const ended: string[] = [];
    const b = await opened(() => { ended.push(turn); });
    expect((await post(b.url)).status).toBe(200);
    turn = 'next';
    expect((await post(b.url)).status).toBe(200);
    expect(ended).toEqual(['first']);
    expect((await post(b.url, 'next-call')).status).toBe(200);
    expect(ended).toEqual(['first', 'next']);
  });

  it('remembers a recent stop across an idle gap before the next turn', async () => {
    let now = 100_000;vi.spyOn(Date, 'now').mockImplementation(() => now);
    let turn = 'first';const ended: string[] = [];
    const b = await opened(() => { ended.push(turn); });
    expect((await post(b.url)).status).toBe(200);
    now += 600_000;turn = 'next';
    expect((await post(b.url)).status).toBe(200);
    expect(ended).toEqual(['first']);
  });

  it('logs a missing hook event for a known agent', async () => {
    const b = await opened(() => {});
    expect((await fetch(b.url, { method: 'POST', body: '{}' })).status).toBe(404);
    expect(b.rejected).toEqual([{ key: 'agent-1', event: 'unknown', reason: 'unknown hook event' }]);
  });

  it('shares an in-flight stop and its answer across retries', async () => {
    let release!: () => void;const waiting = new Promise<void>(r => release = r);let calls = 0;
    const b = await opened(async () => { calls++;await waiting;return 'accepted'; });
    const first = post(b.url);const second = post(b.url);
    try { await vi.waitFor(() => expect(calls).toBeGreaterThan(0));expect(calls).toBe(1); }
    finally { release(); }
    expect(await (await first).text()).toBe('accepted');
    expect(await (await second).text()).toBe('accepted');
  });

  it.skipIf(!existsSync('/proc/net/tcp'))('finishes a verified stop after its caller closes the connection during the pane check', async () => {
    let checking!: () => void;const checked = new Promise<void>(r => checking = r);
    let finish!: () => void;const pause = new Promise<void>(r => finish = r);
    const heard: unknown[] = [];
    const owns = fromAgent(async () => { checking();await pause;return [process.pid]; });
    const b = await opened((_key, event, body) => void heard.push({ event, body }), owns);
    const call = request(b.url + '/stop', { method: 'POST', headers: { 'x-hh-pid': String(process.pid), 'x-hh-call': 'closed-call' } });
    call.on('error', () => {});call.end('{"last_assistant_message":"Done."}');
    await checked;call.destroy();finish();
    await vi.waitFor(() => expect(heard).toEqual([{ event: 'stop', body: { last_assistant_message: 'Done.' } }]));
  });

  it.skipIf(!existsSync('/proc/net/tcp'))('rejects a real caller claiming the pid of another agent, including retries', async () => {
    const victim = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    close.push(() => void victim.kill('SIGKILL'));
    const heard: string[] = [];
    const b = await opened(key => void heard.push(key), fromAgent(async key => key === 'agent-1' ? [victim.pid!] : [process.pid]));
    expect((await post(b.bridge.agent('agent-2').hookUrl)).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await post(b.url, 'borrowed-call', String(victim.pid))).status).toBe(403);
    expect(heard).toEqual(['agent-2']);
  });

  it('reports owner refusals once a minute and does not reuse authorization for a different pid', async () => {
    let now = 100_000;vi.spyOn(Date, 'now').mockImplementation(() => now);
    const pids: (number | undefined)[] = [];
    const b = await opened(() => { throw Error('must not run'); }, async (_key, peer) => { pids.push(peer.pid);return false; });
    for (let i = 0; i < 3; i++) expect((await post(b.url)).status).toBe(403);
    expect(b.rejected).toEqual([{ key: 'agent-1', event: 'stop', reason: 'owner check failed' }]);
    expect(pids).toContain(process.pid);
    expect((await post(b.url, 'forged-call', '12345')).status).toBe(403);
    expect(pids).toContain(12345);
    now += 60_000;
    expect((await post(b.url)).status).toBe(403);
    expect(b.rejected).toHaveLength(2);
  });

  it('does not trust a borrowed pid or a cached successful stop before checking the caller', async () => {
    let allowed = true;let calls = 0;
    const b = await opened(() => { calls++; }, async () => allowed);
    expect((await post(b.url)).status).toBe(200);
    allowed = false;
    expect((await post(b.url, 'one-call', '12345')).status).toBe(403);
    expect(calls).toBe(1);
  });

  it('reports an unknown address without leaking its secret or attributing it to an agent', async () => {
    const b = await opened(() => {});
    const unknown = b.url.replace(/hook\/.+$/, 'hook/private-unknown-secret');
    expect((await post(unknown)).status).toBe(404);
    expect(b.rejected).toEqual([{ key: null, event: 'stop', reason: 'unknown bridge address' }]);
    expect(JSON.stringify(b.rejected)).not.toContain('private-unknown-secret');
  });

  it('reports a failed hook without exposing its body or applying it again', async () => {
    let calls = 0;
    const b = await opened(() => { calls++;throw Error('private-body-secret'); });
    expect((await post(b.url)).status).toBe(502);
    expect((await post(b.url)).status).toBe(502);
    expect(calls).toBe(1);
    expect(b.rejected).toEqual([{ key: 'agent-1', event: 'stop', reason: 'hook handler failed' }]);
  });
});
