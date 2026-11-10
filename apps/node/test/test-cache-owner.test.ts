import { chown, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareCache } from '../src/test-cache.js';

// Another owner cannot be made without root, and a copy made as root keeps its source's: only the call that settles the owner is watched.
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, chown: vi.fn(actual.chown) };
});

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });

it("makes a stored file the node's, whoever built it, as the builder's next run has it linked in", async () => {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'hh-owner-')); folders.push(cacheRoot);
  const context = { cacheRoot, deadline: Date.now() + 2_147_483_647, signal: new AbortController().signal, log: () => {} }, source = join(cacheRoot, 'source');
  await mkdir(join(source, 'deps'), { recursive: true }); await writeFile(join(source, 'deps', 'file'), 'built');
  vi.mocked(chown).mockClear();
  await prepareCache(join(cacheRoot, 'dependencies'), 'a'.repeat(64), 'd'.repeat(64), context, async () => ({ root: source, paths: ['deps'] }));
  expect(vi.mocked(chown).mock.calls.map(([path, uid, gid]) => [basename(String(path)), uid, gid])).toEqual([['file', process.getuid!(), process.getgid!()]]);
});
