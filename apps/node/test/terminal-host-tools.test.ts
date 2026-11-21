import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NodeMessage } from '@hornhoof/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listenIn } from '../../../test-support/ports.mjs';
import { until } from './terminal-host-helpers.js';
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

/* busy: a busy Hornhoof, which answers that call of a program connecting only once the test lets it. */
async function hornhoof(busy: 'initialize' | 'tools/list' | null = null): Promise<{ url: string; heard: Heard[]; waiting: () => number; answer: () => void }> {
  const heard: Heard[] = [];
  const waiting: (() => void)[] = [];
  let holds = busy !== null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      const msg = JSON.parse(body) as { id?: number; method: string };
      heard.push({ method: msg.method, auth: req.headers.authorization ?? '' });
      const answer = () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result: msg.method === 'tools/list' ? { tools: [{ name: 'task' }] } : {} }));
      };
      if (holds && msg.method === busy) waiting.push(answer);
      else answer();
    });
  });
  await listenIn(server);
  servers.push(server);
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, heard, waiting: () => waiting.length,
    answer: () => { holds = false; waiting.splice(0).forEach(answer => answer()); },
  };
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

/* Hornhoof as the node's link reaches it with no turn running: what the program sent, and its answer as /mcp's. */
function overLink() {
  const asked: { key: string; method: string }[] = [];
  const outside = async (key: string, body: string) => {
    const msg = JSON.parse(body) as { id?: number; method: string };
    asked.push({ key, method: msg.method });
    return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, result: msg.method === 'tools/list' ? { tools: [{ name: 'company' }] } : { overLink: msg.method } }) };
  };
  return { asked, outside };
}

/* What an MCP client sends to connect: it asks the server what it is, then lists its tools. */
const connect = async (c: Terminal) => [await call(c, 1, 'initialize'), await call(c, 2, 'tools/list')];

/* Claude Code 2.1.329 waits for an MCP server to connect as many milliseconds as MCP_TIMEOUT says, or 30 seconds, and then
   gives up on it for the rest of its session. The stand-in reads the env its launch was given and does the same, on the
   test's clock, while its calls go on real sockets; stop gives up on them earlier. */
async function connectsAsClaude(c: Terminal, stop = new AbortController()): Promise<'listed' | 'gave up'> {
  const env = readFileSync(c.launch.mock.calls.at(-1)![1].envFile!, 'utf8');
  const limit = setTimeout(() => stop.abort(), Number(/^MCP_TIMEOUT='(\d+)'$/m.exec(env)?.[1]) || 30_000);
  try {
    for (const [id, method] of [[1, 'initialize'], [2, 'tools/list']] as const) {
      const res = await fetch(c.host['bridge'].agent('receipt').mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method }), signal: stop.signal });
      await res.json();
    }
    return 'listed';
  } catch {
    return 'gave up';
  } finally {
    clearTimeout(limit);
  }
}

describe("a program's connection to Hornhoof's tools", () => {
  it("gives Claude Code two minutes to connect to them, so its turn gets them from a busy Hornhoof that answers after 30 seconds", async () => {
    const up = await hornhoof('initialize');
    /* Hornhoof gives a turn far more than the 31 seconds it waits here. */
    const c = await liveTerminal('claude', 'queued', { host: { hornhoof: up.url }, connects: true, timeoutMs: 600_000 });
    /* While its calls are on their way the clock stands still: only the test moves it. */
    const connecting = c.carry(() => connectsAsClaude(c));
    /* Hornhoof has the program's first call, and answers it 31 seconds later. */
    await until(() => up.waiting() === 1);
    for (let second = 0; second < 31; second++) await vi.advanceTimersByTimeAsync(1000);
    up.answer();
    expect(await c.on(connecting)).toBe('listed');
    /* With them its turn does its work. */
    expect(await call(c, 3, 'tools/call')).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
    c.finish();
    expect(await c.on(c.running)).toMatchObject({ ok: true, result: 'Done.' });
  });

  it.each(['initialize', 'tools/list'] as const)('ends the turn of a program that gave up on %s before Hornhoof answered as one without tools, and starts it again in its session for the next turn', async method => {
    const up = await hornhoof(method);
    const c = await liveTerminal('claude', 'queued', { host: { hornhoof: up.url }, connects: true, watched: true });
    const kept = vi.spyOn(c.host['bridge'] as unknown as { keepTools: (key: string, body: Buffer, answer: Buffer) => void }, 'keepTools');
    const stop = new AbortController();
    const connecting = connectsAsClaude(c, stop);
    await until(() => up.waiting() === 1);
    /* Hornhoof did not answer in the time the program waits. */
    stop.abort();
    expect(await connecting).toBe('gave up');
    /* No test here has a time limit: give the bridge a bounded while to hear the connection close, and say so if it never does. */
    for (let turn = 0; turn < 1000 && !c.log.mock.calls.some(([line]) => String(line).includes('gave up')); turn++) await new Promise(resolve => setImmediate(resolve));
    expect(c.log).toHaveBeenCalledWith(`Agent receipt's program gave up on ${method} of Hornhoof's tools before Hornhoof answered: it has no tools until it starts again.`);
    /* Hornhoof's answer comes after all, to a program that no longer waits for it: it gave the program no tools. */
    up.answer();
    await until(() => kept.mock.calls.some(([, body]) => String(body).includes(method)));
    /* Its model ends the turn, which had no tools: the server repeats a turn that ends so. */
    c.finish();
    expect(await c.on(c.running)).toMatchObject({ ok: false, error: 'agent_failed', failure: { kind: 'tools' } });
    expect(c.launch).toHaveBeenCalledTimes(1);
    const next = c.run('NEXT', 'job-next');
    await c.until(() => c.launch.mock.calls.length === 2);
    expect(c.log).toHaveBeenCalledWith("Agent receipt (claude) could not reach Hornhoof's tools when its program connected, so the program starts again in its session.");
    expect(await c.on(c.carry(() => connectsAsClaude(c)))).toBe('listed');
    await c.until(() => c.sent.some(m => m.type === 'job.program' && m.jobId === 'job-next' && m.state === 'thinking'));
    c.finish();
    expect(await c.on(next)).toMatchObject({ ok: true });
  });

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

  it("asks Hornhoof over the node's link for a program that connects or calls a tool between turns, and refuses none of it", async () => {
    const up = await hornhoof();
    const link = overLink();
    const c = await liveTerminal('claude', 'queued', { host: { hornhoof: up.url, toolsOutside: link.outside }, connects: true, watched: true });
    await connect(c);
    c.finish();
    await c.on(c.running);
    /* The turn's own calls went with its token. */
    expect(up.heard).toEqual([{ method: 'initialize', auth: 'Bearer tok-turn' }, { method: 'tools/list', auth: 'Bearer tok-turn' }]);
    /* Started again between turns, it connects and calls a tool, as Claude Code does on what a person typed. */
    expect(await connect(c)).toEqual([{ jsonrpc: '2.0', id: 1, result: { overLink: 'initialize' } }, { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'company' }] } }]);
    expect(await call(c, 3, 'tools/call')).toEqual({ jsonrpc: '2.0', id: 3, result: { overLink: 'tools/call' } });
    expect(link.asked).toEqual([{ key: 'receipt', method: 'initialize' }, { key: 'receipt', method: 'tools/list' }, { key: 'receipt', method: 'tools/call' }]);
    expect(up.heard).toHaveLength(2);
    expect(c.log.mock.calls.filter(([line]) => String(line).startsWith("Hornhoof's tools refused"))).toEqual([]);
  });

  it("lets a tool call made as a person's words open a turn wait for that turn, and go with its token", async () => {
    const up = await hornhoof();
    const link = overLink();
    const c = await liveTerminal('claude', 'queued', { host: { hornhoof: up.url, toolsOutside: link.outside }, connects: true, watched: true });
    await connect(c);
    c.finish();
    await c.on(c.running);
    /* A person types into the agent's terminal: Claude Code says so in its hook and waits there while Hornhoof opens a turn. */
    const opening = vi.spyOn(c.host as unknown as { openingTurn: (key: string) => Promise<unknown> | null }, 'openingTurn');
    const prompt = c.hook('prompt', { prompt: 'what is on my desk' });
    await c.until(() => c.sent.some(m => m.type === 'turn.open'));
    const open = c.sent.find(m => m.type === 'turn.open') as Extract<NodeMessage, { type: 'turn.open' }>;
    /* The program goes on at once and calls a tool, before Hornhoof answered. */
    const called = calling(c, 3, 'tools/call');
    /* While the program's call is on its way the clock stands still, so the turn's wait does not run out meanwhile. */
    await until(() => opening.mock.results.some(r => r.value !== null));
    c.host.opened({ type: 'turn.opened', agentKey: 'receipt', jobId: 'job-typed', toolToken: 'tok-typed', ref: open.ref });
    expect(await c.on(called)).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
    expect(up.heard.at(-1)).toEqual({ method: 'tools/call', auth: 'Bearer tok-typed' });
    expect(link.asked).toEqual([]);
    await c.on(prompt);
  });

  /* A new Kimi session connects to its tools only with its first message, and Antigravity once it takes one, so the node
     cannot tell before a turn that such a program lost them. Its turn ends as one without tools, which the server repeats
     later and does not remind, and the next turn starts it anew. */
  it.each(['initialize', 'server/discover'])('ends the turn of a program with no session yet that was turned away as it connected (%s) as one without tools, and starts it anew once', async method => {
    const up = await hornhoof();
    /* A turn with nothing to type started the program for someone who opened its terminal, and it waits for its first
       message to begin a session. */
    const c = await liveTerminal('kimi', 'queued', { host: { hornhoof: up.url }, connects: true, sessionId: null, prompt: '', watched: true });
    expect(await c.on(c.running)).toMatchObject({ ok: true, sessionId: null });
    /* It connects with no turn open, no turn opens while it waits, and the node knows no answer. */
    expect(await call(c, 1, method)).toMatchObject({ id: 1, error: { code: -32001 } });
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
