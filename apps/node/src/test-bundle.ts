import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { constants, createZstdCompress, createZstdDecompress } from 'node:zlib';
import { CacheReady, checkCacheContext, readReady, safeLink, storedMode, storeStaged, within, type CacheContext, type CacheEntry, type PayloadItem } from './test-cache.js';

/* A stored tree as one file another machine can take: what its READY says, a line of JSON, then the bytes of its files in
   that order, all of it compressed. A machine reads it knowing nothing but its digest, so whatever the line asks for is
   checked before anything is made of it. */
const MAX_LINE = 64 * 1024 * 1024;
const MAX_BYTES = 32 * 1024 ** 3;
const LEVEL = 3;

export const bundleName = (directory: string): string => join(directory, `.bundle-${randomUUID()}`);

async function* bundleBytes(entry: CacheEntry, ready: CacheReady, context: CacheContext): AsyncGenerator<Buffer> {
  yield Buffer.from(`${JSON.stringify(ready)}\n`);
  for (const item of ready.entries) {
    if (item.kind !== 'file') continue;
    checkCacheContext(context);
    yield* createReadStream(within(join(entry.path, 'payload'), item.path));
  }
}

export async function packBundle(entry: CacheEntry, file: string, context: CacheContext): Promise<{ digest: string; size: number }> {
  const ready = entry.ready ?? await readReady(entry, context), hash = createHash('sha256');
  let size = 0;
  const counted = new Transform({ transform(chunk: Buffer, _encoding, done) { hash.update(chunk); size += chunk.length; done(null, chunk); } });
  await pipeline(Readable.from(bundleBytes(entry, ready, context)), createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: LEVEL } }), counted, createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal: context.signal });
  return { digest: hash.digest('hex'), size };
}

/* Takes exactly as many bytes as asked from a stream of chunks. */
class Bytes {
  private held: Buffer = Buffer.alloc(0);
  constructor(private readonly source: AsyncIterator<Buffer>) {}
  private async more(): Promise<boolean> {
    const next = await this.source.next();
    if (next.done) return false;
    this.held = this.held.length ? Buffer.concat([this.held, next.value]) : next.value;
    return true;
  }
  async line(): Promise<string> {
    while (!this.held.includes(10)) {
      if (this.held.length > MAX_LINE || !await this.more()) throw new Error('A bundle has no readable header.');
    }
    const end = this.held.indexOf(10), line = this.held.toString('utf8', 0, end);
    this.held = this.held.subarray(end + 1);
    return line;
  }
  async *take(size: number): AsyncGenerator<Buffer> {
    for (let left = size; left > 0;) {
      if (!this.held.length && !await this.more()) throw new Error('A bundle ended early.');
      const part = this.held.subarray(0, left);
      this.held = this.held.subarray(part.length);
      left -= part.length;
      yield part;
    }
  }
  async ended(): Promise<boolean> { return !this.held.length && !await this.more(); }
}

/* What makes the tree safe to lay out in order: every path comes once, right after a folder that is really a folder, so
   nothing ever goes through a link, and no link leads out. */
function checkEntries(ready: CacheReady, root: string): void {
  const folders = new Set(['.']), seen = new Set<string>();
  let bytes = 0;
  for (const item of ready.entries) {
    const parent = dirname(item.path);
    if (seen.has(item.path) || !folders.has(parent)) throw new Error(`A bundle lays out ${item.path} out of order.`);
    seen.add(item.path);
    if (item.kind === 'directory') folders.add(item.path);
    if (item.kind === 'symlink') safeLink(root, item.path, item.target);
    if (item.kind === 'file') bytes += item.size;
  }
  if (bytes > MAX_BYTES) throw new Error('A bundle is too large.');
}

async function unpackFile(bytes: Bytes, payload: string, item: Extract<PayloadItem, { kind: 'file' }>): Promise<void> {
  const hash = createHash('sha256'), out = await open(within(payload, item.path), 'wx', 0o600);
  try {
    for await (const part of bytes.take(item.size)) { hash.update(part); await out.writeFile(part); }
    if (hash.digest('hex') !== item.digest) throw new Error(`A bundle holds other bytes than it says for ${item.path}.`);
    await out.chmod(storedMode(item.mode));
  } finally { await out.close(); }
}

async function unpackItem(bytes: Bytes, payload: string, item: PayloadItem): Promise<void> {
  if (item.kind === 'directory') await mkdir(within(payload, item.path), { mode: 0o700 });
  else if (item.kind === 'symlink') await symlink(item.target, within(payload, item.path));
  else await unpackFile(bytes, payload, item);
}

export async function unpackBundle(file: string, entry: Pick<CacheEntry, 'path' | 'key' | 'inputDigest'>, context: CacheContext): Promise<CacheReady> {
  const staging = await mkdtemp(join(dirname(entry.path), '.staging-')), source = createReadStream(file), stream = source.pipe(createZstdDecompress());
  source.once('error', error => stream.destroy(error));
  try {
    const bytes = new Bytes(stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>), ready = CacheReady.parse(JSON.parse(await bytes.line()));
    if (ready.key !== entry.key || ready.inputDigest !== entry.inputDigest) throw new Error('A bundle is of another version.');
    const payload = join(staging, 'payload');
    checkEntries(ready, payload);
    await mkdir(payload, { mode: 0o700 });
    for (const item of ready.entries) { checkCacheContext(context); await unpackItem(bytes, payload, item); }
    if (!await bytes.ended()) throw new Error('A bundle holds more than it says.');
    return await storeStaged(entry, staging, ready, context);
  } finally { source.destroy(); stream.destroy(); await rm(staging, { recursive: true, force: true }); }
}
