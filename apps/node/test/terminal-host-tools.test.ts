import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { listenIn } from '../../../test-support/ports.mjs';
import { cleanups, liveTerminal } from './terminal-host-live-helpers.js';

/* How an agent's program gets Hornhoof's tools through the node. Claude Code and Codex connect to their tools on their own
   time after they start, and a program that got an error while it connected has no tools for the rest of its session.
   tmux and the program never run: the test makes the program's calls to the node's bridge, and Hornhoof is a stand-in
   that answers each call and keeps the token it came with. The host runs on the fake clock, which moves only as the test
   moves it. A program stays up between turns while someone has its terminal open, and only then connects between them. */
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

type Heard = { method: string; auth: string };
const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach(server => server.close()));

async function hornhoof(): Promise<{ url: string; heard: Heard[] }> {
  const heard: Heard[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      const msg = JSON.parse(body) as { id?: number; method: string };
      heard.push({ method: msg.method, auth: req.headers.authorization ?? '' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result: msg.method === 'tools/list' ? { tools: [{ name: 'task' }] } : {} }));
    });
  });
  await listenIn(server);
  servers.push(server);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, heard };
}

type Terminal = Awaited<ReturnType<typeof liveTerminal>>;

/* A call of the program to its tools, on its way while the clock moves as far as the bridge holds it for a turn. */
function calling(c: Terminal, id: number, method: string): Promise<{ result?: unknown; error?: { code: number } }> {
  return c.carry(async () => {
    const res = await fetch(c.host['bridge'].agent('receipt').mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method }) });
    return res.json() as Promise<{ result?: unknown; error?: { code: number } }>;
  });
}
const call = (c: Terminal, id: number, method: string) => c.on(calling(c, id, method));

/* What an MCP client sends to connect: it asks the server what it is, then lists its tools. */
const connect = async (c: Terminal) => [await call(c, 1, 'initialize'), await call(c, 2, 'tools/list')];

describe("a program's connection to Hornhoof's tools", () => {
  it('keeps the turn that started a program until the program has its tools, so one that connects after its short turn still gets them', async () => {
    const up = await hornhoof();
    let over = false;
    let connecting = null as Promise<unknown[]> | null;
    const c = await liveTerminal('claude', 'queued', {
      host: { hornhoof: up.url }, connects: true,
      /* The node reads the plan's limits once the program ended its turn. On a busy machine Claude Code may connect to its
         tools only after that, as it did after a turn of under 6 s that had started it. */
      limits: async () => {
        if (over && !connecting) connecting = new Promise(resolve => setImmediate(resolve)).then(async () => [await calling(c, 1, 'initialize'), await calling(c, 2, 'tools/list')]);
        return null;
      },
    });
    over = true;
    c.finish();
    await c.until(() => connecting !== null);
    expect(await c.on(connecting!)).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'task' }] } }]);
    expect(up.heard).toEqual([{ method: 'initialize', auth: 'Bearer tok-turn' }, { method: 'tools/list', auth: 'Bearer tok-turn' }]);
    expect(await c.on(c.running)).toMatchObject({ ok: true, result: 'Done.' });
  });

  it('answers a program that connects again between turns with what Hornhoof said before, and still refuses its tool calls', async () => {
    const up = await hornhoof();
    const c = await liveTerminal('claude', 'queued', { host: { hornhoof: up.url }, connects: true, watched: true });
    await connect(c);
    c.finish();
    await c.on(c.running);
    /* A program started again between turns, as a person's window or a restart does, connects with no turn open. */
    expect(await connect(c)).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'task' }] } }]);
    expect(await call(c, 3, 'tools/call')).toMatchObject({ id: 3, error: { code: -32001 } });
    expect(up.heard).toHaveLength(2);
    expect(c.log).toHaveBeenCalledWith("Hornhoof's tools refused tools/call of agent receipt: no Hornhoof turn is running.");
  });

  it('lets the first program of an agent connect between two turns once the next turn opens, rather than fail its tools for good', async () => {
    const up = await hornhoof();
    const c = await liveTerminal('claude', 'queued', { host: { hornhoof: up.url, toolsMs: 1000 }, connects: true, watched: true });
    c.finish();
    await c.on(c.running);
    /* The program connects only now, as one does whose turn was called off as it started, and the node knows no answer. */
    const late = calling(c, 1, 'initialize');
    await c.pass(50);
    expect(up.heard).toEqual([]);
    const next = c.run('NEXT', 'job-next');
    expect(await c.on(late)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(up.heard).toEqual([{ method: 'initialize', auth: 'Bearer tok-turn' }]);
    await c.until(() => c.sent.some(m => m.type === 'job.program' && m.jobId === 'job-next' && m.state === 'thinking'));
    c.finish();
    expect(await c.on(next)).toMatchObject({ ok: true });
  });

  it('starts a program that was turned away as it connected again in its session, and says so, as it has no tools until then', async () => {
    const up = await hornhoof();
    const c = await liveTerminal('claude', 'queued', { host: { hornhoof: up.url, toolsMs: 100 }, connects: true, watched: true });
    c.finish();
    await c.on(c.running);
    /* The program connects only now, long after its turn, no turn opens while it waits, and the node knows no answer. */
    expect(await call(c, 1, 'initialize')).toMatchObject({ id: 1, error: { code: -32001 } });
    expect(c.log).toHaveBeenCalledWith("Hornhoof's tools refused initialize of agent receipt: no Hornhoof turn is running.");
    expect(c.launch).toHaveBeenCalledTimes(1);
    const next = c.run('NEXT', 'job-next');
    await c.until(() => c.launch.mock.calls.length === 2);
    expect(c.log).toHaveBeenCalledWith("Agent receipt (claude) could not reach Hornhoof's tools when its program connected, so the program starts again in its session.");
    expect(await connect(c)).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }, { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'task' }] } }]);
    await c.until(() => c.sent.some(m => m.type === 'job.program' && m.jobId === 'job-next' && m.state === 'thinking'));
    c.finish();
    expect(await c.on(next)).toMatchObject({ ok: true });
    expect(up.heard).toEqual([{ method: 'initialize', auth: 'Bearer tok-turn' }, { method: 'tools/list', auth: 'Bearer tok-turn' }]);
  });

  /* A new Kimi session connects to its tools only with its first message, and Antigravity once it takes one, so the node
     cannot tell before a turn that such a program lost them. Its turn ends as one without tools, which the server repeats
     later and does not remind, and the next turn starts it anew. */
  it('ends the turn of a program with no session yet that was turned away as it connected as one without tools, and starts it anew once', async () => {
    const up = await hornhoof();
    /* A turn with nothing to type started the program for someone who opened its terminal, and it waits for its first
       message to begin a session. */
    const c = await liveTerminal('kimi', 'queued', { host: { hornhoof: up.url }, connects: true, sessionId: null, prompt: '', watched: true });
    expect(await c.on(c.running)).toMatchObject({ ok: true, sessionId: null });
    /* It connects with no turn open, no turn opens while it waits, and the node knows no answer. */
    expect(await call(c, 1, 'initialize')).toMatchObject({ id: 1, error: { code: -32001 } });
    const turn = async (prompt: string, jobId: string) => {
      const running = c.run(prompt, jobId);
      await c.until(() => c.sent.some(m => m.type === 'job.program' && m.jobId === jobId && m.state === 'thinking'));
      c.finish();
      return await c.on(running);
    };
    expect(await turn('NEXT', 'job-next')).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'tools' } });
    expect(c.launch).toHaveBeenCalledTimes(1);
    expect(await turn('AGAIN', 'job-again')).toMatchObject({ ok: true });
    expect(c.launch).toHaveBeenCalledTimes(2);
    expect(c.log.mock.calls.filter(([line]) => String(line).startsWith("Hornhoof's tools refused"))).toHaveLength(1);
  });
});
