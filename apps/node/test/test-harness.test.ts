import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { packBundle, unpackBundle } from '../src/test-bundle.js';
import { prepareCache, restoreCache, STORED_AT, type CacheEntry, type CacheContext } from '../src/test-cache.js';
import { harnessRemote, harnessShare, type HarnessRemote } from '../src/test-harness.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const KEY = 'a'.repeat(64), INPUT = 'd'.repeat(64);
const LEASE = { companyId: '11111111-1111-4111-8111-111111111111', attempt: '33333333-3333-4333-8333-333333333333' };

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
  it.each([
    ['the checkout itself', ['.']],
    ['a path in another form', ['./t']],
    ['a path with a part that says nothing', ['t/./x']],
    ['a path it does not lay out', ['elsewhere']],
  ])('takes no bundle whose roots name %s, as a machine restores those and gives their parents to a part', async (_what, roots) => {
    const there = await machine(), file = await crafted(there, [{ path: 't', kind: 'directory' }, { path: 't/x', kind: 'directory' }], '', { roots });
    await mkdir(there.dir, { mode: 0o700 });
    await expect(unpackBundle(file, target(there), there)).rejects.toThrow(/root/);
  });

  it.each([['t//x'], ['t/./x'], ['.'], ['t/']])('takes no bundle that lays out %s, a path not in its one form', async path => {
    const there = await machine(), file = await crafted(there, [{ path: 't', kind: 'directory' }, { path, kind: 'directory' }], '');
    await mkdir(there.dir, { mode: 0o700 });
    await expect(unpackBundle(file, target(there), there)).rejects.toThrow(/form/);
  });

  it('gives every file one time wherever it was stored, taken from or copied to, so a tool comparing times finds all of it up to date', async () => {
    const here = await machine(), there = await machine(), entry = await built(here), file = join(here.cacheRoot, 'bundle');
    const times = async (root: string) => Promise.all(['node_modules/dep', 'node_modules/.bin/tool'].map(async path => (await stat(join(root, path))).mtimeMs));
    expect(await times(join(entry.path, 'payload'))).toEqual([STORED_AT.getTime(), STORED_AT.getTime()]);
    await packBundle(entry, file, here);
    await mkdir(there.dir, { mode: 0o700 });
    const taken = await unpackBundle(file, target(there), there);
    expect(await times(join(target(there).path, 'payload'))).toEqual([STORED_AT.getTime(), STORED_AT.getTime()]);
    await restoreCache({ ...target(there), hit: true, ready: taken }, join(there.cacheRoot, 'part'), there);
    expect(await times(join(there.cacheRoot, 'part'))).toEqual([STORED_AT.getTime(), STORED_AT.getTime()]);
    await restoreCache({ ...target(there), hit: true, ready: taken }, join(there.cacheRoot, 'linked'), there, { link: true });
    expect(await times(join(there.cacheRoot, 'linked'))).toEqual([STORED_AT.getTime(), STORED_AT.getTime()]);
    expect((await prepareCache(there.dir, KEY, INPUT, there, async () => { throw new Error('It holds this already.'); })).hit).toBe(true);
  });

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
    await unpackBundle(await crafted(there, [fileItem('f', 'x', 0o755)], 'x', { roots: ['f'] }), target(there), there);
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
    const here = await machine(), source = await tree(join(here.cacheRoot, 'source')), { remote, uploaded, failed } = registry([{ state: 'build', ...LEASE, partBytes: 1024 }]);
    const entry = await prepareCache(here.dir, KEY, INPUT, here, async () => source, harnessShare(remote, UNIT));
    expect(entry).toMatchObject({ hit: false, fetched: false });
    expect(uploaded.map(item => item.key)).toEqual([KEY]);
    expect(uploaded[0]!.size).toBe(uploaded[0]!.bytes.length);
    expect(failed).toEqual([]);
    expect(await readdir(here.dir)).not.toContain(expect.stringMatching(/^\.bundle-/));
  });

  it('takes what another machine built, without building', async () => {
    const elsewhere = await machine(), file = join(elsewhere.cacheRoot, 'bundle'), packed = await packBundle(await built(elsewhere), file, elsewhere);
    const here = await machine(), { remote } = registry([{ state: 'ready', ...LEASE, digest: packed.digest, size: packed.size, partBytes: 1024 }], { download: async (_key, to) => { await writeFile(to, await readFile(file)); } });
    const entry = await prepareCache(here.dir, KEY, INPUT, here, failing('it must not build'), harnessShare(remote, UNIT));
    expect(entry).toMatchObject({ hit: true, fetched: true });
    expect(await readFile(join(entry.path, 'payload', 'node_modules', 'dep'), 'utf8')).toBe('locked');
  });

  it('waits while another machine builds, then takes its result', async () => {
    const elsewhere = await machine(), file = join(elsewhere.cacheRoot, 'bundle'), packed = await packBundle(await built(elsewhere), file, elsewhere);
    const here = await machine(), { remote, asked } = registry([{ state: 'wait', afterMs: 1 }, { state: 'wait', afterMs: 1 }, { state: 'ready', ...LEASE, digest: packed.digest, size: packed.size, partBytes: 1024 }], { download: async (_key, to) => { await writeFile(to, await readFile(file)); } });
    const entry = await prepareCache(here.dir, KEY, INPUT, here, failing('it must not build'), harnessShare(remote, UNIT));
    expect(entry.fetched).toBe(true); expect(asked).toEqual([KEY, KEY, KEY]);
  });

  it('builds here when the machine building it stopped answering and the registry hands it over', async () => {
    const here = await machine(), source = await tree(join(here.cacheRoot, 'source')), { remote, uploaded } = registry([{ state: 'wait', afterMs: 1 }, { state: 'build', ...LEASE, partBytes: 1024 }]);
    await prepareCache(here.dir, KEY, INPUT, here, async () => source, harnessShare(remote, UNIT));
    expect(uploaded).toHaveLength(1);
  });

  it('says why when the unit failed elsewhere, and does not try it again here', async () => {
    const here = await machine(), { remote } = registry([{ state: 'failed', error: 'npm ci: ERESOLVE', afterMs: 60_000 }]);
    await expect(prepareCache(here.dir, KEY, INPUT, here, failing('it must not build'), harnessShare(remote, UNIT))).rejects.toThrow(/ERESOLVE/);
    expect((await readdir(here.dir)).filter(name => name === KEY)).toEqual([]);
  });

  it('tells the registry what failed, with the output, and keeps the last good version', async () => {
    const here = await machine(), old = await built(here), { remote, failed } = registry([{ state: 'build', ...LEASE, partBytes: 1024 }]);
    await expect(prepareCache(here.dir, 'b'.repeat(64), INPUT, here, failing('The product command failed with exit 1.'), harnessShare(remote, UNIT, { tail: () => 'npm ERR! ERESOLVE' }))).rejects.toThrow(/exit 1/);
    expect(failed).toEqual([{ key: 'b'.repeat(64), error: expect.stringContaining('ERESOLVE') }]);
    const kept = await prepareCache(here.dir, KEY, INPUT, here, failing('it must not build'));
    expect(kept.hit).toBe(true); expect(kept.path).toBe(old.path);
  });

  it('gives a stopped build back without calling it failed', async () => {
    const here = await machine(), stop = new AbortController(), { remote, failed } = registry([{ state: 'build', ...LEASE, partBytes: 1024 }]);
    const reason = new Error('stopped');
    await expect(prepareCache(here.dir, KEY, INPUT, { ...here, signal: stop.signal }, async () => { stop.abort(reason); throw reason; }, harnessShare(remote, UNIT))).rejects.toBe(reason);
    expect(failed).toEqual([{ key: KEY, error: null }]);
  });

  it('keeps its own build and gives the claim back when the upload fails', async () => {
    const here = await machine(), source = await tree(join(here.cacheRoot, 'source')), { remote, failed } = registry([{ state: 'build', ...LEASE, partBytes: 1024 }], { upload: failing('Hornhoof answered 507.') });
    const entry = await prepareCache(here.dir, KEY, INPUT, here, async () => source, harnessShare(remote, UNIT));
    expect(entry.hit).toBe(false);
    expect(await readFile(join(entry.path, 'payload', 'node_modules', 'dep'), 'utf8')).toBe('locked');
    expect(failed).toEqual([{ key: KEY, error: null }]);
  });

  it.each([
    ['cannot be reached', { claim: failing('connect ECONNREFUSED') }],
    ['keeps no bundles', { claim: async () => ({ state: 'local' as const }) }],
  ])('builds here for itself when Hornhoof %s', async (_name, over) => {
    const here = await machine(), source = await tree(join(here.cacheRoot, 'source')), { remote, uploaded } = registry([{ state: 'build', ...LEASE, partBytes: 1024 }], over);
    const entry = await prepareCache(here.dir, KEY, INPUT, here, async () => source, harnessShare(remote, UNIT));
    expect(entry.hit).toBe(false); expect(uploaded).toEqual([]);
  });

  it('builds here when the bundle it got cannot be used', async () => {
    const here = await machine(), source = await tree(join(here.cacheRoot, 'source')), { remote } = registry([{ state: 'ready', ...LEASE, digest: 'b'.repeat(64), size: 1, partBytes: 1024 }], { download: async (_key, to) => { await writeFile(to, 'not a bundle'); } });
    const entry = await prepareCache(here.dir, KEY, INPUT, here, async () => source, harnessShare(remote, UNIT));
    expect(entry).toMatchObject({ hit: false, fetched: false });
    expect(await readFile(join(entry.path, 'payload', 'node_modules', 'dep'), 'utf8')).toBe('locked');
    expect((await readdir(here.dir)).filter(name => name.startsWith('.bundle-'))).toEqual([]);
  });

  it('keeps its claim while a long build runs', async () => {
    const here = await machine(), source = await tree(join(here.cacheRoot, 'source')), { remote, asked } = registry([{ state: 'build', ...LEASE, partBytes: 1024 }]);
    await prepareCache(here.dir, KEY, INPUT, here, async () => { await new Promise(resolve => setTimeout(resolve, 60)); return source; }, harnessShare(remote, UNIT, { renewMs: 10 }));
    expect(asked.length).toBeGreaterThan(2);
    await chmod(join(here.dir, KEY), 0o700);
  });
});

describe('the registry over HTTP', () => {
  const SIGNAL = new AbortController().signal;
  const unit = { repositoryScope: { companyId: '11111111-1111-4111-8111-111111111111', repositoryOwnerId: '22222222-2222-4222-8222-222222222222', repoUrlHash: 'c'.repeat(64) }, version: INPUT, unit: 'dependencies', key: KEY, commitSha: 'e'.repeat(40), platform: 'linux-arm64' };
  type Asked = { method: string; url: string; authorization: string | undefined; range: string | undefined; body: Buffer; company: string | string[] | undefined; attempt: string | string[] | undefined };
  /* A server that answers each request as told, and keeps what it was asked. */
  async function server(answer: (asked: Asked, response: ServerResponse<IncomingMessage>) => void, pauseMs = 1, releaseMs?: number) {
    const heard: Asked[] = [];
    const running = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const asked = { method: request.method!, url: request.url!, authorization: request.headers.authorization, range: request.headers.range, body: Buffer.concat(chunks), company: request.headers['x-harness-company'], attempt: request.headers['x-harness-attempt'] };
        heard.push(asked); answer(asked, response);
      });
    });
    await new Promise<void>(resolve => { running.listen(0, '127.0.0.1', resolve); });
    onTestFinished(() => new Promise<void>(resolve => { running.closeAllConnections(); running.close(() => { resolve(); }); }));
    const address = running.address() as { port: number };
    return { heard, remote: harnessRemote(`http://127.0.0.1:${address.port}`, 'the-node-key', pauseMs, releaseMs) };
  }
  const send = (response: ServerResponse<IncomingMessage>, status: number, body = '') => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(body); };
  async function file(text: string) {
    const root = await mkdtemp(join(tmpdir(), 'hh-remote-')); folders.push(root);
    await writeFile(join(root, 'bundle'), text);
    return { root, path: join(root, 'bundle') };
  }

  it('asks with the machine\'s key and reads the answer', async () => {
    const { heard, remote } = await server((_asked, response) => { send(response, 200, JSON.stringify({ state: 'wait', afterMs: 5 })); });
    expect(await remote.claim(unit, SIGNAL)).toEqual({ state: 'wait', afterMs: 5 });
    expect(heard[0]).toMatchObject({ method: 'POST', url: '/api/harness/claim', authorization: 'Bearer the-node-key' });
    expect(JSON.parse(heard[0]!.body.toString())).toEqual({ ...unit, fencing: 1 });
  });

  it('says what the server refused, with its words when it has any', async () => {
    const worded = await server((_asked, response) => { send(response, 403, JSON.stringify({ error: { message: 'This machine takes no tests of this product.' } })); });
    await expect(worded.remote.claim(unit, SIGNAL)).rejects.toThrow('Hornhoof answered 403: This machine takes no tests of this product.');
    const bare = await server((_asked, response) => { send(response, 500, 'not json'); });
    await expect(bare.remote.claim(unit, SIGNAL)).rejects.toThrow(/^Hornhoof answered 500\.$/);
  });

  it('lets a unit go within a short time even when the server never answers, as the cache lock waits meanwhile', async () => {
    const { heard, remote } = await server(() => {}, 1, 200);
    const started = Date.now();
    await expect(remote.failed(KEY, null, LEASE)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(heard.map(asked => asked.url)).toEqual([`/api/harness/${KEY}/failed`]);
  });

  it('builds locally against a server that answers with the old unfenced protocol', async () => {
    const { heard, remote } = await server((_asked, response) => { send(response, 200, JSON.stringify({ state: 'build', partBytes: 1024 })); });
    const here = await machine(), source = await tree(join(here.cacheRoot, 'source'));
    const entry = await prepareCache(here.dir, KEY, INPUT, here, async () => source, harnessShare(remote, UNIT));
    expect(entry.fetched).toBe(false);
    expect(heard.map(request => request.url)).toEqual(['/api/harness/claim']);
  });

  it('sends a bundle in parts, each tried again by itself, and then says it is whole', async () => {
    let refusals = 2;
    const { heard, remote } = await server(({ url }, response) => { if (url.endsWith('/parts/1') && refusals-- > 0) send(response, 503); else send(response, 200, '{}'); });
    const { path } = await file('abcdefgh');
    await remote.upload(KEY, path, 'digest', 8, 3, SIGNAL, LEASE);
    for (const request of heard) expect(request).toMatchObject({ company: LEASE.companyId, attempt: LEASE.attempt });
    expect(heard.map(asked => asked.url.split('/').slice(-2).join('/'))).toEqual(['parts/0', 'parts/1', 'parts/1', 'parts/1', 'parts/2', `${KEY}/done`]);
    expect(heard.filter(asked => asked.url.includes('/parts/')).map(asked => asked.body.toString())).toEqual(['abc', 'def', 'def', 'def', 'gh']);
    expect(JSON.parse(heard.at(-1)!.body.toString())).toEqual({ digest: 'digest', size: 8 });
  });

  it('gives up on a part after three tries, and never says the bundle is whole', async () => {
    const { heard, remote } = await server((_asked, response) => { send(response, 503); });
    const { path } = await file('abc');
    await expect(remote.upload(KEY, path, 'digest', 3, 3, SIGNAL, LEASE)).rejects.toThrow('Hornhoof answered 503');
    expect(heard.map(asked => asked.url.split('/').at(-1))).toEqual(['0', '0', '0']);
  });

  it('waits longer before each new try, as a link that dropped takes a while to come back', async () => {
    const at: number[] = [], { remote } = await server((_asked, response) => { at.push(Date.now()); send(response, 503); }, 100);
    const { path } = await file('abc');
    await expect(remote.upload(KEY, path, 'digest', 3, 3, SIGNAL, LEASE)).rejects.toThrow('Hornhoof answered 503');
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(90);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(190);
  });

  it('stops waiting when it is told to stop', async () => {
    const stop = new AbortController(), { heard, remote } = await server((_asked, response) => { send(response, 503); setTimeout(() => { stop.abort(); }, 20); }, 60_000);
    const { path } = await file('abc');
    await expect(remote.upload(KEY, path, 'digest', 3, 3, stop.signal, LEASE)).rejects.toThrow();
    expect(heard).toHaveLength(1);
  });

  it('stops trying when it is told to stop', async () => {
    const stop = new AbortController(), { heard, remote } = await server((_asked, response) => { stop.abort(); send(response, 503); });
    const { path } = await file('abc');
    await expect(remote.upload(KEY, path, 'digest', 3, 3, stop.signal, LEASE)).rejects.toThrow();
    expect(heard).toHaveLength(1);
  });

  it('takes a bundle by ranges, each tried again by itself, and checks what came', async () => {
    const bytes = 'abcdefgh'; let refusals = 1;
    const { heard, remote } = await server(({ range }, response) => {
      if (range === 'bytes=3-5' && refusals-- > 0) { send(response, 503); return; }
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(range!)!;
      response.writeHead(206); response.end(bytes.slice(Number(from), Number(to) + 1));
    });
    const { root } = await file('');
    await remote.download(KEY, join(root, 'came'), { state: 'ready', ...LEASE, digest: sha(bytes), size: 8, partBytes: 3 }, SIGNAL);
    expect(await readFile(join(root, 'came'), 'utf8')).toBe(bytes);
    for (const request of heard) expect(request).toMatchObject({ company: LEASE.companyId, attempt: LEASE.attempt });
    expect(heard.map(asked => asked.range)).toEqual(['bytes=0-2', 'bytes=3-5', 'bytes=3-5', 'bytes=6-7']);
    await expect(remote.download(KEY, join(root, 'other'), { state: 'ready', ...LEASE, digest: sha('other bytes'), size: 8, partBytes: 3 }, SIGNAL)).rejects.toThrow('differs from what Hornhoof holds');
  });

  it('fails a download it cannot store, so the machine stays up and builds it itself', async () => {
    const { remote } = await server((_asked, response) => { response.writeHead(206); response.end('abc'); });
    const { root } = await file('');
    await expect(remote.download(KEY, join(root, 'no such folder', 'came'), { state: 'ready', ...LEASE, digest: sha('abc'), size: 3, partBytes: 3 }, SIGNAL)).rejects.toThrow(/ENOENT/);
  });

  it('says a build failed, or was given up', async () => {
    const { heard, remote } = await server((_asked, response) => { send(response, 200, '{}'); });
    await remote.failed(KEY, 'npm ci ended with 1', LEASE);
    await remote.failed(KEY, null, LEASE);
    for (const request of heard) expect(request).toMatchObject({ company: LEASE.companyId, attempt: LEASE.attempt });
    expect(heard.map(asked => [asked.url, JSON.parse(asked.body.toString())])).toEqual([[`/api/harness/${KEY}/failed`, { error: 'npm ci ended with 1' }], [`/api/harness/${KEY}/failed`, { error: null }]]);
  });
});
