import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, createReadStream, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { link, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { checkEnds, lastChunkOf, openSealed, saltOf, SEAL_HEAD, SealRefused, seal } from './seal.js';

/* A file's name in the store: the sha256 of its plain bytes, and nothing else. */
export const SHA256 = /^[0-9a-f]{64}$/;
/* What the store knows of a file in it: its plain hash and size, and the hash and size of the sealed bytes it keeps. */
export type StoredFile = { sha256: string; size: number; sealedSha256: string; sealedSize: number; salt: string };
/* What a put may be at most, in plain bytes, and what it says when it is more. */
export type StoreRoom = { bytes: number; full: () => Error };
/* A transfer that moves no byte for this long is cut. */
export const IDLE_MS = 30_000;
/* A temporary file no take runs for, left by a machine that stopped, goes after this long. */
const PART_LIFE_MS = 3_600_000;

export class StoreRefused extends Error {
  constructor(readonly reason: 'name' | 'size' | 'hash' | 'idle' | 'missing') {
    super(
      {
        name: 'This is no file name of the store.',
        size: 'The file that came is not as long as it was said to be.',
        hash: 'The file that came is not the one it was said to be.',
        idle: 'The file stopped coming.',
        missing: 'The store has no such file.',
      }[reason],
    );
  }
}

const checkName = (sha256: string): string => {
  if (!SHA256.test(sha256)) throw new StoreRefused('name');
  return sha256;
};

type Count = Transform & { bytes: number; digest: () => string };

/* Counts and hashes what passes through. */
function counter(): Count {
  const hash = createHash('sha256');
  const out = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      out.bytes += chunk.length;
      done(null, chunk);
    },
  }) as Count;
  out.bytes = 0;
  let digest: string | null = null;
  out.digest = () => (digest ??= hash.digest('hex'));
  return out;
}

/* Cuts a stream that moves no byte for this long, and one that passes its room. */
function guard(room: StoreRoom | undefined, idleMs: number): Transform {
  let timer: NodeJS.Timeout | undefined;
  let bytes = 0;
  const out = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      arm();
      bytes += chunk.length;
      if (room && bytes > room.bytes) return done(room.full());
      done(null, chunk);
    },
    flush(done) {
      clearTimeout(timer);
      done();
    },
    destroy(err, done) {
      clearTimeout(timer);
      done(err);
    },
  });
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => out.destroy(new StoreRefused('idle')), idleMs);
    timer.unref();
  };
  arm();
  return out;
}

/* A file of the store opened to read; one gone since it was seen is missing. */
function openOrMissing(path: string): number {
  try {
    return openSync(path, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new StoreRefused('missing');
    throw err;
  }
}

/* The sealed file opens under its name: its head and its last chunk, read before the rest. */
function checkOpens(fd: number, key: Buffer, sha256: string): void {
  const size = fstatSync(fd).size;
  const last = lastChunkOf(size);
  if (!last) throw new SealRefused();
  const head = Buffer.alloc(SEAL_HEAD);
  const tail = Buffer.alloc(size - last.at);
  readSync(fd, head, 0, head.length, 0);
  readSync(fd, tail, 0, tail.length, last.at);
  checkEnds(key, head, tail, last.n, sha256);
}

/* Writes what comes into a file of its own, made safe on the disk before it ends. */
async function intoFile(path: string): Promise<Writable> {
  const handle = await open(path, 'wx', 0o600);
  return new Writable({
    write(chunk: Buffer, _encoding, done) {
      handle.write(chunk).then(() => done(), done);
    },
    final(done) {
      handle.sync().then(() => handle.close()).then(() => done(), done);
    },
    destroy(err, done) {
      handle.close().then(() => done(err), () => done(err));
    },
  });
}

/* The files of the company that one machine keeps: each sealed, under the sha256 of its plain bytes, in a folder of its
   first two letters. A file is written into tmp while it is counted and hashed, made safe on the disk, and only then
   linked under its name, once: what is there is never written again, and a second take of the same file keeps the one
   there. A take that fails leaves nothing, as it removes its own temporary file. */
export class FileStore {
  /* The temporary files of takes that still run, which no tidying removes. */
  private readonly parts = new Set<string>();

  constructor(readonly dir: string, private readonly idleMs = IDLE_MS) {}

  /* Where a file is, by its name. */
  path(sha256: string): string {
    return join(this.dir, checkName(sha256).slice(0, 2), sha256);
  }

  private tmp(): string {
    return join(this.dir, 'tmp');
  }

  has(sha256: string): boolean {
    return SHA256.test(sha256) && statSync(this.path(sha256), { throwIfNoEntry: false })?.isFile() === true;
  }

  /* The sealed bytes of a file as they travel to another machine, or null when it is not here. */
  sealed(sha256: string): { length: number; stream: () => Readable } | null {
    if (!SHA256.test(sha256)) return null;
    const found = statSync(this.path(sha256), { throwIfNoEntry: false });
    if (!found?.isFile()) return null;
    return { length: found.size, stream: () => createReadStream(this.path(sha256)) };
  }

  /* A file's plain bytes as they go out, opened with the store key a piece at a time. A copy that does not open under its
     name, as one laid under another name, is refused before a byte goes out; one changed on the disk elsewhere fails the
     stream where it stops opening. */
  open(sha256: string, key: Buffer): Readable {
    if (!this.has(sha256)) throw new StoreRefused('missing');
    const fd = openOrMissing(this.path(sha256));
    try {
      checkOpens(fd, key, sha256);
    } catch (err) {
      closeSync(fd);
      throw err;
    }
    const out = openSealed(key, sha256);
    const file = createReadStream('', { fd, start: 0 });
    file.on('error', err => out.destroy(err));
    return file.pipe(out);
  }

  /* The hash and size of the sealed bytes of a file here, and the salt its head carries. */
  async sealedFacts(sha256: string): Promise<{ sealedSha256: string; sealedSize: number; salt: string }> {
    const count = counter();
    let head: Buffer = Buffer.alloc(0);
    const look = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        if (head.length < SEAL_HEAD) head = Buffer.concat([head, chunk]).subarray(0, SEAL_HEAD);
        done(null, chunk);
      },
    });
    await pipeline(createReadStream(this.path(sha256)), look, count, new Writable({ write: (_chunk, _encoding, done) => done() }));
    return { sealedSha256: count.digest(), sealedSize: count.bytes, salt: saltOf(head) };
  }

  /* Seals a file here again under the salt its record names, so its sealed bytes are those the other machines keep of
     it, and lays them in its place at once. The file must open to its name first. Says the sealed facts it has now. */
  async reseal(sha256: string, key: Buffer, salt: string): Promise<{ sealedSha256: string; sealedSize: number; salt: string }> {
    await mkdir(this.tmp(), { recursive: true, mode: 0o700 });
    const part = join(this.tmp(), `${randomUUID()}.part`);
    this.parts.add(part);
    try {
      const count = counter();
      await pipeline(this.open(sha256, key), seal(key, () => sha256, Buffer.from(salt, 'hex')), count, await intoFile(part));
      await rename(part, this.path(sha256));
      return { sealedSha256: count.digest(), sealedSize: count.bytes, salt };
    } finally {
      this.parts.delete(part);
      await rm(part, { force: true });
    }
  }

  /* Writes a part, which names itself once written, and links it under that name. True when it was not there yet. */
  private async publish(write: (part: string) => Promise<string>): Promise<{ name: string; fresh: boolean }> {
    await mkdir(this.tmp(), { recursive: true, mode: 0o700 });
    const part = join(this.tmp(), `${randomUUID()}.part`);
    this.parts.add(part);
    try {
      const name = checkName(await write(part));
      await mkdir(join(this.dir, name.slice(0, 2)), { recursive: true, mode: 0o700 });
      try {
        await link(part, this.path(name));
        return { name, fresh: true };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { name, fresh: false };
        throw err;
      }
    } finally {
      this.parts.delete(part);
      await rm(part, { force: true });
    }
  }

  /* Seals a file from its plain bytes as they come, and keeps it under their hash. A file that was here already stays
     as it was, and its own sealed facts are answered. */
  async put(input: Readable | AsyncIterable<Buffer>, key: Buffer, room?: StoreRoom): Promise<StoredFile & { fresh: boolean }> {
    const plain = counter();
    const sealedCount = counter();
    const salt = randomBytes(16);
    const { name, fresh } = await this.publish(async part => {
      /* A stream goes in as it is: one wrapped again could not be closed while it waits for bytes that never come. */
      const source = input instanceof Readable ? input : Readable.from(input);
      await pipeline(source, guard(room, this.idleMs), plain, seal(key, () => plain.digest(), salt), sealedCount, await intoFile(part));
      return plain.digest();
    });
    const facts = fresh ? { sealedSha256: sealedCount.digest(), sealedSize: sealedCount.bytes, salt: salt.toString('hex') } : await this.sealedFacts(name);
    return { sha256: name, size: plain.bytes, ...facts, fresh };
  }

  /* Takes a sealed file from another machine: it must be as long as said and hash to what was said, or nothing is kept.
     The plain hash is its name, which a holder cannot check without the key; the machine that opens it does. */
  async take(sha256: string, input: Readable, expect: { sealedSha256: string; sealedSize: number }): Promise<boolean> {
    checkName(sha256);
    if (this.has(sha256)) {
      input.destroy();
      return false;
    }
    const count = counter();
    const room: StoreRoom = { bytes: expect.sealedSize, full: () => new StoreRefused('size') };
    const { fresh } = await this.publish(async part => {
      await pipeline(input, guard(room, this.idleMs), count, await intoFile(part));
      if (count.bytes !== expect.sealedSize) throw new StoreRefused('size');
      if (count.digest() !== expect.sealedSha256) throw new StoreRefused('hash');
      return sha256;
    });
    return fresh;
  }

  /* Takes a sealed file no record describes, as a merge brings a row that names it: it is kept only when it opens with
     the store key to bytes of its name, and is at most maxBytes long. */
  async takeOpened(sha256: string, input: Readable, key: Buffer, maxBytes: number): Promise<boolean> {
    checkName(sha256);
    if (this.has(sha256)) {
      input.destroy();
      return false;
    }
    const room: StoreRoom = { bytes: maxBytes, full: () => new StoreRefused('size') };
    const { fresh } = await this.publish(async part => {
      await pipeline(input, guard(room, this.idleMs), await intoFile(part));
      const plain = counter();
      await pipeline(createReadStream(part), openSealed(key, sha256), plain, new Writable({ write: (_chunk, _encoding, done) => done() })).catch(() => {
        throw new StoreRefused('hash');
      });
      if (plain.digest() !== sha256) throw new StoreRefused('hash');
      return sha256;
    });
    return fresh;
  }

  /* Takes a file away; nothing happens when it is not here. */
  async remove(sha256: string): Promise<void> {
    if (SHA256.test(sha256)) await rm(this.path(sha256), { force: true });
  }

  /* The names of every file here, with when each came. */
  async list(): Promise<{ sha256: string; at: Date }[]> {
    const found: { sha256: string; at: Date }[] = [];
    for (const folder of await readdir(this.dir).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{2}$/.test(folder)) continue;
      for (const name of await readdir(join(this.dir, folder)).catch(() => [] as string[])) {
        if (!SHA256.test(name) || !name.startsWith(folder)) continue;
        const facts = await stat(join(this.dir, folder, name)).catch(() => null);
        if (facts?.isFile()) found.push({ sha256: name, at: facts.mtime });
      }
    }
    return found;
  }

  /* Removes temporary files that no take here runs for and that are older than an hour. */
  async tidy(now = new Date()): Promise<void> {
    for (const name of await readdir(this.tmp()).catch(() => [] as string[])) {
      const path = join(this.tmp(), name);
      if (this.parts.has(path)) continue;
      const facts = await stat(path).catch(() => null);
      if (facts && now.getTime() - facts.mtime.getTime() > PART_LIFE_MS) await rm(path, { force: true });
    }
  }
}
