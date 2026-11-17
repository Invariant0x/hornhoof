import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { expect, it, onTestFinished } from 'vitest';

const script = fileURLToPath(new URL('../hh-fetch.cjs', import.meta.url));
const source = readFileSync(script, 'utf8');

/* Run our CLI with a recorded interrupted response, without a server or another program. */
async function interrupted(path: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise(resolve => {
    let out = '', err = '';
    runInNewContext(source, {
      require: createRequire(script),
      URLSearchParams,
      fetch: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
        pull(controller) { controller.error(new Error('recorded connection lost')); },
      })),
      process: {
        argv: ['node', script, '12', 'archive.zip', path],
        env: { HH_ATTACH_URL: 'https://recorded.invalid/api/attachments', HH_ATTACH_PASS: 'sample' },
        stdout: { write(value: string) { out += value; resolve({ code: 0, out, err }); } },
        stderr: { write(value: string) { err += value; } },
        exit(code: number) { resolve({ code, out, err }); },
      },
    }, { filename: script });
  });
}

it('preserves an existing file and removes an incomplete new download when the response is interrupted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hh-fetch-partial-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const existing = join(dir, 'existing.zip');
  writeFileSync(existing, 'previous complete file');
  const failed = await interrupted(existing);
  expect(failed).toMatchObject({ code: 1, out: '' });
  expect(failed.err).toContain('recorded connection lost');
  expect(readFileSync(existing, 'utf8')).toBe('previous complete file');
  const fresh = join(dir, 'new.zip');
  expect((await interrupted(fresh)).code).toBe(1);
  expect(existsSync(fresh)).toBe(false);
  expect(readdirSync(dir)).toEqual(['existing.zip']);
});
