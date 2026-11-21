import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { listenIn } from '../../../test-support/ports.mjs';
import { Bridge } from '../src/terminal/bridge.js';
import { kimiProgram, prepareKimi } from '../src/providers/kimi-terminal.js';
import { kimiAdapter } from '../src/providers/kimi.js';
import { runJob } from '../src/runner.js';

const SCRIPT = fileURLToPath(new URL('../hh-attach.cjs', import.meta.url));
const FETCH = fileURLToPath(new URL('../hh-fetch.cjs', import.meta.url));

/* A Hornhoof that answers each picture with an id and remembers what it got. It hands out one file of task 12. */
async function hub(status = 201) {
  const got: { url: string | undefined; auth: string | undefined; type: string | undefined; length: string | undefined; bytes: Buffer }[] = [];
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => {
      got.push({ url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], length: req.headers['content-length'], bytes: Buffer.concat(parts) });
      if (req.method === 'GET') {
        if (req.url === '/api/attachments/file?task=12&file=archive.zip') {
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-file-name': 'archive.zip' });
          res.end(got.find(g => g.url?.endsWith('name=archive.zip'))?.bytes);
          return;
        }
        if (req.url === '/api/attachments/file?task=message&file=4f0c8b7e-1111-4222-8333-444455556666') {
          res.writeHead(200, { 'content-type': 'image/png', 'x-file-name': encodeURIComponent('4f0c8b7e-screen.png') });
          res.end('a picture');
          return;
        }
        const found = req.url === '/api/attachments/file?task=12&file=build+log.txt';
        res.writeHead(found ? 200 : 404, found ? { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('../build log.txt') } : { 'content-type': 'application/json' });
        res.end(found ? 'all green' : JSON.stringify({ error: { message: 'Task 12 has no file other.txt.' } }));
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 201 ? { id: `id-${got.length}` } : { error: { message: 'Send a PNG, JPEG or WebP picture.' } }));
    });
  });
  await listenIn(server);
  onTestFinished(() => new Promise<void>(r => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/attachments`, got };
}

const run = (script: string) => (args: string[], env: Record<string, string>, cwd?: string) =>
  new Promise<{ code: number; out: string; err: string }>(resolve =>
    execFile(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? '', ...env }, cwd }, (err, out, errOut) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(out), err: String(errOut) }),
    ),
  );
const attach = run(SCRIPT);
const fetchFile = run(FETCH);

describe('hh-attach', () => {
  it("uses the node link for Kimi's terminal when the bridge has lost the turn token, and refuses once the turn ends", async () => {
    const { url, got } = await hub();
    let running = true;
    const bridge = new Bridge(url.replace('/api/attachments', ''), () => {}, null, {
      outside: async (key, body) => {
        const call = JSON.parse(body) as { id: string; method: string };
        if (key !== 'kimi-agent' || call.method !== 'attachments/token') throw new Error('Unexpected node authorization request.');
        return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: call.id, ...(running ? { result: { token: 'attachment-only-token' } } : { error: { message: 'No Hornhoof turn is running for this agent.' } }) }) };
      },
    });
    await bridge.start();
    onTestFinished(() => bridge.stop());
    const dir = mkdtempSync(join(tmpdir(), 'hh-attach-kimi-'));
    const file = join(dir, 'review.md');
    writeFileSync(file, 'Security review');
    const urls = bridge.agent('kimi-agent');
    await prepareKimi(join(dir, 'home'), dir, urls.mcpUrl);
    const { env } = kimiProgram.launch({ bin: 'kimi', home: join(dir, 'home'), workDir: dir, sessionId: 'recorded-session', model: null, instructionsFile: null, urls });
    const configured = JSON.parse(readFileSync(join(dir, '.kimi-code/mcp.json'), 'utf8')) as { mcpServers: { hornhoof: { url: string } } };
    expect(env.HH_ATTACH_URL === configured.mcpServers.hornhoof.url.replace('/mcp/', '/attach/')).toBe(true);
    const asksForPermission = await fetch(urls.mcpUrl, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'attachments/token' }) });
    expect(asksForPermission.status).toBe(403);
    expect(await asksForPermission.text()).toBe('');
    const sent = await attach(['--task', '1151', file], env);
    expect(sent.code, sent.err).toBe(0);
    expect(sent.out.trim()).toBe(`${file} id-1`);
    expect(got.map(g => [g.url, g.auth, g.bytes.toString()])).toEqual([['/api/attachments?task=1151&name=review.md', 'Bearer attachment-only-token', 'Security review']]);
    running = false;
    const refused = await attach(['--task', '1151', file], env);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('No Hornhoof turn is running');
    expect(got).toHaveLength(1);
  });

  it('gives a file over 50 MB through the bridge as it reads it, whole and with its length, and fetches it back the same way', async () => {
    const { url, got } = await hub();
    const bridge = new Bridge(url.replace('/api/attachments', ''), () => {});
    await bridge.start();
    onTestFinished(() => bridge.stop());
    const { attachUrl } = bridge.agent('agent-1');
    bridge.setToken('agent-1', 'turn-token');
    const dir = mkdtempSync(join(tmpdir(), 'hh-attach-big-'));
    const bytes = Buffer.alloc(60 * 1024 * 1024, 3);
    bytes[bytes.length - 1] = 9;
    writeFileSync(join(dir, 'archive.zip'), bytes);
    const env = { HH_ATTACH_URL: attachUrl, HH_ATTACH_PASS: 'bridge' };
    const sent = await attach(['--chat', join(dir, 'archive.zip')], env);
    expect(sent.code, sent.err).toBe(0);
    expect(got.map(g => [g.url, g.auth, g.length, g.bytes.equals(bytes)])).toEqual([['/api/attachments?chat=1&name=archive.zip', 'Bearer turn-token', String(bytes.length), true]]);
    mkdirSync(join(dir, 'back'));
    const back = await fetchFile(['12', 'archive.zip', join(dir, 'back')], env);
    expect(back.code, back.err).toBe(0);
    expect(readFileSync(join(dir, 'back', 'archive.zip')).equals(bytes)).toBe(true);
  });

  it('sends each file with the turn token and prints the id to pass on', async () => {
    const { url, got } = await hub();
    const dir = mkdtempSync(join(tmpdir(), 'hh-attach-'));
    writeFileSync(join(dir, 'light.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    writeFileSync(join(dir, 'dark.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]));
    const r = await attach([join(dir, 'light.png'), join(dir, 'dark.png')], { HH_ATTACH_URL: url, HH_ATTACH_PASS: 'tool-token-0123456789' });
    expect(r.code).toBe(0);
    expect(r.out.trim().split('\n')).toEqual([`${join(dir, 'light.png')} id-1`, `${join(dir, 'dark.png')} id-2`]);
    expect(got.map(g => [g.auth, g.type, [...g.bytes].slice(4)])).toEqual([
      ['Bearer tool-token-0123456789', 'application/octet-stream', [1, 2, 3]],
      ['Bearer tool-token-0123456789', 'application/octet-stream', [4, 5, 6]],
    ]);
  });

  it('keeps the headless Kimi runner, its MCP configuration and hh-attach on the direct turn token', async () => {
    const { url, got } = await hub();
    const dir = mkdtempSync(join(tmpdir(), 'hh-attach-headless-'));
    const file = join(dir, 'review.md');
    writeFileSync(file, 'Headless review');
    /* Only our launch and environment run: the stand-in calls our CLI, then emits Kimi's recorded stream. */
    const sample = readFileSync(new URL('./fixtures/kimi-new.jsonl', import.meta.url), 'utf8');
    const bin = join(dir, 'kimi.cjs');
    writeFileSync(bin, `#!/usr/bin/env node\nrequire('node:child_process').execFileSync(process.execPath, ${JSON.stringify([SCRIPT, '--task', '1151', file])}, { stdio: 'inherit' });\nprocess.stdout.write(${JSON.stringify(sample)});\n`, { mode: 0o700 });
    const home = join(dir, 'home');
    const adapter = kimiAdapter({ home, tools: dir, bin });
    const result = await runJob(adapter, { type: 'job.run', jobId: 'headless-job', subscriptionId: 'kimi-plan', provider: 'kimi', prompt: 'Review', sessionId: null, model: null, secret: null, instructions: null, toolToken: 'headless-turn-token', timeoutMs: 2_147_453_647 }, dir, { toolsUrl: url.replace('/api/attachments', '/mcp'), untimed: true });
    expect(result.ok).toBe(true);
    const configured = JSON.parse(readFileSync(join(home, 'mcp.json'), 'utf8')) as { mcpServers: { hornhoof: { url: string; bearerTokenEnvVar: string } } };
    expect(configured.mcpServers.hornhoof).toEqual({ transport: 'http', url: url.replace('/api/attachments', '/mcp'), bearerTokenEnvVar: 'HH_TOOL_TOKEN', startupTimeoutMs: 120_000 });
    expect(got.map(g => [g.url, g.auth, g.bytes.toString()])).toEqual([['/api/attachments?task=1151&name=review.md', 'Bearer headless-turn-token', 'Headless review']]);
  });

  it("says what went wrong: no turn, no file, or Hornhoof's refusal", async () => {
    const { url } = await hub(400);
    const dir = mkdtempSync(join(tmpdir(), 'hh-attach-'));
    writeFileSync(join(dir, 'notes.txt'), 'hello');
    const outside = await attach([join(dir, 'notes.txt')], {});
    expect(outside.code).toBe(1);
    expect(outside.err).toContain('only inside a Hornhoof turn');
    expect((await attach([join(dir, 'missing.png')], { HH_ATTACH_URL: url, HH_ATTACH_PASS: 't' })).err).toContain('missing.png');
    const refused = await attach([join(dir, 'notes.txt')], { HH_ATTACH_URL: url, HH_ATTACH_PASS: 't' });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('Send a PNG, JPEG or WebP picture.');
  });

  it('puts files of any kind on a task under their own names', async () => {
    const { url, got } = await hub();
    const dir = mkdtempSync(join(tmpdir(), 'hh-attach-'));
    writeFileSync(join(dir, 'build log.txt'), 'all green');
    const r = await attach(['--task', '12', join(dir, 'build log.txt')], { HH_ATTACH_URL: url, HH_ATTACH_PASS: 't' });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(`${join(dir, 'build log.txt')} id-1`);
    expect(got.map(g => [g.url, g.bytes.toString()])).toEqual([['/api/attachments?task=12&name=build+log.txt', 'all green']]);
    expect((await attach(['--task'], { HH_ATTACH_URL: url, HH_ATTACH_PASS: 't' })).err).toContain('Usage');
  });
});

describe('hh-fetch', () => {
  it("downloads a task's file by its name into the folder it runs in, never above it", async () => {
    const { url, got } = await hub();
    const dir = mkdtempSync(join(tmpdir(), 'hh-fetch-'));
    const r = await fetchFile(['12', 'build log.txt'], { HH_ATTACH_URL: url, HH_ATTACH_PASS: 'tool-token-0123456789' }, dir);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('build log.txt');
    expect(readFileSync(join(dir, 'build log.txt'), 'utf8')).toBe('all green');
    expect(got[0]).toMatchObject({ url: '/api/attachments/file?task=12&file=build+log.txt', auth: 'Bearer tool-token-0123456789' });
  });

  it('downloads a picture that came with a message, as the message says', async () => {
    const { url, got } = await hub();
    const dir = mkdtempSync(join(tmpdir(), 'hh-fetch-'));
    const r = await fetchFile(['message', '4f0c8b7e-1111-4222-8333-444455556666'], { HH_ATTACH_URL: url, HH_ATTACH_PASS: 'tool-token-0123456789' }, dir);
    expect(r.code).toBe(0);
    expect(got[0]).toMatchObject({ url: '/api/attachments/file?task=message&file=4f0c8b7e-1111-4222-8333-444455556666', auth: 'Bearer tool-token-0123456789' });
    expect(r.out.trim()).toBe('4f0c8b7e-screen.png');
    expect(readFileSync(join(dir, '4f0c8b7e-screen.png'), 'utf8')).toBe('a picture');
    expect((await fetchFile(['message'], { HH_ATTACH_URL: url, HH_ATTACH_PASS: 't' })).err).toContain('hh-fetch message ID');
  });

  it('saves it where it is told, into a folder or as a file', async () => {
    const { url } = await hub();
    const dir = mkdtempSync(join(tmpdir(), 'hh-fetch-'));
    mkdirSync(join(dir, 'in'));
    const env = { HH_ATTACH_URL: url, HH_ATTACH_PASS: 't' };
    expect((await fetchFile(['#12', 'build log.txt', join(dir, 'in')], env)).out.trim()).toBe(join(dir, 'in', 'build log.txt'));
    expect((await fetchFile(['12', 'build log.txt', join(dir, 'log.txt')], env)).out.trim()).toBe(join(dir, 'log.txt'));
    expect(readFileSync(join(dir, 'log.txt'), 'utf8')).toBe('all green');
  });

  it("says what went wrong: no turn, no task and file, or Hornhoof's refusal", async () => {
    const { url } = await hub();
    expect((await fetchFile(['12', 'a.txt'], {})).err).toContain('only inside a Hornhoof turn');
    expect((await fetchFile(['12'], { HH_ATTACH_URL: url, HH_ATTACH_PASS: 't' })).err).toContain('Usage');
    const refused = await fetchFile(['12', 'other.txt'], { HH_ATTACH_URL: url, HH_ATTACH_PASS: 't' });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('Task 12 has no file other.txt.');
  });
});
