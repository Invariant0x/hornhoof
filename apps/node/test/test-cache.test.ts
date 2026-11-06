import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { link, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import * as cache from '../src/test-cache.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function context() {
  const cacheRoot = await mkdtemp(join(tmpdir(), 'hh-prepared-')); folders.push(cacheRoot);
  return { cacheRoot, deadline: Date.now() + 10_000, signal: new AbortController().signal, log: () => {} };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('cache writer locking', () => {
  it('holds a process lock through the callback and lets another writer proceed after failure', async () => {
    const ctx = await context(), entered = deferred(), release = deferred();
    const lock = join(ctx.cacheRoot, 'writer.lock'), events: string[] = [];
    const first = cache.withCacheLock(lock, ctx, async () => { events.push('first'); entered.resolve(); await release.promise; throw new Error('builder failed'); });
    const rejected = expect(first).rejects.toThrow('builder failed');
    await entered.promise;
    const next = cache.withCacheLock(lock, ctx, async () => { events.push('second'); });
    expect(events).toEqual(['first']);
    release.resolve(); await rejected; await next;
    expect(events).toEqual(['first', 'second']);
  });

  it('cancels a waiting writer without entering its callback', async () => {
    const ctx = await context(), entered = deferred(), release = deferred(), abort = new AbortController();
    const lock = join(ctx.cacheRoot, 'writer.lock');
    const first = cache.withCacheLock(lock, ctx, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    let called = false;
    const waiting = cache.withCacheLock(lock, { ...ctx, signal: abort.signal }, async () => { called = true; });
    const reason = new Error('cancelled queued build'); abort.abort(reason);
    await expect(waiting).rejects.toBe(reason); expect(called).toBe(false);
    release.resolve(); await first;
    await cache.withCacheLock(lock, ctx, async () => { await writeFile(join(ctx.cacheRoot, 'proof'), 'released'); });
    expect(await readFile(join(ctx.cacheRoot, 'proof'), 'utf8')).toBe('released');
  });

  it('rejects an expired deadline without starting a build', async () => {
    const ctx = await context(); let called = false;
    await expect(cache.withCacheLock(join(ctx.cacheRoot, 'writer.lock'), { ...ctx, deadline: Date.now() - 1 }, async () => { called = true; })).rejects.toThrow(/deadline/i);
    expect(called).toBe(false);
  });

  it('refuses a public cache root rather than making shared writable state trusted', async () => {
    const ctx = await context(), publicRoot = join(ctx.cacheRoot, 'public');
    await mkdir(publicRoot, { mode: 0o777 });
    await expect(cache.privateCacheRoot(publicRoot)).rejects.toThrow(/private/i);
  });
});


describe('immutable preparation payloads', () => {
  it('keys sorted inputs and settings, preserving lock version A when B is prepared', async () => {
    const base = { runtime: 'node22-linux-x64', settings: { adapter: 'npm', install: ['npm', 'ci'] }, inputs: [{ path: 'package-lock.json', digest: 'a'.repeat(64) }] };
    expect(cache.cacheKey(base)).toBe(cache.cacheKey({ ...base, settings: { install: ['npm', 'ci'], adapter: 'npm' } }));
    expect(cache.cacheKey(base)).not.toBe(cache.cacheKey({ ...base, inputs: [{ path: 'package-lock.json', digest: 'b'.repeat(64) }] }));
    expect(cache.cacheKey(base)).not.toBe(cache.cacheKey({ ...base, runtime: 'node24-linux-x64' }));
    expect(cache.cacheKey(base)).not.toBe(cache.cacheKey({ ...base, inputs: [{ path: 'package-lock.json', digest: null }] }));
  });

  it('publishes once and gives each consumer independent copies', async () => {
    const ctx = await context(), source = join(ctx.cacheRoot, 'source'), destination = join(ctx.cacheRoot, 'part');
    await mkdir(join(source, 'node_modules'), { recursive: true });
    await writeFile(join(source, 'node_modules', 'dep'), 'version A');
    let builds = 0;
    const build = async () => { builds++; return { root: source, paths: ['node_modules'] }; };
    const directory = join(ctx.cacheRoot, 'dependencies'), key = 'a'.repeat(64), digest = 'c'.repeat(64);
    const first = await cache.prepareCache(directory, key, digest, ctx, build);
    const second = await cache.prepareCache(directory, key, digest, ctx, build);
    expect(first.hit).toBe(false); expect(second.hit).toBe(true); expect(builds).toBe(1);
    await cache.restoreCache(second, destination, ctx);
    await writeFile(join(destination, 'node_modules', 'dep'), 'changed by test');
    expect(await readFile(join(first.path, 'payload', 'node_modules', 'dep'), 'utf8')).toBe('version A');
    await writeFile(join(source, 'node_modules', 'dep'), 'version B');
    await cache.prepareCache(directory, 'b'.repeat(64), digest, ctx, build);
    expect(await readFile(join(first.path, 'payload', 'node_modules', 'dep'), 'utf8')).toBe('version A');
  });

  it('deduplicates overlapping builders and rebuilds a corrupted payload', async () => {
    const ctx = await context(), source = join(ctx.cacheRoot, 'source'); await mkdir(source);
    await writeFile(join(source, 'template'), 'migrated'); let builds = 0;
    const build = async () => { builds++; return { root: source, paths: ['template'] }; };
    const directory = join(ctx.cacheRoot, 'environments'), key = 'e'.repeat(64), digest = 'd'.repeat(64);
    const results = await Promise.all([cache.prepareCache(directory, key, digest, ctx, build), cache.prepareCache(directory, key, digest, ctx, build)]);
    expect(results.map(result => result.hit).sort()).toEqual([false, true]); expect(builds).toBe(1);
    await writeFile(join(results[0].path, 'payload', 'template'), 'corrupt');
    expect((await cache.prepareCache(directory, key, digest, ctx, build)).hit).toBe(false); expect(builds).toBe(2);
    expect((await readdir(directory)).some(name => name.startsWith('.corrupt-'))).toBe(true);
  });

  it('never publishes READY after a failed builder', async () => {
    const ctx = await context(), directory = join(ctx.cacheRoot, 'dependencies');
    await expect(cache.prepareCache(directory, 'f'.repeat(64), 'd'.repeat(64), ctx, async () => { throw new Error('install failed'); })).rejects.toThrow('install failed');
    expect((await readdir(directory)).filter(name => !name.startsWith('.'))).toEqual([]);
  });

  it('rejects an escaping symlink and preserves repository-relative workspace links', async () => {
    const ctx = await context(), source = join(ctx.cacheRoot, 'source'); await mkdir(join(source, 'node_modules'), { recursive: true });
    await symlink('/etc/passwd', join(source, 'node_modules', 'escape'));
    const build = async () => ({ root: source, paths: ['node_modules'] });
    const directory = join(ctx.cacheRoot, 'dependencies');
    await expect(cache.prepareCache(directory, 'a'.repeat(64), 'd'.repeat(64), ctx, build)).rejects.toThrow(/symlink/i);
    await rm(join(source, 'node_modules', 'escape'));
    await mkdir(join(source, 'packages', 'local'), { recursive: true }); await writeFile(join(source, 'packages', 'local', 'package.json'), '{}');
    await symlink('../packages/local', join(source, 'node_modules', 'local'));
    const entry = await cache.prepareCache(directory, 'a'.repeat(64), 'd'.repeat(64), ctx, build);
    const part = join(ctx.cacheRoot, 'part'); await mkdir(join(part, 'packages', 'local'), { recursive: true });
    await writeFile(join(part, 'packages', 'local', 'package.json'), '{"current":true}');
    await cache.restoreCache(entry, part, ctx);
    expect(await readFile(join(part, 'node_modules', 'local', 'package.json'), 'utf8')).toBe('{"current":true}');
  });
});


it('automatically releases a lock after the owning process is killed', async () => {
  const ctx = await context(), path = join(ctx.cacheRoot, 'crash.lock');
  const modulePath = new URL('../src/test-cache.ts', import.meta.url).href;
  const script = `import { withCacheLock } from ${JSON.stringify(modulePath)}; await withCacheLock(process.argv[1], { cacheRoot:process.argv[2], deadline:Date.now()+10000, signal:new AbortController().signal, log:()=>{} }, async()=>{ process.stdout.write('locked'); process.stdin.resume(); await new Promise(resolve=>process.stdin.once('end',resolve)); });`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, path, ctx.cacheRoot], { stdio: ['pipe', 'pipe', 'pipe'] });
  onTestFinished(() => { child.kill('SIGKILL'); });
  expect(String((await once(child.stdout, 'data'))[0])).toBe('locked');
  const closed = once(child, 'exit'); child.kill('SIGKILL'); await closed;
  let ran = false; await cache.withCacheLock(path, ctx, async () => { ran = true; }); expect(ran).toBe(true);
});

it('rejects externally hardlinked payload files', async () => {
  const ctx = await context(), source = join(ctx.cacheRoot, 'source'); await mkdir(source);
  await writeFile(join(ctx.cacheRoot, 'outside'), 'outside'); await link(join(ctx.cacheRoot, 'outside'), join(source, 'linked'));
  await expect(cache.prepareCache(join(ctx.cacheRoot, 'dependencies'), 'a'.repeat(64), 'd'.repeat(64), ctx, async () => ({ root: source, paths: ['linked'] }))).rejects.toThrow(/hardlink/i);
});

it('does not create directories through a checkout symlink during restore', async () => {
  const ctx = await context(), source = join(ctx.cacheRoot, 'source'); await mkdir(join(source, 'nested', 'deep'), { recursive: true });
  await writeFile(join(source, 'nested', 'deep', 'template'), 'artifact');
  const entry = await cache.prepareCache(join(ctx.cacheRoot, 'environments'), 'a'.repeat(64), 'd'.repeat(64), ctx, async () => ({ root: source, paths: ['nested/deep/template'] }));
  const destination = join(ctx.cacheRoot, 'part'), outside = join(ctx.cacheRoot, 'outside');
  await mkdir(destination); await mkdir(outside); await symlink(outside, join(destination, 'nested'));
  await expect(cache.restoreCache(entry, destination, ctx)).rejects.toThrow(/symlink/i);
  expect(await readdir(outside)).toEqual([]);
});

it('does not publish READY when cancelled during a builder callback', async () => {
  const ctx = await context(), source = join(ctx.cacheRoot, 'source'), abort = new AbortController(); await mkdir(source);
  await writeFile(join(source, 'template'), 'artifact');
  const directory = join(ctx.cacheRoot, 'environments'), reason = new Error('lease lost');
  await expect(cache.prepareCache(directory, 'a'.repeat(64), 'd'.repeat(64), { ...ctx, signal: abort.signal }, async () => { abort.abort(reason); return { root: source, paths: ['template'] }; })).rejects.toBe(reason);
  expect((await readdir(directory)).filter(name => !name.startsWith('.'))).toEqual([]);
});


it('retains a writer lock in a trusted descendant until that descendant exits', async () => {
  const ctx = await context(), path = join(ctx.cacheRoot, 'descendant.lock');
  const child = await cache.withCacheLock(path, ctx, async () => {
    return spawn(process.execPath, ['-e', "process.stdout.write('started');process.stdin.resume();"], { stdio: ['pipe', 'pipe', 'pipe', ...cache.cacheLockDescriptors()] });
  });
  onTestFinished(() => { child.kill('SIGKILL'); });
  await once(child.stdout!, 'data');
  expect(spawnSync('flock', ['--nonblock', path, '/usr/bin/true']).status).toBe(1);
  const closed = once(child, 'exit'); child.kill('SIGKILL'); await closed;
  await expect(cache.withCacheLock(path, ctx, async () => 'released')).resolves.toBe('released');
});

it('refuses workspace links redirected outside the current checkout', async () => {
  const ctx = await context(), source = join(ctx.cacheRoot, 'source');
  await mkdir(join(source, 'node_modules'), { recursive: true }); await mkdir(join(source, 'packages/local'), { recursive: true });
  await writeFile(join(source, 'packages/local/package.json'), '{}'); await symlink('../packages/local', join(source, 'node_modules/local'));
  const entry = await cache.prepareCache(join(ctx.cacheRoot, 'dependencies'), 'a'.repeat(64), 'd'.repeat(64), ctx, async () => ({ root: source, paths: ['node_modules'] }));
  const destination = join(ctx.cacheRoot, 'part'), outside = join(ctx.cacheRoot, 'outside');
  await mkdir(join(destination, 'packages'), { recursive: true }); await mkdir(outside); await writeFile(join(outside, 'package.json'), '{}');
  await symlink(outside, join(destination, 'packages/local'));
  await expect(cache.restoreCache(entry, destination, ctx)).rejects.toThrow(/checkout|symlink/i);
});

it('does not restore through a symlink used as the checkout root', async () => {
  const ctx = await context(), source = join(ctx.cacheRoot, 'source'), outside = join(ctx.cacheRoot, 'outside'), destination = join(ctx.cacheRoot, 'part');
  await mkdir(source); await writeFile(join(source, 'artifact'), 'payload');
  const entry = await cache.prepareCache(join(ctx.cacheRoot, 'environments'), 'a'.repeat(64), 'd'.repeat(64), ctx, async () => ({ root: source, paths: ['artifact'] }));
  await mkdir(outside); await symlink(outside, destination);
  await expect(cache.restoreCache(entry, destination, ctx)).rejects.toThrow(/checkout|symlink/i);
  expect(await readdir(outside)).toEqual([]);
});


it('breaks internal payload hardlinks into independent cache and consumer files', async () => {
  const ctx = await context(), source = join(ctx.cacheRoot, 'source'); await mkdir(join(source, 'deps'), { recursive: true });
  await writeFile(join(source, 'deps/a'), 'original'); await link(join(source, 'deps/a'), join(source, 'deps/b'));
  const entry = await cache.prepareCache(join(ctx.cacheRoot, 'dependencies'), 'a'.repeat(64), 'd'.repeat(64), ctx, async () => ({ root: source, paths: ['deps'] }));
  const a = await stat(join(entry.path, 'payload/deps/a')), b = await stat(join(entry.path, 'payload/deps/b'));
  expect(a.nlink).toBe(1); expect(b.nlink).toBe(1); expect(a.ino).not.toBe(b.ino);
  const destination = join(ctx.cacheRoot, 'part'); await cache.restoreCache(entry, destination, ctx);
  await writeFile(join(destination, 'deps/a'), 'changed');
  expect(await readFile(join(destination, 'deps/b'), 'utf8')).toBe('original');
  expect(await readFile(join(entry.path, 'payload/deps/a'), 'utf8')).toBe('original');
});

it('never serves a payload whose publisher was killed before READY and lets a later publisher rebuild', async () => {
  const ctx = await context(), source = join(ctx.cacheRoot, 'source'), directory = join(ctx.cacheRoot, 'environments');
  await mkdir(source); await writeFile(join(source, 'template'), 'unfinished');
  const modulePath = new URL('../src/test-cache.ts', import.meta.url).href;
  const script = `import { prepareCache } from ${JSON.stringify(modulePath)}; await prepareCache(process.argv[1], 'a'.repeat(64), 'd'.repeat(64), {cacheRoot:process.argv[2],deadline:Date.now()+10000,signal:new AbortController().signal,log:()=>{}},async()=>{process.stdout.write('building');process.stdin.resume();await new Promise(resolve=>process.stdin.once('end',resolve));return {root:process.argv[3],paths:['template']};});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, directory, ctx.cacheRoot, source], { stdio: ['pipe', 'pipe', 'pipe'] });
  onTestFinished(() => { child.kill('SIGKILL'); });
  expect(String((await once(child.stdout, 'data'))[0])).toBe('building');
  const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
  await expect(readFile(join(directory, 'a'.repeat(64), 'READY.json'))).rejects.toThrow();
  const entry = await cache.prepareCache(directory, 'a'.repeat(64), 'd'.repeat(64), ctx, async () => { await writeFile(join(source, 'template'), 'rebuilt'); return { root: source, paths: ['template'] }; });
  expect(entry.hit).toBe(false); expect(await readFile(join(entry.path, 'payload/template'), 'utf8')).toBe('rebuilt');
});
