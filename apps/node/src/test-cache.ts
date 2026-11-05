import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { EnvironmentDigest, RepositoryPath } from '@hornhoof/protocol';
import { z } from 'zod';

const lockDescriptors = new AsyncLocalStorage<number[]>();
export const cacheLockDescriptors = (): number[] => lockDescriptors.getStore() ?? [];

export type CacheContext = { cacheRoot: string; deadline: number; signal: AbortSignal; log: (line: string) => void };

export function checkCacheContext(context: CacheContext): void {
  context.signal.throwIfAborted();
  if (Date.now() >= context.deadline) throw new Error('The preparation deadline expired.');
}

export async function privateCacheRoot(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('Prepared caches require a private node-owned directory.');
  return path;
}

function acquireLock(fd: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('flock', ['--exclusive', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd], env: { PATH: '/usr/bin:/bin' } });
    let failure: Error | undefined;
    const abort = () => { child.kill('SIGKILL'); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) reject(signal.reason);
      else if (failure || code !== 0) reject(new Error('Interprocess cache locking is unavailable.', { cause: failure }));
      else resolve();
    });
  });
}

export async function withCacheLock<T>(path: string, context: CacheContext, run: () => Promise<T>): Promise<T> {
  checkCacheContext(context);
  const file = await open(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('Cache locks require private node-owned files.');
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(Math.max(1, context.deadline - Date.now()))]);
    // flock shares this open file description. The parent retains the lock after the child exits.
    await acquireLock(file.fd, signal);
    checkCacheContext(context);
    return await lockDescriptors.run([...cacheLockDescriptors(), file.fd], run);
  } finally { await file.close(); }
}


function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function cacheKey(value: { runtime: string; settings: unknown; inputs: { path: string; digest: string | null }[] }): string {
  return createHash('sha256').update(canonical({ ...value, inputs: [...value.inputs].sort((a, b) => a.path.localeCompare(b.path)) })).digest('hex');
}

const PayloadItem = z.discriminatedUnion('kind', [
  z.strictObject({ path: RepositoryPath, kind: z.literal('directory') }),
  z.strictObject({ path: RepositoryPath, kind: z.literal('file'), digest: EnvironmentDigest, mode: z.number().int() }),
  z.strictObject({ path: RepositoryPath, kind: z.literal('symlink'), target: z.string() }),
]);
type PayloadItem = z.infer<typeof PayloadItem>;
const Ready = z.strictObject({ format: z.literal(1), key: EnvironmentDigest, inputDigest: EnvironmentDigest, roots: z.array(RepositoryPath), entries: z.array(PayloadItem).max(500_000) });
export type CacheEntry = { path: string; key: string; inputDigest: string; hit: boolean };
type CacheBuild = () => Promise<{ root: string; paths: string[] }>;

function within(root: string, path: string): string {
  RepositoryPath.parse(path);
  const full = resolve(root, path);
  if (relative(root, full).startsWith('..') || path.split('/').includes('.git')) throw new Error('A payload path escapes its permitted root.');
  return full;
}
async function noLinkedParents(root: string, path: string): Promise<string> {
  const full = within(root, path);
  for (let parent = dirname(full); parent !== root && parent.startsWith(`${root}/`); parent = dirname(parent)) {
    if ((await lstat(parent)).isSymbolicLink()) throw new Error('A payload parent is a symlink.');
  }
  return full;
}
function safeLink(root: string, path: string, target: string): void {
  if (isAbsolute(target) || target.includes('\\') || relative(root, resolve(dirname(within(root, path)), target)).startsWith('..')) throw new Error('A payload symlink escapes the repository.');
}
export async function fileDigest(path: string, context: CacheContext): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) { checkCacheContext(context); hash.update(chunk); }
  return hash.digest('hex');
}
async function scanItem(root: string, path: string, context: CacheContext): Promise<PayloadItem[]> {
  checkCacheContext(context);
  const full = await noLinkedParents(root, path), stat = await lstat(full);
  if (stat.isSymbolicLink()) {
    const target = await readlink(full); safeLink(root, path, target);
    return [{ path, kind: 'symlink', target }];
  }
  if (stat.isDirectory()) return [{ path, kind: 'directory' }, ...await scanChildren(root, path, context)];
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Cache payloads require regular files without hardlinks.');
  return [{ path, kind: 'file', mode: stat.mode & 0o777, digest: await fileDigest(full, context) }];
}
async function scanChildren(root: string, path: string, context: CacheContext): Promise<PayloadItem[]> {
  const items: PayloadItem[] = [];
  for (const name of (await readdir(within(root, path))).sort()) items.push(...await scanItem(root, path === '.' ? name : `${path}/${name}`, context));
  return items;
}
async function payloadDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!(await lstat(path)).isDirectory()) throw new Error('A payload parent is a symlink or is not a directory.');
}
async function payloadParents(root: string, path: string): Promise<void> {
  const parts = relative(root, dirname(within(root, path))).split('/').filter(Boolean);
  let parent = root;
  for (const part of parts) { parent = join(parent, part); await payloadDirectory(parent); }
}
async function copyItems(source: string, target: string, entries: PayloadItem[], context: CacheContext): Promise<void> {
  for (const item of entries) {
    checkCacheContext(context);
    const destination = within(target, item.path); await payloadParents(target, item.path);
    if (item.kind === 'directory') await payloadDirectory(destination);
    else if (item.kind === 'symlink') { safeLink(target, item.path, item.target); await symlink(item.target, destination); }
    else await copyFile(within(source, item.path), destination, constants.COPYFILE_EXCL);
  }
}
async function syncPath(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
async function syncPayload(root: string, entries: PayloadItem[]): Promise<void> {
  for (const item of [...entries].reverse()) if (item.kind !== 'symlink') await syncPath(within(root, item.path));
  await syncPath(root);
}
async function readReady(entry: CacheEntry, context: CacheContext): Promise<z.infer<typeof Ready>> {
  const path = join(entry.path, 'READY.json'), stat = await lstat(path);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('Invalid cache receipt.');
  const ready = Ready.parse(JSON.parse(await readFile(path, 'utf8')));
  if (ready.key !== entry.key || ready.inputDigest !== entry.inputDigest) throw new Error('Cache input fingerprints differ.');
  const actual = await scanChildren(join(entry.path, 'payload'), '.', context);
  if (canonical(actual) !== canonical(ready.entries)) throw new Error('Cache payload checksum mismatch.');
  return ready;
}
async function cached(entry: CacheEntry, context: CacheContext): Promise<boolean> {
  try { await lstat(entry.path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  try { await readReady(entry, context); return true; }
  catch {
    checkCacheContext(context);
    await rename(entry.path, join(dirname(entry.path), `.corrupt-${entry.key}-${randomUUID()}`));
    context.log('A corrupt preparation cache was quarantined.');
    return false;
  }
}
async function rootsFor(root: string, paths: string[]): Promise<string[]> {
  const expanded = paths.includes('.') ? await readdir(root) : paths;
  const unique = [...new Set(expanded.map(path => relative(root, within(root, path))))].sort();
  return unique.filter(path => !unique.some(parent => parent !== path && path.startsWith(`${parent}/`)));
}
function importMatches(expected: PayloadItem[], copied: PayloadItem[]): boolean {
  const actual = new Map(copied.map(item => [item.path, canonical(item)]));
  return expected.every(item => actual.get(item.path) === canonical(item));
}
async function publish(entry: CacheEntry, context: CacheContext, build: CacheBuild): Promise<void> {
  const staging = await mkdtemp(join(dirname(entry.path), '.staging-'));
  try {
    const source = await build(), roots = await rootsFor(source.root, source.paths), payload = join(staging, 'payload');
    const entries: PayloadItem[] = [];
    for (const path of roots) entries.push(...await scanItem(source.root, path, context));
    await mkdir(payload, { mode: 0o700 }); await copyItems(source.root, payload, entries, context);
    const copied = await scanChildren(payload, '.', context);
    if (!importMatches(entries, copied)) throw new Error('A preparation payload changed during import.');
    await syncPayload(payload, copied);
    const ready = await open(join(staging, 'READY.json'), 'wx', 0o600);
    try { await ready.writeFile(JSON.stringify({ format: 1, key: entry.key, inputDigest: entry.inputDigest, roots, entries: copied })); await ready.sync(); }
    finally { await ready.close(); }
    await syncPath(staging); checkCacheContext(context);
    await rename(staging, entry.path); await syncPath(dirname(entry.path));
  } finally { await rm(staging, { recursive: true, force: true }); }
}
export async function prepareCache(directory: string, key: string, inputDigest: string, context: CacheContext, build: CacheBuild): Promise<CacheEntry> {
  EnvironmentDigest.parse(key); EnvironmentDigest.parse(inputDigest);
  await privateCacheRoot(directory); const locks = await privateCacheRoot(join(directory, '.locks'));
  return withCacheLock(join(locks, key), context, async () => {
    const entry = { path: join(directory, key), key, inputDigest, hit: false };
    if (await cached(entry, context)) return { ...entry, hit: true };
    await publish(entry, context, build); return entry;
  });
}
export async function restoreCache(entry: CacheEntry, destination: string, context: CacheContext): Promise<void> {
  const ready = await readReady(entry, context);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const path of ready.roots) {
    // Check parents before removing an old private copy. A job must never redirect a restore.
    const target = within(destination, path); await payloadParents(destination, path);
    await noLinkedParents(destination, path); await rm(target, { recursive: true, force: true });
  }
  await copyItems(join(entry.path, 'payload'), destination, ready.entries, context);
}
