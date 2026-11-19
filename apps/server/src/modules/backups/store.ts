import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { UUID } from '../../net/proxy.js';
import { BundleRefused, headLine, readHead, type Manifest } from './bundle.js';
import { ROOM, REPORT_MAX, REPORTED_BUNDLES } from './types.js';

export type StoredBundle = { id: string; manifest: Manifest; head: string; size: number };
/* A transfer that moves no byte for this long is cut. */
export const IDLE_MS = 30_000;
/* How far past its signed size a transfer is read before it is seen to be too long. */
const OVER = 1024 * 1024;

/* The bundles a machine keeps, each as its head and its sealed part. A bundle is there once both files are, and what
   is there is never written again: a take of one that is held answers the one held. */
export class BundleStore {
  /* One writer per bundle at a time, in this process. */
  private readonly writing = new Map<string, Promise<unknown>>();
  /* The temporary files of takes that still run, which no tidying removes. */
  private readonly parts = new Set<string>();

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private head(id: string): string {
    return join(this.dir, `${id}.head`);
  }

  /* The path of the sealed part. */
  ageFile(id: string): string {
    return join(this.dir, `${id}.age`);
  }

  private read(id: string): StoredBundle | null {
    try {
      const head = readFileSync(this.head(id), 'utf8');
      const manifest = JSON.parse((JSON.parse(head) as { manifest: string }).manifest) as Manifest;
      return { id, manifest, head, size: statSync(this.ageFile(id)).size };
    } catch {
      return null;
    }
  }

  /* The complete ones, newest first. */
  list(): StoredBundle[] {
    const ids = readdirSync(this.dir).flatMap(name => (name.endsWith('.head') && UUID.test(name.slice(0, -5)) ? [name.slice(0, -5)] : []));
    return ids
      .map(id => this.read(id))
      .filter(bundle => bundle !== null)
      .sort((a, b) => Date.parse(b.manifest.madeAt) - Date.parse(a.manifest.madeAt) || a.id.localeCompare(b.id));
  }

  /* What a machine reports of what it holds: its newest bundles, and every bundle of a database set aside before a
     merge besides, so a restore of one still finds who holds it when many were made since. */
  reported(): string[] {
    const all = this.list();
    const newest = all.slice(0, REPORTED_BUNDLES);
    const forks = all.slice(REPORTED_BUNDLES).filter(bundle => bundle.manifest.reason === 'fork');
    return [...newest, ...forks].slice(0, REPORT_MAX).map(bundle => bundle.id);
  }

  has(id: string): boolean {
    return UUID.test(id) && this.read(id) !== null;
  }

  /* The bundle as it travels: its two lines, then the sealed part. */
  open(id: string): { length: number; stream(): Readable } | null {
    const held = UUID.test(id) ? this.read(id) : null;
    if (!held) return null;
    const lines = Buffer.from(headLine(held.head), 'utf8');
    const file = this.ageFile(id);
    return {
      length: lines.length + held.size,
      stream: () =>
        Readable.from(
          (async function* () {
            yield lines;
            yield* createReadStream(file) as AsyncIterable<Buffer>;
          })(),
          { objectMode: false },
        ),
    };
  }

  private free(): number {
    const { bavail, bsize } = statfsSync(this.dir);
    return bavail * bsize;
  }

  /* One after another for the same bundle. A take publishes in here; a caller that looks whether a bundle is held, takes
     it and acts on what came of it as one step runs that step in here, and names the bundle to take as inside. */
  alone<T>(id: string, work: () => Promise<T>): Promise<T> {
    const run = (this.writing.get(id) ?? Promise.resolve()).then(work, work);
    const settled = run.catch(() => undefined);
    this.writing.set(id, settled);
    void settled.then(() => {
      if (this.writing.get(id) === settled) this.writing.delete(id);
    });
    return run;
  }

  /* Takes a bundle from a stream: its head is checked first by the caller's check, which throws; then there must be
     room; then the sealed part goes into a file of this take alone while it is counted and hashed, cut the moment it
     passes the signed size or stops coming; and only what has the signed size and hash is published, once. Any failure
     removes this take's file and nothing else. inside: the bundle whose turn of alone the caller holds already, where
     the take publishes without waiting for a turn of its own. */
  async take(input: Readable, check: (head: string) => Manifest, opts: { id?: string; free?: () => number; idleMs?: number; inside?: string } = {}): Promise<StoredBundle> {
    let part: string | null = null;
    try {
      const { head, rest } = await readHead(input);
      const manifest = check(head);
      if (opts.id !== undefined && opts.id !== manifest.id) throw new BundleRefused('format', 'This is another bundle than the one asked for.');
      const held = this.read(manifest.id);
      if (held) {
        rest.destroy();
        return held;
      }
      if ((opts.free ?? (() => this.free()))() < ROOM * manifest.size) throw new BundleRefused('room', 'There is too little free disk here to keep this bundle.');
      part = join(this.dir, `${manifest.id}.${randomBytes(6).toString('hex')}.part`);
      this.parts.add(part);
      const sha256 = await this.receive(rest, part, manifest.size, opts.idleMs ?? IDLE_MS);
      if (sha256.size !== manifest.size) throw new BundleRefused('size', 'The bundle is not as long as its head says.');
      if (sha256.hash !== manifest.sha256) throw new BundleRefused('hash', 'The sealed part is not the one its head names.');
      const taken = part;
      const publish = async () => {
        const there = this.read(manifest.id);
        if (there) return there;
        writeFileSync(this.head(manifest.id), head, { mode: 0o600 });
        renameSync(taken, this.ageFile(manifest.id));
        return this.read(manifest.id)!;
      };
      return await (opts.inside === manifest.id ? publish() : this.alone(manifest.id, publish));
    } catch (err) {
      input.destroy();
      throw err;
    } finally {
      if (part) {
        rmSync(part, { force: true });
        this.parts.delete(part);
      }
    }
  }

  private async receive(rest: Readable, part: string, size: number, idleMs: number): Promise<{ size: number; hash: string }> {
    const hash = createHash('sha256');
    let got = 0;
    let idle: NodeJS.Timeout | undefined;
    let cut: BundleRefused | null = null;
    const watch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        cut = new BundleRefused('idle', 'The bundle stopped coming.');
        rest.destroy(cut);
      }, idleMs);
    };
    watch();
    const file = createWriteStream(part, { flags: 'wx', mode: 0o600, highWaterMark: OVER });
    try {
      await pipeline(
        rest,
        async function* (source: AsyncIterable<Uint8Array>) {
          for await (const chunk of source) {
            got += chunk.length;
            if (got > size) throw new BundleRefused('size', 'The bundle is longer than its head says.');
            hash.update(chunk);
            watch();
            yield chunk;
          }
        },
        file,
      );
    } catch (err) {
      /* A file cut before it was open is still made a moment later: only once it is closed can it be removed. */
      if (!file.closed) await new Promise<void>(resolve => file.once('close', resolve).destroy());
      throw cut ?? (err instanceof BundleRefused ? err : new BundleRefused('size', 'The bundle broke off before its end.'));
    } finally {
      clearTimeout(idle);
    }
    return { size: got, hash: hash.digest('hex') };
  }

  /* Hashes the stored sealed part again, as a restore does before it opens it. */
  async verify(id: string): Promise<StoredBundle> {
    const held = UUID.test(id) ? this.read(id) : null;
    if (!held) throw new BundleRefused('format', 'This machine does not hold that bundle.');
    if (held.size !== held.manifest.size) throw new BundleRefused('size', 'The stored bundle is not as long as its head says.');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(this.ageFile(id)) as AsyncIterable<Buffer>) hash.update(chunk);
    if (hash.digest('hex') !== held.manifest.sha256) throw new BundleRefused('hash', 'The stored sealed part is not the one its head names.');
    return held;
  }

  /* A bundle this machine sealed itself, by a rename of its sealed part. */
  put(head: string, manifest: Manifest, ageFile: string): StoredBundle {
    if (!this.read(manifest.id)) {
      writeFileSync(this.head(manifest.id), head, { mode: 0o600 });
      renameSync(ageFile, this.ageFile(manifest.id));
    } else rmSync(ageFile, { force: true });
    return this.read(manifest.id)!;
  }

  remove(id: string): void {
    if (!UUID.test(id)) return;
    rmSync(this.head(id), { force: true });
    rmSync(this.ageFile(id), { force: true });
  }

  /* Removes every complete bundle that is not named, and what tidy removes. */
  keepOnly(ids: string[]): void {
    for (const name of readdirSync(this.dir)) {
      const id = name.split('.')[0]!;
      if (name.endsWith('.head') && !ids.includes(id)) this.remove(id);
    }
    this.tidy();
  }

  /* Removes what a take that died left, and a sealed part with no head: a keeper stopped in the middle of a transfer
     leaves them, and nothing else ever would take them away. A take that still runs keeps its file. */
  tidy(): void {
    for (const name of readdirSync(this.dir)) {
      const path = join(this.dir, name);
      const id = name.split('.')[0]!;
      if (name.endsWith('.part')) {
        if (!this.parts.has(path)) rmSync(path, { force: true });
      } else if (name.endsWith('.age') && !existsSync(this.head(id)) && !this.writing.has(id)) rmSync(path, { force: true });
    }
  }
}
