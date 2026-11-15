import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Bridge, type OutsideAnswer } from '../src/terminal/bridge.js';
import { eventually } from '../../../test-support/eventually.mjs';
import { listenIn } from '../../../test-support/ports.mjs';

/* What Claude Code 2.1.325 sent as it connected to an MCP server over HTTP, recorded at the server: it asks what the
   server is with server/discover first, then initializes, says it did, opens its stream and lists the tools. */
type Recorded = { method: 'GET' | 'POST'; headers: Record<string, string>; body?: { id?: unknown; method: string } };
const CLAUDE_CONNECTS: Recorded[] = readFileSync(new URL('./fixtures/claude-mcp-connect.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Recorded);

type Asked = { key: string; body: string; version: string | undefined };

/* Hornhoof as the node's link reaches it: it answers each request as /mcp would and a notification with nothing. */
function hornhoof(answer: (msg: { id?: unknown; method: string }) => OutsideAnswer | null = msg => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: msg.method === 'tools/list' ? { tools: [{ name: 'company' }] } : { said: msg.method } }) })) {
  const asked: Asked[] = [];
  const outside = async (key: string, body: string, version: string | undefined): Promise<OutsideAnswer | null> => {
    asked.push({ key, body, version });
    const msg = JSON.parse(body) as { id?: unknown; method: string };
    if (msg.id === undefined) return { status: 202, body: '' };
    return answer(msg);
  };
  return { asked, outside };
}

/* Hornhoof's /mcp for a turn's token: what reaches it with one. */
async function upstream(): Promise<{ url: string; seen: { auth: string; body: string }[]; server: Server }> {
  const seen: { auth: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization ?? '', body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { inTurn: true } }));
    });
  });
  await listenIn(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

describe("the node's bridge with no turn of the agent running", () => {
  const closers: (() => void)[] = [];
  afterEach(() => { closers.splice(0).forEach(c => c()); });

  async function bridgeWith(options: ConstructorParameters<typeof Bridge>[3] = {}) {
    const up = await upstream();
    const bridge = new Bridge(up.url, () => {}, null, options);
    await bridge.start();
    closers.push(() => bridge.stop(), () => up.server.close());
    const send = (key: string, r: Recorded) => fetch(bridge.agent(key).mcpUrl, { method: r.method, headers: r.headers, ...(r.body ? { body: JSON.stringify(r.body) } : {}) });
    return { up, bridge, send };
  }

  /* Each request of the program as it connects, and what it got back. */
  async function connects(send: (key: string, r: Recorded) => Promise<Response>, key: string) {
    const got: { method: string; status: number; body: unknown }[] = [];
    for (const r of CLAUDE_CONNECTS.filter(r => r.method === 'POST')) {
      const res = await send(key, r);
      const text = await res.text();
      got.push({ method: r.body!.method, status: res.status, body: text ? JSON.parse(text) : null });
    }
    return got;
  }

  it('hands what a program sends as it connects to Hornhoof over the node\'s link, as Claude Code sends it, and never turns it away', async () => {
    const at = hornhoof();
    const { up, bridge, send } = await bridgeWith({ outside: at.outside });
    const since = Date.now();
    const got = await connects(send, 'agent-1');
    expect(got.map(g => [g.method, g.status])).toEqual([['server/discover', 200], ['initialize', 200], ['notifications/initialized', 202], ['tools/list', 200]]);
    expect(got.find(g => g.method === 'tools/list')!.body).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'company' }] } });
    expect(JSON.stringify(got)).not.toContain('-32001');
    /* Each went as the program sent it, with the protocol version it asked with. */
    const posts = CLAUDE_CONNECTS.filter(r => r.method === 'POST');
    expect(at.asked.map(a => [a.key, JSON.parse(a.body), a.version])).toEqual(posts.map(r => ['agent-1', r.body, r.headers['mcp-protocol-version']]));
    expect(up.seen).toEqual([]);
    expect(bridge.listedSince('agent-1', since)).toBe(true);
    expect(bridge.toolsRefusedSince('agent-1', since)).toBe(false);
  });

  it('asks Hornhoof again for a program that started again, and for one on a node that started again with nothing kept', async () => {
    const at = hornhoof();
    const first = await bridgeWith({ outside: at.outside });
    await connects(first.send, 'agent-1');
    /* The program started again on the same node: what it gets is Hornhoof's answer now, not what the node kept. */
    const again = await connects(first.send, 'agent-1');
    expect(at.asked).toHaveLength(8);
    expect(again.map(g => g.status)).toEqual([200, 200, 202, 200]);
    /* The node itself started again and keeps nothing. */
    const fresh = await bridgeWith({ outside: at.outside });
    expect((await connects(fresh.send, 'agent-1')).map(g => g.status)).toEqual([200, 200, 202, 200]);
    expect(at.asked).toHaveLength(12);
  });

  it('hands a tool call with no turn to Hornhoof, which runs it in a step of its own, and gives the program its answer', async () => {
    const at = hornhoof(msg => ({ status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'Acme' }] } }) }));
    const { up, send } = await bridgeWith({ outside: at.outside });
    const res = await send('agent-1', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' }, body: { id: 4, method: 'tools/call', params: { name: 'company', arguments: {} } } as Recorded['body'] });
    expect(await res.json()).toEqual({ jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'Acme' }] } });
    expect(at.asked).toEqual([{ key: 'agent-1', body: '{"id":4,"method":"tools/call","params":{"name":"company","arguments":{}}}', version: '2025-11-25' }]);
    expect(up.seen).toEqual([]);
  });

  it("lets a tool call wait for the turn a person's words are opening now, and sends it with that turn's token", async () => {
    const at = hornhoof();
    let open!: () => void;
    const opening = new Promise<void>(resolve => (open = resolve));
    let waits = false;
    const { up, bridge, send } = await bridgeWith({ outside: at.outside, opening: key => (key === 'agent-1' ? ((waits = true), opening) : null) });
    const call = { method: 'POST' as const, headers: { 'content-type': 'application/json' }, body: { id: 1, method: 'tools/call', params: { name: 'answer_request' } } as Recorded['body'] };
    const waiting = send('agent-1', call);
    await eventually(() => waits);
    /* The turn opened: Hornhoof answered with its token. */
    bridge.setToken('agent-1', 'tok-typed');
    open();
    expect(await (await waiting).json()).toEqual({ jsonrpc: '2.0', id: 1, result: { inTurn: true } });
    expect(up.seen).toEqual([{ auth: 'Bearer tok-typed', body: JSON.stringify(call.body) }]);
    expect(at.asked).toEqual([]);

    /* Hornhoof opened no turn for them: the call goes over the link as any call with no turn. */
    bridge.setToken('agent-1', null);
    const refused = Promise.resolve();
    const other = await bridgeWith({ outside: at.outside, opening: () => refused });
    expect(await (await other.send('agent-1', call)).json()).toEqual({ jsonrpc: '2.0', id: 1, result: { said: 'tools/call' } });
    expect(at.asked).toHaveLength(1);
  });

  it('keeps to what it remembers and to its refusal when Hornhoof cannot be asked over the link', async () => {
    const at = hornhoof(() => null);
    const refused: [string | null, string, string][] = [];
    const { send } = await bridgeWith({ outside: at.outside, refused: (...said) => refused.push(said) });
    const res = await send('agent-1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: { id: 7, method: 'tools/list' } });
    expect(await res.json()).toMatchObject({ id: 7, error: { code: -32001 } });
    expect(refused).toEqual([['agent-1', 'tools/list', 'no Hornhoof turn is running']]);
  });
});
