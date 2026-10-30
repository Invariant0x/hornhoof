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
      res.writeHead(200, { 'content-type': 'application/json' });
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
});
