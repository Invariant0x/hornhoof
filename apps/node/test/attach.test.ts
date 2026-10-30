import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../hh-attach.cjs', import.meta.url));

/* A Hornhoof that answers each picture with an id and remembers what it got. */
async function hub(status = 201) {
  const got: { auth: string | undefined; type: string | undefined; bytes: Buffer }[] = [];
  const server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', c => parts.push(c));
    req.on('end', () => {
      got.push({ auth: req.headers.authorization, type: req.headers['content-type'], bytes: Buffer.concat(parts) });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 201 ? { id: `id-${got.length}` } : { error: { message: 'Send a PNG, JPEG or WebP picture.' } }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  onTestFinished(() => new Promise<void>(r => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/attachments`, got };
}

const attach = (args: string[], env: Record<string, string>) =>
  new Promise<{ code: number; out: string; err: string }>(resolve =>
    execFile(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH ?? '', ...env } }, (err, out, errOut) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(out), err: String(errOut) }),
    ),
  );

describe('hh-attach', () => {
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
});
