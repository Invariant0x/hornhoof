import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { constants, createReadStream } from 'node:fs';
import { chmod, chown, copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { EnvironmentDigest, RepositoryPath } from '@hornhoof/protocol';
import { z } from 'zod';
import type { JobUser } from './isolation.js';
import { checkDeadline, deadlineDelay, deadlineSignal, type DeadlineContext } from './test-context.js';

const lockDescriptors = new AsyncLocalStorage<number[]>();
export const cacheLockDescriptors = (): number[] => lockDescriptors.getStore() ?? [];

export type CacheContext = { cacheRoot: string; deadline: number; signal: AbortSignal; log: (line: string) => void };

export function checkCacheContext(context: DeadlineContext): void {
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
    const signal = deadlineSignal(context.signal, context.deadline);
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

const ESCAPE = 'A payload path escapes its permitted root.';
const PayloadPath = RepositoryPath.refine(path => !path.split('/').includes('.git'), ESCAPE);
const PayloadItem = z.discriminatedUnion('kind', [
  z.strictObject({ path: PayloadPath, kind: z.literal('directory') }),
  z.strictObject({ path: PayloadPath, kind: z.literal('file'), digest: EnvironmentDigest, mode: z.number().int().min(0).max(0o777), size: z.number().int().nonnegative() }),
  z.strictObject({ path: PayloadPath, kind: z.literal('symlink'), target: z.string() }),
]);
export type PayloadItem = z.infer<typeof PayloadItem>;
export const CacheReady = z.strictObject({ format: z.literal(2), key: EnvironmentDigest, inputDigest: EnvironmentDigest, roots: z.array(RepositoryPath), entries: z.array(PayloadItem).max(500_000) });
export type CacheReady = z.infer<typeof CacheReady>;
/* hit: nothing was built for it here. fetched: another machine built it. */
export type CacheEntry = { path: string; key: string; inputDigest: string; hit: boolean; fetched?: boolean; ready?: CacheReady };
type CacheBuild = () => Promise<{ root: string; paths: string[] }>;
/* Decides where a missing tree comes from, and returns the entry once it is stored: publish builds it on this machine. */
export type CacheShare = (entry: CacheEntry, context: CacheContext, publish: () => Promise<CacheReady>) => Promise<CacheEntry>;
/* link: the part gets read-only links to the one stored file instead of copies, for all of it or for these paths. owner: who
   gets what is restored. */
type RestoreOptions = { link?: boolean | string[]; owner?: JobUser; except?: string };
/* Stored files nobody may write. A part that holds a link to one can read it and replace it, and never change it. */
export const storedMode = (mode: number): number => (mode & 0o111 ? 0o555 : 0o444);
/* The one time every stored file carries, on any machine. A tree that was moved here has no times of its own worth reading, and
   tools that compare times read equal ones as up to date, in whatever order the files came. As many digits as today's times,
   which are compared as text; older than any source a part checks out, so nothing it holds passes for newer than that. */
export const STORED_AT = new Date(1_000_000_000_000);
const atStoredTime = (path: string) => utimes(path, STORED_AT, STORED_AT);
const BATCH = 256;

export function within(root: string, path: string): string {
  RepositoryPath.parse(path);
  const full = resolve(root, path);
  if (relative(root, full).startsWith('..') || path.split('/').includes('.git')) throw new Error(ESCAPE);
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
export async function fileDigest(path: string, context: DeadlineContext): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) { checkCacheContext(context); hash.update(chunk); }
  return hash.digest('hex');
}
/* One process lists a whole tree, as asking for each of a dependency tree's files from here takes most of what storing or
   reusing it costs. */
type Listed = { full: string; kind: string; size: number; mode: number; links: number; inode: string; time: string; target: string };
const LISTED = /^(\S) (\d+) ([0-7]+) (\d+) (\S+) (\S+) ([\s\S]*)$/;
const LISTING_BYTES = 1024 ** 3;
function listedItems(output: string): Listed[] {
  const fields = output.split('\0'), found: Listed[] = [];
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const line = LISTED.exec(fields[at]!);
    if (!line) throw new Error('A tree could not be listed.');
    found.push({ full: line[7]!, kind: line[1]!, size: Number(line[2]), mode: parseInt(line[3]!, 8) & 0o777, links: Number(line[4]), inode: line[5]!, time: line[6]!, target: fields[at + 1]! });
  }
  return found;
}
function listTree(starts: string[], context: CacheContext): Promise<Listed[]> {
  checkCacheContext(context);
  return new Promise((resolve, reject) => {
    execFile('find', [...starts, '-printf', '%y %s %m %n %D:%i %T@ %p\\0%l\\0'], { env: { PATH: '/usr/bin:/bin' }, maxBuffer: LISTING_BYTES, signal: context.signal, timeout: deadlineDelay(context.deadline) }, (error, output) => {
      if (error) reject(error);
      else { try { resolve(listedItems(output)); } catch (failure) { reject(failure as Error); } }
    });
  });
}
async function scanned(root: string, found: Listed, links: number, context: CacheContext): Promise<PayloadItem> {
  const path = relative(root, found.full); within(root, path);
  if (found.kind === 'l') { safeLink(root, path, found.target); return { path, kind: 'symlink', target: found.target }; }
  if (found.kind === 'd') return { path, kind: 'directory' };
  if (found.kind !== 'f' || found.links !== links) throw new Error('Cache payloads cannot contain external hardlinks.');
  return { path, kind: 'file', mode: found.mode, size: found.size, digest: await fileDigest(found.full, context) };
}
/* A tree as it is stored, each file hashed, each folder before what it holds. ownLinks: a file may have other names as long
   as they all lie in this tree, as a copy parts them; a tree that is the copy has none. */
async function scanTree(root: string, starts: string[], context: CacheContext, ownLinks: boolean): Promise<PayloadItem[]> {
  const found = (await listTree(starts.map(path => join(root, path)), context)).filter(item => item.full !== root), names = new Map<string, number>(), items: PayloadItem[] = [];
  for (const item of found) if (item.kind === 'f') names.set(item.inode, (names.get(item.inode) ?? 0) + 1);
  await inBatches(found, context, async item => { items.push(await scanned(root, item, ownLinks ? names.get(item.inode) ?? 1 : 1, context)); });
  return items.sort((a, b) => (a.path < b.path ? -1 : 1));
}
async function scanRoots(root: string, paths: string[], context: CacheContext): Promise<PayloadItem[]> {
  for (const path of paths) { await noLinkedParents(root, path); await lstat(within(root, path)); }
  return paths.length ? scanTree(root, paths, context, true) : [];
}
async function payloadDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!(await lstat(path)).isDirectory()) throw new Error('A payload parent is a symlink or is not a directory.');
}
async function madeFolder(target: string, path: string, made: Set<string>): Promise<void> {
  if (path === '.' || made.has(path)) return;
  await madeFolder(target, dirname(path), made);
  await payloadDirectory(join(target, path)); made.add(path);
}
async function copyItems(source: string, target: string, entries: PayloadItem[], context: CacheContext): Promise<void> {
  const made = new Set<string>();
  for (const item of entries) await madeFolder(target, item.kind === 'directory' ? item.path : dirname(item.path), made);
  await inBatches(entries, context, async item => {
    if (item.kind === 'symlink') { safeLink(target, item.path, item.target); await symlink(item.target, join(target, item.path)); }
    else if (item.kind === 'file') await copyFile(join(source, item.path), join(target, item.path), constants.COPYFILE_EXCL);
  });
}
async function syncPath(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await file.sync(); } finally { await file.close(); }
}
/* Everything written so far reaches the disk at once: one call, where syncing each file of a dependency tree takes minutes. */
function syncFileSystem(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('sync', ['--file-system', path], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
    child.once('error', reject);
    child.once('close', code => { if (code === 0) resolve(); else reject(new Error('The prepared files could not reach the disk.')); });
  });
}
async function inBatches<T>(items: T[], context: CacheContext, run: (item: T) => Promise<void>): Promise<void> {
  for (let at = 0; at < items.length; at += BATCH) {
    checkCacheContext(context);
    await Promise.all(items.slice(at, at + BATCH).map(run));
  }
}
/* A stored tree was hashed when it came here. After that only its shape is read: the same paths and sizes, and nothing
   written after its READY. So a hit costs a walk over the tree, not a hash of all of it. */
function sameShape(item: PayloadItem | undefined, found: Listed, writtenAt: string): boolean {
  if (!item || found.time > writtenAt) return false;
  if (item.kind === 'file') return found.kind === 'f' && found.size === item.size;
  return item.kind === 'directory' ? found.kind === 'd' : found.kind === 'l' && found.target === item.target;
}
export async function readReady(entry: Pick<CacheEntry, 'path' | 'key' | 'inputDigest'>, context: CacheContext): Promise<CacheReady> {
  const path = join(entry.path, 'READY.json'), stat = await lstat(path), payload = join(entry.path, 'payload');
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('Invalid cache receipt.');
  const ready = CacheReady.parse(JSON.parse(await readFile(path, 'utf8')));
  if (ready.key !== entry.key || ready.inputDigest !== entry.inputDigest) throw new Error('Cache input fingerprints differ.');
  const [written, , ...found] = await listTree([path, payload], context), items = new Map(ready.entries.map(item => [item.path, item]));
  for (const each of found) if (!sameShape(items.get(each.full.slice(payload.length + 1)), each, written!.time)) throw new Error(`The stored file ${each.full} changed.`);
  if (found.length !== ready.entries.length) throw new Error('Cache payload checksum mismatch.');
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
/* A copy keeps the owner of what it was copied from, and whoever built a tree runs again with it linked in: its owner could rewrite
   it for every later run. So a stored file is the node's, as one that came from another machine is. */
async function storedFile(path: string, mode: number): Promise<void> {
  await chown(path, process.getuid!(), process.getgid!());
  await atStoredTime(path);
  await chmod(path, storedMode(mode));
}
async function publish(entry: CacheEntry, context: CacheContext, build: CacheBuild): Promise<CacheReady> {
  const staging = await mkdtemp(join(dirname(entry.path), '.staging-'));
  try {
    const source = await build(), roots = await rootsFor(source.root, source.paths), payload = join(staging, 'payload');
    const entries = await scanRoots(source.root, roots, context);
    await mkdir(payload, { mode: 0o700 }); await copyItems(source.root, payload, entries, context);
    const copied = await scanTree(payload, ['.'], context, false);
    if (!importMatches(entries, copied)) throw new Error('A preparation payload changed during import.');
    await inBatches(copied, context, item => (item.kind === 'file' ? storedFile(join(payload, item.path), item.mode) : Promise.resolve()));
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
  const full = within(root, path);
  if (full === resolve(root)) throw new Error('A stored root is the checkout itself.');
  let parent = root;
  for (const part of relative(root, dirname(full)).split('/').filter(Boolean)) { parent = join(parent, part); await restoredFolder(parent, owner); }
}
async function copiedFile(from: string, to: string, item: Extract<PayloadItem, { kind: 'file' }>, owner: JobUser | undefined): Promise<void> {
  await copyFile(from, to, constants.COPYFILE_EXCL);
  await atStoredTime(to);
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
const linkedBy = (link: RestoreOptions['link'], path: string): boolean => (Array.isArray(link) ? link.some(root => path === root || path.startsWith(`${root}/`)) : !!link);
async function restoredItem(source: string, target: string, item: PayloadItem, options: RestoreOptions): Promise<void> {
  const to = join(target, item.path);
  if (item.kind === 'symlink') { safeLink(target, item.path, item.target); await symlink(item.target, to); return; }
  if (item.kind === 'directory') return;
  await (linkedBy(options.link, item.path) ? linkedFile : copiedFile)(join(source, item.path), to, item, options.owner);
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
  for (const item of items) if (item.kind === 'directory') await restoredFolder(join(destination, item.path), options.owner);
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
