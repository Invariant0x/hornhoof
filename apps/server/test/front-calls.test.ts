import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { CALL_BODY_MAX, CALL_LOST, CALL_NOT_SENT, CALL_PAUSED, CALL_WAITING, frontCalls } from '../src/net/front-calls.js';
import type { Target } from '../src/net/proxy.js';
import { until } from './helpers-basic.js';

const INVOCATION = 'x-hornhoof-invocation';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const call = (id: number | string = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'remember', arguments: { text: 'x' } } });
const result = (id: number | string, text: string) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });

type Seen = { url?: string; headers: http.IncomingHttpHeaders; body: string };
type Try = (seen: Seen, res: http.ServerResponse, n: number) => void;

function downWithTheTest(server: http.Server): void {
  const sockets = new Set<net.Socket>();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  onTestFinished(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
}

async function listening(server: http.Server): Promise<Target> {
  downWithTheTest(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
}

/* A keeper that answers each try as the test says, the last way for every try after it, and keeps what it was sent. */
async function keeperAnswering(...tries: Try[]) {
  const seen: Seen[] = [];
  const target = await listening(
    http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
        tries[Math.min(seen.length, tries.length) - 1]!(seen.at(-1)!, res, seen.length);
      });
    }),
  );
  return { target, seen };
}

/* Front's door for tool calls alone: what it does not take answers 404 here, where front passes it on. */
async function doorTo(keeper: Target, holdMs = 60_000) {
  const takes = frontCalls({ keeper, holdMs, everyMs: 5 });
  return listening(http.createServer((req, res) => void (takes(req, res) || res.writeHead(404).end('not a call'))));
}

type Answer = { status: number; headers: http.IncomingHttpHeaders; body: string };

function post(to: Target, body: unknown, headers: Record<string, string> = {}, path = '/mcp', method = 'POST'): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const out = http.request({ ...to, path, method, agent: false, headers: { 'content-type': 'application/json', authorization: 'Bearer token', ...headers } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    out.on('error', reject);
    out.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
}

const ok: Try = (seen, res) => {
  const id = (JSON.parse(seen.body) as { id: number }).id;
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result(id, 'Noted.')));
};
const cut: Try = (_seen, res) => void res.socket!.destroy();
const half: Try = (_seen, res) => {
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
  res.write('{"jsonrpc":"2.0","id":1,"res', () => res.socket!.destroy());
};
const refused = (status: number, reason: string): Try => (_seen, res) =>
  void res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '5' }).end(JSON.stringify({ error: { code: 'unavailable', message: 'x', reason } }));
const toolError = (id: number, text: string) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } });

describe("front's door for tool calls", () => {
  it('stamps each tool call with an id of its own, and nothing else', async () => {
    const { target, seen } = await keeperAnswering(ok);
    const door = await doorTo(target);
    await post(door, call(1));
    await post(door, call(1), { [INVOCATION]: '00000000-0000-4000-8000-000000000001' });
    await post(door, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { [INVOCATION]: '00000000-0000-4000-8000-000000000001' });
    const ids = seen.map(s => s.headers[INVOCATION]);
    expect(ids[0]).toMatch(UUID);
    expect(ids[1]).toMatch(UUID);
    expect(new Set(ids.slice(0, 2)).size).toBe(2);
    expect(ids).not.toContain('00000000-0000-4000-8000-000000000001');
    expect(ids[2]).toBeUndefined();
    expect(seen[0]!.headers.authorization).toBe('Bearer token');
    expect(seen[0]!.headers['x-forwarded-for']).toBe('127.0.0.1');
    expect(JSON.parse(seen[0]!.body)).toEqual(call(1));
  });

  it('sends a call again with the same id until it is answered', async () => {
    const { target, seen } = await keeperAnswering(cut, ok);
    const answer = await post(await doorTo(target), call(7));
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual(result(7, 'Noted.'));
    expect(seen).toHaveLength(2);
    expect(seen[0]!.headers[INVOCATION]).toBe(seen[1]!.headers[INVOCATION]);
    expect(seen[1]!.body).toBe(seen[0]!.body);
  });

  it('sends a call again whose answer broke off, and gives the agent only the whole one', async () => {
    const { target, seen } = await keeperAnswering(half, ok);
    const answer = await post(await doorTo(target), call(1));
    expect(JSON.parse(answer.body)).toEqual(result(1, 'Noted.'));
    expect(seen).toHaveLength(2);
  });

  it('sends a call again while the app is starting, or the hop before it has no answer', async () => {
    const { target, seen } = await keeperAnswering(refused(503, 'starting'), refused(502, 'starting'), ok);
    const answer = await post(await doorTo(target), call(1));
    expect(JSON.parse(answer.body)).toEqual(result(1, 'Noted.'));
    expect(new Set(seen.map(s => s.headers[INVOCATION])).size).toBe(1);
    expect(seen).toHaveLength(3);
  });

  it('tells the agent that a call lost in time may have run, and that one never sent did not', async () => {
    const { target, seen } = await keeperAnswering(cut);
    const lost = await post(await doorTo(target, 40), call(9));
    expect(lost.status).toBe(200);
    expect(lost.headers['content-type']).toBe('application/json');
    expect(JSON.parse(lost.body)).toEqual(toolError(9, CALL_LOST));
    expect(seen.length).toBeGreaterThan(1);

    const nowhere = await listening(http.createServer());
    const closed = { ...nowhere, port: 1 };
    expect(JSON.parse((await post(await doorTo(closed, 40), call(9))).body)).toEqual(toolError(9, CALL_NOT_SENT));
  });

  /* The agent's client gives up after a minute. The keeper holds a request for the app too, so front tells it how long is
     left: the two holds together stay inside front's own. */
  it('counts its hold from when the call came, and tells the keeper how long of it is left', async () => {
    const { target, seen } = await keeperAnswering(refused(503, 'starting'));
    const began = Date.now();
    await post(await doorTo(target, 60), call(3));
    expect(Date.now() - began).toBeLessThan(5000);
    const left = seen.map(s => Number(s.headers['x-hornhoof-hold']));
    expect(left.length).toBeGreaterThan(1);
    expect(left[0]).toBeLessThanOrEqual(60);
    expect(left.every(ms => Number.isInteger(ms) && ms >= 0)).toBe(true);
    expect([...left].sort((a, b) => b - a)).toEqual(left);
  });

  it('tells the agent a call did not run when the app never took it', async () => {
    const { target } = await keeperAnswering(refused(503, 'starting'));
    expect(JSON.parse((await post(await doorTo(target, 40), call(9))).body)).toEqual(toolError(9, CALL_NOT_SENT));
    const maybe = await keeperAnswering(refused(502, 'starting'));
    expect(JSON.parse((await post(await doorTo(maybe.target, 40), call(9))).body)).toEqual(toolError(9, CALL_LOST));
  });

  it('waits out a pending merge', async () => {
    const { target, seen } = await keeperAnswering(refused(503, 'merge_pending'), ok);
    expect(JSON.parse((await post(await doorTo(target), call(1))).body)).toEqual(result(1, 'Noted.'));
    expect(seen).toHaveLength(2);
    /* The app refused before the tool ran: the agent hears that the call did not run, and what to do about it. */
    const waiting = await keeperAnswering(refused(503, 'merge_pending'));
    expect(JSON.parse((await post(await doorTo(waiting.target, 40), call(9))).body)).toEqual(toolError(9, CALL_WAITING));
  });

  it('holds a call the machine cannot take yet', async () => {
    const { target, seen } = await keeperAnswering(refused(503, 'read_only'), refused(503, 'read_only'), ok);
    expect(JSON.parse((await post(await doorTo(target), call(1))).body)).toEqual(result(1, 'Noted.'));
    expect(seen).toHaveLength(3);
    /* The machine only reads for longer than front holds a call: the agent hears that it did not run. */
    const paused = await keeperAnswering(refused(503, 'read_only'));
    expect(JSON.parse((await post(await doorTo(paused.target, 40), call(9))).body)).toEqual(toolError(9, CALL_PAUSED));
  });

  it('passes every other answer as it came, and tries none of them again', async () => {
    const unauthorized = await keeperAnswering((_seen, res) => void res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' }).end('{"error":{"code":"unauthorized"}}'));
    const answer = await post(await doorTo(unauthorized.target), call(1));
    expect(answer.status).toBe(401);
    expect(answer.headers['www-authenticate']).toBe('Bearer');
    expect(answer.body).toBe('{"error":{"code":"unauthorized"}}');
    expect(unauthorized.seen).toHaveLength(1);

    const maintenance = await keeperAnswering(refused(503, 'maintenance'));
    const held = await post(await doorTo(maintenance.target), call(1));
    expect(held.status).toBe(503);
    expect(JSON.parse(held.body).error.reason).toBe('maintenance');
    expect(maintenance.seen).toHaveLength(1);
  });

  it('gives a request that is no tool call the last answer it got once the hold ran out', async () => {
    const { target } = await keeperAnswering(refused(503, 'starting'));
    const answer = await post(await doorTo(target, 40), { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(answer.status).toBe(503);
    expect(JSON.parse(answer.body).error.reason).toBe('starting');
  });

  it('refuses a batch and a call too large for the app, and sends neither on', async () => {
    const { target, seen } = await keeperAnswering(ok);
    const door = await doorTo(target);
    const batch = await post(door, [call(1), call(2)]);
    expect(batch.status).toBe(400);
    expect(JSON.parse(batch.body)).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Hornhoof takes one call per request.' } });
    const large = await post(door, Buffer.alloc(CALL_BODY_MAX + 1, 'x'));
    expect(large.status).toBe(413);
    expect(JSON.parse(large.body)).toEqual({ error: { code: 'validation', message: 'Request body is too large' } });
    expect(seen).toEqual([]);
  });

  it('takes nothing but a POST to /mcp', async () => {
    const { target, seen } = await keeperAnswering(ok);
    const door = await doorTo(target);
    expect((await post(door, call(1), {}, '/api/tasks')).status).toBe(404);
    expect((await post(door, '', {}, '/mcp', 'GET')).status).toBe(404);
    expect(seen).toEqual([]);
  });

  /* Front's pause between tries is virtual: a try begins only when the test moves the clock, so once the agent's connection
     is gone and the pause has passed, nothing is under way and nothing is due, and no try can come any more. */
  it('stops trying for an agent that went away', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    onTestFinished(() => void vi.useRealTimers());
    const { target, seen } = await keeperAnswering(cut);
    const answers: http.ServerResponse[] = [];
    const takes = frontCalls({ keeper: target, holdMs: 60_000, everyMs: 5 });
    const door = await listening(http.createServer((req, res) => void (answers.push(res), takes(req, res))));
    const socket = net.connect(door.port, door.host);
    socket.on('error', () => {});
    const body = JSON.stringify(call(1));
    socket.write(`POST /mcp HTTP/1.1\r\nHost: h\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    await until(() => seen.length === 1 && vi.getTimerCount() === 1);
    await vi.advanceTimersByTimeAsync(5);
    await until(() => seen.length === 2 && vi.getTimerCount() === 1);
    socket.destroy();
    await until(() => answers[0]!.destroyed);
    await vi.advanceTimersByTimeAsync(5);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen.length).toBe(2);
  });
});
