import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { packBundle, unpackBundle } from '../src/test-bundle.js';
import { prepareCache, restoreCache, type CacheEntry, type CacheContext } from '../src/test-cache.js';
import { harnessShare, type HarnessRemote } from '../src/test-harness.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const KEY = 'a'.repeat(64), INPUT = 'd'.repeat(64);

async function machine(): Promise<CacheContext & { dir: string }> {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'hh-harness-')); folders.push(cacheRoot);
  return { cacheRoot, dir: join(cacheRoot, 'dependencies'), deadline: Date.now() + 10_000, signal: new AbortController().signal, log: () => {} };
}
async function tree(root: string): Promise<{ root: string; paths: string[] }> {
  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'dep'), 'locked');
  await writeFile(join(root, 'node_modules', '.bin', 'tool'), '#!/bin/sh\n', { mode: 0o755 });
  await symlink('../dep', join(root, 'node_modules', '.bin', 'link'));
  return { root, paths: ['node_modules'] };
}
async function built(context: CacheContext & { dir: string }): Promise<CacheEntry> {
  const source = await tree(join(context.cacheRoot, 'source'));
  return prepareCache(context.dir, KEY, INPUT, context, async () => source);
}
/* A bundle as a machine could send it: anything at all behind a checked digest. */
async function crafted(context: CacheContext, entries: unknown[], bytes: string, over: object = {}): Promise<string> {
  const header = JSON.stringify({ format: 2, key: KEY, inputDigest: INPUT, roots: ['t'], entries, ...over });
  const file = join(context.cacheRoot, 'crafted');
  await writeFile(file, zstdCompressSync(Buffer.from(`${header}\n${bytes}`)));
  return file;
}
const fileItem = (path: string, text: string, mode = 0o644) => ({ path, kind: 'file', digest: sha(text), mode, size: Buffer.byteLength(text) });
const target = (context: CacheContext & { dir: string }) => ({ path: join(context.dir, KEY), key: KEY, inputDigest: INPUT });

describe('a stored tree as one file for another machine', () => {
  it('arrives whole on another machine, and is a hit there from then on', async () => {
    const here = await machine(), there = await machine(), file = join(here.cacheRoot, 'bundle');
    const packed = await packBundle(await built(here), file, here);
    expect(packed.size).toBe((await stat(file)).size);
    expect(packed.digest).toBe(createHash('sha256').update(await readFile(file)).digest('hex'));
    await mkdir(there.dir, { mode: 0o700 });
    await unpackBundle(file, target(there), there);
    let builds = 0;
    const entry = await prepareCache(there.dir, KEY, INPUT, there, async () => { builds++; return { root: there.cacheRoot, paths: [] }; });
    expect(entry.hit).toBe(true); expect(builds).toBe(0);
    const part = join(there.cacheRoot, 'part');
    await restoreCache(entry, part, there, { link: true });
    expect(await readFile(join(part, 'node_modules', 'dep'), 'utf8')).toBe('locked');
    expect((await stat(join(part, 'node_modules', '.bin', 'tool'))).mode & 0o111).toBe(0o111);
    expect((await lstat(join(part, 'node_modules', '.bin', 'link'))).isSymbolicLink()).toBe(true);
    await expect(writeFile(join(part, 'node_modules', 'dep'), 'changed')).rejects.toThrow(/EACCES/);
  });

  it.each([
    ['a path out of the folder', [{ ...fileItem('../evil', 'x') }], 'x'],
    ['an absolute path', [{ ...fileItem('/tmp/evil', 'x') }], 'x'],
    ['a file under a link', [{ path: 't', kind: 'directory' }, { path: 't/l', kind: 'symlink', target: '.' }, fileItem('t/l/evil', 'x')], 'x'],
    ['a link out of the folder', [{ path: 't', kind: 'directory' }, { path: 't/l', kind: 'symlink', target: '../..' }], ''],
    ['a file with no folder before it', [fileItem('t/f', 'x')], 'x'],
    ['the same path twice', [fileItem('f', 'x'), fileItem('f', 'x')], 'xx'],
    ['bytes that differ from the digest', [fileItem('f', 'x')], 'y'],
    ['fewer bytes than promised', [fileItem('f', 'xyz')], 'x'],
    ['more bytes than promised', [fileItem('f', 'x')], 'xy'],
  ])('refuses %s and stores nothing', async (_name, entries, bytes) => {
    const there = await machine(); await mkdir(there.dir);
    await expect(unpackBundle(await crafted(there, entries, bytes), target(there), there)).rejects.toThrow();
    expect((await readdir(there.dir)).filter(name => name === KEY)).toEqual([]);
    expect((await readdir(there.dir)).filter(name => name.startsWith('.staging-'))).toEqual([]);
  });

  it('refuses a bundle of another key', async () => {
    const there = await machine(); await mkdir(there.dir);
    await expect(unpackBundle(await crafted(there, [fileItem('f', 'x')], 'x', { key: 'b'.repeat(64) }), target(there), there)).rejects.toThrow();
  });

  it('never makes a file that runs as its owner', async () => {
    const there = await machine(); await mkdir(there.dir);
    await expect(unpackBundle(await crafted(there, [fileItem('f', 'x', 0o4755)], 'x'), target(there), there)).rejects.toThrow();
    await unpackBundle(await crafted(there, [fileItem('f', 'x', 0o755)], 'x'), target(there), there);
    expect((await stat(join(there.dir, KEY, 'payload', 'f'))).mode & 0o7777).toBe(0o555);
  });
});

type Claim = Awaited<ReturnType<HarnessRemote['claim']>>;
/* The registry as a machine sees it: answers come from a list, and what it was told is kept. */
function registry(answers: Claim[], over: Partial<HarnessRemote> = {}) {
  const asked: string[] = [], uploaded: { key: string; size: number; bytes: Buffer }[] = [], failed: { key: string; error: string | null }[] = [];
  const remote: HarnessRemote = {
    claim: async unit => { asked.push(unit.key); return answers.length > 1 ? answers.shift()! : answers[0]!; },
    upload: async (key, file, _digest, size) => { uploaded.push({ key, size, bytes: await readFile(file) }); },
    download: async () => { throw new Error('nothing to download'); },
    failed: async (key, error) => { failed.push({ key, error }); },
    ...over,
  };
  return { remote, asked, uploaded, failed };
}
const UNIT = { repositoryScope: { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: 'c'.repeat(64) }, version: 'e'.repeat(64), unit: 'dependencies', commitSha: 'f'.repeat(40), platform: 'linux-arm64' };
const failing = (message: string) => async (): Promise<never> => { throw new Error(message); };

describe('one build for all the machines', () => {
  it('builds on the machine the registry names, and hands the result over', async () => {
    const here = await machine(), source = await tree(join(here.cacheRoot, 'source')), { remote, uploaded, failed } = registry([{ state: 'build', partBytes: 1024 }]);
    const entry = await prepareCache(here.dir, KEY, INPUT, here, async () => source, harnessShare(remote, UNIT));
    expect(entry).toMatchObject({ hit: false, fetched: false });
    expect(uploaded.map(item => item.key)).toEqual([KEY]);
    expect(uploaded[0]!.size).toBe(uploaded[0]!.bytes.length);
    expect(failed).toEqual([]);
    expect(await readdir(here.dir)).not.toContain(expect.stringMatching(/^\.bundle-/));
  });

  it('takes what another machine built, without building', async () => {
    const elsewhere = await machine(), file = join(elsewhere.cacheRoot, 'bundle'), packed = await packBundle(await built(elsewhere), file, elsewhere);
    const here = await machine(), { remote } = registry([{ state: 'ready', digest: packed.digest, size: packed.size, partBytes: 1024 }], { download: async (_key, to) => { await writeFile(to, await readFile(file)); } });
    const entry = await prepareCache(here.dir, KEY, INPUT, here, failing('it must not build'), harnessShare(remote, UNIT));
    expect(entry).toMatchObject({ hit: true, fetched: true });
    expect(await readFile(join(entry.path, 'payload', 'node_modules', 'dep'), 'utf8')).toBe('locked');
  });

  it('waits while another machine builds, then takes its result', async () => {
    const elsewhere = await machine(), file = join(elsewhere.cacheRoot, 'bundle'), packed = await packBundle(await built(elsewhere), file, elsewhere);
    const here = await machine(), { remote, asked } = registry([{ state: 'wait', afterMs: 1 }, { state: 'wait', afterMs: 1 }, { state: 'ready', digest: packed.digest, size: packed.size, partBytes: 1024 }], { download: async (_key, to) => { await writeFile(to, await readFile(file)); } });
    const entry = await prepareCache(here.dir, KEY, INPUT, here, failing('it must not build'), harnessShare(remote, UNIT));
    expect(entry.fetched).toBe(true); expect(asked).toEqual([KEY, KEY, KEY]);
  });

  it('builds here when the machine building it stopped answering and the registry hands it over', async () => {
    const here = await machine(), source = await tree(join(here.cacheRoot, 'source')), { remote, uploaded } = registry([{ state: 'wait', afterMs: 1 }, { state: 'build', partBytes: 1024 }]);
    await prepareCache(here.dir, KEY, INPUT, here, async () => source, harnessShare(remote, UNIT));
    expect(uploaded).toHaveLength(1);
  });

  it('says why when the unit failed elsewhere, and does not try it again here', async () => {
    const here = await machine(), { remote } = registry([{ state: 'failed', error: 'npm ci: ERESOLVE', afterMs: 60_000 }]);
    await expect(prepareCache(here.dir, KEY, INPUT, here, failing('it must not build'), harnessShare(remote, UNIT))).rejects.toThrow(/ERESOLVE/);
    expect((await readdir(here.dir)).filter(name => name === KEY)).toEqual([]);
  });

  it('tells the registry what failed, with the output, and keeps the last good version', async () => {
    const here = await machine(), old = await built(here), { remote, failed } = registry([{ state: 'build', partBytes: 1024 }]);
    await expect(prepareCache(here.dir, 'b'.repeat(64), INPUT, here, failing('The product command failed with exit 1.'), harnessShare(remote, UNIT, { tail: () => 'npm ERR! ERESOLVE' }))).rejects.toThrow(/exit 1/);
    expect(failed).toEqual([{ key: 'b'.repeat(64), error: expect.stringContaining('ERESOLVE') }]);
    const kept = await prepareCache(here.dir, KEY, INPUT, here, failing('it must not build'));
    expect(kept.hit).toBe(true); expect(kept.path).toBe(old.path);
  });

  it('gives a stopped build back without calling it failed', async () => {
    const here = await machine(), stop = new AbortController(), { remote, failed } = registry([{ state: 'build', partBytes: 1024 }]);
    const reason = new Error('stopped');
    await expect(prepareCache(here.dir, KEY, INPUT, { ...here, signal: stop.signal }, async () => { stop.abort(reason); throw reason; }, harnessShare(remote, UNIT))).rejects.toBe(reason);
    expect(failed).toEqual([{ key: KEY, error: null }]);
  });

  it('keeps its own build and gives the claim back when the upload fails', async () => {
    const here = await machine(), source = await tree(join(here.cacheRoot, 'source')), { remote, failed } = registry([{ state: 'build', partBytes: 1024 }], { upload: failing('Hornhoof answered 507.') });
    const entry = await prepareCache(here.dir, KEY, INPUT, here, async () => source, harnessShare(remote, UNIT));
    expect(entry.hit).toBe(false);
    expect(await readFile(join(entry.path, 'payload', 'node_modules', 'dep'), 'utf8')).toBe('locked');
    expect(failed).toEqual([{ key: KEY, error: null }]);
  });

  it.each([
    ['cannot be reached', { claim: failing('connect ECONNREFUSED') }],
    ['keeps no bundles', { claim: async () => ({ state: 'local' as const }) }],
  ])('builds here for itself when Hornhoof %s', async (_name, over) => {
    const here = await machine(), source = await tree(join(here.cacheRoot, 'source')), { remote, uploaded } = registry([{ state: 'build', partBytes: 1024 }], over);
    const entry = await prepareCache(here.dir, KEY, INPUT, here, async () => source, harnessShare(remote, UNIT));
    expect(entry.hit).toBe(false); expect(uploaded).toEqual([]);
  });

  it('builds here when the bundle it got cannot be used', async () => {
    const here = await machine(), source = await tree(join(here.cacheRoot, 'source')), { remote } = registry([{ state: 'ready', digest: 'b'.repeat(64), size: 1, partBytes: 1024 }], { download: async (_key, to) => { await writeFile(to, 'not a bundle'); } });
    const entry = await prepareCache(here.dir, KEY, INPUT, here, async () => source, harnessShare(remote, UNIT));
    expect(entry).toMatchObject({ hit: false, fetched: false });
    expect(await readFile(join(entry.path, 'payload', 'node_modules', 'dep'), 'utf8')).toBe('locked');
    expect((await readdir(here.dir)).filter(name => name.startsWith('.bundle-'))).toEqual([]);
  });

  it('keeps its claim while a long build runs', async () => {
    const here = await machine(), source = await tree(join(here.cacheRoot, 'source')), { remote, asked } = registry([{ state: 'build', partBytes: 1024 }]);
    await prepareCache(here.dir, KEY, INPUT, here, async () => { await new Promise(resolve => setTimeout(resolve, 60)); return source; }, harnessShare(remote, UNIT, { renewMs: 10 }));
    expect(asked.length).toBeGreaterThan(2);
    await chmod(join(here.dir, KEY), 0o700);
  });
});
