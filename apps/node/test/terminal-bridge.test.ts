import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bridge } from '../src/terminal/bridge.js';
import { fromAgent } from '../src/terminal/peer.js';
import { eventually } from '../../../test-support/eventually.mjs';
import { listenIn } from '../../../test-support/ports.mjs';
import { procFixture } from './terminal-proc-fixture.js';

/* The longest time a timer takes: a wait the passing path must never see run out. */
const NEVER = 2_147_483_647;

type Seen = { method: string; url: string; auth: string; body: string };

async function upstream(result: unknown = { ok: true }): Promise<{ url: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization ?? '', body });
      res.writeHead(200, { 'content-type': 'application/json', 'x-file-name': 'build.tar.gz' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  await listenIn(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

/* Hornhoof behind its proxy in a short outage: it answers with these statuses first, then as usual. */
async function outage(statuses: number[]): Promise<{ url: string; seen: string[]; server: Server }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push(`${req.method} ${req.url} ${body}`);
      const status = statuses.shift() ?? 200;
      res.writeHead(status, { 'content-type': 'application/json', 'x-file-name': 'run.log' });
      res.end(status === 200 ? JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }) : 'Bad Gateway');
    });
  });
  await listenIn(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

/* A tool call, or a batch of them. */
const toolCall = (...names: string[]) => {
  const calls = names.map((name, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'tools/call', params: { name, arguments: {} } }));
  return JSON.stringify(calls.length === 1 ? calls[0] : calls);
};

describe("the node's bridge to Hornhoof's tools", () => {
  const closers: (() => void)[] = [];
  afterEach(() => { vi.useRealTimers(); closers.splice(0).forEach(c => c()); });

  it.each([false, true])('marks a sensitive request and learns its response before giving it to the program, delegated: %s', async delegated => {
    const result = { content: [{ type: 'text', text: '{"password":"private-bridge-marker"}' }] };
    const up = await upstream(result);
    const observed: unknown[] = [];
    const bridge = new Bridge(up.url, () => {}, null, { sensitive: (key, name, input, answer) => { observed.push({ key, name, input, answer }); } });
    await bridge.start();
    closers.push(() => bridge.stop(), () => up.server.close());
    bridge.setToken('agent-1', 'turn-token');
    const url = bridge.agent('agent-1').mcpUrl;
    const params = { name: 'vault_entry', arguments: { entry: 'Partner' } };
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: delegated ? { name: 'use_tool', arguments: params } : params };
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result });
    expect(observed).toEqual([
      { key: 'agent-1', name: 'vault_entry', input: { entry: 'Partner' }, answer: undefined },
      { key: 'agent-1', name: 'vault_entry', input: { entry: 'Partner' }, answer: { jsonrpc: '2.0', id: 1, result } },
    ]);
  });

  it('uses the sensitive flag of a newly listed tool before forwarding its input or reply', async () => {
    const policy = { sensitive: true, secretInput: ['value'], secretOutput: ['value'] };
    const result = { tools: [{ name: 'new_private_tool', _meta: policy }], content: [{ type: 'text', text: '{"value":"private-generic-marker"}' }] };
    const up = await upstream(result);
    const observed: unknown[] = [];
    const bridge = new Bridge(up.url, () => {}, null, { sensitive: (key, name, input, answer) => { observed.push({ key, name, input, answer }); } });
    await bridge.start();
    closers.push(() => bridge.stop(), () => up.server.close());
    bridge.setToken('agent-1', 'turn-token');
    const url = bridge.agent('agent-1').mcpUrl;
    await (await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })).text();
    const request = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'new_private_tool', arguments: { value: 'private-input-marker' } } };
    await (await fetch(url, { method: 'POST', body: JSON.stringify(request) })).text();
    expect(observed).toEqual([
      { key: 'agent-1', name: 'new_private_tool', input: request.params.arguments, answer: undefined },
      { key: 'agent-1', name: 'new_private_tool', input: request.params.arguments, answer: { jsonrpc: '2.0', id: 1, result } },
    ]);
  });

  it('waits for private output cleanup before forwarding a sensitive call', async () => {
    const up = await upstream();
    let seen = false;
    let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    const bridge = new Bridge(up.url, () => {}, null, { sensitive: async (_key, _name, _input, answer) => { if (!answer) { seen = true; await cleanup; } } });
    const forward = vi.spyOn(bridge as unknown as { forward: (url: string, init: RequestInit, retry: boolean) => Promise<Response> }, 'forward').mockResolvedValue(new Response('{"jsonrpc":"2.0","id":1,"result":{}}'));
    await bridge.start();
    closers.push(() => bridge.stop(), () => up.server.close());
    bridge.setToken('agent-1', 'turn-token');
    const response = fetch(bridge.agent('agent-1').mcpUrl, { method: 'POST', headers: { connection: 'close' }, body: toolCall('vault_entry') });
    try {
      await eventually(() => seen);
      expect(forward).not.toHaveBeenCalled();
    } finally { release(); }
    await (await response).text();
    expect(forward).toHaveBeenCalledOnce();
  });

  it('refuses a sensitive call when private output cleanup fails, without exposing the error', async () => {
    const up = await upstream();
    const bridge = new Bridge(up.url, () => {}, null, { sensitive: async () => { throw new Error('private-cleanup-error-marker'); } });
    await bridge.start();
    closers.push(() => bridge.stop(), () => up.server.close());
    bridge.setToken('agent-1', 'turn-token');
    const response = await fetch(bridge.agent('agent-1').mcpUrl, { method: 'POST', headers: { connection: 'close' }, body: toolCall('vault_entry') });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('private-cleanup-error-marker');
    expect(up.seen).toEqual([]);
  });

  /* The bridge's pauses between tries, taken on no clock: each one is only written down. */
  async function bridgeTo(statuses: number[]) {
    const up = await outage(statuses);
    const pauses: number[] = [];
    const bridge = new Bridge(up.url, () => {}, null, { pause: async ms => { pauses.push(ms); } });
    await bridge.start();
    closers.push(() => bridge.stop(), () => up.server.close());
    bridge.setToken('agent-1', 'tok-turn-1');
    const a = bridge.agent('agent-1');
    const post = (body: string) => fetch(a.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    return { up, pauses, a, post };
  }

  it('asks Hornhoof again after growing pauses when a short outage answers a call that only reads, or a file asked for', async () => {
    const read = await bridgeTo([502, 503]);
    const answer = await read.post(toolCall('test_run'));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(read.up.seen).toHaveLength(3);
    expect(read.pauses).toEqual([1_000, 2_000]);

    const file = await bridgeTo([504]);
    const got = await fetch(`${file.a.attachUrl}/file?task=12&file=run.log`);
    expect(got.status).toBe(200);
    expect(got.headers.get('x-file-name')).toBe('run.log');
    expect(file.up.seen).toEqual(['GET /api/attachments/file?task=12&file=run.log ', 'GET /api/attachments/file?task=12&file=run.log ']);
    expect(file.pauses).toEqual([1_000]);

    const tunnel = await bridgeTo([404, 502]);
    const inbox = await tunnel.post(toolCall('inbox'));
    expect(inbox.status).toBe(200);
    expect(await inbox.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(tunnel.up.seen).toHaveLength(3);
    expect(tunnel.pauses).toEqual([1_000, 2_000]);
  });

  it('gives an outage that lasts back after a few tries, and never asks again for a call that may have changed something', async () => {
    const lasting = await bridgeTo([502, 502, 502, 502, 502]);
    expect((await lasting.post(toolCall('task'))).status).toBe(502);
    expect(lasting.up.seen).toHaveLength(4);
    expect(lasting.pauses).toEqual([1_000, 2_000, 4_000]);

    for (const body of [toolCall('report'), toolCall('task', 'submit'), '{"jsonrpc":"2.0","id":1,"method":"initialize"}']) {
      const write = await bridgeTo([502]);
      expect((await write.post(body)).status).toBe(502);
      expect(write.up.seen).toHaveLength(1);
      expect(write.pauses).toEqual([]);
    }
  });

  it("hands each tool call on with the token of the agent's running turn", async () => {
    const up = await upstream();
    const bridge = new Bridge(up.url, () => {});
    await bridge.start();
    closers.push(() => bridge.stop(), () => up.server.close());
    const a = bridge.agent('agent-1');
    bridge.setToken('agent-1', 'tok-turn-1');
    const res = await fetch(a.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer forged' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(up.seen[0]).toMatchObject({ method: 'POST', url: '/mcp', auth: 'Bearer tok-turn-1', body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });

    bridge.setToken('agent-1', 'tok-turn-2');
    await fetch(a.attachUrl, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('png') });
    expect(up.seen[1]).toMatchObject({ url: '/api/attachments', auth: 'Bearer tok-turn-2', body: 'png' });
  });

  /* Codex sends the agent's secret from its environment as a bearer token, to the tools address that carries none: the
     secret stays off its command line, which any process of the machine reads. */
  it('knows an agent by the secret its program sends as a bearer token to the tools address without one, and by nothing else', async () => {
    const up = await upstream();
    const bridge = new Bridge(up.url, () => {});
    await bridge.start();
    closers.push(() => bridge.stop(), () => up.server.close());
    const a = bridge.agent('agent-1');
    const other = bridge.agent('agent-2');
    bridge.setToken('agent-1', 'tok-turn-1');
    expect(a.mcpUrl).toBe(`${a.mcpAddress}/${a.secret}`);
    expect(a.mcpAddress).not.toContain(a.secret);
    expect(a.hookUrl.endsWith(`/hook/${a.secret}`)).toBe(true);
    const post = (to: string, authorization?: string) => fetch(to, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    const res = await post(a.mcpAddress, `Bearer ${a.secret}`);
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect(up.seen).toEqual([expect.objectContaining({ url: '/mcp', auth: 'Bearer tok-turn-1' })]);
    for (const auth of ['Bearer wrong', a.secret, `Basic ${a.secret}`, undefined]) expect((await post(a.mcpAddress, auth)).status).toBe(404);
    /* The secret in the path names the agent; a bearer token beside it names no other. */
    expect((await post(a.mcpUrl, `Bearer ${other.secret}`)).status).toBe(200);
    expect(up.seen.at(-1)).toMatchObject({ auth: 'Bearer tok-turn-1' });
    const attach = a.attachUrl.slice(0, -a.secret.length - 1);
    expect((await fetch(attach, { method: 'POST', headers: { authorization: `Bearer ${a.secret}` }, body: Buffer.from('png') })).status).toBe(404);
    expect(up.seen).toHaveLength(2);
  });

  /* Agents of one plan share a Linux user, and each reads the others' environment: the secret proves nothing alone, whether it
     comes in the path or as a bearer token. The kernel's tables, here a controlled copy of /proc, must find the process that
     holds the caller's end under the agent's own pane; the user it runs as is never asked. */
  it("refuses a process of the same user outside the agent's pane that sends the agent's own secret as a bearer token", async () => {
    const up = await upstream();
    const PANE = 4100;
    const caller = { pid: PANE + 1, belongs: true };
    const fixture = procFixture('agent-1', () => caller.belongs);
    const bridge = new Bridge(up.url, () => {}, fromAgent(async key => (key === 'agent-1' ? [PANE] : []), fixture.proc), { proc: fixture.proc, capture: fixture.capture });
    await bridge.start();
    fixture.listen(bridge, () => PANE, () => caller.pid);
    closers.push(() => bridge.stop(), () => up.server.close());
    const a = bridge.agent('agent-1');
    bridge.setToken('agent-1', 'tok-turn-1');
    /* A connection of its own each time: the bridge keeps what it found for a connection. */
    const post = (to: string, authorization?: string) => fetch(to, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close', ...(authorization ? { authorization } : {}) }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    expect((await post(a.mcpAddress, `Bearer ${a.secret}`)).status).toBe(200);
    Object.assign(caller, { pid: 4200, belongs: false });
    expect((await post(a.mcpAddress, `Bearer ${a.secret}`)).status).toBe(403);
    expect((await post(a.mcpUrl)).status).toBe(403);
    expect(up.seen).toHaveLength(1);
  });

  it("hands on a task's files both ways, with their names and of any size, and nothing else under the picture address", async () => {
    const up = await upstream();
    const bridge = new Bridge(up.url, () => {});
    await bridge.start();
    closers.push(() => bridge.stop(), () => up.server.close());
    const a = bridge.agent('agent-1');
    bridge.setToken('agent-1', 'tok-turn-1');
    const big = Buffer.alloc(60 * 1024 * 1024, 7);
    expect((await fetch(`${a.attachUrl}?task=12&name=build.tar.gz`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: big })).status).toBe(200);
    expect(up.seen[0]).toMatchObject({ method: 'POST', url: '/api/attachments?task=12&name=build.tar.gz', auth: 'Bearer tok-turn-1' });
    expect(up.seen[0]!.body.length).toBe(big.length);
    const got = await fetch(`${a.attachUrl}/file?task=12&file=build.tar.gz`);
    expect(got.headers.get('x-file-name')).toBe('build.tar.gz');
    expect(up.seen[1]).toMatchObject({ method: 'GET', url: '/api/attachments/file?task=12&file=build.tar.gz', auth: 'Bearer tok-turn-1' });
    expect((await fetch(`${a.attachUrl}/other`)).status).toBe(404);
    expect(up.seen).toHaveLength(2);
  });

  it("says when the agent's program has listed its tools during a turn, and gives up after the time it was given", async () => {
    const up = await upstream();
    const bridge = new Bridge(up.url, () => {});
    await bridge.start();
    closers.push(() => bridge.stop(), () => up.server.close());
    const a = bridge.agent('agent-1');
    const post = (method: string) => fetch(a.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }) });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let early: boolean | null = null;
    void bridge.listed('agent-1', 100).then(ok => (early = ok));
    await post('tools/list');
    await vi.advanceTimersByTimeAsync(99);
    expect(early).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(early).toBe(false);
    vi.useRealTimers();
    bridge.setToken('agent-1', 'tok-turn-1');
    let listed: boolean | null = null;
    void bridge.listed('agent-1', NEVER).then(ok => (listed = ok));
    /* The bridge hears a listing as it answers it, before the program's call returns. */
    await post('tools/call');
    expect(listed).toBeNull();
    await post('tools/list');
    expect(listed).toBe(true);
  });

  it('counts a listing of the tools from when it was asked, so a slow answer to the program before counts for none since', async () => {
    let answer = () => {};
    const answered = new Promise<void>(r => (answer = r));
    let asking = false;
    const slow = createServer((req, res) => {
      asking = true;
      req.resume().on('end', () => void answered.then(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}')));
    });
    await listenIn(slow);
    const bridge = new Bridge(`http://127.0.0.1:${(slow.address() as AddressInfo).port}`, () => {});
    await bridge.start();
    closers.push(() => bridge.stop(), () => slow.close());
    const a = bridge.agent('agent-1');
    bridge.setToken('agent-1', 'tok-turn-1');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const asked = fetch(a.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    await eventually(() => asking);
    vi.setSystemTime(Date.now() + 100);
    const since = Date.now();
    let listed: boolean | null = null;
    void bridge.listed('agent-1', 300, since).then(ok => (listed = ok));
    answer();
    await asked;
    await vi.advanceTimersByTimeAsync(299);
    expect(listed).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(listed).toBe(false);
    expect([bridge.listedSince('agent-1', since), bridge.listedSince('agent-1', since - 1000)]).toEqual([false, true]);
  });

  it('keeps the later of two listings when the answer to the earlier one comes last', async () => {
    let answer = () => {};
    const answered = new Promise<void>(r => (answer = r));
    let calls = 0;
    const server = createServer((req, res) => {
      const first = calls++ === 0;
      req.resume().on('end', () => void (first ? answered : Promise.resolve()).then(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}')));
    });
    await listenIn(server);
    const bridge = new Bridge(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, () => {});
    await bridge.start();
    closers.push(() => bridge.stop(), () => server.close());
    const a = bridge.agent('agent-1');
    bridge.setToken('agent-1', 'tok-turn-1');
    const list = () => fetch(a.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    vi.useFakeTimers({ toFake: ['Date'] });
    const early = list();
    await eventually(() => calls === 1);
    vi.setSystemTime(Date.now() + 100);
    const since = Date.now();
    await list();
    expect(bridge.listedSince('agent-1', since)).toBe(true);
    answer();
    await early;
    expect(bridge.listedSince('agent-1', since)).toBe(true);
  });

  /* A program keeps its connection to the bridge between two tool calls, often for longer than Node's 5 seconds, and its
     next call on a connection the bridge just closed broke with ECONNRESET. The bridge keeps an idle connection as long as
     Hornhoof's own front does, and tells the program so. */
  it('keeps a program\'s idle connection as long as Hornhoof\'s front does, and says so in each answer', async () => {
    const up = await upstream();
    const bridge = new Bridge(up.url, () => {});
    await bridge.start();
    closers.push(() => bridge.stop(), () => up.server.close());
    const res = await fetch(bridge.agent('agent-1').mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":7,"method":"tools/call"}' });
    await res.arrayBuffer();
    expect([res.status, res.headers.get('connection'), res.headers.get('keep-alive')]).toEqual([200, 'keep-alive', 'timeout=72']);
  });

  it('answers a tool call between turns with an error the agent can read, without asking Hornhoof', async () => {
    const up = await upstream();
    const bridge = new Bridge(up.url, () => {});
    await bridge.start();
    closers.push(() => bridge.stop(), () => up.server.close());
    const a = bridge.agent('agent-1');
    const res = await fetch(a.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":7,"method":"tools/call"}' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', id: 7, error: { message: expect.stringContaining('No Hornhoof turn') } });
    expect(up.seen).toEqual([]);
  });

  it('lets the tool calls of an agent whose program connects as a turn opens wait for its token, for a while', async () => {
    const up = await upstream();
    const bridge = new Bridge(up.url, () => {});
    await bridge.start();
    closers.push(() => bridge.stop(), () => up.server.close());
    const a = bridge.agent('agent-1');
    bridge.waitForTurns('agent-1', NEVER);
    const post = (id: number, method = 'initialize') => fetch(a.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method }) });
    const holds = () => bridge['waiting'].get('agent-1')?.size === 1;
    const waiting = post(1);
    await eventually(holds);
    expect(up.seen).toEqual([]);
    bridge.setToken('agent-1', 'tok-typed');
    expect((await waiting).status).toBe(200);
    expect(up.seen[0]).toMatchObject({ auth: 'Bearer tok-typed' });

    bridge.setToken('agent-1', null);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    bridge.waitForTurns('agent-1', 100);
    let answered = false;
    /* A list of tools Hornhoof never gave this agent. */
    const late = post(2, 'tools/list').then(res => { answered = true; return res.json(); });
    await eventually(holds);
    await vi.advanceTimersByTimeAsync(99);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await late).toMatchObject({ id: 2, error: { message: expect.stringContaining('No Hornhoof turn') } });
    expect(up.seen).toHaveLength(1);
  });

  it("answers a program that connects with no turn open with what Hornhoof said to the same before, and says what it refused", async () => {
    const up = await upstream();
    const refused: [string | null, string, string][] = [];
    const bridge = new Bridge(up.url, () => {}, null, { refused: (...said) => refused.push(said) });
    await bridge.start();
    closers.push(() => bridge.stop(), () => up.server.close());
    const a = bridge.agent('agent-1');
    const post = (body: object) => fetch(a.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', ...body }) });
    bridge.setToken('agent-1', 'tok-turn');
    await post({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    await post({ id: 1, method: 'tools/list' });
    bridge.setToken('agent-1', null);
    const since = Date.now();

    expect(await (await post({ id: 5, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json()).toEqual({ jsonrpc: '2.0', id: 5, result: { ok: true } });
    expect((await post({ method: 'notifications/initialized' })).status).toBe(202);
    expect(await (await post({ id: 6, method: 'tools/list' })).json()).toEqual({ jsonrpc: '2.0', id: 6, result: { ok: true } });
    expect(await (await post({ id: 7, method: 'ping' })).json()).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
    expect(bridge.listedSince('agent-1', since)).toBe(true);
    expect(up.seen).toHaveLength(2);

    /* What Hornhoof never said, it does not say for it: another protocol version, another agent's tools, a tool call. */
    expect(await (await post({ id: 8, method: 'initialize', params: { protocolVersion: '2099-01-01' } })).json()).toMatchObject({ id: 8, error: { code: -32001 } });
    expect(await (await fetch(bridge.agent('agent-2').mcpUrl, { method: 'POST', body: '{"jsonrpc":"2.0","id":9,"method":"tools/list"}' })).json()).toMatchObject({ id: 9, error: { code: -32001 } });
    await post({ id: 10, method: 'tools/call', params: { name: 'task' } });
    await post({ id: 11, method: 'tools/call', params: { name: 'task' } });
    expect(up.seen).toHaveLength(2);
    expect(refused).toEqual([['agent-1', 'initialize', 'no Hornhoof turn is running'], ['agent-2', 'tools/list', 'no Hornhoof turn is running'], ['agent-1', 'tools/call', 'no Hornhoof turn is running']]);
  });

  it('remembers a program it turned away as it connected between turns, until the program lists its tools', async () => {
    const up = await upstream();
    const bridge = new Bridge(up.url, () => {});
    await bridge.start();
    closers.push(() => bridge.stop(), () => up.server.close());
    const a = bridge.agent('agent-1');
    const since = Date.now();
    const post = (method: string) => fetch(a.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }) });
    await post('tools/call');
    expect(bridge.toolsRefusedSince('agent-1', since)).toBe(false);
    expect(await (await post('initialize')).json()).toMatchObject({ error: { code: -32001 } });
    expect(bridge.toolsRefusedSince('agent-1', since)).toBe(true);
    expect(bridge.toolsRefusedSince('agent-1', Date.now() + 1)).toBe(false);
    bridge.setToken('agent-1', 'tok-turn');
    await post('tools/list');
    expect(bridge.toolsRefusedSince('agent-1', since)).toBe(false);
  });

  /* Newer MCP clients, agy 1.4.12 among them, first ask the server what it is with server/discover, and fall back to
     initialize when the server does not know it. agy asks as it takes a person's words, a moment before the turn opens. */
  it('lets a program that asks what the server is with server/discover wait for the turn as one that initializes does, and remembers it turned one away', async () => {
    const up = await upstream();
    const bridge = new Bridge(up.url, () => {});
    await bridge.start();
    closers.push(() => bridge.stop(), () => up.server.close());
    const a = bridge.agent('agent-1');
    const discover = () => fetch(a.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"server/discover"}' });
    bridge.waitForTurns('agent-1', NEVER);
    const waiting = discover();
    await eventually(() => bridge['waiting'].get('agent-1')?.size === 1);
    bridge.setToken('agent-1', 'tok-typed');
    expect((await waiting).status).toBe(200);
    expect(up.seen[0]).toMatchObject({ auth: 'Bearer tok-typed', body: '{"jsonrpc":"2.0","id":1,"method":"server/discover"}' });

    bridge.setToken('agent-1', null);
    bridge.waitForTurns('agent-1', 0);
    const since = Date.now();
    expect(await (await discover()).json()).toMatchObject({ id: 1, error: { code: -32001 } });
    expect(bridge.toolsRefusedSince('agent-1', since)).toBe(true);
  });

  it('never holds a tool call from between turns for the next turn, which would run it under that turn', async () => {
    const up = await upstream();
    const bridge = new Bridge(up.url, () => {});
    await bridge.start();
    closers.push(() => bridge.stop(), () => up.server.close());
    const a = bridge.agent('agent-1');
    /* A held call would wait here for a token that never comes, until the runner's limit for the test. */
    bridge.waitForTurns('agent-1', NEVER);
    const call = fetch(a.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"report"}}' });
    expect(await (await call).json()).toMatchObject({ id: 3, error: { message: expect.stringContaining('No Hornhoof turn') } });
    expect(up.seen).toEqual([]);
  });

  it("takes an agent's hook calls, and refuses a wrong secret", async () => {
    const up = await upstream();
    const heard: [string, string, unknown][] = [];
    const bridge = new Bridge(up.url, async (key, event, body) => void heard.push([key, event, body]));
    await bridge.start();
    closers.push(() => bridge.stop(), () => up.server.close());
    const a = bridge.agent('agent-1');
    expect(bridge.agent('agent-1').hookUrl).toBe(a.hookUrl);
    expect((await fetch(`${a.hookUrl}/stop`, { method: 'POST', body: '{"session_id":"s1"}' })).status).toBe(200);
    expect(heard).toEqual([['agent-1', 'stop', { session_id: 's1' }]]);
    expect((await fetch(a.hookUrl.replace(/hook\/[^/]+/, 'hook/wrong') + '/stop', { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await fetch(a.mcpUrl.replace(/mcp\/.+$/, 'mcp/wrong'), { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it("refuses tool, picture and hook calls that do not come from the agent's own program", async () => {
    const up = await upstream();
    const heard: string[] = [];
    const asked: { key: string; port: number; bridgePort: number }[] = [];
    const bridge = new Bridge(up.url, key => void heard.push(key), async (key, peer) => {
      asked.push({ key, ...peer });
      return false;
    });
    await bridge.start();
    closers.push(() => bridge.stop(), () => up.server.close());
    const a = bridge.agent('agent-1');
    bridge.setToken('agent-1', 'tok-turn-1');
    const mcp = await fetch(a.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    expect(mcp.status).toBe(403);
    expect((await fetch(a.attachUrl, { method: 'POST', body: Buffer.from('png') })).status).toBe(403);
    expect((await fetch(`${a.hookUrl}/stop`, { method: 'POST', body: '{}' })).status).toBe(403);
    expect(up.seen).toEqual([]);
    expect(heard).toEqual([]);
    expect(asked[0]).toMatchObject({ key: 'agent-1', bridgePort: Number(new URL(a.mcpUrl).port) });
    expect(asked[0]!.port).toBeGreaterThan(0);
  });
});

describe('lifecycle hook events', () => {
  it.each(['queued', 'tool', 'tooldone', 'toolfail', 'ask', 'interrupt', 'end'])('accepts %s', async event => {
    const seen: unknown[] = [];
    const bridge = new Bridge('http://127.0.0.1:9', (key, got, body) => { seen.push([key, got, body]); });
    await bridge.start();
    try {
      const res = await fetch(`${bridge.agent('agent').hookUrl}/${event}`, { method: 'POST', body: '{"tool_name":"Bash"}' });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
      expect(seen).toEqual([['agent', event, { tool_name: 'Bash' }]]);
    } finally { bridge.stop(); }
  });
});
