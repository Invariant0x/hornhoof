import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Bridge } from '../src/terminal/bridge.js';

type Seen = { method: string; url: string; auth: string; body: string };

async function upstream(): Promise<{ url: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization ?? '', body });
      res.writeHead(200, { 'content-type': 'application/json', 'x-file-name': 'build.tar.gz' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

describe("the node's bridge to Hornhoof's tools", () => {
  const closers: (() => void)[] = [];
  afterEach(() => closers.splice(0).forEach(c => c()));

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

  it("hands on a task's files both ways, with their names and up to 50 MB, and nothing else under the picture address", async () => {
    const up = await upstream();
    const bridge = new Bridge(up.url, () => {});
    await bridge.start();
    closers.push(() => bridge.stop(), () => up.server.close());
    const a = bridge.agent('agent-1');
    bridge.setToken('agent-1', 'tok-turn-1');
    const big = Buffer.alloc(20 * 1024 * 1024, 7);
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
    const early = bridge.listed('agent-1', 100);
    await post('tools/list');
    expect(await early).toBe(false);
    bridge.setToken('agent-1', 'tok-turn-1');
    let listed: boolean | null = null;
    void bridge.listed('agent-1', 5000).then(ok => (listed = ok));
    await post('tools/call');
    await new Promise(r => setTimeout(r, 20));
    expect(listed).toBeNull();
    await post('tools/list');
    await new Promise(r => setTimeout(r, 20));
    expect(listed).toBe(true);
  });

  it('counts a listing of the tools from when it was asked, so a slow answer to the program before counts for none since', async () => {
    let answer = () => {};
    const answered = new Promise<void>(r => (answer = r));
    const slow = createServer((req, res) => {
      req.resume().on('end', () => void answered.then(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}')));
    });
    await new Promise<void>(r => slow.listen(0, '127.0.0.1', r));
    const bridge = new Bridge(`http://127.0.0.1:${(slow.address() as AddressInfo).port}`, () => {});
    await bridge.start();
    closers.push(() => bridge.stop(), () => slow.close());
    const a = bridge.agent('agent-1');
    bridge.setToken('agent-1', 'tok-turn-1');
    const asked = fetch(a.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    await new Promise(r => setTimeout(r, 100));
    const since = Date.now();
    const listed = bridge.listed('agent-1', 300, since);
    answer();
    await asked;
    expect(await listed).toBe(false);
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
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const bridge = new Bridge(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, () => {});
    await bridge.start();
    closers.push(() => bridge.stop(), () => server.close());
    const a = bridge.agent('agent-1');
    bridge.setToken('agent-1', 'tok-turn-1');
    const list = () => fetch(a.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    const early = list();
    await new Promise(r => setTimeout(r, 100));
    const since = Date.now();
    await list();
    expect(bridge.listedSince('agent-1', since)).toBe(true);
    answer();
    await early;
    expect(bridge.listedSince('agent-1', since)).toBe(true);
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
    bridge.waitForTurns('agent-1', 2000);
    const post = (id: number) => fetch(a.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize' }) });
    const waiting = post(1);
    await new Promise(r => setTimeout(r, 100));
    expect(up.seen).toEqual([]);
    bridge.setToken('agent-1', 'tok-typed');
    expect((await waiting).status).toBe(200);
    expect(up.seen[0]).toMatchObject({ auth: 'Bearer tok-typed' });

    bridge.setToken('agent-1', null);
    bridge.waitForTurns('agent-1', 100);
    const started = Date.now();
    expect(await (await post(2)).json()).toMatchObject({ id: 2, error: { message: expect.stringContaining('No Hornhoof turn') } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(up.seen).toHaveLength(1);
  });

  it('never holds a tool call from between turns for the next turn, which would run it under that turn', async () => {
    const up = await upstream();
    const bridge = new Bridge(up.url, () => {});
    await bridge.start();
    closers.push(() => bridge.stop(), () => up.server.close());
    const a = bridge.agent('agent-1');
    bridge.waitForTurns('agent-1', 2000);
    const call = fetch(a.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"report"}}' });
    setTimeout(() => bridge.setToken('agent-1', 'tok-next'), 50);
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
