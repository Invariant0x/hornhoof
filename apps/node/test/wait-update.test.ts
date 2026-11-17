import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, onTestFinished } from 'vitest';
import { command } from '../src/main.js';
import { writeState } from '../src/state.js';
import { waitUpdate } from '../src/wait-update.js';
import { listenIn } from '../../../test-support/ports.mjs';

const KEY = 'node-key-1234567890';
const waiting = { ready: false, drain: { state: 'waiting', turnsLeft: 2, partsLeft: 1, since: '2026-11-04T18:30:00.000Z' }, pollAfterMs: 7 };
const ready = { ready: true, drain: { state: 'restarting', since: '2026-11-04T18:46:00.000Z' }, pollAfterMs: 5 };

type Answer = { status: number; body?: unknown };

/* A server that gives these answers in turn, and keeps giving the last. */
async function server(answers: Answer[]) {
  const requests: { method?: string; url?: string; authorization?: string; body: string }[] = [];
  const respond = (req: IncomingMessage, res: ServerResponse, body: string) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
    const answer = answers[Math.min(requests.length - 1, answers.length - 1)]!;
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body ?? {}));
  };
  const http = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => respond(req, res, body));
  });
  await listenIn(http);
  onTestFinished(() => void http.close());
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`, requests };
}

function nodeFolder(url: string) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-wait-update-'));
  writeState(dir, { server: url, subscriptionId: 's1', provider: 'claude', key: KEY });
  return dir;
}

function terminal() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', chunk => (out += chunk));
  stderr.on('data', chunk => (err += chunk));
  return { io: { stdin: new PassThrough(), stdout, stderr }, said: () => out + err };
}

describe('hornhoof-node wait-update', () => {
  it('asks with the key until the server says the node is free, at the pace the server names', async () => {
    const s = await server([{ status: 200, body: waiting }, { status: 200, body: waiting }, { status: 200, body: ready }]);
    const t = terminal();
    const naps: number[] = [];
    expect(await waitUpdate(nodeFolder(s.url), t.io, async ms => void naps.push(ms))).toBe(0);
    expect(s.requests).toHaveLength(3);
    expect(s.requests[0]).toMatchObject({ method: 'POST', url: '/api/nodes/update', authorization: `Bearer ${KEY}`, body: '{}' });
    expect(naps).toEqual([7, 7]);
  });

  it('says once what the node waits for, and never the key', async () => {
    const s = await server([{ status: 200, body: waiting }, { status: 200, body: waiting }, { status: 200, body: ready }]);
    const t = terminal();
    await waitUpdate(nodeFolder(s.url), t.io, async () => {});
    expect(t.said().match(/2 turns and 1 test part/g)).toHaveLength(1);
    expect(t.said()).toContain('since 2026-11-04T18:30:00.000Z');
    expect(t.said()).toContain('It takes no new work meanwhile.');
    expect(t.said()).not.toContain(KEY);
  });

  it('answers 3 for a server from before this wait, and leaves saying why to the installer', async () => {
    const s = await server([{ status: 404, body: { error: { code: 'not_found', message: 'Not found.' } } }]);
    expect(await waitUpdate(nodeFolder(s.url), terminal().io, async () => {})).toBe(3);
    expect(s.requests).toHaveLength(1);
  });

  /* As the public link answers for a moment while the machine that leads fences itself or hands over. */
  it("keeps its wait through a 404 that is not a Hornhoof server's own refusal, and asks again", async () => {
    const s = await server([{ status: 200, body: waiting }, { status: 404, body: { ok: false } }, { status: 404, body: 'Not Found' }, { status: 200, body: ready }]);
    const t = terminal();
    expect(await waitUpdate(nodeFolder(s.url), t.io, async () => {})).toBe(0);
    expect(s.requests).toHaveLength(4);
    expect(t.said()).not.toContain('Could not ask');
  });

  it("asks again soon and then less often while the server is away, always within the server's hold of the node", async () => {
    const s = await server([{ status: 200, body: waiting }, ...Array.from({ length: 8 }, () => ({ status: 503 })), { status: 200, body: ready }]);
    const naps: number[] = [];
    expect(await waitUpdate(nodeFolder(s.url), terminal().io, async ms => void naps.push(ms))).toBe(0);
    expect(naps).toEqual([7, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
  });

  it('starts its pace over once the server answers again', async () => {
    const s = await server([{ status: 503 }, { status: 503 }, { status: 200, body: waiting }, { status: 503 }, { status: 200, body: ready }]);
    const naps: number[] = [];
    expect(await waitUpdate(nodeFolder(s.url), terminal().io, async ms => void naps.push(ms))).toBe(0);
    expect(naps).toEqual([1000, 2000, 7, 1000]);
  });

  it('answers 1 at once when the server refuses the key', async () => {
    const s = await server([{ status: 401, body: { error: { code: 'unauthorized' } } }]);
    const t = terminal();
    expect(await waitUpdate(nodeFolder(s.url), t.io, async () => {})).toBe(1);
    expect(s.requests).toHaveLength(1);
    expect(t.said()).toContain('401');
  });

  it('answers 1 at once when the server refuses the update, and says why in its words', async () => {
    const s = await server([{ status: 403, body: { error: { code: 'forbidden', message: 'Only the built-in node may prepare a server update.' } } }]);
    const t = terminal();
    expect(await waitUpdate(nodeFolder(s.url), t.io, async () => {})).toBe(1);
    expect(s.requests).toHaveLength(1);
    expect(t.said()).toContain('Only the built-in node may prepare a server update.');
  });

  it('answers 1 for a node with no key', async () => {
    const t = terminal();
    expect(await waitUpdate(mkdtempSync(join(tmpdir(), 'hh-wait-update-')), t.io, async () => {})).toBe(1);
    expect(t.said()).toContain('no key');
  });

  it('rides out a server that restarts meanwhile', async () => {
    const s = await server([{ status: 200, body: waiting }, { status: 503 }, { status: 503 }, { status: 200, body: ready }]);
    expect(await waitUpdate(nodeFolder(s.url), terminal().io, async () => {})).toBe(0);
    expect(s.requests).toHaveLength(4);
  });

  it('gives up with 1 on a server that stays away for 5 minutes, leaving the node as it is', async () => {
    const s = await server([{ status: 503 }]);
    const t = terminal();
    const naps: number[] = [];
    expect(await waitUpdate(nodeFolder(s.url), t.io, async ms => void naps.push(ms))).toBe(1);
    expect(s.requests.length).toBeGreaterThan(5);
    expect(naps.reduce((a, b) => a + b, 0)).toBe(300_000);
    expect(t.said()).toContain('503');
  });

  it('gives up with 1 on a server it cannot reach', async () => {
    const t = terminal();
    expect(await waitUpdate(nodeFolder('http://127.0.0.1:1'), t.io, async () => {})).toBe(1);
    expect(t.said()).toContain('Could not ask');
  });

  it('is a command of the node, in the folder the node keeps its state in', async () => {
    const s = await server([{ status: 200, body: ready }]);
    process.env.HORNHOOF_DATA = nodeFolder(s.url);
    onTestFinished(() => void delete process.env.HORNHOOF_DATA);
    expect(await command(['wait-update'], terminal().io)).toBe(0);
    expect(s.requests).toHaveLength(1);
  });
});
