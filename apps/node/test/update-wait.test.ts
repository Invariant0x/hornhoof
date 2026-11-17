import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { command } from '../src/main.js';
import { writeState } from '../src/state.js';

async function fixture(answers: object[], status = 200) {
  const requests: { authorization: string | undefined; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', data => { body += String(data); });
    req.on('end', () => {
      requests.push({ authorization: req.headers.authorization, body });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answers.shift()));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = mkdtempSync(join(tmpdir(), 'hh-update-wait-'));
  writeState(dir, { server: url, subscriptionId: 'node-id', provider: 'claude', key: 'node-wait-test-key-12345678' });
  vi.stubEnv('HORNHOOF_DATA', dir);
  onTestFinished(() => vi.unstubAllEnvs());
  const io = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
  let output = '';
  io.stdout.on('data', d => { output += String(d); });
  io.stderr.on('data', d => { output += String(d); });
  return { url, requests, io, output: () => output };
}

describe('the installer waits for a node update', () => {
  it('polls through waiting and postponement without stopping the live node', async () => {
    const f = await fixture([
      { ready: false, drain: { state: 'waiting', turnsLeft: 2, partsLeft: 1, until: '2026-11-04T12:00:00.000Z' }, pollAfterMs: 1 },
      { ready: false, drain: { state: 'postponed', turnsLeft: 1, partsLeft: 0, retryAt: '2026-11-04T13:00:00.000Z' }, pollAfterMs: 1 },
      { ready: true, drain: { state: 'restarting', since: '2026-11-04T14:00:00.000Z' }, pollAfterMs: 1 },
    ]);
    expect(await command(['wait-update'], f.io)).toBe(0);
    expect(f.requests).toEqual(Array.from({ length: 3 }, () => ({ authorization: 'Bearer node-wait-test-key-12345678', body: JSON.stringify({ scope: 'node' }) })));
    expect(f.output()).toContain('postponed');
    expect(f.output()).not.toContain('node-wait-test-key');
  });

  it.each([401, 503])('refuses to authorize an update when the server answers %s', async status => {
    const f = await fixture([{ message: 'private server detail' }], status);
    expect(await command(['wait-update'], f.io)).toBe(1);
    expect(f.requests).toHaveLength(1);
    expect(f.output()).not.toContain('private server detail');
    expect(f.output()).not.toContain('node-wait-test-key');
  });

  it('explains that an old server must update its app before the nodes, without authorizing a stop', async () => {
    const f = await fixture([{ message: 'route not found' }], 404);
    expect(await command(['wait-update'], f.io)).toBe(3);
    expect(f.requests).toHaveLength(1);
    expect(f.output()).toContain('Update the server app first');
    expect(f.output()).toContain('running node was left alone');
  });

  it('uses the built-in key for the server update scope', async () => {
    const f = await fixture([{ ready: true, drain: { state: 'restarting', since: '2026-11-04T14:00:00.000Z' }, pollAfterMs: 1 }]);
    vi.stubEnv('HORNHOOF_SERVER', f.url);
    vi.stubEnv('NODE_KEY', 'builtin-wait-key-123456789');
    expect(await command(['wait-update', '--server'], f.io)).toBe(0);
    expect(f.requests).toEqual([{ authorization: 'Bearer builtin-wait-key-123456789', body: JSON.stringify({ scope: 'server' }) }]);
  });

  it('accepts server credentials over stdin without printing them', async () => {
    const f = await fixture([{ ready: true, drain: { state: 'restarting', since: '2026-11-04T14:00:00.000Z' }, pollAfterMs: 1 }]);
    f.io.stdin.end(`${f.url}\nstdin-node-key-123456789\n`);
    expect(await command(['wait-update', '--server', '--stdin'], f.io)).toBe(0);
    expect(f.requests).toEqual([{ authorization: 'Bearer stdin-node-key-123456789', body: JSON.stringify({ scope: 'server' }) }]);
    expect(f.output()).not.toContain('stdin-node-key');
  });
});
