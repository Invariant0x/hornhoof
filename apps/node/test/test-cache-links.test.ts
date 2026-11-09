import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareCache, restoreCache } from '../src/test-cache.js';

// The limits of a file system cannot be reached from a test: only the one call that meets them is doubled.
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link) };
});

const folders: string[] = [];
afterEach(async () => { vi.mocked(link).mockReset(); vi.mocked(link).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).link); await Promise.all(folders.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function stored() {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'hh-links-')); folders.push(cacheRoot);
  const context = { cacheRoot, deadline: Date.now() + 2_147_483_647, signal: new AbortController().signal, log: () => {} }, source = join(cacheRoot, 'source');
  await mkdir(join(source, 'deps'), { recursive: true }); await writeFile(join(source, 'deps', 'file'), 'locked');
  const entry = await prepareCache(join(cacheRoot, 'dependencies'), 'a'.repeat(64), 'd'.repeat(64), context, async () => ({ root: source, paths: ['deps'] }));
  return { context, entry, part: join(cacheRoot, 'part'), kept: join(entry.path, 'payload', 'deps', 'file') };
}
const refused = (code: string) => Object.assign(new Error(code), { code });

describe('a file system that gives no link', () => {
  it.each(['EXDEV', 'EPERM', 'EMLINK'])('gives the part a copy of its own on %s', async code => {
    const { context, entry, part, kept } = await stored();
    vi.mocked(link).mockRejectedValue(refused(code));
    await restoreCache(entry, part, context, { link: true });
    const file = join(part, 'deps', 'file');
    expect(await readFile(file, 'utf8')).toBe('locked');
    expect((await stat(file)).ino).not.toBe((await stat(kept)).ino);
    await writeFile(file, 'changed by a part');
    expect(await readFile(kept, 'utf8')).toBe('locked');
  });

  it('does not take a disk error for a limit', async () => {
    const { context, entry, part } = await stored();
    vi.mocked(link).mockRejectedValue(refused('EIO'));
    await expect(restoreCache(entry, part, context, { link: true })).rejects.toThrow('EIO');
  });
});
