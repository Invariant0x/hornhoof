import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, createReadStream, type Stats } from 'node:fs';
import { chmod, chown, copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { EnvironmentDigest, RepositoryPath } from '@hornhoof/protocol';
import { z } from 'zod';
import type { JobUser } from './isolation.js';
import { checkDeadline } from './test-context.js';

const lockDescriptors = new AsyncLocalStorage<number[]>();
export const cacheLockDescriptors = (): number[] => lockDescriptors.getStore() ?? [];

export type CacheContext = { cacheRoot: string; deadline: number; signal: AbortSignal; log: (line: string) => void };

export function checkCacheContext(context: CacheContext): void {
  checkDeadline(context, 'The preparation deadline expired.');
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
  z.strictObject({ path: RepositoryPath, kind: z.literal('file'), digest: EnvironmentDigest, mode: z.number().int().min(0).max(0o777), size: z.number().int().nonnegative() }),
  z.strictObject({ path: RepositoryPath, kind: z.literal('symlink'), target: z.string() }),
]);
export type PayloadItem = z.infer<typeof PayloadItem>;
export const CacheReady = z.strictObject({ format: z.literal(2), key: EnvironmentDigest, inputDigest: EnvironmentDigest, roots: z.array(RepositoryPath), entries: z.array(PayloadItem).max(500_000) });
export type CacheReady = z.infer<typeof CacheReady>;
/* hit: nothing was built for it here. fetched: another machine built it. */
export type CacheEntry = { path: string; key: string; inputDigest: string; hit: boolean; fetched?: boolean; ready?: CacheReady };
type CacheBuild = () => Promise<{ root: string; paths: string[] }>;
/* Decides where a missing tree comes from, and returns the entry once it is stored: publish builds it on this machine. */
export type CacheShare = (entry: CacheEntry, context: CacheContext, publish: () => Promise<CacheReady>) => Promise<CacheEntry>;
/* link: the part gets read-only links to the one stored file instead of copies. owner: who gets what is restored. */
export type RestoreOptions = { link?: boolean; owner?: JobUser; except?: string };
/* Stored files nobody may write. A part that holds a link to one can read it and replace it, and never change it. */
export const storedMode = (mode: number): number => (mode & 0o111 ? 0o555 : 0o444);
const BATCH = 256;

export function within(root: string, path: string): string {
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
export function safeLink(root: string, path: string, target: string): void {
  if (isAbsolute(target) || target.includes('\\') || relative(root, resolve(dirname(within(root, path)), target)).startsWith('..')) throw new Error('A payload symlink escapes the repository.');
}
export async function fileDigest(path: string, context: CacheContext): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) { checkCacheContext(context); hash.update(chunk); }
  return hash.digest('hex');
}
async function scanItem(root: string, path: string, context: CacheContext, links?: ReadonlySet<string>): Promise<PayloadItem[]> {
  checkCacheContext(context);
  const full = await noLinkedParents(root, path), stat = await lstat(full, { bigint: true });
  if (stat.isSymbolicLink()) {
    const target = await readlink(full); safeLink(root, path, target);
    return [{ path, kind: 'symlink', target }];
  }
  if (stat.isDirectory()) return [{ path, kind: 'directory' }, ...await scanChildren(root, path, context, links)];
  if (!stat.isFile() || (stat.nlink !== 1n && !links?.has(inodeKey(stat)))) throw new Error('Cache payloads cannot contain external hardlinks.');
  return [{ path, kind: 'file', mode: Number(stat.mode & 0o777n), size: Number(stat.size), digest: await fileDigest(full, context) }];
}
async function scanChildren(root: string, path: string, context: CacheContext, links?: ReadonlySet<string>): Promise<PayloadItem[]> {
  const items: PayloadItem[] = [];
  for (const name of (await readdir(within(root, path))).sort()) items.push(...await scanItem(root, path === '.' ? name : `${path}/${name}`, context, links));
  return items;
}
const inodeKey = (stat: { dev: bigint; ino: bigint }): string => `${stat.dev}:${stat.ino}`;
type SourceLinks = Map<string, { count: bigint; total: bigint }>;
async function collectSourceLinks(root: string, path: string, context: CacheContext, found: SourceLinks): Promise<void> {
  checkCacheContext(context);
  const full = await noLinkedParents(root, path), stat = await lstat(full, { bigint: true });
  if (stat.isDirectory()) {
    for (const name of await readdir(full)) await collectSourceLinks(root, `${path}/${name}`, context, found);
  } else if (stat.isFile()) {
    const key = inodeKey(stat), before = found.get(key);
    found.set(key, { count: (before?.count ?? 0n) + 1n, total: stat.nlink });
  }
}
async function sourceLinks(root: string, paths: string[], context: CacheContext): Promise<ReadonlySet<string>> {
  const found: SourceLinks = new Map();
  for (const path of paths) await collectSourceLinks(root, path, context, found);
  for (const value of found.values()) if (value.count !== value.total) throw new Error('Cache payloads cannot contain external hardlinks.');
  return new Set(found.keys());
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
export async function syncPath(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
/* Everything written so far reaches the disk at once: one call, where syncing each file of a dependency tree takes minutes. */
export function syncFileSystem(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('sync', ['--file-system', path], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
    child.once('error', reject);
    child.once('close', code => { if (code === 0) resolve(); else reject(new Error('The prepared files could not reach the disk.')); });
  });
}
export async function inBatches<T>(items: T[], context: CacheContext, run: (item: T) => Promise<void>): Promise<void> {
  for (let at = 0; at < items.length; at += BATCH) {
    checkCacheContext(context);
    await Promise.all(items.slice(at, at + BATCH).map(run));
  }
}
/* A stored tree was hashed when it came here. After that only its shape is read: the same paths and sizes, and nothing
   written after its READY. So a hit costs a walk over the tree, not a hash of all of it. */
function sameShape(item: PayloadItem | undefined, stat: Stats, writtenAt: number): boolean {
  if (!item || stat.mtimeMs > writtenAt) return false;
  if (item.kind === 'file') return stat.isFile() && stat.size === item.size;
  return item.kind === 'directory' ? stat.isDirectory() : stat.isSymbolicLink();
}
async function shapeOf(root: string, items: Map<string, PayloadItem>, writtenAt: number, context: CacheContext, parent = ''): Promise<number> {
  checkCacheContext(context);
  const counts = await Promise.all((await readdir(join(root, parent))).map(async name => {
    const path = parent ? `${parent}/${name}` : name, stat = await lstat(join(root, path)), item = items.get(path);
    if (!sameShape(item, stat, writtenAt)) throw new Error(`The stored file ${path} changed.`);
    if (item?.kind === 'symlink' && await readlink(join(root, path)) !== item.target) throw new Error(`The stored link ${path} changed.`);
    return 1 + (stat.isDirectory() ? await shapeOf(root, items, writtenAt, context, path) : 0);
  }));
  return counts.reduce((sum, count) => sum + count, 0);
}
export async function readReady(entry: Pick<CacheEntry, 'path' | 'key' | 'inputDigest'>, context: CacheContext): Promise<CacheReady> {
  const path = join(entry.path, 'READY.json'), stat = await lstat(path);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('Invalid cache receipt.');
  const ready = CacheReady.parse(JSON.parse(await readFile(path, 'utf8')));
  if (ready.key !== entry.key || ready.inputDigest !== entry.inputDigest) throw new Error('Cache input fingerprints differ.');
  const found = await shapeOf(join(entry.path, 'payload'), new Map(ready.entries.map(item => [item.path, item])), stat.mtimeMs, context);
  if (found !== ready.entries.length) throw new Error('Cache payload checksum mismatch.');
  return ready;
}
async function cached(entry: CacheEntry, context: CacheContext): Promise<CacheReady | null> {
  try { await lstat(entry.path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try { return await readReady(entry, context); }
  catch {
    checkCacheContext(context);
    await rename(entry.path, join(dirname(entry.path), `.corrupt-${entry.key}-${randomUUID()}`));
    context.log('A corrupt preparation cache was quarantined.');
    return null;
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
/* The last step of storing a tree: what is in staging reaches the disk, READY goes beside it, and then it all moves into
   place at once. A crash before that leaves no entry. */
export async function storeStaged(entry: Pick<CacheEntry, 'path' | 'key' | 'inputDigest'>, staging: string, ready: CacheReady, context: CacheContext): Promise<CacheReady> {
  await syncFileSystem(staging);
  const file = await open(join(staging, 'READY.json'), 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(ready)); await file.sync(); }
  finally { await file.close(); }
  await syncPath(staging); checkCacheContext(context);
  await rename(staging, entry.path); await syncPath(dirname(entry.path));
  return ready;
}
async function publish(entry: CacheEntry, context: CacheContext, build: CacheBuild): Promise<CacheReady> {
  const staging = await mkdtemp(join(dirname(entry.path), '.staging-'));
  try {
    const source = await build(), roots = await rootsFor(source.root, source.paths), payload = join(staging, 'payload');
    const links = await sourceLinks(source.root, roots, context), entries: PayloadItem[] = [];
    for (const path of roots) entries.push(...await scanItem(source.root, path, context, links));
    await mkdir(payload, { mode: 0o700 }); await copyItems(source.root, payload, entries, context);
    const copied = await scanChildren(payload, '.', context);
    if (!importMatches(entries, copied)) throw new Error('A preparation payload changed during import.');
    await inBatches(copied, context, async item => { if (item.kind === 'file') await chmod(within(payload, item.path), storedMode(item.mode)); });
    return await storeStaged(entry, staging, { format: 2, key: entry.key, inputDigest: entry.inputDigest, roots, entries: copied }, context);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
export async function prepareCache(directory: string, key: string, inputDigest: string, context: CacheContext, build: CacheBuild, share?: CacheShare): Promise<CacheEntry> {
  EnvironmentDigest.parse(key); EnvironmentDigest.parse(inputDigest);
  await privateCacheRoot(directory); const locks = await privateCacheRoot(join(directory, '.locks'));
  return withCacheLock(join(locks, key), context, async () => {
    const entry: CacheEntry = { path: join(directory, key), key, inputDigest, hit: false };
    const ready = await cached(entry, context), store = () => publish(entry, context, build);
    const prepared = ready ? { ...entry, hit: true, ready } : share ? await share(entry, context, store) : { ...entry, ready: await store() };
    await markUsed(prepared);
    return prepared;
  });
}
async function restoredLinks(root: string, entries: PayloadItem[]): Promise<void> {
  const checkout = await realpath(root);
  for (const item of entries) {
    if (item.kind !== 'symlink') continue;
    const end = await realpath(within(root, item.path)).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return checkout; throw error; });
    const path = relative(checkout, end);
    if (path === '..' || path.startsWith('../')) throw new Error('A restored workspace symlink escapes its checkout.');
  }
}
async function restoredFolder(path: string, owner: JobUser | undefined): Promise<void> {
  await payloadDirectory(path);
  if (owner) await chown(path, owner.uid, owner.gid);
}
async function restoredParents(root: string, path: string, owner: JobUser | undefined): Promise<void> {
  let parent = root;
  for (const part of relative(root, dirname(within(root, path))).split('/').filter(Boolean)) { parent = join(parent, part); await restoredFolder(parent, owner); }
}
async function copiedFile(from: string, to: string, item: Extract<PayloadItem, { kind: 'file' }>, owner: JobUser | undefined): Promise<void> {
  await copyFile(from, to, constants.COPYFILE_EXCL);
  await chmod(to, item.mode);
  if (owner) await chown(to, owner.uid, owner.gid);
}
/* The same disk gives a link; anywhere else the part gets a copy of its own. */
async function linkedFile(from: string, to: string, item: Extract<PayloadItem, { kind: 'file' }>, owner: JobUser | undefined): Promise<void> {
  try { await link(from, to); }
  catch (error) {
    if (!['EXDEV', 'EPERM', 'EMLINK'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    await copiedFile(from, to, item, owner);
  }
}
async function restoredItem(source: string, target: string, item: PayloadItem, options: RestoreOptions): Promise<void> {
  const to = within(target, item.path);
  if (item.kind === 'symlink') { safeLink(target, item.path, item.target); await symlink(item.target, to); return; }
  if (item.kind === 'directory') return;
  await (options.link ? linkedFile : copiedFile)(within(source, item.path), to, item, options.owner);
}
export async function restoreCache(entry: CacheEntry, destination: string, context: CacheContext, options: RestoreOptions = {}): Promise<void> {
  const ready = entry.ready ?? await readReady(entry, context), { except } = options;
  const wanted = (path: string) => except === undefined || (path !== except && !path.startsWith(`${except}/`));
  const items = ready.entries.filter(item => wanted(item.path));
  await mkdir(destination, { recursive: true, mode: 0o700 });
  if (!(await lstat(destination)).isDirectory()) throw new Error('The checkout root is a symlink or is not a directory.');
  for (const path of ready.roots.filter(wanted)) {
    // Check parents before removing an old private copy. A job must never redirect a restore.
    const target = within(destination, path); await restoredParents(destination, path, options.owner);
    await noLinkedParents(destination, path); await rm(target, { recursive: true, force: true });
  }
  for (const item of items) if (item.kind === 'directory') await restoredFolder(within(destination, item.path), options.owner);
  await inBatches(items, context, item => restoredItem(join(entry.path, 'payload'), destination, item, options));
  await restoredLinks(destination, items);
}

/* Machines keep what they are likely to need again: the last ones used, for as long as they stay in use. A part takes a tree
   right after it is prepared, and a part lasts at most two hours, so nothing used more recently than that goes. */
const LAST_USED = 'USED';
const IN_USE_MS = 3 * 60 * 60_000;
const IDLE_MS = 7 * 24 * 60 * 60_000;
const LEFT_BEHIND_MS = 24 * 60 * 60_000;
const markUsed = (entry: Pick<CacheEntry, 'path'>) => writeFile(join(entry.path, LAST_USED), '');
const changedAt = (path: string) => lstat(path).then(stat => stat.mtimeMs, () => 0);
async function usedAt(path: string): Promise<number> {
  return await changedAt(join(path, LAST_USED)) || changedAt(join(path, 'READY.json'));
}
export async function pruneCache(directory: string, keep: number, context: CacheContext, now = Date.now()): Promise<void> {
  const names = await readdir(directory).catch(() => [] as string[]);
  for (const name of names.filter(name => /^\.(?:staging|bundle|corrupt)-/.test(name))) {
    if (now - await changedAt(join(directory, name)) > LEFT_BEHIND_MS) await rm(join(directory, name), { recursive: true, force: true });
  }
  const stored = await Promise.all(names.filter(name => /^[a-f0-9]{64}$/.test(name)).map(async name => ({ name, used: await usedAt(join(directory, name)) })));
  for (const [index, { name, used }] of stored.sort((a, b) => b.used - a.used).entries()) {
    if (now - used < IN_USE_MS || (index < keep && now - used < IDLE_MS)) continue;
    await withCacheLock(join(directory, '.locks', name), context, () => rm(join(directory, name), { recursive: true, force: true }));
  }
}
