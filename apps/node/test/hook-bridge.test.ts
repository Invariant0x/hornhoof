import { spawn } from 'node:child_process';
import { Agent as HttpAgent, request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bridge } from '../src/terminal/bridge.js';
import { fromAgent, OwnerUnknown, socketOf, type Peer } from '../src/terminal/peer.js';
import { procFixture } from './terminal-proc-fixture.js';
import { eventually } from '../../../test-support/eventually.mjs';

type Rejection = { key: string | null; event: string; reason: string };
const close: (() => void)[] = [];
afterEach(() => { close.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); });
const post = (url: string, id = 'one-call', pid = String(process.pid)) => fetch(url + '/stop', { method: 'POST', headers: { 'x-hh-call': id, 'x-hh-pid': pid }, body: '{"last_assistant_message":"Done."}' });

async function opened(onHook: ConstructorParameters<typeof Bridge>[1], owns: ConstructorParameters<typeof Bridge>[2] = null, fixture?: ReturnType<typeof procFixture>) {
  const rejected: Rejection[] = [];
  const bridge = new Bridge('http://127.0.0.1:9', onHook, owns, { proc: fixture?.proc, rejected: (key, event, reason) => rejected.push({ key, event, reason }) });
  await bridge.start();close.push(() => bridge.stop());
  fixture?.listen(bridge, () => process.pid, () => process.pid);
  return { bridge, url: bridge.agent('agent-1').hookUrl, rejected };
}

describe('hook delivery through the bridge', () => {
  it('accepts Antigravity invocation hooks with their payload intact', async () => {
    const heard: unknown[] = [];
    const b = await opened((_key, event, body) => void heard.push({ event, body }));
    const body = { invocationNum: 0, conversationId: 'agy-1', lastUserInput: 'hello' };
    expect((await fetch(b.url + '/invocation', { method: 'POST', body: JSON.stringify(body) })).status).toBe(200);
    expect(heard).toEqual([{ event: 'invocation', body }]);
  });

  it('accepts a legacy caller without a pid and denies malformed pid hints', async () => {
    let calls = 0;
    const fixture = procFixture('agent-1');
    const b = await opened(() => { calls++; }, fromAgent(async () => [process.pid], fixture.proc), fixture);
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
    try { await eventually(() => calls > 0);expect(calls).toBe(1); }
    finally { release(); }
    expect(await (await first).text()).toBe('accepted');
    expect(await (await second).text()).toBe('accepted');
  });

  it('finishes a verified stop after its caller closes the connection during the pane check', async () => {
    let checking!: () => void;const checked = new Promise<void>(r => checking = r);
    let finish!: () => void;const pause = new Promise<void>(r => finish = r);
    const heard: unknown[] = [];
    const fixture = procFixture('agent-1');
    const owns = fromAgent(async () => { checking();await pause;return [process.pid]; }, fixture.proc);
    const b = await opened((_key, event, body) => void heard.push({ event, body }), owns, fixture);
    const proof: Peer = { port: 0, bridgePort: 0, pid: process.pid };
    const closed = new Promise<void>(resolve => b.bridge['server']!.once('connection', socket => {
      proof.port = socket.remotePort!;proof.bridgePort = socket.localPort!;
      socket.once('close', () => resolve());
    }));
    const call = request(b.url + '/stop', { method: 'POST', headers: { 'x-hh-pid': String(process.pid), 'x-hh-call': 'closed-call' } });
    call.on('error', () => {});call.end('{"last_assistant_message":"Done."}');
    await checked;
    proof.acceptedInode = await socketOf(fixture.proc, proof);
    expect(proof.acceptedInode).not.toBeNull();
    call.destroy();await closed;
    expect(await socketOf(fixture.proc, proof)).toBeNull();
    expect(await fromAgent(async () => [process.pid], fixture.proc)('agent-1', proof)).toBe(false);
    finish();
    await eventually(() => heard.length > 0);
    expect(heard).toEqual([{ event: 'stop', body: { last_assistant_message: 'Done.' } }]);
  });

  it('rejects a real caller claiming the pid of another agent, including retries', async () => {
    const victim = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    close.push(() => void victim.kill('SIGKILL'));
    const heard: string[] = [];
    const fixture = procFixture('agent-1');
    const b = await opened(key => void heard.push(key), fromAgent(async key => key === 'agent-1' ? [victim.pid!] : [process.pid], fixture.proc), fixture);
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

  it('answers a lookup that gave no answer with a retryable 502, keeps nothing of it and says why', async () => {
    const answers: (() => boolean)[] = [() => { throw new OwnerUnknown('lsof timed out'); }, () => true];
    const heard: string[] = [];
    const b = await opened((_key, event) => void heard.push(event), async () => answers.shift()!());
    expect((await post(b.url, 'slow-call')).status).toBe(502);
    expect(heard).toEqual([]);
    expect((await post(b.url, 'slow-call')).status).toBe(200);
    expect(heard).toEqual(['stop']);
    expect(b.rejected).toEqual([{ key: 'agent-1', event: 'stop', reason: 'owner check unavailable: lsof timed out' }]);
  });

  it("reports a refused check command and tools call with the check's reason, as it does a hook", async () => {
    const b = await opened(() => { throw Error('must not run'); }, async (_key, _peer, why) => { why?.("the caller is not under the agent's pane");return false; });
    const check = b.url.replace('/hook/', '/check/');
    expect((await fetch(check, { method: 'POST', headers: { 'x-hh-pid': String(process.pid) }, body: '{}' })).status).toBe(403);
    expect((await fetch(b.bridge.agent('agent-1').mcpUrl, { method: 'POST', body: '{}' })).status).toBe(403);
    expect((await post(b.url)).status).toBe(403);
    const reason = "owner check failed: the caller is not under the agent's pane";
    expect(b.rejected).toEqual([{ key: 'agent-1', event: 'check', reason }, { key: 'agent-1', event: 'mcp', reason }, { key: 'agent-1', event: 'stop', reason }]);
    expect(JSON.stringify(b.rejected)).not.toContain(b.url.split('/').at(-1)!);
  });

  it('tells the host of a refused hook by its event, and never of a refused call of another kind or of no event', async () => {
    const unowned: [string, string][] = [];
    const bridge = new Bridge('http://127.0.0.1:9', () => { throw Error('must not run'); }, async () => false, { unowned: (key, event) => void unowned.push([key, event]) });
    await bridge.start();close.push(() => bridge.stop());
    const { hookUrl, attachUrl } = bridge.agent('agent-1');
    expect((await fetch(hookUrl + '/start', { method: 'POST', body: '{}' })).status).toBe(403);
    expect((await fetch(hookUrl, { method: 'POST', body: '{}' })).status).toBe(403);
    expect((await fetch(attachUrl + '/file')).status).toBe(403);
    expect(unowned).toEqual([['agent-1', 'start']]);
  });

  /* Calls on one kept connection, as one program makes them, each with its own call id. */
  function kept(bridge: Bridge, url: string) {
    const agent = new HttpAgent({ keepAlive: true, maxSockets: 1 });
    close.push(() => agent.destroy());
    const sockets = new Set<unknown>();
    bridge['server']!.on('connection', socket => sockets.add(socket));
    let n = 0;
    const call = () => new Promise<number>((resolve, reject) => {
      const req = request(url + '/stop', { method: 'POST', agent, headers: { 'x-hh-pid': String(process.pid), 'x-hh-call': `kept-${n++}` } }, res => { res.resume();res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject).end('{}');
    });
    return { call, sockets };
  }

  it('asks a refused caller again on its kept connection, so it passes once its pane has its program again', async () => {
    let adopted = false;const heard: string[] = [];
    const b = await opened((_key, event) => void heard.push(event), async (_key, _peer, why) => adopted || (why?.("the caller is not under the agent's pane"), false));
    const c = kept(b.bridge, b.url);
    expect(await c.call()).toBe(403);
    adopted = true;
    expect(await c.call()).toBe(200);
    expect(heard).toEqual(['stop']);
    expect(c.sockets.size).toBe(1);
  });

  it("answers a hook whose owner check outlasts the hook's wait with a retryable 502 first, on the bridge's clock", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    close.push(() => vi.useRealTimers());
    let checking!: () => void;const checked = new Promise<void>(resolve => { checking = resolve; });
    const b = await opened(() => { throw Error('must not run'); }, () => { checking();return new Promise<boolean>(() => {}); });
    const c = kept(b.bridge, b.url);
    let status = 0;
    const answer = c.call().then(code => { status = code; });
    await checked;
    await vi.advanceTimersByTimeAsync(1999);
    expect(status).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await answer;
    expect(status).toBe(502);
    expect(b.rejected).toEqual([{ key: 'agent-1', event: 'stop', reason: 'owner check unavailable: owner check timed out' }]);
  });

  it('reads the socket table again for the next call when it could not be read as the connection opened', async () => {
    let unreadable = true;const heard: string[] = [];const rejected: Rejection[] = [];
    const capture = async () => { if (unreadable) throw new OwnerUnknown('socket table read failed');return { acceptedInode: '7' }; };
    const bridge = new Bridge('http://127.0.0.1:9', (_key, event) => void heard.push(event), async (_key, peer) => peer.acceptedInode === '7', { capture, rejected: (key, event, reason) => rejected.push({ key, event, reason }) });
    await bridge.start();close.push(() => bridge.stop());
    const c = kept(bridge, bridge.agent('agent-1').hookUrl);
    expect(await c.call()).toBe(502);
    unreadable = false;
    expect(await c.call()).toBe(200);
    expect(heard).toEqual(['stop']);
    expect(c.sockets.size).toBe(1);
    expect(rejected).toEqual([{ key: 'agent-1', event: 'stop', reason: 'owner check unavailable: socket table read failed' }]);
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
